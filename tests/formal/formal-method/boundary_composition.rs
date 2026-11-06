use super::{parse_model, run_case, Expr, SolverResult};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const SOURCE: &str = super::operational_checks::MODEL;
pub(super) const CONTRACTS: &str = include_str!("boundary-contracts.smt2");
const GROUPS: [&str; 4] = ["control", "evidence", "producer", "consumer"];
const FLAGS: [&str; 6] = ["bad_skip_answer", "bad_drop_save", "bad_late_complete", "bad_report_reset", "bad_reuse", "bad_producer"];
const WRITES: [&[&str]; 13] = [
    &["phase", "need"], &["reported"], &["phase", "reported", "available", "value"],
    &["saved"], &["answered"], &["phase", "need", "epoch"], &["reused"],
    &["checked", "matched"], &["phase"], &["worked"], &["message", "produced"],
    &["consumed", "consumedReady"], &[],
];

fn owner(n: &str) -> Result<&'static str, String> {
    Ok(match n {
        "phase" | "reported" | "answered" | "need" | "epoch" | "worked" => "control",
        "available" | "saved" | "value" | "reused" | "checked" | "matched" => "evidence",
        "message" | "produced" => "producer",
        "consumed" | "consumedReady" => "consumer",
        "init" | "next" | "assertion@32" => "coordinator",
        "environmentInput" | "event" | "resultChoice" | "currentVersion" | "resultVersion" | "assertion@9" => "environment",
        n if FLAGS.contains(&n) => "environment",
        _ => return Err(format!("unassigned composition symbol {n}")),
    })
}
fn and(xs: impl IntoIterator<Item=String>) -> String {
    format!("(and true {})", xs.into_iter().collect::<Vec<_>>().join(" "))
}
fn flags(mutation: Option<&str>) -> String {
    FLAGS.iter().map(|f|format!("(assert (= {f} {}))\n",Some(*f)==mutation)).collect()
}
fn invariant(group: &str, t: usize) -> String {
    match group {
        "control" => format!("(and (=> (= (epoch {t}) 1) (answered {t})) (=> (and (available {t}) (= (epoch {t}) 0)) (= (phase {t}) 1)) (=> (available {t}) (reported {t})))"),
        "evidence" => format!("(and (=> (reused {t}) (and (available {t}) (saved {t}) (checked {t}) (matched {t}))) (=> (matched {t}) (= currentVersion resultVersion)) (=> (saved {t}) (available {t})))"),
        "producer" => format!("(=> (produced {t}) (= (message {t}) environmentInput))"),
        "consumer" => format!("(=> (consumedReady {t}) (and (produced {t}) (= (consumed {t}) (message {t}))))"),
        _ => unreachable!(),
    }
}
fn invariant_all(t: usize) -> String {and(GROUPS.map(|g| invariant(g,t)))}
fn check(z3: &str, out: Option<&Path>, name: &str, model: &str, pre: &str, query: &str, expected: SolverResult) -> Result<(),String> {
    let name=format!("boundary_{name}");
    run_case(z3,&name,model,pre,query,expected)?;
    if let Some(dir)=out {
        std::fs::write(dir.join(format!("{name}.smt2")),format!("{model}\n{pre}\n(assert {query})\n(check-sat)\n")).map_err(|e|e.to_string())?;
    }
    Ok(())
}
fn symbols(expr:&Expr,names:&BTreeSet<String>,locals:&BTreeSet<String>,result:&mut BTreeSet<String>) {
    match expr {
        Expr::Atom(a) => {if names.contains(a)&&!locals.contains(a){result.insert(a.clone());}},
        Expr::List(xs) => for x in xs {symbols(x,names,locals,result)},
    }
}

pub(super) fn run(z3:&str)->Result<(),String> {
    let output=std::env::var_os("FORMAL_RUN_DIR").map(std::path::PathBuf::from);
    if let Some(dir)=&output {std::fs::create_dir_all(dir).map_err(|e|e.to_string())?;}
    let out=output.as_deref();
    let forms=parse_model(SOURCE)?;
    let mut declarations=String::new();
    let mut model=String::new();
    let mut anchor=String::new();
    let mut nodes=BTreeMap::new();
    let mut next=None;
    for (i,f) in forms.iter().enumerate() {
        let xs=f.list().ok_or("top-level atom")?;
        let h=xs[0].atom().ok_or("missing head")?;
        let name=if h=="assert" {format!("assertion@{i}")} else if h.starts_with("declare-")||h=="define-fun" {xs[1].atom().ok_or("missing name")?.to_owned()} else {String::new()};
        if !name.is_empty(){owner(&name)?;nodes.insert(name,f.clone());}
        if h=="define-fun" && xs[1].atom()==Some("next") {next=Some(xs[4].clone());}
        if h!="assert" {model.push_str(&format!("{}\n",f.render()));}
        if h=="assert" && xs[1].atom()!=Some("init") {anchor.push_str(&format!("{}\n",f.render()));}
        if h!="assert"&&h!="define-fun" {declarations.push_str(&format!("{}\n",f.render()));}
    }
    model.push_str(&anchor);declarations.push_str(&anchor);
    let next=next.ok_or("missing next")?;
    let branches=next.list().ok_or("next not disjunction")?;
    if branches[0].atom()!=Some("or"){return Err("next not disjunction".into());}
    if branches.len()!=WRITES.len()+1 {return Err("event set changed; review frame contract".into());}
    let fields=nodes.keys().filter(|n|GROUPS.contains(&owner(n).unwrap())).cloned().collect::<BTreeSet<_>>();
    let mut projections=BTreeMap::<String,Vec<String>>::new();
    let mut guard_branches=Vec::new();
    let mut frame_report=String::from("event\towner\tmodified_fields\tframe_obligation\n");
    for (event,b) in branches[1..].iter().enumerate() {
        let xs=b.list().ok_or("branch not conjunction")?;
        if xs.len()!=fields.len()+3||xs[0].atom()!=Some("and"){return Err("branch does not have guard plus total writes".into());}
        let mut writes=BTreeMap::new();
        for write in &xs[3..] {
            let w=write.list().ok_or("write not list")?;
            let lhs=w.get(1).and_then(Expr::list).ok_or("write without application lhs")?;
            let field=lhs.first().and_then(Expr::atom).ok_or("write no field")?;
            if w.len()!=3||w[0].atom()!=Some("=")||lhs.len()!=2||lhs[1].atom()!=Some("n")||!fields.contains(field)||writes.insert(field.to_owned(),write.clone()).is_some(){return Err("invalid/duplicate/unowned next write".into());}
        }
        if writes.keys().cloned().collect::<BTreeSet<_>>()!=fields{return Err("missing frame write".into());}
        guard_branches.push(and([xs[1].render(),xs[2].render()]));
        for g in GROUPS {
            let owned=writes.iter().filter(|(f,_)|owner(f).unwrap()==g).collect::<Vec<_>>();
            let relation=and(std::iter::once(xs[1].render()).chain(owned.iter().map(|(_,w)|w.render())));
            projections.entry(g.into()).or_default().push(relation);
            let changed=owned.iter().filter(|(f,w)|w.render()!=format!("(= ({f} n) ({f} t))")).map(|(f,_)|f.as_str()).collect::<Vec<_>>();
            frame_report.push_str(&format!("{event}\t{g}\t{}\tall other owned fields explicitly equal pre-state; foreign fields owned elsewhere\n",changed.join(",")));
        }
    }
    let disj=|xs:&Vec<String>|format!("(or {})",xs.join(" "));
    let mut relations=format!("(define-fun boundary_guard ((t Int) (n Int)) Bool {})\n",disj(&guard_branches));
    for (g,bs) in &projections {relations.push_str(&format!("(define-fun boundary_{g} ((t Int) (n Int)) Bool {})\n",disj(bs)));}
    model.push_str(&relations);
    model.push_str(CONTRACTS);
    let reconstructed=and(std::iter::once("(boundary_guard 0 1)".into()).chain(GROUPS.map(|g|format!("(boundary_{g} 0 1)"))));
    check(z3,out,"reconstruction",&model,"",&format!("(not (= (next 0 1) {reconstructed}))"),SolverResult::Unsat)?;
    let normal=flags(None);
    for g in GROUPS.into_iter().chain(["guard"]) {
        check(z3,out,&format!("{g}_exports_interface"),&model,&normal,&format!("(and (boundary_{g} 0 1) (not (interface_{g} 0 1)))"),SolverResult::Unsat)?;
    }
    check(z3,out,"initial_establishes_interfaces",&model,&normal,&format!("(and init (not {}))",invariant_all(0)),SolverResult::Unsat)?;
    let pre=format!("{normal}(assert {})\n(assert {reconstructed})\n",invariant_all(0));
    for (event,allowed) in WRITES.iter().enumerate() {
        let frame=and(fields.iter().filter(|f|!allowed.contains(&f.as_str())).map(|f|format!("(= ({f} 1) ({f} 0))")));
        check(z3,out,&format!("event_{event}_frame"),&model,&normal,&format!("(and (next 0 1) (= (event 0) {event}) (not {frame}))"),SolverResult::Unsat)?;
    }
    for g in GROUPS {
        let dependencies: &[&str]=match g {"control"=>&["evidence"],"consumer"=>&["producer"],_=>&[]};
        let imports=and(dependencies.iter().map(|other|format!("(interface_{other} 0 1)")));
        let local_pre=format!("{normal}(assert {})\n(assert (boundary_{g} 0 1))\n(assert (interface_guard 0 1))\n(assert {imports})\n",invariant_all(0));
        check(z3,out,&format!("{g}_post"),&model,&local_pre,&format!("(not {})",invariant(g,1)),SolverResult::Unsat)?;
        if !dependencies.is_empty() {
            let missing_pre=format!("{normal}(assert {})\n(assert (boundary_{g} 0 1))\n(assert (interface_guard 0 1))\n",invariant_all(0));
            check(z3,out,&format!("{g}_missing_import"),&model,&missing_pre,&format!("(not {})",invariant(g,1)),SolverResult::Sat)?;
        }
    }
    for (flag,g) in [("bad_skip_answer","control"),("bad_late_complete","control"),("bad_report_reset","control"),("bad_reuse","evidence"),("bad_producer","producer")] {
        let pre=format!("{}(assert {})\n(assert {reconstructed})\n",flags(Some(flag)),invariant_all(0));
        check(z3,out,&format!("{flag}_post_mutation"),&model,&pre,&format!("(not {})",invariant(g,1)),SolverResult::Sat)?;
    }
    let save="(=> (= (event 0) 3) (saved 1))";
    check(z3,out,"save_post",&model,&pre,&format!("(not {save})"),SolverResult::Unsat)?;
    let drop_pre=format!("{}(assert {})\n(assert {reconstructed})\n",flags(Some("bad_drop_save")),invariant_all(0));
    check(z3,out,"save_post_mutation",&model,&drop_pre,&format!("(not {save})"),SolverResult::Sat)?;
    for event in 0..branches.len()-1 {
        check(z3,out,&format!("event_{event}_enabled"),&model,&pre,&format!("(= (event 0) {event})"),SolverResult::Sat)?;
    }
    let goal="(and (=> (consumedReady 1) (and (= (consumed 1) environmentInput) (<= 0 (consumed 1)) (<= (consumed 1) 2))) (=> (reused 1) (and (reported 1) (saved 1) (= currentVersion resultVersion))) (=> (and (available 1) (= (epoch 1) 0)) (not (= (phase 1) 2))) (=> (= (epoch 1) 1) (answered 1)))";
    let guarantees=format!("(assert {})\n",invariant_all(1));
    check(z3,out,"abstract_whole_system",&declarations,&guarantees,&format!("(not {goal})"),SolverResult::Unsat)?;
    check(z3,out,"abstract_witness",&declarations,&guarantees,"(and (consumedReady 1) (reused 1) (= (epoch 1) 1) (= environmentInput 2))",SolverResult::Sat)?;
    let unanchored=declarations.replace(&anchor, "");
    check(z3,out,"omit_environment_anchor",&unanchored,&guarantees,&format!("(not {goal})"),SolverResult::Sat)?;
    for missing in GROUPS {
        let weakened=format!("(assert {})\n",and(GROUPS.into_iter().filter(|g|*g!=missing).map(|g|invariant(g,1))));
        check(z3,out,&format!("omit_{missing}_guarantee"),&declarations,&weakened,&format!("(not {goal})"),SolverResult::Sat)?;
    }
    let names=nodes.keys().cloned().collect::<BTreeSet<_>>();
    let mut edges=Vec::new();
    for (n,f) in &nodes {
        let xs=f.list().unwrap();let head=xs[0].atom().unwrap();
        let mut refs=BTreeSet::new();let mut locals=BTreeSet::new();
        if head=="define-fun" {
            for p in xs[2].list().ok_or("params")? {locals.insert(p.list().ok_or("param")?[0].atom().ok_or("param name")?.to_owned());}
            symbols(&xs[4],&names,&locals,&mut refs);
        } else if head=="assert" {symbols(&xs[1],&names,&locals,&mut refs);}
        for r in refs {edges.push((n.clone(),r));}
    }
    let mut mapping=String::from("source\ttarget\tsemantic_source\tsemantic_target\tobligations\n");
    for (a,b) in &edges {
        let target_owner=owner(b)?;
        let obligations=match a.as_str(){"init"|"assertion@32"=>"initial_establishes_interfaces".to_owned(), "assertion@9"=>"original environment assertion retained verbatim; abstract_whole_system".into(), "next" if GROUPS.contains(&target_owner)=>format!("{target_owner}_exports_interface; {target_owner}_post; reconstruction; event frames; enabled witnesses"), "next"=>"guard_exports_interface; original environment anchors; normal flags false; each mutation detected".into(), _=>return Err("unclassified dependency".into())};
        mapping.push_str(&format!("{a}\t{b}\t{}\t{}\t{obligations}\n",owner(a)?,owner(b)?));
    }
    if let Some(dir)=out {
        std::fs::write(dir.join("boundary-dependency-map.tsv"),mapping).map_err(|e|e.to_string())?;
        std::fs::write(dir.join("boundary-frames.tsv"),frame_report).map_err(|e|e.to_string())?;
        std::fs::write(dir.join("boundary-projections.smt2"),format!("{model}\n")).map_err(|e|e.to_string())?;
    }
    println!("boundary composition: {} symbols / {} original syntactic references mapped; four state owners, coordinator and explicit environment; reconstruction, base, inductive postconditions, frames, enabled cases and abstract composition checked",nodes.len(),edges.len());
    Ok(())
}

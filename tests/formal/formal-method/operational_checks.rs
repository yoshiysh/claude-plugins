use super::{classify, diagnostic, parse_model, run_case, run_solver, Expr, SolverResult};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
pub(super) const MODEL: &str = include_str!("operational.smt2");
pub(super) const SOURCE: &str = include_str!("operational_checks.rs");
const STEPS: usize = 10;
const FLAGS: [&str; 6] = ["bad_skip_answer", "bad_drop_save", "bad_late_complete", "bad_report_reset", "bad_reuse", "bad_producer"];

fn preconditions(mutation: Option<&str>) -> String {
    let mut s = FLAGS.iter().map(|f| format!("(assert (= {f} {}))\n", if Some(*f) == mutation {"true"} else {"false"})).collect::<String>();
    for t in 0..STEPS { s.push_str(&format!("(assert (next {t} {}))\n",t+1)); }
    s
}
fn any(predicate: impl Fn(usize) -> String) -> String {
    format!("(or {})", (0..=STEPS).map(predicate).collect::<Vec<_>>().join(" "))
}
fn trace_case(z3: &str, name: &str, mutation: Option<&str>, query: &str, expected: SolverResult, out: Option<&Path>) -> Result<(), String> {
    let pre = preconditions(mutation);
    run_case(z3, name, MODEL, &pre, query, expected)?;
    if let Some(dir) = out {
        let formula = format!("{MODEL}\n{pre}\n(assert {query})\n(check-sat)\n");
        std::fs::write(dir.join(format!("{name}.smt2")), &formula).map_err(|e| e.to_string())?;
        if expected == SolverResult::Sat {
            let fields = ["phase", "reported", "answered", "need", "available", "saved", "value", "reused", "checked", "matched", "epoch", "worked", "message", "consumed", "produced", "consumedReady"];
            let keys = (0..=STEPS).flat_map(|t| fields.iter().map(move |f| format!("({f} {t})"))).chain((0..STEPS).map(|t| format!("(event {t})"))).collect::<BTreeSet<_>>();
            let full = format!("{formula}(get-value ({}))\n",keys.iter().cloned().collect::<Vec<_>>().join(" "));
            let (status,text,stderr)=run_solver(z3,&full).map_err(|e|e.to_string())?;
            if !matches!(status, super::ChildStatus::Exited(Some(0))) {return Err(diagnostic(status,&stderr));}
            let (head,body)=text.split_once('\n').ok_or("missing witness")?;
            if head.trim()!="sat" {return Err("witness not sat".into());}
            let forms=parse_model(body)?;
            let pairs=forms.first().and_then(Expr::list).ok_or("missing values")?;
            let mut seen=BTreeSet::new();
            let mut replay=formula.replace("(check-sat)","");
            for pair in pairs {
                let p=pair.list().ok_or("invalid witness pair")?;
                if p.len()!=2 {return Err("invalid pair size".into());}
                let key=p[0].render(); let val=p[1].render();
                if !keys.contains(&key)||!seen.insert(key.clone()) {return Err("unknown/duplicate witness field".into());}
                if val!="true"&&val!="false"&&val.parse::<i64>().is_err() {return Err("unsupported witness value".into());}
                replay.push_str(&format!("(assert (= {key} {val}))\n"));
            }
            if seen!=keys {return Err("incomplete witness".into());}
            replay.push_str("(check-sat)\n");
            let (s,r,e)=run_solver(z3,&replay).map_err(|e|e.to_string())?;
            if classify(s,&r)!=SolverResult::Sat {return Err(format!("replay failed: {}",diagnostic(s,&e)));}
            std::fs::write(dir.join(format!("{name}.witness")),body).map_err(|e|e.to_string())?;
        }
    }
    Ok(())
}

type Graph = BTreeMap<String, BTreeSet<String>>;
fn refs(expr: &Expr, names: &BTreeSet<String>, locals: &BTreeSet<String>, found: &mut BTreeSet<String>) -> Result<(), String> {
    match expr {
        Expr::Atom(a) => {
            if locals.contains(a) { return Ok(()); }
            if names.contains(a) { found.insert(a.clone()); return Ok(()); }
            if a=="true"||a=="false"||a.parse::<i64>().is_ok() {return Ok(());}
            Err(format!("unsupported or unbound atom {a}"))
        }
        Expr::List(xs) => {
            let head=xs.first().and_then(Expr::atom).ok_or("non-symbol function")?;
            let builtins=["and","or","not","=>","=","<",">","<=",">=","+","-","*","ite","mod"];
            if !builtins.contains(&head)&&!names.contains(head) {return Err(format!("unsupported binding/operator {head}"));}
            if names.contains(head)&&!locals.contains(head) {found.insert(head.into());}
            for x in &xs[1..] {refs(x,names,locals,found)?;}
            Ok(())
        }
    }
}
fn graph(source: &str) -> Result<(Graph, BTreeMap<String,String>),String> {
    let forms=parse_model(source)?;
    let mut defs=BTreeMap::new(); let mut graph=Graph::new(); let mut provenance=BTreeMap::new();
    for (ordinal,form) in forms.iter().enumerate() {
        let x=form.list().ok_or("top level atom")?;
        let head=x.first().and_then(Expr::atom).ok_or("empty form")?;
        match head {
            "set-logic"|"set-option"=>(),
            "assert"=> {
                if x.len()!=2 {return Err("assertion arity".into());}
                let name=format!("assertion@{ordinal}");
                graph.insert(name.clone(),BTreeSet::new());
                provenance.insert(name.clone(),form.render());
                defs.insert(name,(Expr::List(Vec::new()),x[1].clone()));
            },
            "declare-const"|"declare-fun"|"define-fun"=> {
                let name=x.get(1).and_then(Expr::atom).ok_or("missing name")?.to_owned();
                if graph.insert(name.clone(), BTreeSet::new()).is_some() {return Err("duplicate definition".into());}
                provenance.insert(name.clone(),form.render());
                if head=="define-fun" {
                    if x.len()!=5 {return Err("definition arity".into());}
                    defs.insert(name,(x[2].clone(),x[4].clone()));
                }
            }
            _=>return Err(format!("unsupported command {head}")),
        }
    }
    let names=graph.keys().cloned().collect::<BTreeSet<_>>();
    for (name,(params,body)) in defs {
        let mut locals=BTreeSet::new();
        for p in params.list().ok_or("parameters not list")? {
            let p=p.list().ok_or("parameter not list")?;
            let local=p.first().and_then(Expr::atom).ok_or("parameter no name")?;
            if !locals.insert(local.into()) {return Err("duplicate local".into());}
        }
        refs(&body,&names,&locals,graph.get_mut(&name).unwrap())?;
    }
    Ok((graph,provenance))
}
fn reachable(graph:&Graph,start:&str)->BTreeSet<String> {
    let mut found=BTreeSet::new();let mut todo=vec![start.to_owned()];
    while let Some(n)=todo.pop() {if found.insert(n.clone()) {todo.extend(graph[&n].iter().cloned());}}
    found
}
fn candidates(graph:&Graph)->Vec<BTreeSet<String>> {
    let mut left=graph.keys().cloned().collect::<BTreeSet<_>>();let mut result=Vec::new();
    while let Some(seed)=left.first().cloned() {
        let forward=reachable(graph,&seed);
        let component=forward.into_iter().filter(|n|reachable(graph,n).contains(&seed)).collect::<BTreeSet<_>>();
        for n in &component {left.remove(n);}
        result.push(component);
    }
    result
}
fn validate_coverage(g:&Graph, owner:&BTreeMap<String,usize>, contracts:&BTreeSet<(String,String)>)->Result<(),String> {
    if owner.keys().cloned().collect::<BTreeSet<_>>()!=g.keys().cloned().collect::<BTreeSet<_>>() {return Err("vertex coverage mismatch".into());}
    let expected=g.iter().flat_map(|(a,bs)|bs.iter().filter_map(|b| if owner[a]!=owner[b] {Some((a.clone(),b.clone()))} else {None})).collect::<BTreeSet<_>>();
    if *contracts!=expected {return Err("cross-boundary dependency coverage mismatch".into());}
    Ok(())
}
fn graph_check(out:Option<&Path>)->Result<(),String> {
    let (g,p)=graph(MODEL)?;let cs=candidates(&g);
    let owner=cs.iter().enumerate().flat_map(|(i,c)|c.iter().map(move|n|(n.clone(),i))).collect::<BTreeMap<_,_>>();
    if owner.len()!=g.len()||cs.iter().map(BTreeSet::len).sum::<usize>()!=g.len() {return Err("partition lost/duplicated vertex".into());}
    let edges=g.iter().flat_map(|(a,bs)|bs.iter().map(move|b|(a.clone(),b.clone()))).collect::<BTreeSet<_>>();
    let cross=edges.iter().filter(|(a,b)|owner[a]!=owner[b]).cloned().collect::<BTreeSet<_>>();
    if cross.is_empty(){return Err("fixture lacks boundary edges".into());}
    validate_coverage(&g,&owner,&cross)?;
    let mut omitted=cross.clone();omitted.pop_first();
    if validate_coverage(&g,&owner,&omitted).is_ok(){return Err("omission mutation was not detected".into());}
    let mut missing=owner.clone();missing.pop_first();
    if validate_coverage(&g,&missing,&cross).is_ok(){return Err("vertex omission not detected".into());}
    if graph("(declare-const x Int) (define-fun p ((x Int)) Bool (= x 1))")?.0["p"].contains("x") {return Err("local shadow creates false edge".into());}
    if graph("(define-fun p () Bool (forall ((x Int)) (= x x)))").is_ok(){return Err("unsupported binding accepted".into());}
    let assertion=graph("(declare-const x Int) (assert (= x 1))")?.0;
    if !assertion["assertion@1"].contains("x") {return Err("assertion reference omitted".into());}
    if graph("(assert (forall ((x Int)) (= x x)))").is_ok(){return Err("unsupported assertion accepted".into());}
    if graph("(assert (= external 1))").is_ok(){return Err("unbound assertion accepted".into());}
    if let Some(dir)=out {
        let mut text=String::from("source\tnode\tSCC_candidate\tdefinition\n");
        for (n,definition) in p {text.push_str(&format!("operational.smt2\t{n}\t{}\t{definition}\n",owner[&n]));}
        text.push_str("\nsource\ttarget\tcross_boundary\tobligation\n");
        for (a,b) in &edges {text.push_str(&format!("{a}\t{b}\t{}\tretain referenced symbol interpretation\n",cross.contains(&(a.clone(),b.clone()))));}
        std::fs::write(dir.join("dependency-graph.tsv"),text).map_err(|e|e.to_string())?;
    }
    println!("operational graph: {} vertices, {} edges, {} deterministic SCC candidates, {} cross edges; omission/shadow/binder negatives detected",g.len(),edges.len(),cs.len(),cross.len());
    Ok(())
}

pub(super) fn run(z3:&str)->Result<(),String> {
    let output=std::env::var_os("FORMAL_RUN_DIR").map(std::path::PathBuf::from);
    if let Some(p)=&output {std::fs::create_dir_all(p).map_err(|e|e.to_string())?;}
    let out=output.as_deref();graph_check(out)?;
    let late="(and (= (event 0) 0) (= (event 1) 1) (= (event 2) 2) (= (event 3) 3))";
    let pending=any(|t|format!("(and (= (epoch {t}) 1) (not (answered {t})))"));
    let lost=any(|t| if t<STEPS {format!("(and (= (event {t}) 3) (not (saved {})))",t+1)} else {"false".into()});
    let early=any(|t|format!("(and (= (epoch {t}) 0) (available {t}) (not (= (phase {t}) 1)))"));
    let reset=any(|t|format!("(and (available {t}) (not (reported {t})))"));
    let reused=any(|t|format!("(and (reused {t}) (or (not (checked {t})) (not (matched {t}))))"));
    let composition=any(|t|format!("(and (consumedReady {t}) (> (consumed {t}) 2))"));
    for (name,query,flag) in [("009_answer_gate",pending,"bad_skip_answer"),("015_save",lost,"bad_drop_save"),("015_old_run_stopped",early,"bad_late_complete"),("015_report_retained",reset,"bad_report_reset"),("015_reuse_gate",reused,"bad_reuse"),("008_anchored_composition",composition,"bad_producer")] {
        trace_case(z3,&format!("operational_{name}"),None,&query,SolverResult::Unsat,out)?;
        trace_case(z3,&format!("operational_{name}_mutation"),Some(flag),&query,SolverResult::Sat,out)?;
    }
    for result in 1..=5 {trace_case(z3,&format!("operational_015_late_result_{result}_saved"),None,&format!("(and {late} (= (resultChoice 2) {result}) (saved 4) (= (value 4) {result}) (= (phase 4) 1) (reported 4))"),SolverResult::Sat,out)?;}
    let resumed=format!("(and {late} (= (event 4) 4) (= (event 5) 5) (= (event 6) 7) (= (event 7) 6) (= currentVersion resultVersion) (reused 8) (answered 8) (= (epoch 8) 1))");
    trace_case(z3,"operational_answer_resume_check_reuse_witness",None,&resumed,SolverResult::Sat,out)?;
    trace_case(z3,"operational_mismatch_cannot_reuse",None,&resumed.replace("(= currentVersion resultVersion)","(not (= currentVersion resultVersion))"),SolverResult::Unsat,out)?;
    trace_case(z3,"operational_failure_cannot_complete_after_reuse",None,&format!("(and {resumed} (> (value 8) 1) (= (event 8) 8) (= (phase 9) 2))"),SolverResult::Unsat,out)?;
    trace_case(z3,"operational_success_can_complete_after_reuse",None,&format!("(and {resumed} (= (value 8) 1) (= (event 8) 8) (= (phase 9) 2))"),SolverResult::Sat,out)?;
    trace_case(z3,"operational_producer_consumer_witness",None,"(and (= (event 0) 10) (= (event 1) 11) (= environmentInput 2) (= (consumed 2) 2))",SolverResult::Sat,out)?;
    Ok(())
}

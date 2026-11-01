use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fs;

fn main() {
    let path = env::args().nth(1).expect("TLC dot path required");
    let dot = fs::read_to_string(path).expect("cannot read TLC dot");
    let mut nodes = HashMap::new();
    let mut initial_states = Vec::new();
    let mut edges = Vec::new();
    for line in dot.lines() {
        let line = line.trim();
        if let Some((source, rest)) = line.split_once(" -> ") {
            if let Some((target, attributes)) = rest.split_once(" [label=\"") {
                let label = attributes.split_once('"').expect("edge label").0;
                let label = label.strip_prefix("Step").unwrap_or(label);
                edges.push((source.to_string(), target.to_string(), label.to_string()));
            }
        } else if let Some((id, attributes)) = line.split_once(" [label=\"") {
            let marker = "phase = \\\"";
            if let Some((_, phase)) = attributes.split_once(marker) {
                let phase = phase.split_once("\\\"").expect("phase label").0;
                nodes.insert(id.to_string(), phase.to_string());
                if attributes.contains("style = filled") {
                    initial_states.push(id.to_string());
                }
            }
        }
    }
    assert!(!nodes.is_empty() && !edges.is_empty(), "TLC graph has no states or actions");
    let mut projected: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for (source, target, action) in edges {
        let from = nodes.get(&source).expect("unknown source state");
        let to = nodes.get(&target).expect("unknown target state");
        projected.entry((from.clone(), to.clone())).or_default().insert(action);
    }
    assert_eq!(initial_states.len(), 1, "TLC graph must have exactly one initial state");
    let initial = nodes.get(&initial_states[0]).expect("initial state has no phase");
    println!("```mermaid\nstateDiagram-v2\n    [*] --> {initial}");
    for ((from, to), actions) in projected {
        let label = actions.into_iter().collect::<Vec<_>>().join(", ");
        println!("    {from} --> {to}: {label}");
    }
    println!("```");
}

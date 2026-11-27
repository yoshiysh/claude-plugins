//! `partition-assemble`: 分割の決定的な欄（SP-264-023）。
//! `adopted`・`parts` と境界の `producer`・`consumer`・`shared_symbols` は、
//! 候補と辺と採否から一意に決まる。
//! 境界の前提・保証・出どころ・責任は分割作成役の下書きから写す。

use crate::error::InputError;
use crate::types::{
    self, Boundary, Candidate, Part, PartitionAssembleInput, PartitionAssembleOutput,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const VAR: &str = "var:";
const TR: &str = "tr:";

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: PartitionAssembleInput = types::parse(input)?;
    let adopted_ids: BTreeSet<&str> = input
        .decisions
        .iter()
        .filter(|d| d.adopted)
        .map(|d| d.candidate_id.as_str())
        .collect();
    let adopted = input.decisions.iter().any(|d| d.adopted);
    let mut seen_candidates = BTreeSet::new();
    let mut seen_nodes = BTreeSet::new();
    let mut parts = Vec::new();
    for c in &input.candidates {
        if !seen_candidates.insert(c.id.as_str()) {
            return Err(InputError::new(format!("候補の id {} が重なる", c.id)));
        }
        for n in &c.nodes {
            if !seen_nodes.insert(n.as_str()) {
                return Err(InputError::new(format!("節点 {n} が 2 つの候補にある")));
            }
        }
        let part = part_of(c)?;
        if adopted && adopted_ids.contains(c.id.as_str()) {
            parts.push(part);
        }
    }
    // 節点の id から部分を引く（採った候補の節点だけ）
    let mut owner: BTreeMap<&str, &str> = BTreeMap::new();
    for p in &parts {
        for n in p.owns_variables.iter().chain(&p.transitions) {
            owner.insert(n.as_str(), p.id.as_str());
        }
    }
    // 同じ edge_id の下書きが重なれば先の要素を使う（重なりは CLI が下書きの欠陥にする）
    let mut drafts = BTreeMap::new();
    for b in &input.boundaries {
        drafts.entry(b.edge_id.as_str()).or_insert(b);
    }
    let mut crossing = BTreeSet::new();
    let mut boundaries = Vec::new();
    let mut missing_boundaries = Vec::new();
    for e in &input.graph_edges {
        let consumer = owner.get(e.from.as_str());
        let producer = owner.get(e.to.as_str());
        let (Some(consumer), Some(producer)) = (consumer, producer) else {
            continue;
        };
        if consumer == producer {
            continue;
        }
        crossing.insert(e.id.as_str());
        let Some(d) = drafts.get(e.id.as_str()) else {
            missing_boundaries.push(e.id.clone());
            continue;
        };
        boundaries.push(Boundary {
            edge_id: e.id.clone(),
            producer: producer.to_string(),
            consumer: consumer.to_string(),
            shared_symbols: vec![symbol_of(&e.to)?.to_string()],
            assumption: d.assumption.clone(),
            guarantee: d.guarantee.clone(),
            assumption_basis: d.assumption_basis.clone(),
            responsible: d.responsible.clone(),
        });
    }
    let extra_boundaries = input
        .boundaries
        .iter()
        .filter(|b| !crossing.contains(b.edge_id.as_str()))
        .map(|b| b.edge_id.clone())
        .collect();
    types::output(&PartitionAssembleOutput {
        adopted,
        parts,
        boundaries,
        missing_boundaries,
        extra_boundaries,
    })
}

/// 候補の節点から部分を作る。節点は 1 つのモデルに属する（`writer-merge-scc/1`）。
fn part_of(c: &Candidate) -> Result<Part, InputError> {
    let mut model_ids = BTreeSet::new();
    let mut owns_variables = Vec::new();
    let mut transitions = Vec::new();
    for n in &c.nodes {
        let (model_id, is_variable) = if let Some(rest) = n.strip_prefix(VAR) {
            (model_of(rest, n)?, true)
        } else if let Some(rest) = n.strip_prefix(TR) {
            (model_of(rest, n)?, false)
        } else {
            let message = format!("候補 {} の節点 {n} が変数でも遷移でもない", c.id);
            return Err(InputError::new(message));
        };
        model_ids.insert(model_id);
        if is_variable {
            owns_variables.push(n.clone());
        } else {
            transitions.push(n.clone());
        }
    }
    let mut it = model_ids.into_iter();
    let (Some(model_id), None) = (it.next(), it.next()) else {
        let message = format!("候補 {} の節点が 1 つのモデルに属さない", c.id);
        return Err(InputError::new(message));
    };
    owns_variables.sort();
    transitions.sort();
    Ok(Part {
        id: c.id.clone(),
        model_id: model_id.to_string(),
        owns_variables,
        transitions,
    })
}

/// `<model_id>/<名前>` の `<model_id>`。
fn model_of<'a>(rest: &'a str, node: &str) -> Result<&'a str, InputError> {
    match rest.split_once('/') {
        Some((model_id, name)) if !model_id.is_empty() && !name.is_empty() => Ok(model_id),
        _ => {
            let message = format!("節点 {node} の id が <種類>:<model_id>/<名前> でない");
            Err(InputError::new(message))
        }
    }
}

/// 節点の id の `/` の後の名前（境界の共有の記号）。
fn symbol_of(node: &str) -> Result<&str, InputError> {
    match node.split_once('/') {
        Some((_, name)) if !name.is_empty() => Ok(name),
        _ => {
            let message = format!("節点 {node} の id に / の後の名前が無い");
            Err(InputError::new(message))
        }
    }
}

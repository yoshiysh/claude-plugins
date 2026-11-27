//! `partition-models`: 性質を連結成分でモデルに分け、model_id を決める（SP-264-010・011）。

use crate::error::InputError;
use crate::order::{cmp_ids, sha256_hex};
use crate::types::{
    self, ModelAssignment, ModelProperty, PartitionModelsInput, PartitionModelsOutput,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// `m-<h>` の `<h>` の短い形の長さ（SP-264-011）。
const SHORT_HASH_LEN: usize = 12;

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: PartitionModelsInput = types::parse(input)?;
    check_properties(&input.properties)?;
    check_previous(&input.previous)?;
    let mut properties = input.properties;
    properties.sort_by(|a, b| cmp_ids(&a.id, &b.id));
    let components = components(&properties);
    let (formal, nonformal) = split_formal(&properties, &components);
    let ids = assign_ids(&formal, &input.previous);
    let models = build_models(formal, nonformal, ids);
    types::output(&PartitionModelsOutput { models })
}

fn error(message: String) -> InputError {
    InputError::new(message)
}

fn check_properties(properties: &[ModelProperty]) -> Result<(), InputError> {
    let mut seen = BTreeSet::new();
    for p in properties {
        if p.source_ids.is_empty() {
            return Err(error(format!("性質 {} の source_ids が空", p.id)));
        }
        if !seen.insert(p.id.as_str()) {
            return Err(error(format!("性質の id {} が重なる", p.id)));
        }
    }
    Ok(())
}

fn check_previous(previous: &[ModelAssignment]) -> Result<(), InputError> {
    let mut model_ids = BTreeSet::new();
    let mut owner: BTreeMap<&str, &str> = BTreeMap::new();
    for m in previous {
        let model_id = m.model_id.as_str();
        if model_id.contains('.') {
            return Err(error(format!("前回の model_id {model_id} が . を含む")));
        }
        if !model_ids.insert(model_id) {
            return Err(error(format!("前回の model_id {model_id} が重なる")));
        }
        for pid in &m.property_ids {
            let first = *owner.entry(pid.as_str()).or_insert(model_id);
            if first != model_id {
                return Err(error(format!("性質 {pid} が前回の 2 つのモデルにある")));
            }
        }
    }
    Ok(())
}

/// `source_ids` を共有する性質を結んだ連結成分。各成分は性質の位置を昇順に持ち、
/// 成分は最小の性質の位置の順に並ぶ（性質は id の順に並べてある）。
fn components(properties: &[ModelProperty]) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..properties.len()).collect();
    let mut first: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, p) in properties.iter().enumerate() {
        for s in &p.source_ids {
            let j = *first.entry(s.as_str()).or_insert(i);
            union(&mut parent, i, j);
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..properties.len() {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = groups.into_values().collect();
    out.sort_by_key(|c| c[0]);
    out
}

fn find(parent: &mut [usize], i: usize) -> usize {
    let mut root = i;
    while parent[root] != root {
        root = parent[root];
    }
    let mut cur = i;
    while parent[cur] != root {
        let next = parent[cur];
        parent[cur] = root;
        cur = next;
    }
    root
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let ra = find(parent, a);
    let rb = find(parent, b);
    // 小さい位置を根にする（成分の並びは components が決める）
    if ra != rb {
        parent[ra.max(rb)] = ra.min(rb);
    }
}

fn is_formal(properties: &[ModelProperty], component: &[usize]) -> bool {
    component.iter().any(|&i| properties[i].formalizable)
}

fn ids_of(properties: &[ModelProperty], component: &[usize]) -> Vec<String> {
    component
        .iter()
        .map(|&i| properties[i].id.clone())
        .collect()
}

/// 成分を性質の id の組にし、形式の成分と形式でない成分の性質に分ける（規則 2・5）。
fn split_formal(
    properties: &[ModelProperty],
    components: &[Vec<usize>],
) -> (Vec<Vec<String>>, Vec<String>) {
    let mut formal = Vec::new();
    let mut nonformal = Vec::new();
    for c in components {
        if is_formal(properties, c) {
            formal.push(ids_of(properties, c));
        } else {
            nonformal.extend(ids_of(properties, c));
        }
    }
    if formal.is_empty() {
        // 形式の成分が無ければ、全ての性質を 1 つのモデルにまとめる（規則 5）
        nonformal.sort_by(|a, b| cmp_ids(a, b));
        return (vec![nonformal], Vec::new());
    }
    (formal, nonformal)
}

/// 成分と前回のモデルの重なりの組（重なり, 前回の位置, 成分の位置）。重なりが 1 以上のものだけ。
fn overlaps(formal: &[Vec<String>], previous: &[ModelAssignment]) -> Vec<(usize, usize, usize)> {
    let mut pairs = Vec::new();
    for (ci, c) in formal.iter().enumerate() {
        for (pi, p) in previous.iter().enumerate() {
            let overlap = c.iter().filter(|id| p.property_ids.contains(id)).count();
            if overlap > 0 {
                pairs.push((overlap, pi, ci));
            }
        }
    }
    pairs
}

/// 形式の成分ごとの model_id（SP-264-011）。返り値は `formal` と同じ位置に並ぶ。
fn assign_ids(formal: &[Vec<String>], previous: &[ModelAssignment]) -> Vec<String> {
    let mut pairs = overlaps(formal, previous);
    // 重なりの大きい順、同じなら前回の id の小さい順、同じなら成分の最小の性質の id の小さい順
    pairs.sort_by(|a, b| {
        let by_previous = cmp_ids(&previous[a.1].model_id, &previous[b.1].model_id);
        let by_component = cmp_ids(&formal[a.2][0], &formal[b.2][0]);
        b.0.cmp(&a.0).then(by_previous).then(by_component)
    });
    let mut assigned: Vec<Option<String>> = vec![None; formal.len()];
    let mut used_previous = BTreeSet::new();
    for (_, pi, ci) in pairs {
        if assigned[ci].is_none() && used_previous.insert(pi) {
            assigned[ci] = Some(previous[pi].model_id.clone());
        }
    }
    let mut taken: BTreeSet<String> = BTreeSet::new();
    for p in previous {
        taken.insert(p.model_id.clone());
    }
    for id in assigned.iter().flatten() {
        taken.insert(id.clone());
    }
    let mut out = Vec::with_capacity(formal.len());
    for (ci, slot) in assigned.into_iter().enumerate() {
        let id = match slot {
            Some(id) => id,
            None => hashed_id(&formal[ci], &taken),
        };
        taken.insert(id.clone());
        out.push(id);
    }
    out
}

/// `m-<h>`。短い形が既に使われていれば 64 文字の全てを使う。
fn hashed_id(ids: &[String], taken: &BTreeSet<String>) -> String {
    let hex = sha256_hex(ids.join("\n").as_bytes());
    let short = format!("m-{}", &hex[..SHORT_HASH_LEN]);
    if taken.contains(&short) {
        format!("m-{hex}")
    } else {
        short
    }
}

/// モデルを作り、形式でない成分の性質を最小の model_id のモデルに足す（規則 4）。
fn build_models(
    formal: Vec<Vec<String>>,
    nonformal: Vec<String>,
    ids: Vec<String>,
) -> Vec<ModelAssignment> {
    let mut models = Vec::with_capacity(ids.len());
    for (model_id, property_ids) in ids.into_iter().zip(formal) {
        models.push(ModelAssignment {
            model_id,
            property_ids,
        });
    }
    models.sort_by(|a, b| cmp_ids(&a.model_id, &b.model_id));
    if let Some(first) = models.first_mut() {
        first.property_ids.extend(nonformal);
    }
    for m in &mut models {
        m.property_ids.sort_by(|a, b| cmp_ids(a, b));
    }
    models
}

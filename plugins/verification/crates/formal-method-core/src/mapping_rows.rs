//! `mapping-rows`: 対応表の location の行の骨組み（SP-264-025）。
//! 行の数・row_id・出所・性質は性質の `source_ids` から一意に決まる。
//! 形式化できる性質の行の `relation` と、全ての行の `model_element` は作成役が書く。

use crate::error::InputError;
use crate::order::cmp_ids;
use crate::schema;
use crate::types::{
    self, LocationSource, MappingProperty, MappingRow, MappingRowsInput, MappingRowsOutput,
    SourceRef,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// location の出所の `kind`。
const LOCATION: &str = "location";

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: MappingRowsInput = types::parse(input)?;
    let mut elements: BTreeMap<&str, &SourceRef> = BTreeMap::new();
    for e in &input.elements {
        if elements.insert(e.id.as_str(), &e.source).is_some() {
            return Err(error(format!("要素の id {} が重なる", e.id)));
        }
    }
    let mut properties: Vec<&MappingProperty> = input.properties.iter().collect();
    properties.sort_by(|a, b| cmp_ids(&a.id, &b.id));
    let mut rows = Vec::new();
    let mut row_ids = BTreeSet::new();
    for p in properties {
        for source_id in &p.source_ids {
            let Some(source) = elements.get(source_id.as_str()) else {
                return Err(error(format!("性質 {} の出所 {source_id} が無い", p.id)));
            };
            let row = skeleton_row(p, source_id, source);
            if !row_ids.insert(row.row_id.clone()) {
                return Err(error(format!("行の id {} が重なる", row.row_id)));
            }
            rows.push(row);
        }
    }
    types::output(&MappingRowsOutput { rows })
}

fn error(message: String) -> InputError {
    InputError::new(message)
}

/// 骨組みの行。形式化できない性質の行は関係と理由を決める（性質ごとに一意な関係）。
fn skeleton_row(p: &MappingProperty, source_id: &str, source: &SourceRef) -> MappingRow {
    let (relation, reason) = if p.formalizable {
        (None, None)
    } else {
        let relation = schema::role("relation_nonformal").to_string();
        (Some(relation), p.nonformal_reason.clone())
    };
    MappingRow {
        row_id: format!("{}/{source_id}", p.id),
        source: LocationSource {
            kind: LOCATION.to_string(),
            target_id: source.target_id.clone(),
            file: source.file.clone(),
            span: source.span.clone(),
        },
        property_id: p.id.clone(),
        relation,
        reason,
    }
}

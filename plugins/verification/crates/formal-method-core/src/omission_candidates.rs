//! `omission-candidates`: 漏れの候補（SP-264-027）。
//! モデルが引かず、対応表のどの行も触れない要素を id の順に出す。
//! 「触れる」は `omissionDefects`（`checks/model.mjs`）の定め: target の行はその対象の要素、
//! location の行は同じ対象・同じファイルで span が重なるか span が無いもの。他の行は触れない。

use crate::error::InputError;
use crate::extract_skeleton::parse_span;
use crate::order::cmp_ids;
use crate::types::{
    self, OmissionCandidatesInput, OmissionCandidatesOutput, Pointer, SourceRef, SourcedElement,
};
use serde_json::Value;
use std::collections::BTreeSet;

/// 対象を指す行の `kind`。
const TARGET: &str = "target";
/// ファイルの範囲を指す行の `kind`。
const LOCATION: &str = "location";

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: OmissionCandidatesInput = types::parse(input)?;
    let cited: BTreeSet<&str> = input.cited_ids.iter().map(String::as_str).collect();
    let rows: Vec<&Pointer> = input.rows.iter().map(|r| &r.source).collect();
    let mut seen = BTreeSet::new();
    let mut candidates = Vec::new();
    for e in &input.elements {
        if !seen.insert(e.id.as_str()) {
            return Err(error(format!("要素の id {} が重なる", e.id)));
        }
        if cited.contains(e.id.as_str()) {
            continue;
        }
        let Some(span) = parse_span(&e.source.span) else {
            return Err(error(format!("要素 {} の範囲を読めない", e.id)));
        };
        if !touched(&rows, &e.source, span)? {
            candidates.push(e.clone());
        }
    }
    candidates.sort_by(|a: &SourcedElement, b| cmp_ids(&a.id, &b.id));
    types::output(&OmissionCandidatesOutput { candidates })
}

fn error(message: String) -> InputError {
    InputError::new(message)
}

/// どれかの行が要素に触れるか。
fn touched(rows: &[&Pointer], src: &SourceRef, span: (u64, u64)) -> Result<bool, InputError> {
    for row in rows {
        if touches(row, src, span)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn touches(row: &Pointer, src: &SourceRef, span: (u64, u64)) -> Result<bool, InputError> {
    match row.kind.as_str() {
        TARGET => Ok(row.id.as_deref() == Some(src.target_id.as_str())),
        LOCATION => {
            let same_target = row.target_id.as_deref() == Some(src.target_id.as_str());
            let same_file = row.file.as_deref() == Some(src.file.as_str());
            if !same_target || !same_file {
                return Ok(false);
            }
            let Some(row_span) = &row.span else {
                return Ok(true);
            };
            let Some((from, to)) = parse_span(row_span) else {
                return Err(error(format!("行の範囲 {row_span} を読めない")));
            };
            Ok(from <= span.1 && span.0 <= to)
        }
        _ => Ok(false),
    }
}

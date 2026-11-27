//! `extract-skeleton`: 走査の範囲と外部の ID の下書き（SP-264-026）。
//! 走査の範囲は依頼の範囲と受付で固定した行数から、外部の ID の下書きは CLI が求めた参照から決める。
//! 固定の文は `x-core.texts` の名前で引く。

use crate::error::InputError;
use crate::order::cmp_ids;
use crate::schema;
use crate::types::{
    self, ExternalDependency, ExternalReference, ExtractSkeletonInput, ExtractSkeletonOutput,
    Scanned, ScopeEntry, SourceRef, TargetFile,
};
use serde_json::Value;
use std::collections::BTreeMap;

/// 読んだ範囲の `status`。
const READ: &str = "read";
/// 読めなかったファイルの `status`。
const UNREAD: &str = "unread";

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: ExtractSkeletonInput = types::parse(input)?;
    let mut files: BTreeMap<&str, &TargetFile> = BTreeMap::new();
    for f in &input.files {
        if files.insert(f.path.as_str(), f).is_some() {
            return Err(error(format!("ファイル {} が重なる", f.path)));
        }
    }
    let mut scope: Vec<&ScopeEntry> = input.scope.iter().collect();
    scope.sort_by(|a, b| cmp_ids(&a.file, &b.file));
    let mut scanned = Vec::new();
    for entry in scope {
        let Some(file) = files.get(entry.file.as_str()) else {
            return Err(error(format!(
                "範囲のファイル {} が files に無い",
                entry.file
            )));
        };
        scanned.extend(scanned_of(entry, file)?);
    }
    let external_dependencies = drafts(&input.target_id, &input.references);
    let output = ExtractSkeletonOutput {
        scanned,
        external_dependencies,
    };
    types::output(&output)
}

fn error(message: String) -> InputError {
    InputError::new(message)
}

/// 1 つのファイルの走査の記録。テキストでないファイルは読めなかった記録を 1 つ。
fn scanned_of(entry: &ScopeEntry, file: &TargetFile) -> Result<Vec<Scanned>, InputError> {
    let lines = match file.lines {
        Some(n) if file.text => n,
        _ => return Ok(vec![unread(&entry.file)]),
    };
    let Some(spans) = &entry.spans else {
        return Ok(vec![read(&entry.file, None)]);
    };
    let mut out = Vec::with_capacity(spans.len());
    for span in spans {
        let Some((from, to)) = parse_span(span) else {
            return Err(error(format!("{} の範囲 {span} を読めない", entry.file)));
        };
        // 行数を超える span は行数で切る。全体が行数の外なら覆う行が無い
        if from > lines {
            continue;
        }
        let clipped = format!("L{from}-L{}", to.min(lines));
        out.push(read(&entry.file, Some(clipped)));
    }
    Ok(out)
}

fn read(file: &str, span: Option<String>) -> Scanned {
    Scanned {
        file: file.to_string(),
        span,
        status: READ.to_string(),
        reason: None,
    }
}

fn unread(file: &str) -> Scanned {
    Scanned {
        file: file.to_string(),
        span: None,
        status: UNREAD.to_string(),
        reason: Some(schema::text("unread_non_text").to_string()),
    }
}

/// `L<from>-L<to>`（1 ≦ from ≦ to）を読む。CLI の `parseSpan` と同じ定め。
pub(crate) fn parse_span(span: &str) -> Option<(u64, u64)> {
    let (a, b) = span.strip_prefix('L')?.split_once("-L")?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    let (from, to) = (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?);
    (1..=to).contains(&from).then_some((from, to))
}

/// 外部の ID の下書き。id の順で、同じ id は最初の参照を使う。
fn drafts(target_id: &str, references: &[ExternalReference]) -> Vec<ExternalDependency> {
    let mut first: BTreeMap<&str, &ExternalReference> = BTreeMap::new();
    for r in references {
        first.entry(r.id.as_str()).or_insert(r);
    }
    // BTreeMap の str の順は UTF-8 のバイト列の辞書順（cmp_ids と同じ）
    let template = schema::text("external_reference_template");
    first
        .values()
        .map(|r| draft(template, target_id, r))
        .collect()
}

fn draft(template: &str, target_id: &str, r: &ExternalReference) -> ExternalDependency {
    let line = r.line.to_string();
    let text = template
        .replace("{id}", &r.id)
        .replace("{file}", &r.file)
        .replace("{line}", &line);
    ExternalDependency {
        id: r.id.clone(),
        text,
        source: SourceRef {
            target_id: target_id.to_string(),
            file: r.file.clone(),
            span: format!("L{line}-L{line}"),
        },
    }
}

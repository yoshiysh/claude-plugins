//! prd-spec の静的な層（探索グラフ）。
//!
//! doc_check.mjs が本文を解析して作った事実（項目・項目の本文の digest・本文中の ID 参照・
//! トレーサビリティ表の紐付け）と、段 1 の入口で残した項目の digest を受け取り、
//! 変わった項目と影響の範囲を決定的に返す。本文の解析はしない（解析の正本は doc_check に 1 つだけ置く）。

pub mod checks;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// 入力の事実。`entry` が無く固定でもない文書（新しく書く文書）は、全ての項目を変わった項目に数える。
#[derive(Debug, Deserialize)]
pub struct Facts {
    /// 文書のキー → 項目の ID → 入口の本文の digest。entry が existing でない run では空。
    #[serde(default)]
    pub entry: BTreeMap<String, BTreeMap<String, String>>,
    pub docs: Vec<Doc>,
}

#[derive(Debug, Deserialize)]
pub struct Doc {
    pub key: String,
    /// 固定の文書（run の中で書き換えない）。入口を持たなくても、項目を変わった項目に数えない。
    #[serde(default)]
    pub fixed: bool,
    pub items: Vec<Item>,
    /// トレーサビリティ表の行（要求 ID と仕様項目 ID の組）。
    #[serde(default)]
    pub links: Vec<Link>,
}

#[derive(Debug, Deserialize)]
pub struct Item {
    pub id: String,
    /// 項目の digest（doc_check が本文の区間と項目自身の trace から取る。この run で付けた trace も項目の変更に数えるため）。
    pub digest: String,
    /// 区間の本文に現れる、自分以外の項目の ID。
    #[serde(default)]
    pub refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Link {
    pub requirement_id: String,
    pub spec_id: String,
}

/// 出力。どの集合も ID の昇順で、同じ入力からは同じ出力になる。
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Impact {
    /// 入口に無いか、入口から本文の digest が変わった項目。
    pub changed: Vec<String>,
    /// 入口にあって今は無い項目。
    pub removed: Vec<String>,
    /// changed と removed と、それらと参照でつながる項目（1 hop）。
    pub impact: Vec<String>,
    /// 入口の digest を持つ文書のキー（この外の固定でない文書は全ての項目が changed）。
    pub baselined: Vec<String>,
}

pub fn impact(facts: &Facts) -> Impact {
    let mut changed = BTreeSet::new();
    let mut removed = BTreeSet::new();
    let mut baselined = BTreeSet::new();
    let mut current: BTreeSet<&str> = BTreeSet::new();

    for doc in &facts.docs {
        let base = facts.entry.get(&doc.key);
        if base.is_some() {
            baselined.insert(doc.key.clone());
        }
        for item in &doc.items {
            current.insert(item.id.as_str());
            let same = base
                .and_then(|b| b.get(&item.id))
                .is_some_and(|d| d == &item.digest);
            if !same && !doc.fixed {
                changed.insert(item.id.clone());
            }
        }
    }
    // 入口にあって今は無い項目。文書ごと消すか改名した文書の項目も含める。
    for base in facts.entry.values() {
        for id in base.keys() {
            if !current.contains(id.as_str()) {
                removed.insert(id.clone());
            }
        }
    }

    // 参照の辺は向きを持つが、影響は両向きに伝わる（変えた項目を参照する項目も、変えた項目が参照する項目も読み直す）。
    let mut neighbors: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for doc in &facts.docs {
        for item in &doc.items {
            for r in &item.refs {
                if r == &item.id {
                    continue;
                }
                neighbors
                    .entry(item.id.as_str())
                    .or_default()
                    .insert(r.as_str());
                neighbors
                    .entry(r.as_str())
                    .or_default()
                    .insert(item.id.as_str());
            }
        }
        // 同じ要求を実現する仕様項目どうしと、その要求は、互いに影響する。
        let mut by_req: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for l in &doc.links {
            by_req
                .entry(l.requirement_id.as_str())
                .or_default()
                .insert(l.spec_id.as_str());
        }
        for (req, specs) in &by_req {
            for s in specs {
                neighbors.entry(req).or_default().insert(s);
                neighbors.entry(s).or_default().insert(req);
                for t in specs {
                    if s != t {
                        neighbors.entry(s).or_default().insert(t);
                    }
                }
            }
        }
    }

    let mut hit: BTreeSet<String> = changed.iter().chain(removed.iter()).cloned().collect();
    for seed in changed.iter().chain(removed.iter()) {
        if let Some(ns) = neighbors.get(seed.as_str()) {
            hit.extend(ns.iter().map(|s| s.to_string()));
        }
    }

    Impact {
        changed: changed.into_iter().collect(),
        removed: removed.into_iter().collect(),
        impact: hit.into_iter().collect(),
        baselined: baselined.into_iter().collect(),
    }
}

//! 優先度 1 の静的な検査。doc_check が渡す事実だけから、決定的に指摘を返す。
//!
//! 文書の構造の解析（区間・表・「> 条件の値:」の宣言・本文中の ID・用語表の行）は doc_check が 1 か所で行い、
//! 解析済みの値を渡す。ここで文字を読むのは、略記の ID と欄の数の 2 つの検査だけ。
//! 指摘の文面は doc_check の表（WORKSPACE_TEXT）が持ち、ここは種別と引数だけを返す。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Deserialize, Default)]
pub struct CheckFacts {
    #[serde(default)]
    pub docs: Vec<CheckDoc>,
    /// 決定の台帳（decisions.json）。text は value と quote をつないだもの。
    #[serde(default)]
    pub decisions: Vec<Decision>,
    /// flow の判断の要素の入力（名前と値の集合）。
    #[serde(default)]
    pub flow: Vec<FlowDecision>,
    /// 保持規則（resolutions の ruling = hold）が触れる項目。
    #[serde(default)]
    pub holds: Vec<Hold>,
    /// この run で変えた項目（impact の changed）。
    #[serde(default)]
    pub changed: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckDoc {
    pub key: String,
    #[serde(default)]
    pub fixed: bool,
    pub sections: Vec<Section>,
    #[serde(default)]
    pub trace: Vec<Trace>,
    #[serde(default)]
    pub glossary: Vec<GlossaryRow>,
}

#[derive(Debug, Deserialize)]
pub struct Section {
    /// doc_check の区間の key（項目なら ID、それ以外は `§見出し`）。
    pub key: String,
    #[serde(default)]
    pub id: Option<String>,
    /// 見出しの行を除いた本文。
    pub body: String,
    /// 本文に現れる、自分以外の項目 ID（doc_check の ID_IN_TEXT で取り出したもの）。
    #[serde(default)]
    pub ids: Vec<String>,
    /// 「> 条件の値: 名前 = a / b」の宣言（doc_check の quoteParagraphs と splitAxis で取り出したもの）。
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Deserialize)]
pub struct Condition {
    pub name: String,
    pub values: Vec<String>,
}

/// 用語表の行のうち、定義の所在を「定義は SP-X」と示すもの。
#[derive(Debug, Deserialize)]
pub struct GlossaryRow {
    /// 用語表の節の key。
    pub section: String,
    pub term: String,
    pub target: String,
}

#[derive(Debug, Deserialize)]
pub struct Trace {
    pub item_id: String,
    pub kind: String,
    #[serde(default)]
    pub r#ref: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Decision {
    pub id: String,
    /// 決定の値と引用が名指す項目 ID（覆された決定は doc_check が渡さない）。
    pub named: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct FlowDecision {
    pub id: String,
    pub inputs: Vec<FlowInput>,
}

#[derive(Debug, Deserialize)]
pub struct FlowInput {
    pub name: String,
    pub values: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Hold {
    pub id: String,
    pub item_ids: Vec<String>,
}

/// 指摘。`code` は doc_check の表の種別、`doc` は帰属する文書、`args` はその表の関数の引数。
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct Finding {
    pub code: &'static str,
    pub doc: String,
    pub args: Vec<serde_json::Value>,
}

fn s(v: &str) -> serde_json::Value {
    serde_json::Value::String(v.to_string())
}

/// 項目 ID（PR-/SP- の形）を文から取り出す。doc_check の ID_IN_TEXT（`\bSP-…-\d+\b`）と同じく、直前が英数字か `_` でなければ語頭とする。
pub fn ids_in(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < b.len() {
        let at_word = i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
        if at_word && (b[i..].starts_with(b"PR-") || b[i..].starts_with(b"SP-")) {
            let mut j = i + 3;
            let p0 = j;
            while j < b.len() && (b[j].is_ascii_uppercase() || b[j].is_ascii_digit()) {
                j += 1;
            }
            if j > p0 && b[p0].is_ascii_uppercase() && j < b.len() && b[j] == b'-' {
                let n0 = j + 1;
                let mut k = n0;
                while k < b.len() && b[k].is_ascii_digit() {
                    k += 1;
                }
                let ends = k == b.len() || !(b[k].is_ascii_alphanumeric() || b[k] == b'_');
                if k > n0 && ends {
                    out.push(text[i..k].to_string());
                    i = k;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

pub fn check(f: &CheckFacts) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();
    out.extend(decision_unapplied(f));
    out.extend(abbreviated_ids(f));
    out.extend(doc_flow_table(f));
    out.extend(glossary_backref(f));
    out.extend(hold_propagation(f));
    out.extend(field_spelling(f));
    // 同じ区間の別の文が同じ指摘を出すことがある。同じ引数は 1 つにする。
    let mut seen = BTreeSet::new();
    out.retain(|x| {
        seen.insert((
            x.code,
            x.doc.clone(),
            x.args.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        ))
    });
    out
}

/// DECISION_UNAPPLIED: 決定が名指す項目のうち書き換えてよい文書にあるものがあるのに、その項目を持つ文書の
/// どの項目にも節にも、その決定の trace（kind = decision、ref = 決定の ID）が無い。決定が本文に入っていない。
/// 表の行だけを直す決定があるので、名指した項目そのものではなく、その文書の中の trace を見る。
fn decision_unapplied(f: &CheckFacts) -> Vec<Finding> {
    let mut doc_of: BTreeMap<&str, &CheckDoc> = BTreeMap::new();
    for d in f.docs.iter().filter(|d| !d.fixed) {
        for sec in &d.sections {
            if let Some(id) = &sec.id {
                doc_of.entry(id.as_str()).or_insert(d);
            }
        }
    }
    let mut out = Vec::new();
    for dec in &f.decisions {
        let named: BTreeSet<&str> = dec
            .named
            .iter()
            .map(String::as_str)
            .filter(|id| doc_of.contains_key(id))
            .collect();
        let Some(first) = named.iter().next() else {
            continue;
        };
        let docs: BTreeSet<&str> = named.iter().map(|id| doc_of[id].key.as_str()).collect();
        let traced = f
            .docs
            .iter()
            .filter(|d| docs.contains(d.key.as_str()))
            .any(|d| {
                d.trace
                    .iter()
                    .any(|t| t.kind == "decision" && t.r#ref.as_deref() == Some(dec.id.as_str()))
            });
        if !traced {
            let items: Vec<serde_json::Value> = named.iter().map(|x| s(x)).collect();
            out.push(Finding {
                code: "DECISION_UNAPPLIED",
                doc: doc_of[first].key.clone(),
                args: vec![s(first), s(&dec.id), serde_json::Value::Array(items)],
            });
        }
    }
    out
}

/// ABBREV_ID: 既知の項目 ID の接頭辞の末尾（か接頭辞の全体）と番号をつないだ略記（例: SP-BPRUN-048 → `RUN048`・`BPRUN048`）。
/// 参照切れの検査は正しい形の ID しか見ないので、略記は素通りする。どれの略記か決まるよう、当たる ID が 1 つのときだけ出す
/// （当たるかは全ての文書の ID の集合で決まる）。
fn abbreviated_ids(f: &CheckFacts) -> Vec<Finding> {
    let mut known: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for d in &f.docs {
        for sec in &d.sections {
            for id in sec.id.iter().chain(sec.ids.iter()) {
                if let Some(num) = id.rsplit('-').next() {
                    known.entry(num.to_string()).or_default().insert(id.clone());
                }
            }
        }
    }
    let mut out = Vec::new();
    for d in f.docs.iter().filter(|d| !d.fixed) {
        for sec in &d.sections {
            for (tok, letters, num) in abbreviations(&sec.body) {
                let hits: Vec<&String> = known
                    .get(&num)
                    .map(|ids| {
                        ids.iter()
                            .filter(|id| {
                                id.split('-')
                                    .nth(1)
                                    .is_some_and(|mid| mid.ends_with(&letters))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if hits.len() == 1 {
                    out.push(Finding {
                        code: "ABBREV_ID",
                        doc: d.key.clone(),
                        args: vec![s(&sec.key), s(&tok), s(hits[0])],
                    });
                }
            }
        }
    }
    out
}

/// 大文字 2 字以上と数字 3 桁の語（前後が英数字・`-`・`_` でない）。
fn abbreviations(text: &str) -> Vec<(String, String, String)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let at_word =
            i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'-' || b[i - 1] == b'_');
        if at_word && b[i].is_ascii_uppercase() {
            let mut j = i;
            while j < b.len() && b[j].is_ascii_uppercase() {
                j += 1;
            }
            let mut k = j;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            let ends =
                k == b.len() || !(b[k].is_ascii_alphanumeric() || b[k] == b'-' || b[k] == b'_');
            if j - i >= 2 && k - j == 3 && ends {
                out.push((
                    text[i..k].to_string(),
                    text[i..j].to_string(),
                    text[j..k].to_string(),
                ));
                i = k;
                continue;
            }
            i = j.max(i + 1);
            continue;
        }
        i += 1;
    }
    out
}

/// DOC_FLOW_TABLE: trace で流れの判断を指す項目が、その判断の入力と同じ名前の条件を宣言し、値の集合が違う。
/// 流れと本文の表が同じ判断に別の値を定めている。
fn doc_flow_table(f: &CheckFacts) -> Vec<Finding> {
    let flow: BTreeMap<&str, &FlowDecision> = f.flow.iter().map(|x| (x.id.as_str(), x)).collect();
    let mut out = Vec::new();
    for d in f.docs.iter().filter(|d| !d.fixed) {
        for sec in &d.sections {
            let Some(id) = &sec.id else { continue };
            if sec.conditions.is_empty() {
                continue;
            }
            let refs: BTreeSet<&str> = d
                .trace
                .iter()
                .filter(|t| &t.item_id == id && t.kind == "flow")
                .filter_map(|t| t.r#ref.as_deref())
                .collect();
            for r in refs {
                let Some(el) = flow.get(r) else { continue };
                for input in &el.inputs {
                    for c in sec.conditions.iter().filter(|c| c.name == input.name) {
                        let a: BTreeSet<&String> = c.values.iter().collect();
                        let b: BTreeSet<&String> = input.values.iter().collect();
                        if a != b {
                            out.push(Finding {
                                code: "DOC_FLOW_TABLE",
                                doc: d.key.clone(),
                                args: vec![
                                    s(id),
                                    s(r),
                                    s(&c.name),
                                    s(&c.values.join(" / ")),
                                    s(&input.values.join(" / ")),
                                ],
                            });
                        }
                    }
                }
            }
        }
    }
    out
}

/// GLOSSARY_BACKREF: 用語表の行が「定義は SP-X」と定義の所在を示すのに、SP-X の本文にその語が無い。
/// 印の無い行（「（SP-X）」だけ）は語の出典を挙げただけのことが多いので、doc_check が渡さない。
fn glossary_backref(f: &CheckFacts) -> Vec<Finding> {
    let mut text_of: BTreeMap<&str, String> = BTreeMap::new();
    for d in &f.docs {
        for sec in &d.sections {
            if let Some(id) = &sec.id {
                text_of.entry(id.as_str()).or_default().push_str(&sec.body);
            }
        }
    }
    let squash = |t: &str| t.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let mut out = Vec::new();
    for d in f.docs.iter().filter(|d| !d.fixed) {
        for row in &d.glossary {
            if let Some(body) = text_of.get(row.target.as_str())
                && !squash(body).contains(&squash(&row.term))
            {
                out.push(Finding {
                    code: "GLOSSARY_BACKREF",
                    doc: d.key.clone(),
                    args: vec![s(&row.section), s(&row.term), s(&row.target)],
                });
            }
        }
    }
    out
}

/// HOLD_PROPAGATION（degraded）: この run で変えた項目が、保持規則の触れる項目を参照しているのに、その保持規則の ID も
/// 「裁定が下るまで」の文も持たない。保持中の論点を断定している疑い。主題の一致までは見ないので、報告に留める。
fn hold_propagation(f: &CheckFacts) -> Vec<Finding> {
    let changed: BTreeSet<&str> = f.changed.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    for d in f.docs.iter().filter(|d| !d.fixed) {
        for sec in &d.sections {
            let Some(id) = &sec.id else { continue };
            if !changed.contains(id.as_str()) || sec.body.contains("裁定が下るまで") {
                continue;
            }
            let refs: BTreeSet<&str> = sec.ids.iter().map(String::as_str).collect();
            for h in &f.holds {
                if h.item_ids.iter().any(|x| x == id) || sec.body.contains(&h.id) {
                    continue;
                }
                if let Some(held) = h.item_ids.iter().find(|x| refs.contains(x.as_str())) {
                    out.push(Finding {
                        code: "HOLD_PROPAGATION",
                        doc: d.key.clone(),
                        args: vec![s(id), s(held), s(&h.id)],
                    });
                }
            }
        }
    }
    out
}

/// FIELD_SPELLING（degraded）: コードスパンの欄に返す要素を「A・B・C の 3 項目」と日本語の名前で述べ、同じ文にキーの綴り
/// （N 個以上のコードスパンか `{` の並び）が無い。実装者がキーの名前を決められない。
fn field_spelling(f: &CheckFacts) -> Vec<Finding> {
    let mut out = Vec::new();
    for d in f.docs.iter().filter(|d| !d.fixed) {
        for sec in &d.sections {
            let Some(id) = &sec.id else { continue };
            for sentence in sec.body.split('。') {
                let spans: Vec<&str> = sentence.split('`').skip(1).step_by(2).collect();
                let Some(field) = spans.iter().find(|x| {
                    !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                }) else {
                    continue;
                };
                let Some(n) = item_count(sentence) else {
                    continue;
                };
                if spans.len() >= n || sentence.contains('{') {
                    continue;
                }
                out.push(Finding {
                    code: "FIELD_SPELLING",
                    doc: d.key.clone(),
                    args: vec![s(id), s(field), serde_json::Value::from(n)],
                });
            }
        }
    }
    out
}

/// 「A・B・C・D の 4 項目」の数。数の前の同じ文に「・」が N - 1 個以上あり、項目 ID が無いときだけ返す
/// （「SP-X の 4 項目」のように別の項目で要素を定める文や、「2 項目を含めない」のように数だけを述べる文を拾わないため）。
fn item_count(sentence: &str) -> Option<usize> {
    let kanji = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
    let digit = |c: char| -> Option<u32> {
        if c.is_ascii_digit() {
            c.to_digit(10)
        } else if ('０'..='９').contains(&c) {
            Some(c as u32 - '０' as u32)
        } else {
            None
        }
    };
    let chars: Vec<char> = sentence.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        let mut n: Option<u32> = None;
        while i < chars.len() {
            let Some(d) = digit(chars[i]) else { break };
            n = Some(n.unwrap_or(0) * 10 + d);
            i += 1;
        }
        if n.is_none() {
            if let Some(p) = kanji.iter().position(|k| *k == chars[i]) {
                n = Some(p as u32 + 1);
                i += 1;
            } else {
                i += 1;
                continue;
            }
        }
        let n = n.expect("数を読んだ") as usize;
        let rest: String = chars[i..].iter().collect();
        let rest = rest.trim_start();
        if n < 2
            || !(rest.starts_with("項目")
                || rest.starts_with("つの欄")
                || rest.starts_with("個の欄"))
        {
            continue;
        }
        let before: String = chars[..start].iter().collect();
        if before.matches('・').count() + 1 >= n && ids_in(sentence).is_empty() {
            return Some(n);
        }
    }
    None
}

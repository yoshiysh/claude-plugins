//! `core.schema.json` を正本として、実行体が使う列挙・名前付きの値・固定の文を実行時に取り出す（SP-264-003）。
//! 値を src に書き写さない。列挙の中の特定の値は `x-core.roles` の名前で引き、列挙の中の位置で引かない。

use crate::error::InputError;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// build の時に埋め込む schema（crate は repo の中でしか build しない。DD-2）。
const EMBEDDED: &str = include_str!("../../../skills/formal-method/references/core.schema.json");

/// debug の build だけで schema の path を差し替える環境変数（壊れた schema での起動を確かめるため。DD-11）。
#[cfg(debug_assertions)]
const OVERRIDE_ENV: &str = "FORMAL_METHOD_CORE_SCHEMA_OVERRIDE";

/// 実行体が引く名前付きの値（`x-core.roles` の鍵）。起動の時に全てを確かめる。
const ROLE_NAMES: [&str; 5] = [
    "relation_nonformal",
    "basis_other_part",
    "result_holds",
    "result_fails",
    "result_unknown",
];

/// 実行体が出す固定の文（`x-core.texts` の鍵）。起動の時に全てを確かめる。
const TEXT_NAMES: [&str; 2] = ["unread_non_text", "external_reference_template"];

/// schema から取り出した値。
#[derive(Debug)]
pub struct Core {
    version: String,
    enums: BTreeMap<String, Vec<String>>,
    roles: BTreeMap<String, String>,
    texts: BTreeMap<String, String>,
}

static CORE: OnceLock<Result<Core, InputError>> = OnceLock::new();

/// schema を 1 度だけ読み、版・roles・texts を確かめる。どのサブコマンドの処理よりも前に呼ぶ。
pub fn init() -> Result<&'static Core, InputError> {
    let loaded = CORE.get_or_init(load);
    loaded.as_ref().map_err(InputError::clone)
}

/// `x-core.version`。
pub fn version() -> &'static str {
    &checked().version
}

/// 名前付きの値（`x-core.roles.<name>.value`）。
pub fn role(name: &str) -> &'static str {
    lookup(&checked().roles, "x-core.roles", name)
}

/// 固定の文（`x-core.texts.<name>`）。
pub fn text(name: &str) -> &'static str {
    lookup(&checked().texts, "x-core.texts", name)
}

/// `value` が `$defs/<name>` の列挙の値であることを確かめる。
pub fn check_enum(name: &str, value: &str) -> Result<(), InputError> {
    let values = checked().enums.get(name);
    if values.is_some_and(|vs| vs.iter().any(|v| v == value)) {
        return Ok(());
    }
    let message = format!("{value} は $defs/{name} の列挙の値でない");
    Err(InputError::new(message))
}

fn checked() -> &'static Core {
    match init() {
        Ok(value) => value,
        Err(e) => panic!("schema を確かめる前に値を引いた: {e}"),
    }
}

fn lookup(map: &'static BTreeMap<String, String>, at: &str, name: &str) -> &'static str {
    match map.get(name) {
        Some(value) => value,
        None => panic!("{at}.{name} は起動の時に確かめる名前に無い"),
    }
}

fn load() -> Result<Core, InputError> {
    let text = schema_text()?;
    Core::parse(&text)
}

#[cfg(debug_assertions)]
fn schema_text() -> Result<String, InputError> {
    match std::env::var_os(OVERRIDE_ENV) {
        Some(path) => std::fs::read_to_string(path).map_err(io_error),
        None => Ok(EMBEDDED.to_string()),
    }
}

#[cfg(not(debug_assertions))]
fn schema_text() -> Result<String, InputError> {
    Ok(EMBEDDED.to_string())
}

fn schema_error(message: &str) -> InputError {
    InputError::new(format!("schema の誤り: {message}"))
}

#[cfg(debug_assertions)]
fn io_error(e: std::io::Error) -> InputError {
    schema_error(&e.to_string())
}

fn json_error(e: serde_json::Error) -> InputError {
    schema_error(&e.to_string())
}

fn string_at<'a>(node: &'a Value, key: &str, at: &str) -> Result<&'a str, InputError> {
    match node.get(key).and_then(Value::as_str) {
        Some(s) => Ok(s),
        None => {
            let message = format!("{at}.{key} が文字列でない");
            Err(schema_error(&message))
        }
    }
}

impl Core {
    fn parse(text: &str) -> Result<Self, InputError> {
        let root: Value = serde_json::from_str(text).map_err(json_error)?;
        let enums = enums_of(&root)?;
        let Some(x) = root.get("x-core") else {
            return Err(schema_error("x-core が無い"));
        };
        let version = string_at(x, "version", "x-core")?.to_string();
        if version != env!("CARGO_PKG_VERSION") {
            let message = format!("x-core.version {version} が実行体の版と違う");
            return Err(schema_error(&message));
        }
        let mut roles = BTreeMap::new();
        for name in ROLE_NAMES {
            let at = format!("x-core.roles.{name}");
            let Some(role) = x.get("roles").and_then(|r| r.get(name)) else {
                let message = format!("{at} が無い");
                return Err(schema_error(&message));
            };
            let enum_name = string_at(role, "enum", &at)?;
            let value = string_at(role, "value", &at)?;
            let values = enums.get(enum_name);
            if !values.is_some_and(|vs| vs.iter().any(|v| v == value)) {
                let message = format!("{at}.value {value} が $defs/{enum_name} の列挙に無い");
                return Err(schema_error(&message));
            }
            roles.insert(name.to_string(), value.to_string());
        }
        let mut texts = BTreeMap::new();
        for name in TEXT_NAMES {
            let node = x.get("texts").and_then(|t| t.get(name));
            let Some(t) = node.and_then(Value::as_str) else {
                let message = format!("x-core.texts.{name} が文字列でない");
                return Err(schema_error(&message));
            };
            texts.insert(name.to_string(), t.to_string());
        }
        Ok(Self {
            version,
            enums,
            roles,
            texts,
        })
    }
}

/// `$defs` のうち `enum` を持つ型の名前と値（値は全て文字列）。
fn enums_of(root: &Value) -> Result<BTreeMap<String, Vec<String>>, InputError> {
    let Some(defs) = root.get("$defs").and_then(Value::as_object) else {
        return Err(schema_error("$defs が無い"));
    };
    let mut enums = BTreeMap::new();
    for (name, def) in defs {
        let Some(values) = def.get("enum").and_then(Value::as_array) else {
            continue;
        };
        let mut strings = Vec::with_capacity(values.len());
        for v in values {
            let Some(s) = v.as_str() else {
                let message = format!("$defs/{name} の列挙に文字列でない値");
                return Err(schema_error(&message));
            };
            strings.push(s.to_string());
        }
        enums.insert(name.clone(), strings);
    }
    Ok(enums)
}

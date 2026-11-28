//! formal-method-core: formal-method の CLI が渡す事実から、担当に書かせない値を決定的に導く（#264）。
//! サブコマンドは入力の JSON（`$defs/<Subcommand>Input`）を読み、1 行の JSON（`$defs/<Subcommand>Output`）を返す。
//! 型は `core.schema.json` が正本で、同じ入力からはバイト列として同じ出力を返す（SP-264-005）。

pub mod error;
pub mod order;
pub mod schema;
pub mod types;

mod complete_return;
mod extract_skeleton;
mod mapping_rows;
mod omission_candidates;
mod partition_assemble;
mod partition_models;
mod plan_skeleton;
mod review_tally;

use error::InputError;
use serde_json::Value;

/// サブコマンドの名前（SP-264-005）。
pub const SUBCOMMANDS: [&str; 8] = [
    "partition-models",
    "plan-skeleton",
    "partition-assemble",
    "mapping-rows",
    "extract-skeleton",
    "omission-candidates",
    "review-tally",
    "complete-return",
];

type Handler = fn(Value) -> Result<Value, InputError>;

/// サブコマンドを入力の JSON の本文に当て、出力の JSON の 1 行（改行を含まない）を返す。
/// schema の検証（`schema::init`）を先に済ませる。
pub fn dispatch(subcommand: &str, input: &str) -> Result<String, InputError> {
    schema::init()?;
    let run = handler(subcommand)?;
    let value: Value = serde_json::from_str(input).map_err(not_json)?;
    let output = run(value)?;
    serde_json::to_string(&output).map_err(unserializable)
}

fn handler(subcommand: &str) -> Result<Handler, InputError> {
    let run: Handler = match subcommand {
        "partition-models" => partition_models::run,
        "plan-skeleton" => plan_skeleton::run,
        "partition-assemble" => partition_assemble::run,
        "mapping-rows" => mapping_rows::run,
        "extract-skeleton" => extract_skeleton::run,
        "omission-candidates" => omission_candidates::run,
        "review-tally" => review_tally::run,
        "complete-return" => complete_return::run,
        _ => return Err(unknown_subcommand(subcommand)),
    };
    Ok(run)
}

fn unknown_subcommand(subcommand: &str) -> InputError {
    InputError::new(format!("未知のサブコマンド: {subcommand}"))
}

fn not_json(e: serde_json::Error) -> InputError {
    InputError::new(format!("入力が JSON でない: {e}"))
}

fn unserializable(e: serde_json::Error) -> InputError {
    InputError::new(format!("出力を JSON にできない: {e}"))
}

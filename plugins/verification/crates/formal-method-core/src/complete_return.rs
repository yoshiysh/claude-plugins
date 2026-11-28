//! `complete-return`: 作業記録と返り値の文脈の値（SP-264-029）。
//! 文脈の欄を task の値で入れる。下書きにその欄があり値が違えば、欄の名前を `problems` に載せる。
//! 役は task の値で見分ける: `perspective` が null でなければ確認役、`unit_id` が null でなければ
//! 原因の分類役（`unit_id` を持ち `perspective` を持たない）、他は作成役。

use crate::error::InputError;
use crate::schema;
use crate::types::{self, CompleteReturnInput, CompleteReturnOutput};
use serde_json::{Map, Value};

/// 作業記録の `schema` の値。
const WORKLOG_SCHEMA: &str = "formal-method.worklog/1";
/// task の `stage` が属する列挙（`$defs` の名前）。
const STAGE_ENUM: &str = "Stage";

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: CompleteReturnInput = types::parse(input)?;
    let task = &input.task;
    schema::check_enum(STAGE_ENUM, &task.stage)?;
    let mut problems = Vec::new();
    let mut worklog = input.worklog;
    let worklog_fields = [
        ("schema", WORKLOG_SCHEMA),
        ("role", task.role.as_str()),
        ("task_id", task.task_id.as_str()),
        ("stage", task.stage.as_str()),
        ("target", task.target.as_str()),
    ];
    for (name, value) in worklog_fields {
        fill(&mut worklog, name, value, &mut problems);
    }
    let mut ret = input.ret;
    fill(&mut ret, "task_id", &task.task_id, &mut problems);
    if let Some(unit_id) = &task.unit_id {
        fill(&mut ret, "unit_id", unit_id, &mut problems);
    }
    if let Some(perspective) = &task.perspective {
        fill(&mut ret, "perspective", perspective, &mut problems);
    }
    let output = CompleteReturnOutput {
        worklog,
        ret,
        problems,
    };
    types::output(&output)
}

/// 欄を task の値にする。下書きに違う値があれば欄の名前を控える（同じ名前は 1 度だけ）。
fn fill(draft: &mut Map<String, Value>, name: &str, value: &str, problems: &mut Vec<String>) {
    let want = Value::String(value.to_string());
    if draft.get(name).is_some_and(|v| *v != want) && !problems.iter().any(|p| p == name) {
        problems.push(name.to_string());
    }
    draft.insert(name.to_string(), want);
}

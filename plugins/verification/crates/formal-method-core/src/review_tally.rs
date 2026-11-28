//! `review-tally`: 確認役の項目ごとの記録から `result` を決める（SP-264-028）。
//! 指摘が 1 つ以上なら成り立たない、項目が 1 つ以上で全てが成り立つなら成り立つ、他は確認できず。
//! 値は `x-core.roles` の名前で引く。

use crate::error::InputError;
use crate::schema;
use crate::types::{self, ReviewTallyInput, ReviewTallyOutput};
use serde_json::Value;

/// 項目の `result` が属する列挙（`$defs` の名前）。
const ITEM_RESULT_ENUM: &str = "ConfirmationResult";

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: ReviewTallyInput = types::parse(input)?;
    for item in &input.items {
        schema::check_enum(ITEM_RESULT_ENUM, &item.result)?;
    }
    let holds = schema::role("result_holds");
    let result = if !input.findings.is_empty() {
        schema::role("result_fails")
    } else if !input.items.is_empty() && input.items.iter().all(|i| i.result == holds) {
        holds
    } else {
        schema::role("result_unknown")
    };
    let output = ReviewTallyOutput {
        result: result.to_string(),
    };
    types::output(&output)
}

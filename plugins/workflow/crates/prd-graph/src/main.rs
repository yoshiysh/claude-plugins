//! `prd-graph impact`: 標準入力の事実（JSON）から影響の範囲を求め、標準出力に 1 行の JSON で返す。
//! `prd-graph check`: 標準入力の事実（区間の本文と台帳）から優先度 1 の静的な検査の指摘を求め、`{"findings": [...]}` で返す。
//! 入力が読めなければ理由を標準エラーに出して exit 2 で終わる（推定で補わない）。

use std::io::{self, Read, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [cmd] if cmd == "impact" => run(|input| {
            serde_json::from_str::<prd_graph::Facts>(input)
                .map(|f| serde_json::to_string(&prd_graph::impact(&f)))
        }),
        [cmd] if cmd == "check" => run(|input| {
            serde_json::from_str::<prd_graph::checks::CheckFacts>(input).map(|f| {
                serde_json::to_string(
                    &serde_json::json!({ "findings": prd_graph::checks::check(&f) }),
                )
            })
        }),
        _ => {
            eprintln!("usage: prd-graph impact|check < facts.json");
            ExitCode::from(2)
        }
    }
}

fn run<F>(f: F) -> ExitCode
where
    F: FnOnce(&str) -> Result<serde_json::Result<String>, serde_json::Error>,
{
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("prd-graph: 標準入力を読めません: {e}");
        return ExitCode::from(2);
    }
    let line = match f(&input) {
        Ok(Ok(line)) => line,
        Ok(Err(e)) | Err(e) => {
            eprintln!("prd-graph: 事実の JSON の形が違います: {e}");
            return ExitCode::from(2);
        }
    };
    let mut stdout = io::stdout().lock();
    if writeln!(stdout, "{line}").is_err() {
        return ExitCode::from(2);
    }
    ExitCode::SUCCESS
}

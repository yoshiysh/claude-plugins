//! `prd-graph impact`: 標準入力の事実（JSON）から影響の範囲を求め、標準出力に 1 行の JSON で返す。
//! 入力が読めなければ理由を標準エラーに出して exit 2 で終わる（推定で補わない）。

use std::io::{self, Read, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [cmd] if cmd == "impact" => run_impact(),
        _ => {
            eprintln!("usage: prd-graph impact < facts.json");
            ExitCode::from(2)
        }
    }
}

fn run_impact() -> ExitCode {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("prd-graph: 標準入力を読めません: {e}");
        return ExitCode::from(2);
    }
    let facts: prd_graph::Facts = match serde_json::from_str(&input) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("prd-graph: 事実の JSON の形が違います: {e}");
            return ExitCode::from(2);
        }
    };
    let out = prd_graph::impact(&facts);
    let line = serde_json::to_string(&out).expect("Impact は常に JSON にできる");
    let mut stdout = io::stdout().lock();
    if writeln!(stdout, "{line}").is_err() {
        return ExitCode::from(2);
    }
    ExitCode::SUCCESS
}

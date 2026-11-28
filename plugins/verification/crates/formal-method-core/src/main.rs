//! 実行体の入口。`--version` か 1 つのサブコマンドを受ける。
//! サブコマンドは標準入力の JSON を読み、標準出力に 1 行の JSON を出して exit 0 で終わる。
//! 入力の誤りは理由を標準エラーに 1 行で出し、標準出力に何も出さず exit 2 で終わる（SP-264-005）。

use formal_method_core::error::InputError;
use formal_method_core::{SUBCOMMANDS, dispatch, schema};
use std::io::{Read, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(line) => write_line(&line),
        Err(e) => {
            eprintln!("{}", e.line());
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<String, InputError> {
    // 名前付きの値が列挙と食い違う schema では、何を出すよりも前に止まる（SP-264-003）
    schema::init()?;
    match args {
        [flag] if flag == "--version" => Ok(version_line()),
        [subcommand] if SUBCOMMANDS.contains(&subcommand.as_str()) => {
            let input = read_stdin()?;
            dispatch(subcommand, &input)
        }
        _ => Err(usage()),
    }
}

/// `<実行体の名前> <版>`。版は Cargo.toml の version で、schema の `x-core.version` と同じ。
fn version_line() -> String {
    format!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
}

fn read_stdin() -> Result<String, InputError> {
    let mut text = String::new();
    match std::io::stdin().read_to_string(&mut text) {
        Ok(_) => Ok(text),
        Err(e) => Err(InputError::new(format!("標準入力を読めない: {e}"))),
    }
}

fn usage() -> InputError {
    let names = SUBCOMMANDS.join("・");
    let message = format!("引数は --version か 1 つのサブコマンド（{names}）");
    InputError::new(message)
}

fn write_line(line: &str) -> ExitCode {
    let mut stdout = std::io::stdout().lock();
    let written = writeln!(stdout, "{line}").and_then(|()| stdout.flush());
    match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("標準出力に書けない: {e}");
            ExitCode::FAILURE
        }
    }
}

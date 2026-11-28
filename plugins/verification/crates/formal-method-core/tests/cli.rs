//! SP-264-005: サブコマンドの呼び方。入力の誤りは exit 2 で、標準出力に何も出さない（DD-10）。
//! 同じ入力で同じ出力になることは、各サブコマンドのテストで確かめる。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{SUBCOMMANDS, assert_input_error, run};

#[test]
fn broken_json_is_rejected_by_every_subcommand() {
    // 推定で補わず、CLI の欠陥として止めるため（spec §3）
    for sub in SUBCOMMANDS {
        assert_input_error(sub, "{");
        assert_input_error(sub, "");
    }
}

#[test]
fn input_of_wrong_type_is_rejected_by_every_subcommand() {
    // 型に合わない入力を既定値で埋めると、骨組みが黙って欠ける
    for sub in SUBCOMMANDS {
        assert_input_error(sub, "[]");
        assert_input_error(sub, "\"x\"");
        assert_input_error(sub, "{\"unknown_field\":1}");
    }
}

#[test]
fn unknown_subcommand_exits_2() {
    // 未知のサブコマンドを黙って通すと、CLI の呼び間違いを見逃す
    let out = run(&["no-such-subcommand"], "{}");
    assert_eq!(out.code, Some(2));
    assert_eq!(out.stdout, "");
    assert!(!out.stderr.trim().is_empty());
}

#[test]
fn missing_subcommand_exits_2() {
    // 引数の無い起動も誤りとして扱う
    let out = run(&[], "{}");
    assert_eq!(out.code, Some(2));
    assert_eq!(out.stdout, "");
}

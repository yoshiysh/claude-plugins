//! 入力の誤り。main は理由を標準エラーに 1 行で出し、exit 2 で終わる（SP-264-005）。

use std::fmt;

/// 入力が JSON でない・型に合わない・サブコマンドが定める誤りに当たる、のどれか。
/// schema の誤り（起動の時の検証）もこの型で返す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputError(String);

impl InputError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    /// 規則をまだ持たないサブコマンド（後の単位で実装する）。
    pub fn not_implemented(subcommand: &str) -> Self {
        Self(format!("{subcommand} の規則はまだ実装していない"))
    }

    /// 標準エラーに出す 1 行（改行を空白に替える）。
    pub fn line(&self) -> String {
        self.0.replace(['\r', '\n'], " ")
    }
}

impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InputError {}

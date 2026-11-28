//! id の並べ方と指紋。
//! id は UTF-8 のバイト列の辞書順で比べる（CLI の `cmpBytes` と同じ。SP-264-005）。

use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fmt::Write;

/// 2 つの id を UTF-8 のバイト列の辞書順で比べる（`str` の `Ord` と同じ順）。
pub fn cmp_ids(a: &str, b: &str) -> Ordering {
    a.as_bytes().cmp(b.as_bytes())
}

/// バイト列の SHA-256 を、小文字の 16 進 64 文字で返す。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for b in digest.iter() {
        // String への書き込みは失敗しない
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

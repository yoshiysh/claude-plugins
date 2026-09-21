import re

_JA = "　-〿぀-ヿ㐀-鿿＀-￯"
_BOUNDARY = re.compile(rf"(?<=[!-~])\s*(?=[{_JA}])|(?<=[{_JA}])\s*(?=[!-~])")


def prose_pattern(phrase: str) -> re.Pattern:
    """文書の表現を照合する正規表現。ASCII と日本語の境目の空白の有無だけを許容し、語は全て必須のまま残す。"""
    return re.compile(r"\s*".join(re.escape(part) for part in _BOUNDARY.split(phrase)))

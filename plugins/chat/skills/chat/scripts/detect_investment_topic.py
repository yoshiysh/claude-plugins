#!/usr/bin/env python3
"""投資トピック判定（軽量キーワード分類、LLM 不使用）。

chat スキルの investment-topic-router agent から呼ばれる。`/chat <text>` の相談が
「投資判断の相談」か「金融コードベースの純技術質問」かを決定的に分類する。前者なら
agent が investment-strategist に委譲し、後者なら壁打ちパイプライン（prompt-compiler 以降）
へ進む。

Why 決定的 script:
  投資トピックかどうかの分類は、キーワードの共起パターンで機械的に決まる。
  LLM 判断は不要（Determinism Split）。実際の規制判定（売買命令拒否等）は
  investment-strategist 側が担うため、ここは軽量分類のみに徹する
  （banned-phrases.json のような重量級ルールブックは持たない）。

分類の難しさ:
  "DCF" / "ticker" / "株価" のような語は、投資相談（「DCF で見たい」）と
  技術質問（「DCF 計算関数の Decimal 型変換」）の両方に出る。有無だけでは
  判定できないため、3 層で判定する。

  (a) INTENT_KEYWORDS   : 投資意図が明確な語（買い時 / 組み入れ / 目標株価 等）。
                          単独で強い positive シグナル。
  (b) CODE_SUPPRESSORS  : コード/型システム文脈の語（Decimal / mypy / pandera 等）。
                          曖昧語を「技術質問」側に打ち消す。
  (c) AMBIGUOUS_DOMAIN  : 金融ドメイン語（DCF / ticker / 株価 等）。単独では決めない。

判定ルール:
  - INTENT_KEYWORDS が「否定されずに」ヒット → 投資トピック（true）。
    投資意図語は「買え」等の命令ではなく相談意図の表明であり、
    technical suppressor があっても投資相談として委譲するのが安全側
    （investment-strategist が改めて売買命令をガードする）。
  - INTENT なし・AMBIGUOUS のみ・CODE_SUPPRESSORS あり → 非投資（false）。
    「DCF 計算関数」「ticker の TID251」等はコードの話。
  - INTENT なし・AMBIGUOUS のみ・CODE_SUPPRESSORS なし → 非投資（false）。
    ドメイン語だけでは投資相談とみなさない（false positive を避ける）。
    真に投資したい相談は必ず INTENT 語を伴うという前提。

否定文脈の扱い:
  「投資判断とは無関係」「投資判断は聞いていない」のように INTENT_KEYWORDS の
  直後に否定が続く場合、そのマッチのみ無効化する（(d) NEGATION_MARKERS を参照）。
  無効化は文全体でも節全体でもなく「マッチしたキーワードの直後」単位で行う —
  同じ文・同じ節内の別の生きた intent まで巻き込むと、句読点を挟まない
  「投資判断じゃなくて NVDA 買い時？」のような相談まで false にしてしまうため。
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# (a) 投資意図が明確な語。単独で投資トピック確定。
# Why: これらは「相場の是非を問う／PF をどう扱うか」という投資判断意図の表明で、
#      コード文脈で自然に出ることがほぼない。
INTENT_KEYWORDS: tuple[str, ...] = (
    "買い時",
    "売り時",
    "買うべき",
    "売るべき",
    "仕込み時",
    "利確",
    "損切り",
    "組み入れ",
    "組入",
    "組み替え",
    "リバランス",
    "目標株価",
    "target price",
    "銘柄評価",
    "投資判断",
    "割安",
    "割高",
    "上がる",
    "下がる",
    "買い増し",
    "エントリー",
    "ポートフォリオの相談",
    "このpfを評価して",
    "この pf を評価して",
    "ポートフォリオを評価して",
    "このpfを分析して",
    "この pf を分析して",
    "ポートフォリオを分析して",
    "pfについて分析",
    "pf について分析",
    "ポートフォリオについて分析",
    "投資戦略",
    "ポートフォリオ戦略",
    "セクターローテーション",
    "次のセクター",
    "pf を見て",
    "pf をみて",
    "ポートフォリオを見て",
    "保有比率",
    "何を買え",
    "どれを買え",
    "買った方がいい",
    "売った方がいい",
    "投資妙味",
    "旬",
    "セクター旬",
    "テーマ株",
)

# (b) コード/型システム文脈の suppressor。曖昧語を打ち消す。
# Why: 金融「ドメイン」の実装（DCF 計算関数・ticker 文字列処理・Decimal 変換）は
#      コードチェックの対象で、投資相談ではない。汎用語（「検証」「テスト」等）は
#      入れない — 別の投資相談を誤って抑制するリスクがあるため。
CODE_SUPPRESSORS: tuple[str, ...] = (
    "decimal",
    "型変換",
    "型ヒント",
    "型安全",
    "pandera",
    "mypy",
    "tid251",
    "関数",
    "メソッド",
    "クラス",
    "リファクタ",
    "計算関数",
    "バリデーション",
    "スキーマ",
    "schema",
    "実装",
    "コード",
    "ロジック",
    "エラー",
    "例外",
    "テストケース",
    "パース",
    "変換処理",
    "float",
    "dataclass",
    "protocol",
)

# (c) 金融ドメイン語。単独では判定しない（INTENT or SUPPRESSOR と組み合わせて解釈）。
# Why: DCF / ticker / 株価 は投資相談にもコード質問にも出る二義的な語。
AMBIGUOUS_DOMAIN: tuple[str, ...] = (
    "dcf",
    "ticker",
    "株価",
    "銘柄",
    "配当",
    "モメンタム",
    "screening",
    "スクリーニング",
    "バリュエーション",
    "ポートフォリオ",
    "pf",
    "利回り",
)

# (d) 否定マーカー。INTENT_KEYWORDS の直後にこれらが続く場合、
#     そのマッチは「投資意図の表明」ではなく「言及の否定」とみなし無効化する。
# Why: 日本語の否定は対象語の後ろに置かれる後置構造のため
#      （「投資判断とは無関係」「投資判断は聞いていない」）、キーワードより後ろに
#      続くかどうかで判定する。
# Why "以外" / "関係ない" を含めない: 「半導体以外で買い時の銘柄は？」のような
#      一般的なスクリーニング表現で "以外" が頻出し、生きた intent（買い時）を
#      誤って抑制してしまう。"無関係" があれば「〜とは無関係」は既にカバーできるため、
#      過剰抑制のリスクがある語は含めない。
NEGATION_MARKERS: tuple[str, ...] = (
    "無関係",
    "ではない",
    "じゃない",
    "ではなく",
    "じゃなくて",
    "聞いていない",
    "とは違う",
)

# 節分割用パターン。日本語/ASCII の主要な句読点で否定のスコープを区切る。
_CLAUSE_SPLIT_PATTERN = re.compile(r"[、。！？,.!?]")


def _find_matches(text_lower: str, keywords: tuple[str, ...]) -> list[str]:
    """text_lower に含まれるキーワードを返す。日本語は部分一致、ASCII 語は語境界一致。

    Why 語境界: "pf" が "perform" に、"float" が別語に埋もれて誤ヒットするのを防ぐ。
    日本語は分かち書きがないため部分一致で拾う。
    """
    matched: list[str] = []
    for kw in keywords:
        if kw.isascii() and re.fullmatch(r"[a-z0-9 ]+", kw):
            # ASCII 語は語境界で照合（誤部分一致を防ぐ）
            if re.search(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", text_lower):
                matched.append(kw)
        elif kw in text_lower:
            matched.append(kw)
    return matched


def _is_negated_after(clause: str, keyword: str) -> bool:
    """clause 内の keyword の全出現について、直後に否定マーカーが続くか判定する。

    Why 位置ベース: キーワードより前にある否定マーカーには反応しない。
    節単位で一括抑制すると、句読点を挟まない同一節内の別の生きた intent
    まで誤って消してしまう（「投資判断じゃなくて NVDA 買い時？」で
    "買い時" まで消えては困る）。

    Why 全出現走査: 同じ keyword が同一節内に複数回現れる場合、最初の出現だけを
    見ると、最初は否定されていても後続の出現が生きているケース（「投資判断は
    無関係だし投資判断をお願いします」）まで一律に否定扱いにしてしまう。
    いずれかの出現が否定されて
    いなければ、その keyword は生きているとみなす。
    """
    start = 0
    found_any = False
    while True:
        idx = clause.find(keyword, start)
        if idx < 0:
            break
        found_any = True
        tail = clause[idx + len(keyword) :]
        if not _find_matches(tail, NEGATION_MARKERS):
            return False
        start = idx + len(keyword)
    return found_any


def _find_live_intent_matches(text_lower: str) -> list[str]:
    """否定されていない INTENT_KEYWORDS マッチのみを返す。

    句読点区切りの節ごとに intent を探し、各マッチの直後（同一節内の
    残り部分）に否定マーカーが続く場合のみそのマッチを捨てる。同じ節・同じ文の
    他の intent は、それぞれ自分の直後だけを見て独立に判定する。

    Why 事前絞り込み: テキスト全体に対して先に INTENT_KEYWORDS（90語）を
    1 回だけ照合し、以降は節ごとのループでその絞り込み済みキーワード（通常
    0〜数語）だけを見る。事前絞り込みなしだと節数 N に対して N * 90 回の
    照合が走るが、テキスト全体に出現しないキーワードは当然どの節にも
    出現しないため、先に絞ることで無駄な照合を削れる。
    """
    matched_intents = _find_matches(text_lower, INTENT_KEYWORDS)
    if not matched_intents:
        return []

    live: list[str] = []
    for clause in _CLAUSE_SPLIT_PATTERN.split(text_lower):
        if not clause:
            continue
        for kw in _find_matches(clause, tuple(matched_intents)):
            if not _is_negated_after(clause, kw):
                live.append(kw)
    return live


# CommonMark の fenced code block は backtick / tilde とも 3 文字以上の任意長を許す。
# 開始と同じ記号・同じ長さで閉じる対応を後方参照で強制する（``` を ~~~ で閉じる
# cross-match や、```` ブロック内のネストした ``` を誤って終端扱いする過剰除去を防ぐ）。
_FENCE_PATTERN = re.compile(r"(`{3,}|~{3,}).*?\1", re.DOTALL)

# diff の存在を高確度で示す行（unified diff 形式に固有で、Markdown の箇条書き等とは
# 混同しない）。この行が1つでもあれば、貼り付けられた内容は実際の diff だと判断できる。
_DIFF_MARKER_PATTERN = re.compile(
    r"^diff --git |^@@ .*@@|^index [0-9a-f]{7,}", re.MULTILINE
)

# diff 内の追加/削除行・ヘッダ行を除去するためのパターン。
# Why `[+-]{1,3}(?!-)` を無条件では使わないか: この形は Markdown の箇条書き
# （`- 項目1`）にも一致してしまい、地の文で書かれた投資相談の箇条書きを誤って
# 除去してしまうバグが実測で確認された（`_DIFF_MARKER_PATTERN` が見つかった場合に
# 限定して適用することで回避する）。
_DIFF_LINE_PATTERN = re.compile(
    r"^(diff --git |@@ .*@@|index [0-9a-f]{7,}|\+\+\+ |--- |[+-]{1,3}(?!-)).*$",
    re.MULTILINE,
)


def _strip_code_and_diff(text: str) -> str:
    """相談文から fenced code block と diff 行を除いた、prose 部分のみを返す。

    Why: 相談文にコード片や diff が貼られている場合、その中身（例えば
    `src/domain/strategies.py` の "割安"/"目標株価" といった識別子・コメント）に
    INTENT_KEYWORDS が偶然一致し、コードレビュー依頼を投資トピックと誤判定することが
    実測で確認されている。分類は prose（相談者が実際に書いた地の文）のみに対して行う
    べきで、引用・貼り付けられた中身は対象外にする。

    ただし `+`/`-` 行の除去は、`_DIFF_MARKER_PATTERN`（`diff --git` / `@@ ... @@` /
    `index <hash>`）が本文中に実在する場合のみ行う。この確認をせずに `+`/`-` 行を
    一律除去すると、投資相談を箇条書き（`- NVDA の買い時を教えてほしい`）で書いた
    ユーザーの地の文まで削ってしまい、投資トピックが非投資と誤判定される
    （今回の修正が対処した誤りと鏡像の回帰）ことが実測で確認されたため。
    """
    without_fences = _FENCE_PATTERN.sub("", text)
    if not _DIFF_MARKER_PATTERN.search(without_fences):
        return without_fences
    lines = without_fences.splitlines()
    prose_lines = [line for line in lines if not _DIFF_LINE_PATTERN.match(line)]
    return "\n".join(prose_lines)


def detect_investment_topic(text: str) -> dict[str, bool | list[str]]:
    """相談文が投資トピックかを判定する。

    戻り値: {"is_investment_topic": bool, "matched_keywords": list[str]}
    """
    text_lower = _strip_code_and_diff(text).lower()

    intent = _find_live_intent_matches(text_lower)
    suppressors = _find_matches(text_lower, CODE_SUPPRESSORS)
    ambiguous = _find_matches(text_lower, AMBIGUOUS_DOMAIN)

    # ルール1: 否定されていない投資意図語があれば確定で投資トピック。
    if intent:
        return {"is_investment_topic": True, "matched_keywords": intent + ambiguous}

    # ルール2: intent なし。ambiguous 語があっても suppressor が優勢なら技術質問。
    # ルール3: intent なし・ambiguous のみ（suppressor なし）でも、
    #          ドメイン語だけでは投資相談と断定しない → 非投資。
    return {"is_investment_topic": False, "matched_keywords": suppressors}


def main() -> int:
    parser = argparse.ArgumentParser(description="投資トピック判定（軽量分類）")
    parser.add_argument("--text", required=True, help="相談文（自然文）")
    args = parser.parse_args()

    result = detect_investment_topic(args.text)
    print(json.dumps(result, ensure_ascii=False))
    return 0


# 自己テスト: 仕様の named ケースを検証する。
# Why: この分類が仕様どおりでなければスキル全体が誤動作するため、
#      `python detect_investment_topic.py --selftest` で回帰確認できるようにする。
_SELFTEST_CASES: tuple[tuple[str, bool], ...] = (
    ("この銘柄そろそろ買い時？", True),
    ("NVDA を DCF と旬で評価してほしい", True),
    ("半導体セクターの旬について組み入れの観点で相談したい", True),
    ("ポートフォリオを見てほしい、保有比率のバランスはどう？", True),
    ("このPFを評価して次のセクターを考えて", True),
    ("ポートフォリオについて分析し、今後の投資戦略を考えて", True),
    ("DCF 計算関数の Decimal 型変換が正しいか見てほしい", False),
    ("pandera でこのデータフレームの検証スキーマは妥当？", False),
    ("ticker の TID251 回避のための replace 実装をレビューして", False),
    ("この認証まわりのロジックにセキュリティ懸念ある？", False),
    ("株価データをパースする変換処理の型ヒントを確認したい", False),
    # 否定文脈: INTENT_KEYWORDS の直後に否定が続くため非投資と判定すべき。
    ("この質問は投資判断とは無関係です。コードのレビューをお願いします", False),
    ("投資判断は聞いていない、リファクタの相談です", False),
    # 過補正ガード（句読点あり）: 否定された intent と生きた intent が同じ文に
    # 混在する場合、生きた intent 側を拾って投資トピックのままになるべき。
    ("投資判断じゃなくて雑談だけど、NVDA 買った方がいい？", True),
    ("割高かは別として、この銘柄買い時？", True),
    # 過補正ガード（句読点なし・同一節内）: 位置ベースの否定判定でないと、
    # 節単位の判定では生きた intent（買い時）まで巻き込んで false にしてしまう。
    ("投資判断じゃなくてNVDA買い時？", True),
    # 過補正ガード: "以外" は一般的なスクリーニング表現に頻出するため
    # 否定マーカーに含めない。含めると生きた intent（買い時）を誤って抑制する。
    ("半導体以外で買い時の銘柄は？", True),
    # 既知のヒューリスティック限界: 句読点なしの節内に生きた intent と
    # 否定された intent が両方あると、tail が節末までのため後者の否定マーカーが
    # 前者まで巻き込み false になる。false-negative（安全側 = 技術壁打ちへ流れる）
    # のため許容し、tail を次の intent キーワード位置で区切る改修は見送っている。
    ("買い時か知りたい投資判断ではないけど", False),
    # 回帰: 同一節内に同じ INTENT_KEYWORDS が複数回現れ、最初の出現だけが
    # 否定されているケース。find() で最初の出現しか見ないと、後続の生きた
    # 出現まで一律に否定扱いにしてしまっていた（gemini-code-assist レビュー
    # 指摘, PR #858）。いずれかの出現が生きていれば True になるべき。
    ("買い時ではない銘柄と買い時の銘柄を教えて", True),
    (
        "この diff をレビューしてください。\n"
        "```diff\n"
        "+ if is_undervalued:\n"
        "+     return '割安なので目標株価に近い'\n"
        "```\n"
        "変更後の型ヒントに問題ないか確認したい。",
        False,
    ),
    # ~~~ フェンス（CommonMark で ``` と等価）。``` のみ対応だと ~~~ 内のコード片の
    # 投資語彙が prose として残り過剰委譲する。
    (
        "この関数をレビューして。\n"
        "~~~python\n"
        "def check():\n"
        "    return '割安なので目標株価に近い'\n"
        "~~~\n"
        "型ヒントは正しい？",
        False,
    ),
    # ``` と ~~~ の混在。同一デリミタ対応（後方参照）でないと ``` 開始を ~~~ で
    # 閉じてしまい、間の地の文（投資相談）まで除去して fail-open に反転する。
    (
        "```python\nx = 1\n```\n"
        "NVDA の買い時を教えてほしい。\n"
        "~~~python\ny = 2\n~~~",
        True,
    ),
    # 4 backtick フェンス内にネストした ``` （CommonMark の Markdown 引用イディオム）。
    # 長さ固定の regex だと内側の ``` を終端と誤認し、コード片の投資語彙が prose に
    # 露出して過剰委譲する。
    (
        "この Markdown 生成コードをレビューして。\n"
        "````\n"
        "```python\n"
        "print('割安なので目標株価に近い')\n"
        "```\n"
        "````\n"
        "エスケープは正しい？",
        False,
    ),
    (
        # 箇条書きで書かれた投資相談。diff マーカーが無いため `+`/`-` 行除去は
        # 発火せず、地の文として正しく投資トピック判定される必要がある
        # （Fable のレビューで見つかった回帰: 以前は `- ` で始まる行を
        # 無条件で diff 扱いし除去してしまい、箇条書きの投資相談が誤って
        # 非投資と判定されていた）。
        "- NVDA の買い時を教えてほしい\n- 半導体の組み入れ比率も相談したい",
        True,
    ),
    (
        # fence なしで直接貼られた本物の diff（diff --git ヘッダあり）。
        # diff 内のコメントに「割安」があっても、prose（地の文）は技術的な
        # 質問なので非投資と判定されるべき。
        "この変更のレビューをお願いします。\n"
        "diff --git a/src/domain/strategies.py b/src/domain/strategies.py\n"
        "index 1234567..89abcde 100644\n"
        "--- a/src/domain/strategies.py\n"
        "+++ b/src/domain/strategies.py\n"
        "@@ -10,3 +10,3 @@\n"
        "-    return None  # 割安判定は別モジュールへ移譲\n"
        "+    return compute_valuation_flag()  # 目標株価計算と統合\n"
        "型ヒントの整合性だけ確認したいです。",
        False,
    ),
)


def _run_selftest() -> int:
    failures: list[str] = []
    for text, expected in _SELFTEST_CASES:
        got = bool(detect_investment_topic(text)["is_investment_topic"])
        status = "OK" if got == expected else "FAIL"
        if got != expected:
            failures.append(f"{status}: expected={expected} got={got} :: {text}")
        print(f"{status}: {text} -> {got}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("all selftest cases passed")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_run_selftest())
    raise SystemExit(main())

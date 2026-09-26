#!/usr/bin/env python3
"""pdca の状態を run-dir に持ち、どの呼び出しを受けるかを決める。

ledger.jsonl を書くのはこの script だけ。agent が書くのは、goal.json（goal-framer）、scope.json と
design.json（criteria-author）、out/<brief_id>.json（各 agent）だけ。司令塔は何も書かない。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]

BRIEF_KEYS = {"goal-framer": {"aspect"}, "criteria-author": {"aspect"}, "criteria-verifier": {"aspect"},
              "writer": {"conditions"}, "verifier": {"viewpoint", "mode"}, "completion-judge": {"report_sha256"}}
ROLES = tuple(BRIEF_KEYS)
AUTHORS = ("goal-framer", "criteria-author")
DOCUMENT_READERS = ("goal-framer", "criteria-author", "criteria-verifier", "verifier")
ASPECTS = ("goal", "scope", "design")
DOCS = {"goal": "goal.json", "scope": "scope.json", "design": "design.json"}
NAMES = {"goal": "ゴールの文書", "scope": "範囲の文書", "design": "測定の文書"}
AUTHOR_OF = {"goal": "goal-framer", "scope": "criteria-author", "design": "criteria-author"}
LAYERS = ("ゴール", "範囲の導出", "設計", "実装")
LAYER_OF = {"goal": "ゴール", "scope": "範囲の導出", "design": "設計"}
REVIEW_LAYERS = {"goal": ("ゴール",), "scope": ("ゴール", "範囲の導出"), "design": ("ゴール", "範囲の導出", "設計")}
ASK_LAYERS = ("ゴール", "範囲の導出")
BOUNDARY = "B"
STAGES = "S"
BOUNDARY_RULE = ("boundary.roots の外（他のリポジトリ・ホームの設定・認証情報を含む）を読まない。外が要ると判断したら、"
                 "読まずに指摘か問いにする。人間が境界を広げるまで、外は範囲に無い")
ANSWER_SOURCE = "answer:"
SEVERITIES = ("blocking", "non_blocking")
MEANS_KINDS = ("audit", "script", "test", "command")
CONTROLLED_MEANS = ("script", "test", "command")
PASS_OPS = (">=", "<=", "==")
VERIFY_STATUSES = ("pass", "fail", "not_done")
TEXT = ("空でない文字列", lambda v: isinstance(v, str) and bool(v.strip()))
PATH = ("空でない文字列", lambda v: isinstance(v, str) and v != "")
FLAG = ("真偽値", lambda v: isinstance(v, bool))
ANY = ("任意の値", lambda v: True)


def natural(least: int) -> tuple:
    return (f"{least} 以上の整数", lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= least)


def one_of(values: tuple) -> tuple:
    return (f"{'|'.join(values)} のどれか", lambda v: isinstance(v, str) and v in values)


def list_of(item: tuple) -> tuple:
    return (f"{item[0]} の配列", lambda v: isinstance(v, list) and all(item[1](x) for x in v))


def shaped(fields: dict) -> tuple:
    return (f"{{{', '.join(fields)}}} だけを持つ object",
            lambda v: isinstance(v, dict) and set(v) == set(fields) and all(t[1](v[k]) for k, t in fields.items()))


DATA_SCHEMA = {
    "init": ({"request_sha256": TEXT, "materials": list_of(shaped({"path": TEXT, "sha256": TEXT}))}, {}),
    "amend": ({"request_sha256": TEXT}, {}),
    "answer": ({"question": TEXT, "question_sha256": TEXT, "ask": TEXT, "answer": TEXT},
               {"option": TEXT, "widen": list_of(TEXT), "stages": list_of(TEXT)}),
    "brief": ({"role": one_of(ROLES)}, {"aspect": one_of(ASPECTS), "conditions": list_of(TEXT), "viewpoint": TEXT,
                                         "mode": one_of(("smoke", "verify")), "report_sha256": TEXT}),
    "criteria_written": ({"aspect": one_of(ASPECTS), "sha256": TEXT, "agent": TEXT},
                         {"asks": list_of(shaped({"id": TEXT, "ask": TEXT,
                                                  "options": list_of(shaped({"id": TEXT, "text": TEXT}))}))}),
    "criteria_review": ({"aspect": one_of(ASPECTS), "reviewed_sha256": TEXT, "findings": list_of(ANY),
                         "notes": list_of(TEXT), "agent": TEXT}, {}),
    "fix": ({"documents": shaped(dict.fromkeys(ASPECTS, TEXT)),
             "means": list_of(shaped({"viewpoint": TEXT, "ref": PATH, "sha256": TEXT})),
             "budget": shaped({"rounds": natural(1), "wall_seconds": natural(1)})}, {}),
    "work": ({"conditions": list_of(TEXT), "outputs": list_of(PATH), "agent": TEXT}, {}),
    "smoke": ({"viewpoint": TEXT, "passed": FLAG, "controls": list_of(shaped({"input": ANY, "observed": ANY})),
               "agent": TEXT}, {}),
    "verification": ({"viewpoint": TEXT, "reported": one_of(VERIFY_STATUSES), "status": one_of(VERIFY_STATUSES),
                      "observed": ANY, "evidence": ANY, "findings": list_of(ANY), "agent": TEXT}, {}),
    "judgment": ({"verdict": one_of(("complete", "not_complete")), "open": list_of(TEXT), "reason": ANY,
                  "agent": TEXT}, {}),
    "continue": ({"count": natural(0), "next": TEXT}, {"refused": FLAG}),
    "close": ({"documents": shaped(dict.fromkeys(ASPECTS, TEXT)), "human_gates": list_of(TEXT)}, {}),
}
ALWAYS_VIEWPOINTS = {
    "R-REQUEST": "依頼原文と成果物を直接照らし合わせ、依頼の各文が満たされているか",
    "R-OUTSIDE": "条件に書かれていない所（範囲外のファイル・既存の利用者・他のスキル）への影響",
}
# 改修前の周回 backstop（5）を引き継いだ値で、較正した値ではない。
MAX_ROUNDS = 5
# guide「stop after two or three automatic continuations」。
MAX_AUTO_CONTINUE = 3
WAITING = ("ask_human", "await_human", "closed")
INVOKE = "{brief} とそこに挙げたパスを自分で読み、{agent} に従い、結果を JSON で {out} に書け。"
CONTINUE = "未充足の項目が残っている: {items}。完了を宣言せず、status の next（{next}）に従って続けよ。"

LEDGER = "ledger.jsonl"
REQUEST = "request.md"
OUT = "out"
ENTRY_KEYS = {"seq", "ts", "prev_sha256", "kind", "brief_id", "data"}
SCRIPT_KEYS = {"seq", "ts", "prev_sha256"}
FINDING = {
    "target": "指摘の対象のパス（ゴールか完了条件の文書への指摘なら、その文書）",
    "severity": "|".join(SEVERITIES),
    "layer": "|".join(LAYERS),
    "claim": "何が欠けているか・何が誤っているか",
    "evidence": "根拠の所在（パスと行、または実行したコマンドと出力）",
}
OPTION = {"id": "a", "text": "人間が選ぶ答え（1 つの読み方）", "kinds": ["（任意）この答えで範囲に入る種類の ID"]}
SHAPES = {
    "goal": {
        "boundary": {
            "object": "依頼が変える対象（1 文。依頼か資料が名指しするものから引く）",
            "roots": ["その対象のディレクトリかファイルの絶対パス（ここより外は列挙も読みもしない）"],
            "outside": {"reading": ("依頼が境界の外に及ばないなら、その読み方。及ぶかが割れるなら reading の代わりに "
                                    "question: {ask, options: [{id, text}（境界の中だけ）, {id, text, widen: [広げる先の絶対パス]}]}")},
        },
        "stages": {
            "list": [{"id": "S1", "what": "後の段階が入力にする成果物を作る段階", "needs": []},
                     {"id": "S2", "what": "S1 の成果物を入力にする段階", "needs": ["S1"]}],
            "this_run": ["この run が受け持つ段階の ID（依存する段階の手前で切るときは前の段階だけ）"],
            "question": {"ask": "（任意）段階ごとに分けて回すかを聞く問い",
                         "options": [{"id": "a", "text": "1 回で全部", "stages": ["S1", "S2"]},
                                     {"id": "b", "text": "先に S1 だけ", "stages": ["S1"]}]},
        },
        "system": {
            "flow": "依頼が指すものを出力に置いた流れ（入力 → 工程 → 判断の分岐 → 出力）",
            "closure": "流れの上の要素がどれか 1 つの種類に入り、一覧の外に無いと言える性質",
            "kinds": [{"id": "K1", "kind": "種類の定義（性質で書く）",
                       "enumerate": {"cwd": "コマンドを実行するディレクトリの絶対パス",
                                     "command": "インスタンスを列挙する決定的な短いコマンド"},
                       "known": ["（任意）列挙に必ず出る既知のインスタンス"]}],
        },
        "phrases": [{"id": "P1", "quote": "依頼の句（request.md に逐語。全句をつなぐと request.md 全体）",
                     "reading": "読み方が 1 通りに決まるなら、その読み方"},
                    {"id": "P2", "quote": "読み方が割れる句",
                     "question": {"ask": "人間に聞く問い", "options": [OPTION, OPTION | {"id": "b"}]}}],
    },
    "scope": {
        "conditions": [{"id": "C1", "statement": "満たすべき状態", "kinds": ["（任意）範囲にする goal.json の種類の ID"],
                        "source": {"path": f"request.md か init で登録した資料のパスか {ANSWER_SOURCE}<問いの ID>",
                                   "quote": "その中の逐語の引用"}}],
        "excluded": [{"item": "範囲に入れないもの", "kinds": ["（任意）範囲に入れない種類の ID"], "reason": "入れない理由"}],
        "human_gates": ["マージ", "公開"],
    },
    "design": {
        "viewpoints": [{
            "id": "C1-V1", "condition": "scope.json の条件 ID", "check": "何を確かめるか",
            "means": {"kind": "|".join(MEANS_KINDS), "ref": "測定手段の絶対パス（controls があれば必須）",
                      "pass_if": {"op": "|".join(PASS_OPS), "value": 0}},
            "controls": [{"input": "正解が分かっている入力", "expected": "その入力で出るべき値",
                          "ref": "入力がファイルかディレクトリなら、その絶対パス"}],
        }],
        "budget": {"rounds": MAX_ROUNDS, "wall_seconds": 7200},
        "stops": ["名指しの停止条件"],
    },
}
COMMON_OUTPUT = {
    "role": "brief の role",
    "brief_id": "brief の brief_id",
    "agent": "自分の識別子。起動ごとに一意な文字列を自分で決め、同じ起動の中では同じ値を使う",
    "prompt_extra": "invoke の文以外に受け取った文を逐語で。無ければ空文字列",
}
OUTPUT = {
    "goal-framer": {},
    "criteria-author": {},
    "criteria-verifier": {"aspect": "brief の aspect", "reviewed_sha256": "レビューした文書の sha256",
                          "findings": [FINDING | {"ask": {"question": f"（任意。blocking の {'か'.join(ASK_LAYERS)} だけ）人間に聞けば決まる依頼の読み方の問い",
                                                          "options": [OPTION, OPTION | {"id": "b"}]}}],
                          "notes": ["司令塔あての報告（環境で確かめられなかったこと・確かめて問題が無かったこと）。書き手には渡らない"]},
    "writer": {"outputs": ["作った・直した成果物のパス"]},
    "verify": {"viewpoint": "brief の観点 ID", "status": "|".join(VERIFY_STATUSES),
               "observed": "means.pass_if があれば観測した数値、無ければ null", "evidence": "確かめた方法と結果",
               "findings": [FINDING]},
    "smoke": {"viewpoint": "brief の観点 ID", "controls": [{"input": "controls の input", "observed": "その input で観測した値"}]},
    "completion-judge": {"verdict": "complete|not_complete", "open": ["完了していない項目（complete なら空）"],
                         "reason": "判定の根拠"},
}


RECORD_KINDS = ("criteria_written", "criteria_review", "work", "smoke", "verification", "judgment")


def record_kind(brief_data: dict) -> str:
    if brief_data["role"] == "verifier":
        return "smoke" if brief_data["mode"] == "smoke" else "verification"
    return {"goal-framer": "criteria_written", "criteria-author": "criteria_written", "criteria-verifier": "criteria_review",
            "writer": "work", "completion-judge": "judgment"}[brief_data["role"]]


def judged_complete(judgment: dict | None) -> bool:
    return judgment is not None and judgment["data"]["verdict"] == "complete" and not judgment["data"]["open"]


class StateError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise StateError(message)


def now() -> datetime:
    return datetime.now(timezone.utc)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(path: Path) -> str:
    if path.is_dir():
        h = hashlib.sha256()
        for child in sorted(p for p in path.rglob("*") if p.is_file()):
            h.update(str(child.relative_to(path)).encode("utf-8") + b"\0")
            h.update(sha256_bytes(child.read_bytes()).encode("ascii"))
        return h.hexdigest()
    return sha256_bytes(path.read_bytes())


def user_path(raw: str) -> Path:
    return Path(raw).expanduser()


def inside(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise StateError(f"{path} が JSON として読めない: {exc}") from exc


def require_keys(obj: object, where: str, required: set, optional: set = frozenset()) -> dict:
    if not isinstance(obj, dict):
        raise StateError(f"{where} は object である必要がある")
    unknown = set(obj) - required - optional
    if unknown:
        raise StateError(f"{where} に未知のキーがある: {', '.join(sorted(unknown))}")
    missing = required - set(obj)
    if missing:
        raise StateError(f"{where} に必須のキーが無い: {', '.join(sorted(missing))}")
    return obj


def nonempty_str(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StateError(f"{where} は空でない文字列である必要がある")
    return value


def number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class Ledger:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.path = run_dir / LEDGER
        self.entries = self._read()

    def prefix(self, count: int) -> "Ledger":
        view = object.__new__(Ledger)
        view.run_dir, view.path, view.entries = self.run_dir, self.path, self.entries[:count]
        return view

    def _read(self) -> list[dict]:
        if not self.path.is_file():
            raise StateError(f"{self.path} が無い（init の前）")
        text = self.path.read_text(encoding="utf-8")
        if text and not text.endswith("\n"):
            raise StateError(f"{self.path}: 末尾が改行で終わっていない（途中で切れた書き込みか、別の writer が混ざっている）")
        entries = []
        prev = ""
        for lineno, line in enumerate(text.split("\n")[:-1], start=1):
            where = f"{self.path}:{lineno}"
            if not line.strip():
                raise StateError(f"{where}: 空行がある（台帳の破損）")
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as exc:
                raise StateError(f"{where} が JSON として読めない: {exc}") from exc
            require_keys(entry, where, ENTRY_KEYS - {"brief_id"}, {"brief_id"})
            if entry["seq"] != lineno:
                raise StateError(f"{where}: seq は {lineno} であるべきところ {entry['seq']!r}（行の削除・並べ替え）")
            if entry["prev_sha256"] != prev:
                raise StateError(f"{where}: prev_sha256 が直前の行と一致しない（行の書き換え）")
            if not isinstance(entry["kind"], str) or entry["kind"] not in DATA_SCHEMA:
                raise StateError(f"{where}: 未知の kind {entry['kind']!r}")
            if "brief_id" in entry:
                nonempty_str(entry["brief_id"], f"{where}.brief_id")
            check_data(entry, where)
            entries.append(entry)
            prev = sha256_bytes(line.encode("utf-8"))
        if not entries or entries[0]["kind"] != "init":
            raise StateError(f"{self.path}: 先頭が init ではない")
        self._last_line_sha = prev
        return entries

    def append(self, kind: str, data: dict, brief_id: str | None = None) -> dict:
        entry = {"seq": len(self.entries) + 1, "ts": now().isoformat(timespec="seconds"),
                 "prev_sha256": self._last_line_sha, "kind": kind}
        if brief_id is not None:
            entry["brief_id"] = brief_id
        entry["data"] = data
        line = json.dumps(entry, ensure_ascii=False)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        self.entries.append(entry)
        self._last_line_sha = sha256_bytes(line.encode("utf-8"))
        return entry

    def of(self, *kinds: str, after: int = 0) -> list[dict]:
        return [e for e in self.entries if e["kind"] in kinds and e["seq"] > after]

    def last(self, *kinds: str, after: int = 0) -> dict | None:
        found = self.of(*kinds, after=after)
        return found[-1] if found else None


def check_data(entry: dict, where: str) -> None:
    try:
        datetime.fromisoformat(entry["ts"])
    except (TypeError, ValueError) as exc:
        raise StateError(f"{where}: ts が ISO 8601 の時刻でない") from exc
    kind, data = entry["kind"], entry["data"]
    required, optional = DATA_SCHEMA[kind]
    require_keys(data, f"{where}.data", set(required), set(optional))
    for key, (desc, ok) in (required | optional).items():
        if key in data and not ok(data[key]):
            raise StateError(f"{where}.data.{key} は {desc}（旧形式や手書きの台帳は読まない）")
    if kind == "brief":
        require_keys(data, f"{where}.data", {"role"} | BRIEF_KEYS[data["role"]])
    if kind == "criteria_written" and ("asks" in data) != (data["aspect"] == "goal"):
        raise StateError(f"{where}: asks は goal の criteria_written だけが持つ")
    if "findings" in data:
        validate_findings(data["findings"], f"{where}.data", kind == "criteria_review")


def validate_findings(findings: object, where: str, allow_ask: bool) -> list[dict]:
    if not isinstance(findings, list):
        raise StateError(f"{where}.findings は配列である必要がある")
    for i, f in enumerate(findings):
        w = f"{where}.findings[{i}]"
        if isinstance(f, dict) and ("layer" not in f or "target" not in f):
            raise StateError(f"{w}: 指摘に layer か target が無い")
        require_keys(f, w, set(FINDING), {"ask"})
        for key in FINDING:
            nonempty_str(f[key], f"{w}.{key}")
        if f["severity"] not in SEVERITIES:
            raise StateError(f"{w}.severity は {SEVERITIES} のどれか")
        if f["layer"] not in LAYERS:
            raise StateError(f"{w}.layer は {LAYERS} のどれか")
        if "ask" in f and not allow_ask:
            raise StateError(f"{w}.ask は criteria-verifier の指摘だけが持てる（この指摘は人間に届かない）")
        if "ask" in f:
            if f["severity"] != "blocking" or f["layer"] not in ASK_LAYERS:
                raise StateError(f"{w}.ask は blocking の {'か'.join(ASK_LAYERS)} の指摘だけが持てる")
            ask = require_keys(f["ask"], f"{w}.ask", {"question", "options"})
            nonempty_str(ask["question"], f"{w}.ask.question")
            validate_options(ask["options"], f"{w}.ask.options", None)
    return findings


def validate_options(options: object, where: str, kinds: dict | None, widen: bool = False,
                     stages: dict | None = None) -> None:
    if not isinstance(options, list) or len(options) < 2:
        raise StateError(f"{where} は 2 つ以上の選択肢の配列（選択肢を書くのは問いを立てた agent で、司令塔は逐語で中継する）")
    ids = set()
    for i, o in enumerate(options):
        w = f"{where}[{i}]"
        require_keys(o, w, {"id", "text"}, {"widen"} if widen else {"stages"} if stages is not None else {"kinds"})
        if nonempty_str(o["id"], f"{w}.id") in ids:
            raise StateError(f"{w}.id {o['id']!r} が重複している")
        ids.add(o["id"])
        nonempty_str(o["text"], f"{w}.text")
        if "kinds" in o:
            string_list(o["kinds"], f"{w}.kinds")
            unknown = sorted(set(o["kinds"]) - set(kinds)) if kinds is not None else []
            if unknown:
                raise StateError(f"{w}.kinds が system.kinds に無い種類を指す: {', '.join(unknown)}")
        if "widen" in o:
            if not isinstance(o["widen"], list) or not o["widen"]:
                raise StateError(f"{w}.widen は広げる先のディレクトリの絶対パスの配列")
            for raw in o["widen"]:
                existing_path(raw, f"{w}.widen")
        if stages is not None:
            check_stage_set(o.get("stages"), f"{w}.stages", stages)
    if widen and (all("widen" in o for o in options) or not any("widen" in o for o in options)):
        raise StateError(f"{where} は境界の中だけの選択肢と、widen で広げる選択肢の両方を持つ")


def existing_path(raw: object, where: str) -> Path:
    path = user_path(nonempty_str(raw, where))
    if not path.is_absolute() or not path.exists():
        raise StateError(f"{where} が存在するディレクトリかファイルでない（絶対パスで書く）: {raw}")
    return path.resolve()


def check_stage_set(value: object, where: str, stages: dict) -> set:
    string_list(value, where)
    chosen = set(value)
    unknown = sorted(chosen - set(stages))
    if unknown or not chosen:
        raise StateError(f"{where} は stages.list の ID の空でない集合（未知: {', '.join(unknown)}）")
    missing = sorted({n for sid in chosen for n in stages[sid]["needs"]} - chosen)
    if missing:
        raise StateError(f"{where} が、入力にする前の段階 {', '.join(missing)} を含まない")
    return chosen


def validate_stages(obj: object, seen: set) -> dict:
    st = require_keys(obj, "stages", {"list", "this_run"}, {"question"})
    if not isinstance(st["list"], list) or len(st["list"]) < 2:
        raise StateError("stages.list は 2 つ以上の段階（段階が 1 つなら stages を書かない）")
    table: dict = {}
    for i, stage in enumerate(st["list"]):
        w = f"stages.list[{i}]"
        require_keys(stage, w, {"id", "what", "needs"})
        claim_id(stage["id"], f"{w}.id", seen)
        nonempty_str(stage["what"], f"{w}.what")
        string_list(stage["needs"], f"{w}.needs")
        if set(stage["needs"]) - set(table):
            raise StateError(f"{w}.needs は、この段階より前に書いた段階の ID の配列")
        table[stage["id"]] = stage
    check_stage_set(st["this_run"], "stages.this_run", table)
    if "question" in st:
        q = require_keys(st["question"], "stages.question", {"ask", "options"})
        nonempty_str(q["ask"], "stages.question.ask")
        validate_options(q["options"], "stages.question.options", None, stages=table)
        pass
    return table


def question_sha(q: dict) -> str:
    body = {"ask": q["ask"], "options": [{"id": o["id"], "text": o["text"]} for o in q["options"]]}
    return sha256_bytes(json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8"))


def ask_sha(finding: dict) -> str:
    return question_sha({"ask": finding["ask"]["question"], "options": finding["ask"]["options"]})


def boundary_roots(goal: dict) -> list[Path]:
    return [user_path(r).resolve() for r in goal["boundary"]["roots"]]


def source_text(run_dir: Path, materials: list[dict], answers: dict, raw: str) -> str:
    if raw.startswith(ANSWER_SOURCE):
        qid = raw[len(ANSWER_SOURCE):]
        if qid not in answers:
            raise StateError(f"source.path {raw!r} の問いに人間の答えが記録されていない")
        return answers[qid]["answer"]
    return source_file(run_dir, materials, raw).read_text(encoding="utf-8")


def source_file(run_dir: Path, materials: list[dict], raw: str) -> Path:
    if raw == REQUEST:
        return run_dir / REQUEST
    candidate = user_path(raw).resolve()
    if candidate == run_dir.resolve() / REQUEST:
        return run_dir / REQUEST
    for m in materials:
        root = Path(m["path"])
        if candidate == root or (root.is_dir() and candidate.is_relative_to(root)):
            if candidate.is_file():
                return candidate
    raise StateError(f"source.path {raw!r} は request.md か init で登録した資料か {ANSWER_SOURCE}<問いの ID> ではない")


def claim_id(raw: object, where: str, seen: set) -> None:
    nonempty_str(raw, where)
    if raw.startswith("R-"):
        raise StateError(f"ID {raw!r} は R- で始まる（R- は script が毎回入れる観点に予約）")
    if raw in (BOUNDARY, STAGES):
        raise StateError(f"ID {raw!r} は境界と段階の問いに予約されている")
    if raw in seen:
        raise StateError(f"ID {raw!r} が重複している")
    seen.add(raw)


def string_list(value: object, where: str) -> None:
    if not isinstance(value, list) or not all(isinstance(s, str) and s.strip() for s in value):
        raise StateError(f"{where} は空でない文字列の配列")


def validate_system(obj: object, seen: set) -> dict[str, dict]:
    require_keys(obj, "system", {"flow", "closure", "kinds"})
    nonempty_str(obj["flow"], "system.flow")
    nonempty_str(obj["closure"], "system.closure")
    if not isinstance(obj["kinds"], list) or not obj["kinds"]:
        raise StateError("system.kinds が 0 件")
    for i, k in enumerate(obj["kinds"]):
        w = f"system.kinds[{i}]"
        require_keys(k, w, {"id", "kind", "enumerate"}, {"known"})
        claim_id(k["id"], f"{w}.id", seen)
        nonempty_str(k["kind"], f"{w}.kind")
        enum = require_keys(k["enumerate"], f"{w}.enumerate", {"cwd", "command"})
        nonempty_str(enum["command"], f"{w}.enumerate.command")
        cwd = user_path(nonempty_str(enum["cwd"], f"{w}.enumerate.cwd"))
        if not cwd.is_absolute() or not cwd.is_dir():
            raise StateError(f"{w}.enumerate.cwd が存在するディレクトリでない（絶対パスで書く）: {enum['cwd']}")
        if "known" in k:
            string_list(k["known"], f"{w}.known")
    return {k["id"]: k for k in obj["kinds"]}


def covered_kinds(items: list[dict], where: str, kinds: dict[str, dict]) -> set:
    found = set()
    for i, item in enumerate(items):
        if "kinds" in item:
            string_list(item["kinds"], f"{where}[{i}].kinds")
            unknown = sorted(set(item["kinds"]) - set(kinds))
            if unknown:
                raise StateError(f"{where}[{i}].kinds が goal.json の system.kinds に無い種類を指す: {', '.join(unknown)}")
            found |= set(item["kinds"])
    return found


def squeeze(text: str) -> str:
    return "".join(text.split())


def validate_boundary(obj: object, seen: set) -> list[Path]:
    b = require_keys(obj, "boundary", {"object", "roots", "outside"})
    nonempty_str(b["object"], "boundary.object")
    if not isinstance(b["roots"], list) or not b["roots"]:
        raise StateError("boundary.roots が 0 件")
    roots = [existing_path(raw, "boundary.roots") for raw in b["roots"]]
    outside = require_keys(b["outside"], "boundary.outside", set(), {"reading", "question"})
    if len(outside) != 1:
        raise StateError("boundary.outside は reading（外に及ばない）か question（及ぶかが割れる）のどちらか 1 つを持つ")
    if "reading" in outside:
        nonempty_str(outside["reading"], "boundary.outside.reading")
    else:
        q = require_keys(outside["question"], "boundary.outside.question", {"ask", "options"})
        nonempty_str(q["ask"], "boundary.outside.question.ask")
        validate_options(q["options"], "boundary.outside.question.options", None, widen=True)
        pass
    return roots


def validate_goal(obj: object, run_dir: Path) -> dict:
    require_keys(obj, DOCS["goal"], {"boundary", "system", "phrases"}, {"stages"})
    seen: set = {BOUNDARY, STAGES}
    roots = validate_boundary(obj["boundary"], seen)
    if "stages" in obj:
        validate_stages(obj["stages"], seen)
    kinds = validate_system(obj["system"], seen)
    for kid, k in kinds.items():
        cwd = user_path(k["enumerate"]["cwd"]).resolve()
        if not any(cwd.is_relative_to(root) if root.is_dir() else cwd == root.parent for root in roots):
            raise StateError(f"種類 {kid} の enumerate.cwd が boundary.roots の外にある: {k['enumerate']['cwd']}")
    phrases = obj["phrases"]
    if not isinstance(phrases, list) or not phrases:
        raise StateError("phrases が 0 件")
    for i, ph in enumerate(phrases):
        w = f"phrases[{i}]"
        require_keys(ph, w, {"id", "quote"}, {"reading", "question"})
        claim_id(ph["id"], f"{w}.id", seen)
        nonempty_str(ph["quote"], f"{w}.quote")
        if ("reading" in ph) == ("question" in ph):
            raise StateError(f"{w} は reading（読み方が 1 通り）か question（割れる）のどちらか 1 つを持つ")
        if "reading" in ph:
            nonempty_str(ph["reading"], f"{w}.reading")
        else:
            q = require_keys(ph["question"], f"{w}.question", {"ask", "options"})
            nonempty_str(q["ask"], f"{w}.question.ask")
            validate_options(q["options"], f"{w}.question.options", kinds)
    request = squeeze((run_dir / REQUEST).read_text(encoding="utf-8"))
    joined = squeeze("".join(ph["quote"] for ph in phrases))
    if joined != request:
        at = next((i for i, (a, b) in enumerate(zip(joined, request)) if a != b), min(len(joined), len(request)))
        raise StateError(f"phrases の quote を順につなぐと request.md と一致しない（空白を除いて {at} 文字目から。"
                         f"request.md は「{request[at:at + 20]}」、つないだ quote は「{joined[at:at + 20]}」）。"
                         "句は request.md を頭から終わりまで漏れなく重ならずに分ける")
    return obj


def asks_of(goal: dict) -> list[dict]:
    outside = goal["boundary"]["outside"]
    stages = goal.get("stages", {})
    questions = ([(BOUNDARY, outside["question"])] if "question" in outside else []) + \
        ([(STAGES, stages["question"])] if "question" in stages else []) + \
        [(ph["id"], ph["question"]) for ph in goal["phrases"] if "question" in ph]
    return [{"id": qid, "ask": q["ask"], "options": [{"id": o["id"], "text": o["text"]} for o in q["options"]]}
            for qid, q in questions]


def validate_scope(obj: object, run_dir: Path, materials: list[dict], goal: dict, answers: dict) -> dict:
    require_keys(obj, DOCS["scope"], {"conditions", "excluded", "human_gates"})
    kinds = {k["id"]: k for k in goal["system"]["kinds"]}
    seen: set = set(kinds) | {ph["id"] for ph in goal["phrases"]}
    conditions = obj["conditions"]
    if not isinstance(conditions, list) or not conditions:
        raise StateError("conditions が 0 件")
    for i, cond in enumerate(conditions):
        w = f"conditions[{i}]"
        require_keys(cond, w, {"id", "statement", "source"}, {"kinds"})
        claim_id(cond["id"], f"{w}.id", seen)
        nonempty_str(cond["statement"], f"{w}.statement")
        require_keys(cond["source"], f"{w}.source", {"path", "quote"})
        quote = nonempty_str(cond["source"]["quote"], f"{w}.source.quote")
        raw = nonempty_str(cond["source"]["path"], f"{w}.source.path")
        if quote not in source_text(run_dir, materials, answers, raw):
            raise StateError(f"{w}.source.quote が {raw} に逐語で無い")
    if not isinstance(obj["excluded"], list):
        raise StateError("excluded は配列である必要がある")
    for i, ex in enumerate(obj["excluded"]):
        require_keys(ex, f"excluded[{i}]", {"item", "reason"}, {"kinds"})
        nonempty_str(ex["item"], f"excluded[{i}].item")
        nonempty_str(ex["reason"], f"excluded[{i}].reason")
    covered = covered_kinds(conditions, "conditions", kinds) | covered_kinds(obj["excluded"], "excluded", kinds)
    open_kinds = sorted(set(kinds) - covered)
    if open_kinds:
        raise StateError(f"goal.json の種類のうち、条件にも除外にも対応しないものがある: {', '.join(open_kinds)}")
    string_list(obj["human_gates"], "human_gates")
    return obj


def validate_design(obj: object, scope: dict) -> dict:
    require_keys(obj, DOCS["design"], {"viewpoints", "budget", "stops"})
    viewpoints = obj["viewpoints"]
    if not isinstance(viewpoints, list) or not viewpoints:
        raise StateError("viewpoints が 0 件")
    conditions = {c["id"] for c in scope["conditions"]}
    seen = set(conditions)
    for j, vp in enumerate(viewpoints):
        v = f"viewpoints[{j}]"
        require_keys(vp, v, {"id", "condition", "check", "means"}, {"controls"})
        claim_id(vp["id"], f"{v}.id", seen)
        if vp["condition"] not in conditions:
            raise StateError(f"{v}.condition {vp['condition']!r} は scope.json の条件に無い")
        nonempty_str(vp["check"], f"{v}.check")
        means = require_keys(vp["means"], f"{v}.means", {"kind"}, {"ref", "pass_if"})
        if means["kind"] not in MEANS_KINDS:
            raise StateError(f"{v}.means.kind は {MEANS_KINDS} のどれか")
        if "ref" in means:
            ref = user_path(nonempty_str(means["ref"], f"{v}.means.ref"))
            if not ref.is_absolute() or not ref.exists():
                raise StateError(f"{v}.means.ref が存在しない（絶対パスで書く）: {means['ref']}")
        if "pass_if" in means:
            pass_if = require_keys(means["pass_if"], f"{v}.means.pass_if", {"op", "value"})
            if pass_if["op"] not in PASS_OPS or not number(pass_if["value"]):
                raise StateError(f"{v}.means.pass_if は op {PASS_OPS} と数値の value")
        controls = vp.get("controls", [])
        if not isinstance(controls, list):
            raise StateError(f"{v}.controls は配列である必要がある")
        if means["kind"] in CONTROLLED_MEANS and not controls:
            raise StateError(f"{v}: kind が {means['kind']} なのに controls が無い")
        if controls and "ref" not in means:
            raise StateError(f"{v}: controls があるのに means.ref が無い（smoke で実行する測定手段を指す）")
        for k, control in enumerate(controls):
            require_keys(control, f"{v}.controls[{k}]", {"input", "expected"}, {"ref"})
            nonempty_str(control["input"], f"{v}.controls[{k}].input")
            if "ref" in control:
                ref = user_path(nonempty_str(control["ref"], f"{v}.controls[{k}].ref"))
                if not ref.is_absolute() or not ref.exists():
                    raise StateError(f"{v}.controls[{k}].ref が存在しない（絶対パスで書く）: {control['ref']}")
    uncovered = sorted(conditions - {vp["condition"] for vp in viewpoints})
    if uncovered:
        raise StateError(f"観点が 0 の条件がある: {', '.join(uncovered)}")
    budget = require_keys(obj["budget"], "budget", {"rounds", "wall_seconds"})
    for key in ("rounds", "wall_seconds"):
        if not isinstance(budget[key], int) or isinstance(budget[key], bool) or budget[key] < 1:
            raise StateError(f"budget.{key} は 1 以上の整数")
    if budget["rounds"] > MAX_ROUNDS:
        raise StateError(f"budget.rounds が MAX_ROUNDS = {MAX_ROUNDS} を超える")
    string_list(obj["stops"], "stops")
    return obj


def viewpoints_of(criteria: dict) -> dict[str, dict]:
    table = {vp["id"]: vp for vp in criteria["viewpoints"]}
    for vid, check in ALWAYS_VIEWPOINTS.items():
        table[vid] = {"id": vid, "check": check, "means": {"kind": "audit"}, "condition": None}
    return table


def smoke_passed(controls: list, outputs: list) -> bool:
    return len(outputs) == len(controls) and all(
        o["input"] == c["input"] and o["observed"] == c["expected"] for o, c in zip(outputs, controls)
    )


def effective_status(vp: dict, reported: str, observed: object, findings: list) -> str:
    if any(f["severity"] == "blocking" for f in findings):
        return "fail"
    pass_if = vp["means"].get("pass_if")
    if pass_if is None or reported == "not_done":
        return reported
    if not number(observed):
        return "not_done"
    value = pass_if["value"]
    ok = {">=": observed >= value, "<=": observed <= value, "==": observed == value}[pass_if["op"]]
    return "pass" if ok else "fail"


class State:
    def __init__(self, run_dir: Path, ledger: Ledger | None = None, pinned: dict | None = None):
        self.run_dir = run_dir
        self.pinned = pinned
        self.ledger = ledger or Ledger(run_dir)
        init = self.ledger.entries[0]["data"]
        self.materials = init["materials"]
        self.started = datetime.fromisoformat(self.ledger.entries[0]["ts"])
        self.request_sha = self.ledger.last("init", "amend")["data"]["request_sha256"]
        self._index()
        if ledger is None:
            request = run_dir / REQUEST
            if not request.is_file() or digest(request) != self.request_sha:
                raise StateError("request.md の digest が記録と一致しない（依頼原文が改変された）")
            self._replay()

    def _index(self) -> None:
        self.last_fix = self.ledger.last("fix")
        self.fix_seq = self.last_fix["seq"] if self.last_fix else 0
        self.briefs = {e["brief_id"]: e for e in self.ledger.of("brief")}
        self.used = {e["brief_id"] for e in self.ledger.entries if e["kind"] != "brief" and "brief_id" in e}
        self._assign_rounds()

    def _replay(self) -> None:
        issued: dict[str, dict] = {}
        consumed: set = set()
        for e in self.ledger.entries:
            where = f"{self.ledger.path}:{e['seq']}"
            if e["kind"] == "brief":
                if e.get("brief_id") != f"b{e['seq']}":
                    raise StateError(f"{where}: brief_id が script の採番と違う（script を経ない追記）")
                issued[e["brief_id"]] = e
            elif e["kind"] in RECORD_KINDS:
                brief = issued.get(e.get("brief_id"))
                if brief is None or e["brief_id"] in consumed or record_kind(brief["data"]) != e["kind"]:
                    raise StateError(f"{where}: 発行済みで未使用の brief に対応しない {e['kind']}（script を経ない追記）")
                consumed.add(e["brief_id"])
            elif "brief_id" in e:
                raise StateError(f"{where}: {e['kind']} は brief_id を持たない")
            if e["kind"] in ("fix", "close"):
                pinned = e["data"]["documents"] if e["kind"] == "fix" else None
                before = State(self.run_dir, self.ledger.prefix(e["seq"] - 1), pinned)
                problem = fix_problem(before) if e["kind"] == "fix" else close_problem(before)
                if problem:
                    raise StateError(f"{where}: この {e['kind']} は記録の時点で成立していない（{problem}）")

    def _assign_rounds(self) -> None:
        self.round_of: dict[int, int] = {}
        self.criteria_round_of: dict[int, int] = {}
        work_round = 0
        criteria_round = dict.fromkeys(ASPECTS, 0)
        verified_since_work = True
        for e in self.ledger.entries:
            if e["kind"] == "work":
                if verified_since_work:
                    work_round += 1
                    verified_since_work = False
                self.round_of[e["seq"]] = work_round
            elif e["kind"] == "verification":
                verified_since_work = True
                self.round_of[e["seq"]] = work_round
            elif e["kind"] == "smoke":
                self.round_of[e["seq"]] = work_round
            elif e["kind"] == "criteria_written":
                criteria_round[e["data"]["aspect"]] += 1
            elif e["kind"] == "criteria_review":
                self.criteria_round_of[e["seq"]] = criteria_round[e["data"]["aspect"]]
        self.rounds_used = work_round
        self.next_writer_opens_round = verified_since_work

    def doc_path(self, aspect: str) -> Path:
        return self.run_dir / DOCS[aspect]

    def doc_sha(self, aspect: str) -> str | None:
        if self.pinned:
            return self.pinned[aspect]
        path = self.doc_path(aspect)
        return digest(path) if path.is_file() else None

    def docs(self) -> dict:
        return {a: self.doc_sha(a) for a in ASPECTS}

    def read_doc(self, aspect: str) -> object:
        path = self.doc_path(aspect)
        if not path.is_file():
            raise StateError(f"{DOCS[aspect]} が無い")
        return read_json(path)

    def goal(self) -> dict:
        return validate_goal(self.read_doc("goal"), self.run_dir)

    def scope(self) -> dict:
        return validate_scope(self.read_doc("scope"), self.run_dir, self.materials, self.goal(), self.answers_by_id())

    def criteria(self) -> dict:
        scope = self.scope()
        return scope | validate_design(self.read_doc("design"), scope)

    def answers(self) -> dict:
        return {e["data"]["question"]: e["data"] for e in self.ledger.of("answer")}

    def answers_by_id(self) -> dict:
        table = self.answers()
        by_sha = {a["question_sha256"]: a for a in table.values()}
        written = self.written("goal")
        current = (written["data"]["asks"] if written else []) + self.finding_asks()
        for q in current:
            if q["id"] not in table and question_sha(q) in by_sha:
                table[q["id"]] = by_sha[question_sha(q)]
        return table

    def window_open(self) -> bool:
        return self.last_fix is None or any(
            e["data"]["role"] in AUTHORS for e in self.ledger.of("brief", after=self.fix_seq)
        )

    def check_criteria_digest(self) -> None:
        if self.window_open():
            return
        changed = [DOCS[a] for a in ASPECTS if self.doc_sha(a) != self.last_fix["data"]["documents"][a]]
        if changed:
            raise StateError(f"{', '.join(changed)} の digest が最後の fix と一致しない（固定後の書き換え）")

    def criteria_findings_after_fix(self) -> list[dict]:
        return [e for e in self.ledger.of("verification", after=self.fix_seq)
                if any(f["severity"] == "blocking" and f["layer"] in LAYER_OF.values() for f in e["data"]["findings"])]

    def reopened(self) -> bool:
        if self.last_fix is None:
            return True
        if self.ledger.of("amend", "criteria_written", after=self.fix_seq):
            return True
        return bool(self.criteria_findings_after_fix())

    def fixed(self) -> bool:
        return not self.reopened()

    def fixed_budget(self) -> dict | None:
        return self.last_fix["data"]["budget"] if self.last_fix else None

    def written(self, aspect: str) -> dict | None:
        found = [e for e in self.ledger.of("criteria_written") if e["data"]["aspect"] == aspect]
        return found[-1] if found else None

    def current_review(self, aspect: str) -> dict | None:
        upto = ASPECTS[:ASPECTS.index(aspect) + 1]
        marks = [e["seq"] for e in self.ledger.of("amend", "criteria_written")
                 if e["kind"] == "amend" or e["data"]["aspect"] in upto]
        found = [e for e in self.ledger.of("criteria_review", after=max(marks, default=0))
                 if e["data"]["aspect"] == aspect and e["data"]["reviewed_sha256"] == self.doc_sha(aspect)]
        return found[-1] if found else None

    def latest_review(self, aspect: str) -> dict | None:
        written = self.written(aspect)
        found = [e for e in self.ledger.of("criteria_review", after=written["seq"] if written else 0)
                 if e["data"]["aspect"] == aspect and e["data"]["reviewed_sha256"] == self.doc_sha(aspect)]
        return found[-1] if found else None

    def routed_findings(self, aspect: str) -> list[dict]:
        written = self.written(aspect)
        after = written["seq"] if written else 0
        reviews = [r for r in (self.latest_review(a) for a in ASPECTS) if r and r["seq"] > after]
        entries = reviews + self.ledger.of("verification", after=max(after, self.fix_seq))
        by_sha = {a["question_sha256"]: a for a in self.answers().values()}
        found = []
        for f in (f for e in entries for f in e["data"]["findings"] if f["layer"] == LAYER_OF[aspect]):
            a = by_sha.get(ask_sha(f)) if "ask" in f else None
            found.append(f | {"answer": a["answer"], "answer_source": ANSWER_SOURCE + a["question"]} if a else f)
        stuck = self.design_stuck() if aspect == "scope" else None
        if stuck:
            found += [f for f in stuck["data"]["findings"] if f["severity"] == "blocking" and f["layer"] == LAYER_OF["design"]]
        return found

    def design_stuck(self) -> dict | None:
        reviews = [e for e in self.ledger.of("criteria_review") if e["data"]["aspect"] == "design"][-2:]
        counts = [sum(f["severity"] == "blocking" and f["layer"] == LAYER_OF["design"] for f in e["data"]["findings"])
                  for e in reviews]
        if len(counts) == 2 and 0 < counts[0] <= counts[1] and self.written("scope")["seq"] < reviews[-1]["seq"]:
            return reviews[-1]
        return None

    def needs_author(self, aspect: str) -> bool:
        written = self.written(aspect)
        if written is None:
            return True
        if aspect == "goal" and (self.ledger.of("amend", after=written["seq"]) or self.unreflected()):
            return True
        if aspect != "goal" and written["seq"] < self.written(ASPECTS[ASPECTS.index(aspect) - 1])["seq"]:
            return True
        return any(f["severity"] == "blocking" for f in self.routed_findings(aspect))

    def ready(self, aspect: str) -> bool:
        return not self.needs_author(aspect) and self.current_review(aspect) is not None

    def unreflected(self) -> list[str]:
        if self.pinned:
            return []
        answers = list(self.answers().values())
        wanted = [w for a in answers for w in a.get("widen", [])]
        chosen = [a["stages"] for a in answers if "stages" in a]
        if not (wanted or chosen) or not self.doc_path("goal").is_file():
            return []
        try:
            goal = read_json(self.doc_path("goal"))
            roots = [user_path(r).resolve() for r in goal["boundary"]["roots"]]
            this_run = set(goal.get("stages", {}).get("this_run", []))
        except (StateError, KeyError, TypeError, AttributeError):
            return ["goal.json を読めない"]
        items = [f"人間が広げた境界が boundary.roots に未反映: {w}" for w in wanted
                 if not any(user_path(w).resolve().is_relative_to(r) for r in roots)]
        if chosen and set(chosen[-1]) != this_run:
            items.append(f"人間が選んだ段階が stages.this_run に未反映: {', '.join(chosen[-1])}")
        return items

    def finding_asks(self) -> list[dict]:
        asks = []
        for aspect in ASPECTS:
            review = self.latest_review(aspect)
            for i, f in enumerate(review["data"]["findings"] if review else []):
                if f["severity"] == "blocking" and "ask" in f:
                    asks.append({"id": f"{review['brief_id']}#{i}", "ask": f["ask"]["question"],
                                 "options": [{"id": o["id"], "text": o["text"]} for o in f["ask"]["options"]]})
        return asks

    def pending_asks(self) -> list[dict]:
        asks = self.finding_asks()
        if self.ready("goal"):
            asks += self.written("goal")["data"]["asks"]
        answered = {a["question_sha256"] for a in self.answers().values()}
        pending = [q for q in asks if question_sha(q) not in answered]
        framing = [q for q in pending if q["id"] in (BOUNDARY, STAGES)]
        return framing or pending

    def criteria_open(self) -> list[dict]:
        items = []
        for f in (f for a in ASPECTS for f in self.routed_findings(a) if f["severity"] == "blocking"):
            if f not in items:
                items.append(f)
        amend, written = self.ledger.last("amend"), self.written("goal")
        if amend and (written is None or amend["seq"] > written["seq"]):
            items.append({"target": REQUEST, "claim": "amend で足した依頼が goal.json に未反映"})
        items += [{"target": DOCS["goal"], "claim": claim} for claim in self.unreflected()]
        return items

    def sizes(self) -> dict:
        report = {DOCS[a]: len(self.doc_path(a).read_text(encoding="utf-8")) for a in ASPECTS if self.doc_path(a).is_file()}
        design = self.written("design")
        if design and self.doc_sha("design") == design["data"]["sha256"]:
            report["check"] = {vp["id"]: len(vp["check"]) for vp in self.read_doc("design")["viewpoints"]}
        return report

    def current_round(self) -> int:
        works = self.ledger.of("work", after=self.fix_seq)
        return self.round_of[works[-1]["seq"]] if works else 0

    def round_entries(self, *kinds: str, back: int = 0) -> list[dict]:
        r = self.current_round() - back
        return [e for e in self.ledger.of(*kinds, after=self.fix_seq) if self.round_of[e["seq"]] == r] if r > 0 else []

    def smoke_ok(self, vid: str) -> bool:
        return any(e["data"]["viewpoint"] == vid and e["data"]["passed"] for e in self.ledger.of("smoke", after=self.fix_seq))

    def verdicts(self, criteria: dict) -> dict[str, dict]:
        table = viewpoints_of(criteria)
        latest = {e["data"]["viewpoint"]: e["data"] for e in self.round_entries("verification")}
        return {vid: {"condition": vp["condition"], "status": latest[vid]["status"] if vid in latest else "not_done",
                      "reported": vid in latest} for vid, vp in table.items()}

    def finding_counts(self) -> dict:
        series: dict[str, dict] = {name: {} for name in (*ASPECTS, "verification")}
        answered = {a["question_sha256"] for a in self.answers().values()}
        for e in self.ledger.of("criteria_review", "verification"):
            if e["kind"] == "verification":
                name, r = "verification", self.round_of[e["seq"]]
            else:
                name, r = e["data"]["aspect"], self.criteria_round_of[e["seq"]]
            bucket = series[name].setdefault(r, dict.fromkeys(LAYERS, 0))
            for f in e["data"]["findings"]:
                if f["severity"] == "blocking" and ("ask" not in f or ask_sha(f) in answered):
                    bucket[f["layer"]] += 1
        return {name: [{"round": r, "blocking": c} for r, c in sorted(rows.items())] for name, rows in series.items()}

    def regressions(self) -> list[dict]:
        by_round: dict[int, dict] = {}
        for e in self.ledger.of("verification"):
            by_round.setdefault(self.round_of[e["seq"]], {})[e["data"]["viewpoint"]] = e["data"]["status"]
        rounds = sorted(by_round)
        out = []
        for prev, cur in zip(rounds, rounds[1:]):
            count = sum(1 for vid, s in by_round[cur].items() if s == "fail" and by_round[prev].get(vid) == "pass")
            out.append({"round": cur, "regressed": count})
        return out

    def non_converging(self) -> str | None:
        counts = self.finding_counts()
        for series in counts.values():
            rows = [row["blocking"] for row in series]
            for layer in LAYERS:
                seq = [row[layer] for row in rows]
                for a, b, c in zip(seq, seq[1:], seq[2:]):
                    if b > 0 and c > 0 and b >= a and c >= b:
                        return f"stop:non_converging:{layer}"
        regressed = [r["regressed"] for r in self.regressions()]
        if any(a > 0 and b > 0 for a, b in zip(regressed, regressed[1:])):
            return "stop:non_converging:退行"
        return None

    def elapsed(self) -> int:
        return int((now() - self.started).total_seconds())

    def auto_continues(self) -> int:
        return len([e for e in self.ledger.of("continue") if not e["data"].get("refused")])

    def next(self) -> str:
        closed = self.ledger.last("close")
        if closed:
            return "await_human" if closed["data"]["human_gates"] else "closed"
        stuck = self.non_converging()
        if stuck:
            return stuck
        answered = self.ledger.last("answer")
        if answered and self.unreflected() and len([e for e in self.ledger.of("criteria_written", after=answered["seq"])
                                                    if e["data"]["aspect"] == "goal"]) >= 2:
            return "stop:non_converging:ゴール"
        if any(e["data"].get("refused") for e in self.ledger.of("continue")):
            return "stop:auto_continue"
        budget = self.fixed_budget()
        if budget and self.elapsed() > budget["wall_seconds"]:
            return "stop:time_budget"
        if self.reopened():
            if budget and self.next_writer_opens_round and self.rounds_used >= budget["rounds"]:
                return "stop:rounds"
            if self.pending_asks():
                return "ask_human"
            for aspect in ASPECTS:
                if self.needs_author(aspect):
                    return f"{AUTHOR_OF[aspect]}:{aspect}"
                if self.current_review(aspect) is None:
                    return f"criteria-verifier:{aspect}"
            return "fix"
        criteria = self.criteria()
        out_of_rounds = self.rounds_used >= budget["rounds"]
        if not self.ledger.of("work", after=self.fix_seq):
            return "stop:rounds" if self.next_writer_opens_round and out_of_rounds else "writer"
        verdicts = self.verdicts(criteria)
        if not all(v["reported"] for v in verdicts.values()):
            return "verifier"
        if any(v["status"] != "pass" for v in verdicts.values()):
            return "stop:rounds" if out_of_rounds else "writer"
        last_verification = self.round_entries("verification")[-1]["seq"]
        judgment = self.ledger.last("judgment", after=last_verification)
        if judgment is None:
            return "completion-judge"
        if judged_complete(judgment):
            return "close"
        return "stop:rounds" if out_of_rounds else "writer"

    def status(self) -> dict:
        report = {"next": self.next(), "criteria_fixed": self.fixed(),
                  "auto_continue": {"count": self.auto_continues(), "max": MAX_AUTO_CONTINUE},
                  "findings": self.finding_counts(), "regressions": self.regressions(), "unmet": None,
                  "sizes": self.sizes()}
        budget = self.fixed_budget()
        if budget:
            report["rounds"] = {"used": self.rounds_used, "budget": budget["rounds"]}
            report["elapsed"] = f"elapsed {self.elapsed()}s / {budget['wall_seconds']}s"
        if not self.fixed():
            report["criteria_open"] = self.criteria_open()
            if self.pending_asks():
                report["ask_human"] = self.pending_asks()
        else:
            criteria = self.criteria()
            report["unmet"] = [{"condition": v["condition"], "viewpoint": vid, "status": v["status"]}
                               for vid, v in self.verdicts(criteria).items() if v["status"] != "pass"]
            report["stops"] = criteria["stops"]
            report["human_gates"] = criteria["human_gates"]
        return report


def emit(payload: dict) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def read_request(raw: str) -> str:
    text = user_path(raw).read_text(encoding="utf-8")
    if not text.strip():
        raise StateError("依頼原文が空")
    return text


def cmd_init(args) -> int:
    run_dir = user_path(args.run_dir)
    if (run_dir / LEDGER).exists() or (run_dir / REQUEST).exists():
        raise StateError(f"{run_dir} は初期化済み")
    text = read_request(args.request_file)
    materials = []
    for raw in args.material or []:
        path = user_path(raw)
        if not path.exists():
            raise StateError(f"資料が存在しない: {raw}")
        if inside(path, run_dir):
            raise StateError(f"資料が run-dir の中にある（資料は元の場所のまま渡す）: {raw}")
        materials.append({"path": str(path.resolve()), "sha256": digest(path)})
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / REQUEST).write_text(text, encoding="utf-8")
    entry = {"seq": 1, "ts": now().isoformat(timespec="seconds"), "prev_sha256": "", "kind": "init",
             "data": {"request_sha256": digest(run_dir / REQUEST), "materials": materials}}
    (run_dir / LEDGER).write_text(json.dumps(entry, ensure_ascii=False) + "\n", encoding="utf-8")
    return emit({"recorded_request": text, "materials": materials})


def cmd_amend(args) -> int:
    state = State(user_path(args.run_dir))
    state.check_criteria_digest()
    nxt = state.next()
    if nxt.startswith("stop:") or nxt in ("await_human", "closed"):
        raise StateError(f"停止か完了の後の run には足せない（next = {nxt}）。新しい run で init する")
    text = read_request(args.request_file)
    request = state.run_dir / REQUEST
    current = request.read_text(encoding="utf-8")
    joined = current if current.endswith("\n") else current + "\n"
    request.write_text(joined + "\n" + text, encoding="utf-8")
    state.ledger.append("amend", {"request_sha256": digest(request)})
    return emit({"recorded_request": text, "next": State(state.run_dir).next()})


def cmd_answer(args) -> int:
    state = State(user_path(args.run_dir))
    state.check_criteria_digest()
    if state.next() != "ask_human":
        raise StateError(f"answer は next が ask_human のときだけ取る（next = {state.next()}）")
    pending = {q["id"]: q for q in state.pending_asks()}
    question = pending.get(args.question)
    if question is None:
        raise StateError(f"ask_human で待っていない問い: {args.question}（待っている問い: {', '.join(pending)}）")
    if (args.option is None) == (args.text_file is None):
        raise StateError("--option（選ばれた選択肢の ID）か --text-file（選択肢に無い答えの原文）のどちらか 1 つを取る")
    data = {"question": question["id"], "question_sha256": question_sha(question), "ask": question["ask"]}
    if args.option is not None:
        option = next((o for o in question["options"] if o["id"] == args.option), None)
        if option is None:
            raise StateError(f"{question['id']} に選択肢 {args.option!r} が無い（選択肢: "
                             f"{', '.join(o['id'] for o in question['options'])}）")
        data |= {"answer": option["text"], "option": option["id"]}
        if question["id"] in (BOUNDARY, STAGES):
            goal = state.goal()
            q = goal["boundary"]["outside"]["question"] if question["id"] == BOUNDARY else goal["stages"]["question"]
            full = next(o for o in q["options"] if o["id"] == option["id"])
            if "widen" in full:
                data["widen"] = [str(user_path(w).resolve()) for w in full["widen"]]
            if "stages" in full:
                data["stages"] = full["stages"]
    else:
        data["answer"] = read_request(args.text_file)
    state.ledger.append("answer", data)
    after = State(state.run_dir)
    return emit({"recorded_answer": data, "next": after.next(), "ask_human": after.pending_asks()})


def prior_findings(state: State, role: str, conditions: list, viewpoint: str | None, aspect: str | None) -> list[dict]:
    if role in ("goal-framer", "criteria-author"):
        extra = [{"target": DOCS["goal"], "severity": "blocking", "layer": LAYER_OF["goal"], "claim": claim,
                  "evidence": "人間の答え（brief の answers）"} for claim in state.unreflected()] if aspect == "goal" else []
        return state.routed_findings(aspect) + extra
    if role == "criteria-verifier":
        prev = [e for e in state.ledger.of("criteria_review") if e["data"]["aspect"] == aspect]
        return prev[-1]["data"]["findings"] if prev else []
    if role in ("writer", "verifier"):
        criteria = state.criteria()
        table = viewpoints_of(criteria)
        wanted = {viewpoint} if viewpoint else {vid for vid, vp in table.items()
                                                if vp["condition"] in conditions or vp["condition"] is None}
        done = state.round_entries("verification", back=1 if role == "verifier" else 0)
        return [f for e in done if e["data"]["viewpoint"] in wanted for f in e["data"]["findings"]]
    return []


def cmd_brief(args) -> int:
    state = State(user_path(args.run_dir))
    role = args.role
    if role not in AUTHORS:
        state.check_criteria_digest()
    nxt = state.next()
    if nxt.startswith("stop:") or nxt in WAITING:
        raise StateError(f"停止中（next = {nxt}）")
    conditions = args.conditions or []
    if conditions and role != "writer":
        raise StateError("--conditions は writer だけが取る")
    viewpoints = args.viewpoint or []
    if len(viewpoints) != (1 if role == "verifier" else 0):
        raise StateError("--viewpoint は verifier が 1 つだけ取る")
    if (args.aspect is not None) != (role in (*AUTHORS, "criteria-verifier")):
        raise StateError("--aspect は goal-framer・criteria-author・criteria-verifier が必ず取る")
    if role in AUTHORS and AUTHOR_OF[args.aspect] != role:
        raise StateError(f"{DOCS[args.aspect]} を書くのは {AUTHOR_OF[args.aspect]}")
    if (args.report_file is not None) != (role == "completion-judge"):
        raise StateError("--report-file は completion-judge が必ず取る")
    brief: dict = {"role": role}
    record = {"role": role}
    if args.aspect:
        if role in AUTHORS and state.fixed():
            raise StateError("fix 済みで、完了条件の文書への未解決の指摘も amend も無い")
        index = ASPECTS.index(args.aspect)
        if index and not state.ready(ASPECTS[index - 1]):
            prev = ASPECTS[index - 1]
            raise StateError(f"{NAMES[prev]}が {prev} の反証を通っていない（{NAMES[args.aspect]}は前の文書を固めてから）")
        if role == "criteria-verifier" and state.needs_author(args.aspect):
            raise StateError(f"{DOCS[args.aspect]} が未記録か、範囲の書き直しか指摘への直しが済んでいない")
        brief["aspect"] = record["aspect"] = args.aspect
    else:
        if not state.fixed():
            raise StateError(f"criteria が fix されていない状態で {role} は呼べない")
        criteria = state.criteria()
        table = viewpoints_of(criteria)
        cond_ids = {c["id"] for c in criteria["conditions"]}
        if role == "writer":
            if not conditions:
                raise StateError("writer には担当する条件 ID を --conditions で渡す")
            unknown = [c for c in conditions if c not in cond_ids]
            if unknown:
                raise StateError(f"criteria に無い条件 ID: {', '.join(unknown)}")
            if state.next_writer_opens_round and state.rounds_used >= criteria["budget"]["rounds"]:
                raise StateError(f"rounds の予算（{criteria['budget']['rounds']}）を使い切った")
            brief["conditions"] = record["conditions"] = conditions
        elif role == "verifier":
            vid = viewpoints[0]
            if vid not in table:
                raise StateError(f"criteria に無い観点 ID: {vid}")
            vp = table[vid]
            mode = "smoke" if vp.get("controls") and not state.smoke_ok(vid) else "verify"
            if mode == "verify" and not state.ledger.of("work", after=state.fix_seq):
                raise StateError("work の記録が無い")
            brief.update({"viewpoint": vp, "mode": mode})
            record.update({"viewpoint": vid, "mode": mode})
            if mode == "verify":
                brief["work_outputs"] = sorted({p for e in state.round_entries("work") for p in e["data"]["outputs"]})
        else:
            report = user_path(args.report_file)
            if not report.is_file():
                raise StateError(f"最終報告案が存在しない: {args.report_file}")
            brief["report"] = {"path": str(report.resolve()), "sha256": digest(report)}
            record["report_sha256"] = brief["report"]["sha256"]
    entry = state.ledger.append("brief", record, brief_id=f"b{len(state.ledger.entries) + 1}")
    brief_id = entry["brief_id"]
    out_dir = state.run_dir / OUT
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{brief_id}.json"
    agent_file = SKILL_DIR / "agents" / f"{role}.md"
    brief.update({
        "brief_id": brief_id,
        "agent_file": str(agent_file),
        "out": str(out),
        "request": {"path": str((state.run_dir / REQUEST).resolve()), "sha256": state.request_sha},
        "materials": state.materials,
        "output": COMMON_OUTPUT | OUTPUT[brief.get("mode", role)],
        "prior_findings": prior_findings(state, role, conditions, viewpoints[0] if viewpoints else None, args.aspect),
        "answers": list(state.answers().values()),
    })
    reads = ASPECTS[:ASPECTS.index(args.aspect) + 1] if args.aspect else ASPECTS
    brief["documents"] = {a: {"path": str(state.doc_path(a).resolve()), "sha256": state.doc_sha(a)} for a in reads}
    if role in DOCUMENT_READERS:
        brief["document_rules"] = str(SKILL_DIR / "agents" / "writer.md")
    if role in AUTHORS:
        brief["shape"] = SHAPES[args.aspect]
    if role != "goal-framer" and state.written("goal"):
        brief["boundary"] = {"roots": [str(r) for r in boundary_roots(state.goal())], "rule": BOUNDARY_RULE}
    if role == "completion-judge":
        status_file = out_dir / f"{brief_id}.status.json"
        status_file.write_text(json.dumps(state.status(), ensure_ascii=False), encoding="utf-8")
        brief["status"] = str(status_file)
    brief_file = out_dir / f"{brief_id}.brief.json"
    brief_file.write_text(json.dumps(brief, ensure_ascii=False, indent=1), encoding="utf-8")
    return emit({"brief_id": brief_id, "brief": str(brief_file),
                 "invoke": INVOKE.format(brief=brief_file, agent=agent_file, out=out)})


def check_means(state: State, vid: str) -> None:
    for m in state.last_fix["data"]["means"]:
        if m["viewpoint"] == vid and digest(Path(m["ref"])) != m["sha256"]:
            raise StateError(f"means.ref か controls の ref の digest が fix 時と違う: {m['ref']}")


def cmd_record(args) -> int:
    state = State(user_path(args.run_dir))
    out = read_json(user_path(args.file))
    if isinstance(out, list):
        raise StateError("出力は 1 つの object に限る（配列は受け付けない）")
    if not isinstance(out, dict):
        raise StateError("出力は object である必要がある")
    stamped = SCRIPT_KEYS & set(out)
    if stamped:
        raise StateError(f"script が付けるキーを含む: {', '.join(sorted(stamped))}")
    brief = state.briefs.get(out.get("brief_id"))
    if brief is None:
        raise StateError(f"未発行の brief_id: {out.get('brief_id')!r}")
    if brief["brief_id"] in state.used:
        raise StateError(f"使用済みの brief_id: {brief['brief_id']}")
    role = brief["data"]["role"]
    if out.get("role") != role:
        raise StateError(f"ロールが brief と違う: brief は {role}")
    if role not in AUTHORS:
        state.check_criteria_digest()
    shape = brief["data"].get("mode") if role == "verifier" else role
    require_keys(out, f"{role} の出力", set(COMMON_OUTPUT) | set(OUTPUT[shape]))
    agent = nonempty_str(out["agent"], "agent")
    if out["prompt_extra"] != "":
        raise StateError("prompt_extra が空でない（agent が invoke 以外の文を受け取った）")
    if "findings" in out:
        validate_findings(out["findings"], role, role == "criteria-verifier")
    bid = brief["brief_id"]
    aspect = brief["data"].get("aspect")
    if role in AUTHORS:
        others = {e["data"]["agent"] for e in state.ledger.of("criteria_written")
                  if (e["data"]["aspect"] == "goal") != (aspect == "goal")}
        if agent in others:
            raise StateError("ゴールの文書の書き手と、範囲・測定の文書の書き手が同じ agent")
        data = {"aspect": aspect, "sha256": state.doc_sha(aspect), "agent": agent}
        if aspect == "goal":
            data["asks"] = asks_of(state.goal())
        elif aspect == "scope":
            state.scope()
        else:
            state.criteria()
        entry = state.ledger.append("criteria_written", data, bid)
    elif role == "criteria-verifier":
        if out["aspect"] != aspect:
            raise StateError("aspect が brief と違う")
        if out["reviewed_sha256"] != state.doc_sha(aspect):
            raise StateError(f"レビューした {DOCS[aspect]} の digest が現行と違う")
        if state.written(aspect)["data"]["agent"] == agent:
            raise StateError("criteria-verifier が、レビューした文書の criteria-author と同じ agent")
        string_list(out["notes"], "notes")
        if any(f["layer"] not in REVIEW_LAYERS[aspect] for f in out["findings"]):
            raise StateError(f"{aspect} のレビューが出せる layer は {REVIEW_LAYERS[aspect]}")
        kinds = {k["id"]: k for k in state.goal()["system"]["kinds"]}
        for i, f in enumerate(out["findings"]):
            if "ask" in f:
                validate_options(f["ask"]["options"], f"findings[{i}].ask.options", kinds)
        entry = state.ledger.append("criteria_review", {k: out[k] for k in OUTPUT[role]} | {"agent": agent}, bid)
    elif role == "writer":
        if not isinstance(out["outputs"], list) or not all(isinstance(p, str) and p for p in out["outputs"]):
            raise StateError("outputs はパスの配列")
        entry = state.ledger.append("work", {"conditions": brief["data"]["conditions"], "outputs": out["outputs"],
                                             "agent": agent}, bid)
    elif role == "verifier":
        vid = brief["data"]["viewpoint"]
        if out["viewpoint"] != vid:
            raise StateError(f"観点 ID が brief と違う（brief は {vid}。条件の外の指摘は R-OUTSIDE の brief に載せる）")
        vp = viewpoints_of(state.criteria())[vid]
        check_means(state, vid)
        if shape == "smoke":
            if not isinstance(out["controls"], list) or not all(
                    isinstance(o, dict) and set(o) == {"input", "observed"} for o in out["controls"]):
                raise StateError("controls は {input, observed} の配列")
            passed = smoke_passed(vp.get("controls", []), out["controls"])
            entry = state.ledger.append("smoke", {"viewpoint": vid, "passed": passed, "controls": out["controls"],
                                                  "agent": agent}, bid)
        else:
            if out["status"] not in VERIFY_STATUSES:
                raise StateError(f"status は {VERIFY_STATUSES} のどれか")
            if vp.get("controls") and not state.smoke_ok(vid):
                raise StateError("controls を持つ観点で smoke がまだ pass していない")
            if any(e["data"]["agent"] == agent for e in state.round_entries("work")):
                raise StateError("検証役が、この周の work の writer と同じ agent")
            if any(e["data"]["agent"] == agent and e["data"]["viewpoint"] != vid for e in state.round_entries("verification")):
                raise StateError("同じ周で、別の観点を記録済みの agent と同じ")
            data = {"viewpoint": vid, "reported": out["status"],
                    "status": effective_status(vp, out["status"], out["observed"], out["findings"]),
                    "observed": out["observed"], "evidence": out["evidence"], "findings": out["findings"],
                    "agent": agent}
            entry = state.ledger.append("verification", data, bid)
    else:
        if out["verdict"] not in ("complete", "not_complete"):
            raise StateError("verdict は complete か not_complete")
        if not isinstance(out["open"], list) or not all(isinstance(o, str) and o.strip() for o in out["open"]):
            raise StateError("open は空でない文字列の配列")
        if (out["verdict"] == "complete") != (not out["open"]):
            raise StateError("open は complete なら空、not_complete なら当たった項目を挙げる")
        entry = state.ledger.append("judgment", {k: out[k] for k in OUTPUT[role]} | {"agent": agent}, bid)
    after = State(state.run_dir)
    notes = {"notes": out["notes"]} if role == "criteria-verifier" else {}
    return emit({"recorded": entry["kind"], "seq": entry["seq"], "next": after.next(), "sizes": after.sizes()} | notes)


def fix_problem(state: State) -> str | None:
    if state.pending_asks():
        return "人間の答えを待つ問いがある（ask_human）"
    for aspect in ASPECTS:
        if state.needs_author(aspect):
            return f"{DOCS[aspect]} が書かれていないか、指摘への直しが済んでいない"
        if state.current_review(aspect) is None:
            return f"現行の {DOCS[aspect]} に対するレビューが揃っていない: {aspect}"
    reviewers = [state.current_review(a)["data"]["agent"] for a in ASPECTS]
    authors = {state.written(a)["data"]["agent"] for a in ASPECTS}
    if len(set(reviewers)) != len(reviewers) or authors & set(reviewers):
        return "goal・scope・design のレビュアーに同じ agent がいるか、レビュアーが書き手と同じ agent"
    return None


def cmd_fix(args) -> int:
    state = State(user_path(args.run_dir))
    state.check_criteria_digest()
    nxt = state.next()
    if nxt.startswith("stop:") or nxt in WAITING:
        raise StateError(f"停止中（next = {nxt}）")
    problem = fix_problem(state)
    if problem:
        raise StateError(problem)
    criteria = state.criteria()
    refs = [(vp["id"], raw) for vp in criteria["viewpoints"]
            for raw in [vp["means"].get("ref")] + [c.get("ref") for c in vp.get("controls", [])] if raw]
    means = [{"viewpoint": vid, "ref": str(user_path(raw)), "sha256": digest(user_path(raw))} for vid, raw in refs]
    documents = state.docs()
    state.ledger.append("fix", {"documents": documents, "means": means, "budget": criteria["budget"]})
    return emit({"fixed": documents, "means": means, "next": State(state.run_dir).next()})


def cmd_status(args) -> int:
    state = State(user_path(args.run_dir))
    state.check_criteria_digest()
    return emit(state.status())


def cmd_continue(args) -> int:
    state = State(user_path(args.run_dir))
    state.check_criteria_digest()
    nxt = state.next()
    if nxt.startswith("stop:") or nxt in WAITING:
        raise StateError(f"停止を指している（next = {nxt}）。継続せず、未充足を名指しして報告する")
    count = state.auto_continues()
    if count >= MAX_AUTO_CONTINUE:
        state.ledger.append("continue", {"count": count, "next": "stop:auto_continue", "refused": True})
        raise StateError(f"自動継続が上限 {MAX_AUTO_CONTINUE} 回に達した。以後 next は stop:auto_continue")
    status = state.status()
    state.ledger.append("continue", {"count": count + 1, "next": nxt})
    if status["unmet"] is None:
        items = "完了条件が未固定"
    else:
        items = ", ".join(f"{u['viewpoint']}={u['status']}" for u in status["unmet"]) or "（観点は充足、判定が未了）"
    return emit({"continuation": CONTINUE.format(items=items, next=nxt), "count": count + 1})


def close_problem(state: State) -> str | None:
    if state.ledger.last("close"):
        return "close 済み"
    if not state.fixed():
        return "criteria が fix されていない"
    pending = [vid for vid, v in state.verdicts(state.criteria()).items() if v["status"] != "pass"]
    if pending:
        return f"最新の work に対する最新の検証で pass でない観点がある: {', '.join(pending)}"
    last_verification = state.round_entries("verification")[-1]["seq"]
    judgment = state.ledger.last("judgment", after=last_verification)
    if not judged_complete(judgment):
        return "completion-judge の最新の判定が、open の無い complete でない"
    return None


def cmd_close(args) -> int:
    state = State(user_path(args.run_dir))
    state.check_criteria_digest()
    problem = close_problem(state)
    if problem:
        raise StateError(problem)
    criteria = state.criteria()
    state.ledger.append("close", {"documents": state.docs(), "human_gates": criteria["human_gates"]})
    return emit({"closed": True, "human_gates": criteria["human_gates"], "status": State(state.run_dir).status()})


def build_parser() -> Parser:
    parser = Parser(description="pdca の状態（依頼原文・完了条件・台帳）を持ち、呼び出しの順序を決める")
    sub = parser.add_subparsers(dest="command", required=True, parser_class=Parser)

    def command(name, fn):
        p = sub.add_parser(name)
        p.add_argument("--run-dir", required=True)
        p.set_defaults(fn=fn)
        return p

    p = command("init", cmd_init)
    p.add_argument("--request-file", required=True)
    p.add_argument("--material", action="append")
    p = command("amend", cmd_amend)
    p.add_argument("--request-file", required=True)
    p = command("answer", cmd_answer)
    p.add_argument("--question", required=True)
    p.add_argument("--option")
    p.add_argument("--text-file")
    p = command("brief", cmd_brief)
    p.add_argument("--role", required=True, choices=ROLES)
    p.add_argument("--conditions", nargs="+")
    p.add_argument("--viewpoint", action="append")
    p.add_argument("--aspect", choices=ASPECTS)
    p.add_argument("--report-file")
    p = command("record", cmd_record)
    p.add_argument("--file", required=True)
    command("fix", cmd_fix)
    command("status", cmd_status)
    command("continue", cmd_continue)
    command("close", cmd_close)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        return args.fn(args)
    except (StateError, OSError, UnicodeDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as exc:
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        reason = f"想定外の例外 {type(exc).__name__}: {exc}（{Path(frame.filename).name}:{frame.lineno} {frame.name}）"
        print(json.dumps({"error": reason}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

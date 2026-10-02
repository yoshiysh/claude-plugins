#!/usr/bin/env python3
"""先例の入口: 過去のランの決定と検証結果を、intake と resolver が読める形で W/precedent.json に並べる。

usage:
  python3 precedent.py list --root <workspace のルート> --workspace <W>
  python3 precedent.py convert --from <旧いランの args / precedent の JSON> --out <ディレクトリ>

list: ルート配下の `decisions.json`・`verifications.json` と、convert が作った `answers.md` を、規則どおり全部
並べて `W/precedent.json`（`{"paths": [...]}`）に書く。W 自身の配下は除く（今回のランの決定を先例として
読むと、自分の決定を自分で追認することになる）。どれを使うかは intake と resolver が決める。ここで選ぶと、
選んだ人の判断が根拠の無いまま先例の範囲を狭める。

convert: 旧い形式のラン（決定を args の `decisions` に、依頼者の回答を `answers` / `tbd_answers` の文字列に
持っていたもの）を、`<out>/decisions.json` と `<out>/answers.md` に変換する。
- decisions.json は `{"legacy": true, "source_file": ..., "decisions": [...]}`。決定は中身を変えずに写す。
- answers.md は依頼者の回答を逐語で写す（どの欄から来たかの見出しだけを足す）。
- verifications.json は作らない。旧いランの決定は resolver-verifier を通っていないので、合格として書くと
  検証していないものを検証済みに見せることになる。
"""

import argparse
import json
import os
import sys

NAMES = ("decisions.json", "verifications.json")
ANSWER_FIELDS = ("answers", "tbd_answers")


def list_precedents(root, workspace):
    # realpath: 開発中の [SKILL_DIR] は symlink 越し（.agents/skills・.claude/skills）でも届き、root と W が別の接頭辞で来ると W を除けない。
    root = os.path.realpath(root)
    ws = os.path.realpath(workspace)
    paths = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in ("checks", "findings", "tmp"))
        here = os.path.realpath(dirpath)
        if here == ws or here.startswith(ws + os.sep):
            continue
        for name in NAMES:
            if name in filenames:
                paths.append(os.path.join(here, name))
        if "answers.md" in filenames and _is_legacy(os.path.join(here, "decisions.json")):
            paths.append(os.path.join(here, "answers.md"))
    return sorted(paths)


def _is_legacy(path):
    try:
        with open(path, encoding="utf-8") as f:
            return bool(json.load(f).get("legacy"))
    except (OSError, json.JSONDecodeError, AttributeError):
        return False


def convert(src, out):
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{src} はオブジェクトではありません")
    decisions = data.get("decisions")
    if not isinstance(decisions, list):
        raise ValueError(f"{src} に decisions の配列がありません")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "decisions.json"), "w", encoding="utf-8") as f:
        json.dump({"legacy": True, "source_file": os.path.abspath(src), "decisions": decisions}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    parts = []
    for field in ANSWER_FIELDS:
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            parts.append(f"<!-- {os.path.basename(src)} の {field} -->\n{value}")
    written = bool(parts)
    if written:
        with open(os.path.join(out, "answers.md"), "w", encoding="utf-8") as f:
            f.write("\n\n".join(parts) + "\n")
    return {"decisions": len(decisions), "answers": written, "out": os.path.abspath(out)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list")
    ls.add_argument("--root", required=True)
    ls.add_argument("--workspace", required=True)
    cv = sub.add_parser("convert")
    cv.add_argument("--from", dest="src", required=True)
    cv.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "list":
        paths = list_precedents(a.root, a.workspace)
        target = os.path.join(os.path.abspath(a.workspace), "precedent.json")
        with open(target, "w", encoding="utf-8") as f:
            json.dump({"paths": paths}, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(json.dumps({"paths": len(paths), "path": target}, ensure_ascii=False))
        return 0
    try:
        print(json.dumps(convert(a.src, a.out), ensure_ascii=False))
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"precedent convert: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

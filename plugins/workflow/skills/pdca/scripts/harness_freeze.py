#!/usr/bin/env python3
"""評価 harness の凍結と照合（Plan 成果物を Do が編集できない形にする）。

Plan が固定した成功基準は、それを測る harness（判定スクリプト・fixture・LLM 判定の
凍結プロンプト）まで降りないと実行時に作り替えられる。作った本人が採点物も用意できる
状態は、このスキルが最初に禁じている自己採点の構図そのものである（SKILL.md
「生成と検証の不変条件」）。そこで Plan の最後に harness を**別の場所へ複製して digest で
封じ**、Do 以降はその複製だけを実行・参照する。

このスクリプトが凍結を担うのは、workflow script（pdca.js）に filesystem が無く、
時刻も採れないため（`Date.now()` は resume を壊すので runtime が禁じている）。決定的処理
（複製・digest・時刻）はここ、判断（harness が契約を満たすか）は agent、という分担は
ledger.py と同じ。

使い方:
  harness_freeze.py freeze --run-dir <workspace>/<run-id> \
      --source-root <harness の置き場> --json '<spec JSON>'
  harness_freeze.py verify --run-dir <workspace>/<run-id>|<frozenHarness.path> [--expect <digest>]

spec JSON:
  { "class": "deterministic_script" | "llm_judge",
    "entry": "source-root からの相対パス（実行する入口 / 判定プロンプト）",
    "files": ["source-root からの相対パス", ...] }

`freeze` は `<run-dir>/frozen/` に複製と MANIFEST.json を書き、ledger へそのまま流せる
`harness_frozen` entry を標準出力に返す。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# HARNESS_CLASSES: 凍結が与える保証の強さは harness の class で変わる。
# deterministic_script = 同じ入力に同じ判定を返す実行物（凍結が「同じ採点」を保証する）。
# llm_judge = 判定が言語モデルの読みに依るもの（凍結できるのはプロンプトと fixture までで、
# 判定そのものの同一性は保証されない。詳細は references/harness-freeze.md）。
# 値を増やすときは references/harness-freeze.md の保証表を先に更新する。
HARNESS_CLASSES = ("deterministic_script", "llm_judge")

# FROZEN_DIRNAME: run-dir 配下の凍結先。名前を固定してあるのは、verify と
# pdca.js の args（frozenHarness.path）が同じ場所を指すため。
FROZEN_DIRNAME = "frozen"
MANIFEST_NAME = "MANIFEST.json"


class FreezeError(Exception):
    pass


def _digest_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _aggregate_digest(files: list[dict]) -> str:
    """ファイル単位の digest を、パス順に固定して 1 本に畳む。

    並び順を sorted で固定しないと、同じ内容の harness が呼び出し順で別 digest になり、
    「変更された」と「並びが違う」を区別できなくなる。
    """
    h = hashlib.sha256()
    for f in sorted(files, key=lambda x: x["path"]):
        h.update(f"{f['path']}:{f['digest']}\n".encode("utf-8"))
    return h.hexdigest()


def _load_spec(raw: str) -> dict:
    spec = json.loads(raw)
    if not isinstance(spec, dict):
        raise FreezeError("spec は object である必要があります")
    cls = spec.get("class")
    if cls not in HARNESS_CLASSES:
        raise FreezeError(f"未知の class '{cls}'。使えるのは {', '.join(HARNESS_CLASSES)}")
    entry = str(spec.get("entry") or "").strip()
    if not entry:
        raise FreezeError("spec.entry（実行する入口 / 判定プロンプト）が空です")
    files = spec.get("files")
    if not isinstance(files, list) or not files:
        raise FreezeError("spec.files は 1 件以上の相対パス配列である必要があります")
    rels = [str(f).strip() for f in files]
    if any(not r for r in rels):
        raise FreezeError("spec.files に空の要素があります")
    if entry not in rels:
        # entry が files に無いと、凍結されていない入口を実行することになる。
        rels.append(entry)
    # criteria（指標名・向き・閾値）も凍結対象。ファイルだけ凍結して判定値を CLI の
    # 手入力に残すと、差分を入れた本人が Check 時に指標・向き・閾値を選び直せる
    # （凍結が防ごうとした事故の同型）。
    criteria = spec.get("criteria")
    if not isinstance(criteria, dict):
        raise FreezeError("spec.criteria（metric / higher_is_better / threshold）が必要です")
    if not str(criteria.get("metric") or "").strip():
        raise FreezeError("spec.criteria.metric が空です")
    if not isinstance(criteria.get("higher_is_better"), bool):
        raise FreezeError("spec.criteria.higher_is_better は boolean である必要があります")
    if not isinstance(criteria.get("threshold"), (int, float)) or isinstance(criteria.get("threshold"), bool):
        raise FreezeError("spec.criteria.threshold は数値である必要があります")
    frozen_criteria = {"metric": str(criteria["metric"]).strip(),
                       "higher_is_better": criteria["higher_is_better"],
                       "threshold": criteria["threshold"]}
    return {"class": cls, "entry": entry, "files": sorted(set(rels)),
            "criteria": frozen_criteria}


def _resolve(source_root: Path, rel: str) -> Path:
    target = (source_root / rel).resolve()
    # startswith による前方一致だと /tmp/harness-evil が /tmp/harness の内側と判定される。
    # 境界はパス要素で見る。
    if not target.is_relative_to(source_root.resolve()):
        raise FreezeError(f"source-root の外を指しています: {rel}")
    if not target.is_file():
        raise FreezeError(f"harness のファイルが見つかりません: {target}")
    return target


def cmd_freeze(args) -> int:
    run_dir = Path(args.run_dir).resolve()
    source_root = Path(args.source_root).resolve()
    if not source_root.is_dir():
        raise FreezeError(f"source-root がディレクトリではありません: {source_root}")
    frozen_dir = run_dir / FROZEN_DIRNAME
    manifest_path = frozen_dir / MANIFEST_NAME

    # 凍結先が harness の置き場の中にあると、Do の作業ツリーに凍結物が同居する。
    # 非開示（パスを builder に渡さない）で守っている構造がそこで崩れる。
    if str(frozen_dir).startswith(str(source_root) + "/") or frozen_dir == source_root:
        raise FreezeError(
            f"凍結先 {frozen_dir} が source-root {source_root} の内側です。"
            "builder が作業するツリーの外（workspace 配下）を run-dir に指定してください。"
        )

    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        raise FreezeError(
            f"既に凍結済みです（digest={existing.get('digest')}, frozen_at={existing.get('frozen_at')}）。"
            "凍結後の差し替えは Plan の作り直しにあたるので、新しい run-id で凍結してください。"
        )

    spec = _load_spec(args.json if args.json is not None else sys.stdin.read())
    frozen_dir.mkdir(parents=True, exist_ok=True)
    recorded = []
    for rel in spec["files"]:
        src = _resolve(source_root, rel)
        dest = frozen_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        recorded.append({"path": rel, "digest": _digest_file(dest)})

    digest = _aggregate_digest(recorded)
    frozen_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "class": spec["class"],
        "entry": spec["entry"],
        "criteria": spec["criteria"],
        "files": recorded,
        "digest": digest,
        "frozen_at": frozen_at,
        "source_root": str(source_root),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    print(
        json.dumps(
            {
                "frozenHarness": {
                    "path": str(frozen_dir),
                    "entry": spec["entry"],
                    "digest": digest,
                    "class": spec["class"],
                    "file_count": len(recorded),
                },
                "ledger_entry": {
                    "type": "harness_frozen",
                    "phase": "Plan",
                    "summary": f"評価 harness を凍結（class={spec['class']} / {len(recorded)} ファイル / digest={digest[:12]}）",
                    "payload": manifest,
                    "refs": [],
                },
            },
            ensure_ascii=False,
        )
    )
    return 0


def _frozen_dir_of(target: Path) -> Path:
    """run-dir でも凍結ディレクトリ自体でも受け付ける。

    freeze が返す `frozenHarness.path` は凍結ディレクトリそのものなので、照合する agent は
    そこから親を推測することになる。推測を要求すると、間違えた呼び出しが「凍結が破れている」
    という判定になって run を止める（照合できなかったことと破れたことが同じ見え方になる）。
    """
    target = target.resolve()
    if (target / MANIFEST_NAME).is_file() or target.name == FROZEN_DIRNAME:
        return target
    return target / FROZEN_DIRNAME


def cmd_verify(args) -> int:
    frozen_dir = _frozen_dir_of(Path(args.run_dir))
    manifest_path = frozen_dir / MANIFEST_NAME
    if not manifest_path.exists():
        raise FreezeError(f"凍結の記録がありません: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    changed = []
    current = []
    for entry in manifest.get("files", []):
        path = frozen_dir / entry["path"]
        if not path.is_file():
            changed.append({"path": entry["path"], "reason": "欠落"})
            continue
        now = _digest_file(path)
        current.append({"path": entry["path"], "digest": now})
        if now != entry["digest"]:
            changed.append({"path": entry["path"], "reason": "内容が変わっている"})

    digest = _aggregate_digest(current) if len(current) == len(manifest.get("files", [])) else None
    ok = not changed and digest == manifest.get("digest")
    if args.expect and args.expect != manifest.get("digest"):
        ok = False
        changed.append(
            {"path": MANIFEST_NAME, "reason": f"MANIFEST の digest が期待値 {args.expect} と違う"}
        )

    print(
        json.dumps(
            {
                "ok": ok,
                "digest": manifest.get("digest"),
                "current_digest": digest,
                "frozen_at": manifest.get("frozen_at"),
                "class": manifest.get("class"),
                "changed": changed,
            },
            ensure_ascii=False,
        )
    )
    # 不一致は exit 1。凍結物が変わった状態で Do/Check を続けると、測っているのは
    # 「事前に固定した基準」ではなくなる。
    return 0 if ok else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="評価 harness の凍結と照合")
    sub = ap.add_subparsers(dest="cmd", required=True)

    fz = sub.add_parser("freeze", help="harness を run-dir 配下へ複製し digest で封じる")
    fz.add_argument("--run-dir", required=True, help="workspace/<run-id>（builder の作業ツリー外）")
    fz.add_argument("--source-root", required=True, help="harness ファイルの基準ディレクトリ")
    fz.add_argument("--json", default=None, help="spec JSON。省略時は stdin から読む")
    fz.set_defaults(fn=cmd_freeze)

    vf = sub.add_parser("verify", help="凍結物が凍結時のままかを照合する（不一致は exit 1）")
    vf.add_argument(
        "--run-dir",
        required=True,
        help="workspace/<run-id> でも、freeze が返した frozenHarness.path（凍結ディレクトリ）でもよい",
    )
    vf.add_argument("--expect", default=None, help="期待する aggregate digest")
    vf.set_defaults(fn=cmd_verify)

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (FreezeError, json.JSONDecodeError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

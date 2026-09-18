"""指摘の同一性キーの正本。

review_skill.js の keyOf / normPath はこのキーと一致していなければならない。ズレると、
同じ「同じ指摘か」の問いに 2 つの答えが生まれる —— script の resolved / new の突き合わせと、
改稿ループの乾き判定（前巡の未解消集合と一致したら打ち切る）が、どちらもこのキーで動く。
定義を 2 か所に書かないため、正規化のアルゴリズムはここが正本で、散文は参照するだけにする。

指摘の 2 つの配列を突き合わせたいときは、この実装をなぞらずここを実行する
（正規化の目視再現は件数が増えるほど揺れる）。

入力: JSON を stdin から
  {"reverify_confirmed": [finding, ...], "already_presented": [finding, ...]}
  finding は少なくとも category / file / claim を持つ。キー名は入力の出所を縛らない
  （confirmed と unverified を区別しない汎用の突き合わせ）。
出力: {"new": [...], "matched": [...]} を stdout へ。
"""
import json
import re
import sys


def norm_path(path: str) -> str:
    # `./SKILL.md` と `SKILL.md` の表記揺れは実際に観測されている。
    return re.sub(r"^\./", "", str(path))


def key_of(finding: dict) -> str:
    claim = re.sub(r"\s+", " ", str(finding.get("claim", "")).strip()).lower()
    return "::".join([str(finding.get("category", "")), norm_path(finding.get("file", "")), claim])


def main() -> int:
    data = json.loads(sys.stdin.read())
    presented = {key_of(f) for f in data.get("already_presented", [])}
    new, matched = [], []
    for finding in data.get("reverify_confirmed", []):
        (matched if key_of(finding) in presented else new).append(finding)
    print(json.dumps({"new": new, "matched": matched}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

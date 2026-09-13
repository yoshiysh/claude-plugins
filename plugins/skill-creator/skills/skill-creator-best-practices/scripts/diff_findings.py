"""手直し再検証の指摘突き合わせ。同一性キーの唯一の定義。

review_skill.js の keyOf/normPath はこのキーと一致していなければならない
（ズレると script 側の resolved/new 判定と司令塔側の new 判定が別の答えを出す）。
定義を 2 か所に書かないため、正規化のアルゴリズムはここが正本で、散文の手順書は
このスクリプトを実行するだけにする。

入力: JSON を stdin から
  {"reverify_confirmed": [finding, ...], "already_presented": [finding, ...]}
  finding は少なくとも category / file / claim を持つ。
出力: {"new": [...], "matched": [...]} を stdout へ。new が「手直しが持ち込んだ
可能性のある指摘」で、コピー可否のゲート判定はこの配列を見る。
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

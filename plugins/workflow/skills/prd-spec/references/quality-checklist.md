# 生成物の絶対品質チェックリスト

生成された要求文書・仕様書を、run 間比較ではなく**外部規範に対する絶対評価**で採点する
ためのチェックリスト。評価者（fresh context の verifier）が使う。各項目は判定方法を持ち、
**定義の正は右列のファイル**にある（ここは索引であり、リストや閾値を再定義しない）。

出典: 2026-08 の一次情報調査（EARS 原典・RFC 2119/8174・ISO Directives Part 2・IEEE 830 複製・
29148 公開複製・Shape Up・design doc・PR/FAQ・Kiro/Spec Kit・Anthropic context engineering。
各 URL は `prd-and-spec.md` §10 と `requirement-writing-rules.md` §7 に記載）。

| # | 項目 | 判定方法 | 定義の正 |
|---|---|---|---|
| 1 | 全要求文が 4 語尾のいずれかで終わる | 機械（script 検査 `ST-MODAL` ＋採点者確認。語尾は活用形対応の後方一致 — literal 照合は五段動詞を偽陽性にする） | requirement-writing-rules.md §1 |
| 2 | 要求文中の禁止曖昧語の出現が 0 件 | 機械（grep） | requirement-writing-rules.md §2 |
| 3 | 条件付き要求文が EARS 5 パターンのいずれかに一致する | 目視＋パターン照合 | requirement-writing-rules.md §2.5 |
| 4 | 数量に単位・境界包含・上下限・超過時挙動の 4 点が揃う | 数値抽出→目視 | requirement-writing-rules.md §2.6 |
| 5 | 全項目に ID があり、仕様項目→要求 ID の紐付けが 100% | 機械（表と突合） | traceability.md §1–3 |
| 6 | 要求文書に設計解が無く、仕様書に根拠不明の要求が無い | 目視 | prd-and-spec.md §3–4 |
| 7 | スコープ外の節が非空である | 機械（見出し照合） | document-structure.md |
| 8 | 全要求に `audit_trail` の根拠があり、引用が原本に実在し、認められた根拠原本以外の出所が無い | 機械（ID と trace の突合 `ST-NO-EVIDENCE`）＋引用の照合 | question-policy.md・fixed-premises.md |
| 9 | 必須の内容項目が揃い、該当なしは「該当なし＋根拠」形式 | 見出し照合 | document-structure.md |
| 10 | 本文が規範だけで構成され（根拠句・決定ログ・経緯・未確定事項の章が無い）、決まっていない論点は保持規則として書かれている | 機械（`ST-NON-NORMATIVE`）＋目視 | document-structure.md §4 |
| 11 | 改修案件で、保持すべき既存挙動が明示されている（該当時のみ） | 目視 | requirement-writing-rules.md §7 |
| 12 | 期待挙動を規定しない冗長記述が無い（粒度の上限） | `scripts/check_unlinked_prose.py` が候補を列挙 → 目視裁定 | requirement-writing-rules.md §7・prd-and-spec.md §7 |

| 13 | 文脈ゼロの読者が各要求文を一意に解釈できる（golden rule） | 目視（fresh context 評価者自身が実演になる） | requirement-writing-rules.md |
| 14 | 内容が文書の定義した価値と整合する（価値不要の要求・価値に必要な欠落・必須 5 項目の形骸化が無い） | 目視（fresh 監査者が価値判定を各要求へ適用） | prd-and-spec.md §4（正本） |

#12 の補助: `python3 scripts/check_unlinked_prose.py <docs_dir>` が「定義・割当・例外・要求語彙との接続を持たない段落」を候補として列挙する。**候補は削除リストではない** — 実測較正（Alphora 7 文書）では候補の 89% が規範・前提の偽陽性で、真に過剰だったのは文書間で反復される定型句（読み手の宣言・「投資判断は依頼者が行う」の再演など）だけだった。機械削除・FAIL 化に使わず、writer が 1 段落ずつ「消してどの判断が変わるか」で裁定する。散文が多いこと自体は過剰の証拠にならない（要求文は総称文で、意味の大半は節導入の定義散文が担う）。

## 仕様書側の項目（対象が specifications のときに追加適用）

| # | 項目 | 判定方法 | 定義の正 |
|---|---|---|---|
| S1 | 各仕様項目に検証方法（inspection/analysis/demonstration/test）が明記されている | 機械（表と突合） | requirement-writing-rules.md §8 |
| S2 | 定義した全入力について invalid 時の応答が書かれている | 目視 | requirement-writing-rules.md §8 |
| S3 | 状態を持つ機能で、状態×イベントの未定義組み合わせが 0 または根拠付き「発生しない」 | 機械＋目視 | document-structure.md §6 |
| S4 | 外部境界ごとにインタフェース記述がある | 目視 | requirement-writing-rules.md §8 |
| S5 | 本文にコード・擬似コード・特定実装の指定が無い | 機械（コードブロック検出）＋目視 | requirement-writing-rules.md §8・prd-and-spec.md |
| S6 | 残った未確定事項が返り値側にのみ存在し、解消条件を持つ（本文側は保持規則の形） | 機械（script 検査 `ST-TBD-NORESOLVE` ＋採点者確認） | requirement-writing-rules.md §8・traceability.md §4 |

## 採点の規律

- 採点の材料は生成文書と **Workflow の返り値（`audit_trail` / `holding_rules` / `work_items`）**
  の両方である。根拠・裁定の記録は文書に無いので、文書だけを見て「根拠が無い」と採点しない。
- 各項目は **pass / fail / not-applicable / not-checked** の四値で返す。not-checked を
  fail にも pass にも丸めない（未検査は 0 件ではない）。
- fail には該当箇所の引用を付ける。引用の無い fail は採点として受け取らない。
- このチェックリストは生成側の auditor 群（clarity / traceability 等）と重なるが、役割が違う:
  auditor は**改稿のための指摘**を出し、本リストは**完成品の絶対評価**を出す。
  両方が同じ定義ファイルを正とするので、基準は drift しない。

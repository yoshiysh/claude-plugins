# 規格・規制への言及ポリシー

## 大前提: 既定では規格に言及しない

**多くの案件では、規格に一切言及しない文書が正解である。** 社内ツールの PRD に規格名が並んでいたら、
それは厳格さではなく飾りであり、読み手に「この案件は規制対象なのか」という誤解を与える。

言及してよいのは次のどちらかに当てはまるときだけ。

1. ユーザーがその規格への対応を明示的に求めた
2. ドメイン分析で、案件がその規制の対象であることが**入力から確認できた**（推測ではなく根拠がある）

「決済システムだから当然この規格が要る」という業界知識からの補完は、要求の捏造と同じ失敗である。

## 書き方

- **「〜に準拠している」と書かない。** このスキルは適合性評価を行わない。
- 書いてよいのは、このスキルが実際に強制している範囲だけ。
  - 良い: 「JIS Z 8301 が定める助動詞対応に従う」「ISO/IEC/IEEE 29148 の考え方に基づく」
  - 悪い: 「本仕様書は ISO/IEC/IEEE 29148 に準拠している」

## 条番号を書いてよい典拠（一次情報で本文を確認済み・2026-08-10 時点）

| 典拠 | 確認できている内容 |
|---|---|
| **RFC 2119 / RFC 8174** | MUST / MUST NOT / REQUIRED / SHALL / SHALL NOT / SHOULD / SHOULD NOT / RECOMMENDED / MAY / OPTIONAL の定義。RFC 8174 は「これらの語は**全て大文字で書かれている場合にのみ**定義された意味を持つ」と明確化した |
| **JIS Z 8301** | shall →「しなければならない」/ should →「することが望ましい」/ may →「してもよい」の日本語対応を公式に規定。助動詞規約の唯一の公的根拠 |
| **ISO/IEC/IEEE 29148:2018**（Second edition, 2018-11-30 発行。2011 年版を supersede） | 全文 PDF を取得して逐語確認済み。§7（情報項目は BRS/StRS/SyRS/SRS の 4 種）、§9.4（StRS の規定内容 9.4.1〜9.4.19）、§9.6（SRS の規定内容 9.6.1〜9.6.20）、§9.6.1（節の並び順はプロジェクト裁量）、§5.1・§5.2.7（助動詞規約が全情報項目に及ぶ）、§3.1.19・§3.1.4（requirement / X requirements specification の定義）。**全文検索で `PRD` は一度も出現しない**。詳細は `prd-and-spec.md` |
| **ISO/IEC Directives Part 2 Clause 7** | shall = requirement / should = recommendation / may = permission / can = possibility & capability |
| **現行 21 CFR Part 820（QMSR）** | 下記「廃止済み規制」参照 |
| **金融庁「主要行等向けの総合的な監督指針」** | III-3-7-1 システムリスク、III-3-7-1-2(6) システム企画・開発・運用管理、III-3-10-2(7) 設計・開発段階からのプロジェクトマネジメント |
| **IPA の要件定義関連資料** | 要件定義文書の日本語の曖昧さ低減を扱い、「鉄道、バス**等**の公共交通機関」の『等』を曖昧語の具体例として名指ししている |
| **EARS（Easy Approach to Requirements Syntax）** | 公式ガイド（alistairmavin.com/ears/）で 5 パターンのテンプレート構文と例文を逐語確認済み。Ubiquitous / State-driven（While）/ Event-driven（When）/ Optional feature（Where）/ Unwanted behaviour（If ... then）と、複合形（While ..., When ...）。2009 年に Alistair Mavin と Rolls-Royce の同僚が発表 |

**EARS の扱い**: このスキルは 5 パターンを**条件節の書式として借りている**だけである。
「EARS に準拠している」とは書かない（§書き方の原則どおり、実際に強制している範囲だけを述べる）。
なお公式ガイドには発表会議名の記載が無いため、会議名は書かない。

### 証拠強度の注記

ISO/IEC/IEEE 29148 について、業界で「個別要求 9 項目（necessary / complete / singular /
unambiguous / correct / verifiable / appropriate / feasible / conforming）、要求セット 5 項目
（complete / consistent / feasible / comprehensible / validatable）」という要約が流通している。
**この 14 語のリストは規格本文からの逐語確認ではなく、二次情報に依拠する。**
特性名の列挙は「業界で流通している要約」として扱い、逐語引用として提示しない。

規格本文は有料である（ISO 公式 CHF 227。無料公開は 14 ページのプレビューのみ）。
`prd-and-spec.md` §8 に挙げた条番号は全文 PDF を取得して逐語確認した範囲であり、
**そこに無い条番号を書かない**。「節が存在すること」を確認しただけの条番号を、
内容の引用として使わない。

## 条番号を書いてはならない規格（本文未確認）

以下は有料または取得できず、本文を確認できていない。**存在と大まかな射程には触れてよいが、
条番号・逐語要求は書かない。**

- IEC 62304（医療機器ソフトウェアのライフサイクル）
- ISO 14971（リスクマネジメント）
- ISO 13485（品質マネジメントシステム）
- JIS T 2304
- INCOSE Guide for Writing Requirements
- FISC「金融機関等コンピュータシステムの安全対策基準・解説書」本体

書き方の例:

- 良い: 「医療機器ソフトウェアの安全クラス分類に相当する区分を設ける」
- 悪い: 「IEC 62304 §5.2.2 が要求するとおり〜」

script（`draft.js` / `refine.js` の `structuralFindings`）は、これらの規格名の直後に節番号らしき数字が続く形を文字列検査で拾い、
指摘として返す。

## 廃止済み規制（学習データが古いことによる最大の危険）

**FDA の 21 CFR 820.30 Design Controls は現在存在しない。**

QMSR 最終規則（Federal Register doc 2024-01709、2024-02-02 公布、**2026-02-02 施行済み**）に
より 21 CFR Part 820 が再編され、旧 §820.30 は `[Reserved]` 化された。eCFR versioner API で
現行本文を全文取得して確認した結果、次の語は**現行条文に一度も出現しない**。

- `design input`
- `design output`
- `design history file` / `DHF`

設計開発要求は §820.10(c) が ISO 13485:2016 Clause 7.3 への準拠を求める形に置き換わり、
QMSR は DHF ではなく "medical device file" の語を使う。§820.3 Definitions からも設計管理関連の
定義語は消えている。

### 生成文書で使ってはならない語

`21 CFR 820.30` / `820.30` / `design input` / `design output` / `design history file` / `DHF`

**設計インプット / 設計アウトプットという概念自体は、設計モデルとしては依然有用である。**
使いたい場合は「歴史的な設計統制モデル」であることを同じ段落に明記し、**現行 FDA 規則の
引用としては提示しない**。

script（`draft.js` / `refine.js`）がこれらを完全一致で検査する。agent の判断に委ねないのは、この 4 語が
精密に定義できるからであり、精密に定義できる禁止事項の混入検出は機械検証が正しい形だからである。

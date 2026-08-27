# PRD と仕様書はそれぞれ何を書く文書か

**目次**: [1. PRD に規格上の定義は無い](#1-prd-に規格上の定義は無い) · [2. 規格が定義する文書種別（ISO/IEC/IEEE 29148）](#2-規格が定義する文書種別isoiecieee-29148) · [3. 要求と仕様を分ける軸は 2 つある](#3-要求と仕様を分ける軸は-2-つある) · [4. 目的側に書くもの](#4-目的側に書くもの) · [5. 手段側に書くもの](#5-手段側に書くもの) · [6. 助動詞規約はどちらにも及ぶ](#6-助動詞規約はどちらにも及ぶ) · [7. 目的の定義が分量を決める](#7-目的の定義が分量を決める) · [8. 他の体系が定める記載項目](#8-他の体系が定める記載項目) · [9. 分量について何が言われているか](#9-分量について何が言われているか) · [10. 典拠の強度](#10-典拠の強度)

このファイルは「**何を書く文書なのか**」を定める。要求文を**どう書くか**は
`requirement-writing-rules.md`、章立ては `document-structure.md` が扱う。

## 1. PRD に規格上の定義は無い

**ISO/IEC/IEEE 29148:2018 の全 95 ページに `PRD` / `Product Requirements Document` は
一度も出現しない。** 規格は PRD という文書種別を定義していない。

PRD はプロダクトマネジメント実務の慣行語であり、公式標準を持たない。したがって
「PRD にはこう書くべき」という主張は、**規格の権威ではなく実務慣行の権威**に基づく。
この区別を文書の中で崩さない（規格由来でないものを規格由来のように書かない）。

`MRD` / `BRD` / `FSD` も同様に公式標準を欠く。**公式定義を持つのは StRS / SRS / SyRS / BRS
だけ**であり、この非対称性が用語の混乱の原因になっている。

## 2. 規格が定義する文書種別（ISO/IEC/IEEE 29148）

Clause 7 が定める情報項目は次の 4 種（＋ Annex A の OpsCon、Annex B の ConOps）。

| 文書 | 何を書くか | 規定 |
|---|---|---|
| BRS | 事業要求 | Clause 9.3 |
| **StRS** | ステークホルダーの要求。業務環境・事業モデル・運用概念・利用シナリオ・利用者要求 | **Clause 9.4** |
| SyRS | システム要求 | Clause 9.5 |
| **SRS** | ソフトウェアが満たすべき機能・非機能・インタフェース・設計制約 | **Clause 9.6** |

**このスキルが作る 2 種は、規格の枠組みでは StRS 相当と SRS 相当にあたる。**
「PRD」と呼ぶ場合も、中身は StRS 相当だと理解して書く。

## 3. 要求と仕様を分ける軸は 2 つある

**同じ語が別の軸で使われている。** どちらの軸で話しているかを取り違えない。

### 軸 A: 粒度（ISO/IEC/IEEE 29148・NIST）

- `requirement` = **個別の文**（statement which translates or expresses a need and its
  associated constraints and conditions — §3.1.19）
- `specification` = **それらを束ねた文書**（29148 は `specification` 単独の見出し語を持たず、
  常に `X requirements specification` = structured collection of the requirements として定義する）

この軸では、**specification は requirement を内容として含む**。「what 対 how」ではない。

### 軸 B: 目的と手段（IIBA BABOK v3・PMI）

- business requirements = 「なぜこの変更を始めたのか」を述べる目標・成果
- solution requirements = それを実現する機能・非機能の詳細

**このスキルは軸 B を採る。** 要求文書に目的（なぜ・誰のために・何を達成したいか）を書き、
仕様書に手段（何が必要で、どう実現するか）を書く。軸 A を否定するわけではなく、
2 つの文書を分ける実務上の基準として軸 B が使いやすいからである。

軸 A は「文と文書」の関係を述べているだけで、**2 文書に分けるときの基準を与えない**。

## 4. 目的側に書くもの

29148 Clause 9.4（StRS の規定内容）と、実務慣行（SVPG / Atlassian / 国内 PdM 実践）が
共通して挙げる項目。**「どういう価値を、誰の、どんな状況のために作るか」がここに入る。**

### 行動するのに必須なもの

| 項目 | 中身 | 典拠 |
|---|---|---|
| 何を作るのか・何のために | 解こうとしている課題と、作ろうとしている価値 | 29148 §9.4（規定） |
| 誰のためか | 誰が何をしたいか（利用者要求） | 29148 §9.4（規定） |
| どう使われるか | 運用概念・利用シナリオ | 29148 §9.4（規定） |
| やらないこと | スコープ外 | 29148 §9.4（project constraints）＋ 実務慣行 |
| 前提と依存 | 成り立つために前提としていること・他システムへの依存 | 実務慣行 |

**この 5 つが揃えば、次の工程は動き出せる。** 目的側の文書に必須な**内容項目**はここまでで
ある（**章立て**は `document-structure.md` §1 が定める。器の章 — 要求一覧・未確定事項 — が
そちらに加わる）。

### 何を「やらないこと」に回すか

1 つ目（何を作るのか・何のために）が決まると、判定できる。

> **その要求が無くても、そこで定義した価値は成立するか。成立するなら、やらないことへ回せる
> 候補である。**

**MVP（Minimum Viable Product）が言っているのは、この判定である。** 価値が成立する最小の範囲を
先に決めれば、残りは「今回やらない」と書けば済む。判定基準を持たずにスコープを引くと、
「あったほうがよい」が全部入る。

§5 の `Necessary`（消したら他の要求で埋まらない欠落が出るか）とは**別の問い**である。
`Necessary` は要求の集合の内側を見て重複と導出を落とし、こちらは**価値の側から範囲を切る**。
片方だけでは、集合として整合しているが価値に不要な要求が残る。両方を通す。

### 必要があれば足すもの（オプショナル）

| 項目 | 何のためにあるか |
|---|---|
| 期待するアウトカム・KPI | 事業として投資判断・効果測定を要するとき |
| モニタリング | リリース後に継続的な観測が要るとき |
| 受け入れ条件 | 完成の判定に関係者間の合意が要るとき |
| 事業モデル・業務環境の詳細（市場・競合・自社の位置づけ = いわゆる 3C、既存業務との接続） | 組織の業務プロセスに組み込むとき・投資判断に説明が要るとき |
| 関係者一覧 | 同期すべき相手が複数いるとき |

**これらは事業の都合であって、行動するのに必須ではない。** KPI が無くても実装は始められる。
個人が自分のために作るものなら、目的が 1 行で共有できていればそれで足りる。

**判定基準は「行動するのに必須か」**である。「規格に載っているから」「テンプレートにあるから」
で常設にしない。載せる根拠が案件の側に無い項目は、書かせると空欄か、埋めるための作文になる。

利用者要求は「私が A なら、B したい。なぜなら C だから」の形（ユーザーストーリー）で書いて
よい。この形式は Atlassian の定義が広く使われている実務慣行であり、規格の規定ではない。

## 5. 手段側に書くもの

29148 Clause 9.6（SRS の規定内容）。

Purpose / Scope / Product perspective / 各種インタフェース / **Specified requirements** /
External interfaces / Functions / Usability / Performance / Logical database requirements /
Design constraints / Standards compliance / Software system attributes / Verification /
Supporting information

**`Specified requirements`（§9.6.10）は SRS の 1 節に過ぎない。** ここだけが膨らんで
他の節と目的側の文書が痩せている状態は、規格の基準でも不完全である。

なお §9.6.1 は「節の並び順はプロジェクトの情報管理方針に従って選んでよい」と留保している。
**規定されているのは内容項目であって、章の順序ではない。**

### どこまで書けば十分か（下限）

§9.6.10 が定めている。

> Specify the software system requirements to a **level of detail sufficient for software
> design, development and verification** of the software increment or release in process.

**下限は絶対値ではなく、目的への相対で与えられている。** 設計・実装・検証ができる程度まで
であり、それ以上でもそれ以下でもない。しかも「処理中の increment / release」に相対化されて
いるので、**今回作らない範囲について詳細を書く義務は無い**。

### 書きすぎとは何か（上限）

§5.2.5 の `Appropriate` 特性が、規格中で唯一「詳細の量」を直接名指しする規範文である。

> 要求の具体的意図と詳細の量は、**その要求が指すエンティティの階層レベルに対して適切**である
> こと。This includes **avoiding unnecessary constraints on the architecture or design**
> while allowing **implementation independence** to the extent possible.
>
> NOTE 1: including **design solutions** in the requirements creates the risk that
> **potential design solutions could be overlooked or eliminated**.

**上限は「設計解を書き込んだ時点」である。** 詳しく書くほど良いのではない。実装方法を
決めてしまうと、他の設計解が検討される前に排除される。IEEE 830 も同じことを述べている
（§4.2(b)「Should not describe any design or implementation details」、§4.7「what functions
are to be performed... should not normally specify design items」）。

これが**手段側の上限を与える唯一の理屈**である。目的側の「行動するのに必須か」に対応する。

### 詳細は削るのではなく、逃がす

同じ NOTE 1 が逃がし先を指定している。

> ...the information is documented and communicated in **some other form of documentation,
> such as the requirements attributes in 5.2.8 (e.g., rationale)**

**「なぜそう決めたか」は要求本体から外し、属性として別に記録する。** §5.2.8 は rationale を
含む 8 属性を、要求本体とは別に紐付けるものとして定義している。要求文の中に判断の理由を
書き込んで長くするのではなく、場所を分ける。

### 1 項目の単位

§5.2.5 の `Singular` が定める。

> The requirement states a **single capability, characteristic, constraint or quality factor**.
>
> NOTE 2: Although a single requirement consists of a single function, quality or constraint,
> it **can have multiple conditions** under which the requirement is to be met.

**能力・特性・制約・品質要因が 1 つなら 1 項目である。** 条件が複数あっても分割しない
（「〜の場合かつ〜のとき」は 1 要求のままでよい）。

### 項目を残すかの判定

§5.2.5 の `Necessary` が**削除テスト**を与える。

> If it is **not included** in the set of requirements, a **deficiency** in capability or
> characteristic will exist, **which cannot be fulfilled by implementing other requirements**.

**その項目を消したとき、他の項目を実装しても埋まらない欠落が生じるか。** 生じないなら、
その項目は不要である。他の要求から導ける記述・言い換え・補足説明はここで落ちる。

あわせて `Complete`（要求単体で理解でき、他の情報を要さない）と `Verifiable`（実現を検証
できる）が個別項目の基準、§5.2.6 が**要求の集合**に対する基準（Complete / Consistent /
Feasible / Comprehensible / Able to be validated）を与える。個別と集合で基準が別にあることを
取り違えない。

### 手段側の判定基準（まとめ）

| 問い | 基準 | 典拠 |
|---|---|---|
| 足りているか | 設計・実装・検証ができるか | §9.6.10 |
| 書きすぎか | 設計解を書き込んでいないか | §5.2.5 Appropriate + NOTE 1 |
| 1 項目か | 能力・特性・制約・品質要因が 1 つか | §5.2.5 Singular |
| 要るか | 消したら他で埋まらない欠落が出るか | §5.2.5 Necessary |
| 判断の理由 | 要求本体ではなく属性へ | §5.2.5 NOTE 1・§5.2.8 |

## 6. 助動詞規約はどちらにも及ぶ

29148 §5.2.7 の助動詞規約（shall / should / may / will）は、**規格が定義する全情報項目に
適用される**（§5.1 が「requirements statements themselves, and to the information items
generated during the process of documenting requirements」に適用すると明言する）。
SRS 固有の規約ではない。

したがって「目的側の文書に `shall`（〜しなければならない）を使うのは不適切」という規範は、
**規格に根拠を持たない**。目的側の文書でも助動詞規約を適用してよい。

ただし、**助動詞を守っていることは、書くべき内容が揃っていることを意味しない。**
すべての項目が「〜しなければならない」で終わっていても、運用概念とアウトカムが無ければ
その文書は目的を果たしていない。**形式の適合と内容の充足は別の検査である。**

## 7. 目的の定義が分量を決める

文書の目的をどう置くかで、書く量が構造的に決まる。

| 目的の置き方 | 生じる圧力 |
|---|---|
| 「読んだ者が迷いなく着手できる」 | 足りないものがあれば書き足す。**上限が無い** |
| 「関係者の認識が一致している」 | 一致すれば足りる。**認識の差だけを書けばよい** |

後者を採ると、既に合意されていることは書かなくてよくなる。逆に前者を採ると、書けば書くほど
目的に近づくことになり、際限なく増える。

**このスキルは後者を採る。** 要求文書の分量は「認識を一致させるのに要る量」で決まり、
網羅性では決まらない。

### 目的側の文書が短いことは欠陥ではない

**個人が自分のために作るものなら、目的が 1 行で共有できていればそれで足りる。**
関係者が自分だけなら、同期すべき相手がいない。KPI も受け入れ条件も、事業として投資判断や
効果測定を要するから書くのであって、行動を始めるのに要るものではない。

案件の規模に応じて目的側は伸び縮みする。**縮んだ状態を「不足」と判定しない。**

| 案件 | 目的側の分量 |
|---|---|
| 個人が自分のために作る | 1 行〜数行で足りることがある |
| 少人数のチームで作る | 何を・誰のために・どう使うか・やらないこと |
| 事業として投資判断が要る | ＋ §4「必要があれば足すもの」のうち案件が要求するもの（アウトカム・KPI / モニタリング / 受け入れ条件 / 事業モデル・業務環境 / 関係者一覧） |

手段側（仕様書）は事情が違う。**実装が一意に決まる必要があるため、案件が小さくても
目的側より詳しくなる。** 目的側と手段側で分量の決まり方が違うことを取り違えない
（目的側を網羅で書き、手段側を曖昧に済ませるのが最も悪い形になる）。

## 8. 他の体系が定める記載項目

同じ領域に複数の体系がある。**どれも互いに矛盾しない** — 目的側か手段側か、どの規模を
想定しているかが違うだけである。案件に合うものを選ぶ。

### 目的側の型

| 体系 | 記載項目 | 権威 |
|---|---|---|
| **Shape Up の pitch**（Basecamp / Ryan Singer） | Problem / **Appetite**（どれだけ時間をかけるか）/ Solution / Rabbit Holes（危険な深掘り先）/ No-Gos | 企業の実務＋個人の提唱 |
| **PR-FAQ**（Amazon / Working Backwards） | 見出し・サブ見出し・要約・課題・解決策・引用・入手方法・FAQ。**完成時のプレスリリースを先に書く** | 企業の実務（書籍） |
| 29148 §9.4（StRS） | 業務環境・事業モデル・運用概念・利用シナリオ・利用者要求・制約 | 国際規格 |

**Appetite（先に時間の上限を決める）は他の体系に無い発想である。** 「どこまで作るか」を
解の側ではなく投資の側から縛るため、要求が際限なく増える構造にならない。

### 設計判断の記録（**仕様書ではない**）

この 2 つは仕様書と混同されやすいが、**どちらも「実装が一意に決まる粒度」を目指していない**。
そう明言している。

| 体系 | 記載項目 | 権威 |
|---|---|---|
| **Google の design doc**（Malte Ubl） | Context and scope / **Goals and non-goals** / The actual design / **Alternatives considered** / Cross-cutting concerns | 個人（当事者エンジニア）。Google 社の公式規定ではない |
| **ADR**（Michael Nygard） | Title / Status / **Context（働いている力）** / Decision / **Consequences（決定後に生じる状況）** | 個人の提唱 |

design doc について、原典は次のように述べている。

> The design doc is the place to write down the **trade-offs** you made in designing your software.
>
> A clear indicator that a doc might not be necessary are design docs that are really
> **implementation manuals**.（実装マニュアル化した doc は、そもそも不要のサイン）
>
> Design docs should **rarely contain code, or pseudo-code**.

ライフサイクルも Creation → Review → Implementation → Maintenance の 4 段階で記述され、**独立した仕様書の工程を持たない**（原文には DRAFT/FINAL 等の状態ラベルは無い — 再確認 2026-08）。

ADR は「1 文書 = 1 つの重要な決定」であり、目的は**決定の背後にある動機を残すこと**である
（「プロジェクトの生涯で最も追跡が難しいものの 1 つは、ある決定の背後にある動機である」）。
何を作るかを定める文書ではない。

**`Alternatives considered` と `Consequences` は 29148 に無い。** 「なぜ他の案ではないのか」
「この決定で何を引き受けるのか」は、後から読む者が最も知りたいことでありながら、規格系の
テンプレートには場所が無い。設計判断を含む案件では、仕様書とは別にこの記録を置く価値がある。

### 仕様（手段側）の型

| 体系 | 記載項目 | 権威 |
|---|---|---|
| IEEE 830-1998 | Introduction / Overall description / Specific requirements | 国際規格（recommended practice） |
| Volere | Project Drivers / Mandated Constraints / Functional / Non-Functional（8 分類） | 民間著作物（Robertson 夫妻） |
| 29148 §9.6（SRS） | §5 参照 | 国際規格 |

**仕様書の型を持つのは規格系だけである。** 下記 §9 の軽量な体系はいずれも仕様書を持たない。

### 受け入れ条件・利用者要求の書式

| 体系 | 何を定めるか | 権威 |
|---|---|---|
| Gherkin（Given-When-Then） | 受け入れ条件の**構文**。記載項目や分量は定めない | OSS プロジェクトの慣行（規格ではない） |
| ユーザーストーリーマッピング（Jeff Patton） | backbone / walking skeleton / release slices | 個人の提唱 |
| IPA 非機能要求グレード | 非機能要件の 6 大項目（可用性・性能拡張性・運用保守性・移行性・セキュリティ・システム環境エコロジー） | 国内公的機関の実務ガイド（規格ではない） |

## 9. 分量について何が言われているか

**提唱者自身が上限を明示している体系がある。** 「短くてよい」は手抜きの正当化ではなく、
複数の一次情報が独立に述べている設計判断である。

| 体系 | 分量の指針 |
|---|---|
| **ADR**（Nygard） | 「文書全体は 1〜2 ページに収めるべき」と**原型記事が明記** |
| **PR-FAQ**（Amazon） | プレスリリースは数段落・**常に 1 ページ未満**、FAQ は 5 ページ以下（合計 6 ページ程度） |
| **Google design doc** | 大規模で 10〜20 ページが sweet spot、**小規模には 1〜3 ページの mini design doc** |
| **IEEE 830-1998** | アウトラインの使用を強制せず、Annex A で Specific requirements だけでも **8 通りの代替構成**を提示 |

**IEEE 830 は国際規格でありながら構成のテーラリングを明示的に許容している。** 「規格に
載っているから全項目必須」という読み方は、規格自身が支持していない。

### この分量指針を仕様書へ転用してはならない

**上表の 4 体系のうち、仕様書の分量を述べているものは 1 つも無い。** ADR・design doc・
pitch・PR-FAQ はいずれも仕様書ではなく、原典がそう明言している。

- Shape Up: **「This isn't a spec.** It's more like the boundaries and rules of a game.
  It could go in countless different ways once it's time to play.」
- design doc: 実装マニュアル化した doc は不要のサイン。code / pseudo-code を含めない

したがって「ADR は 1〜2 ページでよい」から「仕様書も短くてよい」を導けない。

### 短さには 2 つの別々の機構がある

短い理由が違うと、移植できるかどうかも違う。

| 機構 | 何をしているか | 該当 | 仕様書へ移植できるか |
|---|---|---|---|
| **詳細を文書の外へ逃がす** | 実装者の判断・コード・プロトタイプに委ねる | Shape Up / design doc | **できない**。仕様書は委ねないために書くものだから |
| **対象範囲を 1 単位に限定する** | 1 文書 = 1 つの決定。文書を増やして 1 文書を薄く保つ | ADR | **単位が見つかれば可能**（後述） |

Shape Up は詳細を省く理由を「後続フェーズのデザイナーに余地を与えるため」と明言し、
実装者に委ねる範囲も定めている（shaped work は **rough / solved / bounded** の 3 特性を持ち、
チームは境界の内側で自分のタスクとアプローチを決める）。**委ねることが設計の目的**であって、
書けなかったから短いのではない。

**このスキルの仕様書は機構 1 を使えない。** 読み手が判断を委ねられる相手ではなく、
「実装が一意に決まる」ことを目的にしているためである。使えるとすれば機構 2 — ただし
ADR の「1 決定」に相当する単位を仕様書側で見つける必要がある。**単位が決まらないまま
1 文書に詰め込むと、機構 2 も働かない。**

分量に上限を置く体系はいずれもプロダクト開発・設計判断の文脈にあり、網羅を求めるのは
規制産業・調達契約の文脈である。**どちらが正しいかではなく、案件がどちらの文脈にあるかで
決まる。**

## 10. 典拠の強度

**一次情報で本文を確認済み**（条番号を引用してよい）:

| 典拠 | 確認した内容 |
|---|---|
| ISO/IEC/IEEE 29148:2018 §7 | 情報項目は BRS / StRS / SyRS / SRS の 4 種 |
| 同 §9.4 | StRS の規定内容（9.4.1〜9.4.19） |
| 同 §9.6 | SRS の規定内容（9.6.1〜9.6.20）。§9.6.1 の並び順の留保 |
| 同 §5.1・§5.2.7 | 助動詞規約が全情報項目に及ぶこと |
| 同 §3.1.19・§3.1.4 | requirement と X requirements specification の定義 |
| 同 §9.6.10 | 詳細度の下限（design/development/verification に十分） |
| 同 §5.2.5 | Appropriate（詳細の量・設計解を含めない・NOTE 1 の逃がし先）/ Singular / Necessary / Complete / Verifiable |
| 同 §5.2.6・§5.2.8 | 要求の集合の 5 特性 / rationale を含む 8 属性 |
| IEEE Std 830-1998 §4.2(b)・§4.7・§5.3.7・§5.3.8 | 設計詳細を書かない旨、構成 8 通りの選択基準 |
| 同 全文検索 | `PRD` が一度も出現しないこと |
| NIST CSRC Glossary | requirement / specification の定義の出所 |
| IIBA BABOK v3 / PMI | business requirements と solution requirements の対比 |

| IEEE Std 830-1998 §5・Figure 1・Annex A | SRS の章立てと、Specific requirements の 8 通りの代替構成 |
| Shape Up（無料公開） | pitch の 5 要素 |
| Malte Ubl "Design Docs at Google" | 項目立てと分量の目安 |
| Michael Nygard "Documenting Architecture Decisions"(2011) | ADR の 5 項目・「1〜2 ページ」・1 文書 = 1 決定・目的は動機の保存 |
| Shape Up ch.4 / ch.2 / ch.10 | breadboard と fat marker sketch の定義、**"This isn't a spec"**、rough/solved/bounded、実装者へ委ねる範囲 |
| industrialempathy.com（Malte Ubl） | design doc がトレードオフの記録であること、実装マニュアル化は不要のサイン、ライフサイクル 4 段階（Creation/Review/Implementation/Maintenance） |
| Cucumber 公式 Reference | Gherkin の構文 |
| Volere 公式サイト | テンプレートのセクション構成 |
| JISC 規格データベース / JIS X 0166 本文注記 | JIS X 0166 の実在と、2014 年版が 29148:2011 に IDT であること |
| JIS Z 8301:2019 箇条 7 表 3〜表 6 | 助動詞的表現の日本語対応 |
| IPA 公式 | ユーザのための要件定義ガイド 第 2 版 / 非機能要求グレード |

**実務慣行**（規格の権威を持たない。そう明示して使う）:
SVPG（Marty Cagan）/ Atlassian / 国内 PdM の実践記事 / Shape Up / PR-FAQ /
Google design doc / ADR / Gherkin / ユーザーストーリーマッピング / IPA のガイド。
アウトカム・モニタリング・受け入れ条件・ユーザーストーリー形式・**分量の上限**は
ここに由来する。

### 日本語で書くときの根拠

**助動詞の日本語対応の根拠は JIS Z 8301 である。** ただし同規格が定めるのは**規格票の
書き方**であって、要求文書一般の書き方ではない。要求文書へ適用するのはこのスキルの判断で
あり、規格がそう命じているわけではない。

JIS X 0166 は 29148 の JIS 版だが、**日本語の要求用語（要求 / 要件 / 仕様）を本文で定義して
いるかは未確認**である。確認できるまで「JIS X 0166 が〜と定めている」とは書かない。

IPA の「ユーザのための要件定義ガイド」「非機能要求グレード」は規格ではなく、公的機関が
発行する実務ガイドである。非機能要件の 6 大項目を引くときはその出所を明示する。

### 確認できていないこと（書かない）

- JIS X 0166 の 2021 年版が 29148:2018 に対して IDT か MOD か
- JIS X 0166 が日本語の要求用語・助動詞規約をどう表現しているか
- 29148 / JIS X 0166 にテーラリング（情報項目の省略を許す）条項があるか
- IEEE 830-1998 が 29148 によって正式に廃止されたか
- Shape Up が pitch そのものの分量に言及しているか（breadboard / fat marker sketch の粗さの理由は確認済み）
- Amazon が PR-FAQ 承認後に仕様書に相当する文書を書くか（**未確認。書かないとは断定しない**）
- 29148 / IEEE 830 / Volere に「1 文書が大きくなりすぎたら分ける」旨の記述があるか
  （**要求数への言及は 29148 に無いことは確認済み**。分割の指示の有無は未確認）
- SVPG が近年「PRD を書くな」と主張しているか（2006 年の記事で「唯一 spec の要件を満たせる
  形式は高忠実度プロトタイプ」と述べていることは確認済み。**それ以降の変化は未確認**）

**規格本文は有料**（ISO 公式 CHF 227）。無料公開されているのは 14 ページのプレビューのみ。
上表の条番号は全文 PDF を取得して逐語確認したものに限る。**確認していない条番号を書かない**
（`citation-policy.md` の規律をこのファイル自身にも適用する）。

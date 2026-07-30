# 委譲呼び出し契約（他スキルからの起用）

`/chat` は他スキルから `Skill({skill: "chat"})` 経由で直接起用されることを想定している。
現在の呼び出し元: `magi-issue-resolver`（Step 5 の機械的起動条件に該当した diff を、Fable 追加
レビューとしてこのスキルへ渡す。magi-issue-resolver スキルの Step 5-5）。

呼び出し元は相談文の先頭に委譲ヘッダを付す:

```
[SKILL_DELEGATION caller=<skill> purpose=code-review]
<相談文本体（diff とレビュー観点）>
```

SKILL.md 側の判定ロジック（Step 0.5・Step 1・Step 5 のスキップ）は SKILL.md 本体に書く。
このファイルには、その判定の**理由**（通常のユーザー起動フローでは毎回読まれる必要のない、
委譲時にのみ関係する契約説明）を集約する。

## Why Step 1（investment-topic-router）をスキップするか

コードレビュー依頼の diff は金融ドメインのコード（`src/domain/` 等）を必然的に含みうるため、
`detect_investment_topic.py` の INTENT キーワード判定（「目標株価」「割安」「割高」等）が実コード
中の識別子・コメントに反応し、**最もレビューが必要な diff ほど誤って investment-strategist へ委譲
される**という逆相関が実測で確認されている。委譲元スキルはコードレビュー依頼のみを渡す契約で
あり、投資判断の規制境界は investment-strategist 側に一元化されたまま変わらない（このスキップは
chat 内の判定を省くだけで、investment-strategist の規制ガードには一切触れない）。

## ヘッダの spoof 可能性について

ヘッダは理屈上ユーザーも打てば通過できる（spoof 可能）。これは受容する — sounding-board-consultant
は元々助言のみで行動を取らず、投資判断の最終ガードは investment-strategist 側の規制境界に一元化
されているため、Step 1 を迂回しても規制上の抜け穴は生まれない。ユーザーが自分自身のガードを
明示的に外す操作を防ぐことは、このスキルの責務の範囲外と判断する。

**ヘッダのスキップと `detect_investment_topic.py` 側の diff/コード片除去は代替ではなく相補的**:
ヘッダは委譲元スキルからの呼び出しにのみ効く。ユーザーが手で `/chat` にコード片を貼り、そこに
「割安」等の語が含まれる場合は今日でも Step 1 を通り、同じ誤ルーティングが起こりうる
（`[SKILL_DIR]/scripts/detect_investment_topic.py` 側の前処理で別途対処する。詳細は当該ファイル参照）。

## Why Step 5（Notion 記録）もスキップするか

個人の技術壁打ちログ（Notion「Fable 相談ログ」DB）に、他スキルからの委譲呼び出し（コードレビュー
目的）を混在させない。ユーザー自身が `/chat` で行った相談だけを記録対象とする設計判断。

## Why Step 4（relay-formatter）を purpose=code-review では skip するか

relay-formatter の非劣化保証（トーンダウン・捏造の防止）は、**整形結果を人間が読む**ことを前提に
価値を持つ。`purpose=code-review` の委譲では消費者は呼び出し元スキル（コントローラ自身）であり、
Step 3 の raw 出力をそのまま読める。整形は Sonnet 1 hop を追加するだけで、コントローラ向けの
非劣化保証としては何も担保しない（劣化のリスクがあるのは「人間に見せる文言」のときだけ）。

Issue #830 反復（`magi-issue-resolver` PR #879）で Step 4 を意図的にスキップし raw 出力を直接
読んだ結果、Fable の指摘（QualityRiskStrategy の不整合フォールバック除去 + guards docstring 改善 +
既存 Issue #871 への追記）は取りこぼしなく反映できた。劣化は観測されていない。

他の呼び出し元・他の `purpose` を追加する際は、消費者が人間かコントローラかを再確認し、
人間に relay する経路では Step 4 を必ず通すこと（この skip は `purpose=code-review` かつ
消費者がコントローラ自身であるケースに限定する）。

## 今後の再検証ポイント（未着手・記録のみ）

`investment-topic-router`（agent）が `Skill({skill: "investment-strategist"})` を呼ぶ経路は、
本ファイルが扱う「委譲元から `/chat` を呼ぶ」経路とは逆方向（`/chat` から他スキルを呼ぶ経路）だが、
同じ「subagent コンテキストからの委譲呼び出しが実際に機能するか」という懸念を共有する
（詳細は `references/notion-recording-guide.md` §subagent が継承できないケイパビリティ 参照）。
investment-strategist 自体は script 実行・riopon-rag・MAGI 等、インタラクティブ認可コネクタに
依存しない構成であるため実害の可能性は低いと推測されるが、実地確認はまだ行っていない。

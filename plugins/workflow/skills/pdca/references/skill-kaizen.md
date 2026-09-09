# skill-kaizen: pdca を配布スキル自身に適用する運転手順

対象が「このリポジトリの配布スキル（Workflow を持つもの）」であるときの、pdca 一周の
司令塔手順。ループの契約（Plan の事前固定・作る側と測る側の分離・ゲート①②・decision 規則）は
SKILL.md のままで、ここに書くのはスキル改善に固有の入出力の取り方だけである。

この手順が要るのは、スキル改善の Do/Check が「文書を書く」ではなく「**staging 版スキルで
基準入力を再実行して本体版と比べる**」形を取るため。第 1 サイクル（prd-spec の乾き停止、
2026-09）で実証した手順の定型化であり、各段は実績がある。

## 前提（Plan より先に揃える）

- **目的アンカー**: Plan の goal が trace する上位目的。対象スキルの要求文書（PRD）の
  目的章を使う。無ければ 1〜3 行の運営目的を依頼者と合意してから始める
  （goal は目的から導く。目的を Plan の中で発明しない）。
- **telemetry**: 対象スキルの実行実測が `~/.claude/skill-telemetry/<skill>/` に
  1 run 以上あること。無ければまず通常運転の run を
  `python3 [SKILL_DIR]/scripts/skill_telemetry.py record` で記録するところから（実測ゼロの改善は問題起点に
  ならない — それは動機起点で、成功基準は provisional になる）。
- **再現入力**: 同一入力で再実行できる args 一式（Workflow の wrapper script として保存
  しておく）。これが無いと対照測定が組めない。

## 手順

1. **観測**: `python3 [SKILL_DIR]/scripts/goal_selector.py select --skill <対象>` で
   在庫から候補を選別し、pending 全件を一括提示して依頼者の裁定（approved / rejected /
   done / superseded + 理由）を `decide` で記録する。approved の statement をそのまま
   問題起点の入力にする（selector は在庫の決定的な関数であり、候補を発明しない。
   傾向の目視だけしたいときは `skill_telemetry.py summary`）。
2. **Plan**: SKILL.md どおり intake → evidence-collector → planner。両 agent には
   「対象がスキル自身のとき」の節が効く（事実 = telemetry + 対象スキルの実装、出典必須）。
   選択肢は改稿差分 3 点以内で構成させる。
3. **ゲート①**: Plan 全文を提示し承認を得る（SKILL.md と同じ）。
4. **Do（staging）**: 対象スキルの実体を対象リポジトリの外（scratchpad 等）へ複製し、
   採用案の差分だけを適用する。**本体は触らない。** 対象スキルが tests/ を持つなら
   staging で先に回す（仕様を意図的に変える差分は、テストの契約更新も同じ差分に含める）。
5. **Check（対照 run）**: control（本体版）と treatment（staging 版）を**同一入力・
   独立ドラフト・対で**発行する。互いの作業ファイルを共有させない（run 間の相互影響の
   遮断）。結果は両条件とも `skill_telemetry.py record` で記録してから、事前固定の
   基準で判定する。
6. **ゲート②〜Act**: SKILL.md の decision 規則どおり。standardize の恒久化先は対象
   スキルの本体で、反映は **PR 経由**（マージは不変条件の人間ゲート）。PR 本文に
   run 表・機序・較正（n、束適用の未分離）をそのまま載せる。

## この運転に固有の注意

- **運転手と対象を分ける**: pdca 自身を対象にする改善は、pdca を別の対象で最低 1 周
  運転して telemetry を作ってからにする（エンジンの測定基準が自分ごと動くのを避ける）。
- **staging のベースを固定する**: 対照の意味は「差分以外が同一」で決まる。control と
  treatment は同じコミットから作り、途中で main が進んでも run 中は追随しない。
  standardize 時に本体へ再適用し、他の変更を巻き戻していないかを diff で確認する。
- **telemetry が無い主張は事実にしない**: 過去 run の記憶・会話ログの数値は unverified。
  記録が消えていたら、その run は「無かった」ではなく「未計測」として扱う。

import csv, re
from pathlib import Path
O = Path(__file__).resolve().parent
R = O.parents[2]
def w(name, header, rows):
    with open(O / name, "w") as f:
        f.write("\t".join(header) + "\n")
        for r in rows:
            assert len(r) == len(header), (name, r[0])
            assert all("\t" not in c and "\n" not in c for c in r), (name, r[0])
            f.write("\t".join(r) + "\n")

w("props.tsv", ["property", "decision", "verdict", "reason"], [
 ("P1", "W4・AGENTS.md:85-87・V1", "強すぎ",
  "式は振り分ける pend の全ての指摘に重大度を求め、人の指摘（htriage）も含む（Assigners が人の指摘にも reviewer を返し、TriageGuard が要求する。Flow.tla:166-183）。X3 は人の指摘を重大度を問わず直すので経路に重大度は要らず、人の指摘に重大度を付けることを求める決定は無い（FQ7）。agent・bot の指摘については過不足なし。自己検査の失敗を対象外にしているのは FQ8 の一方の案"),
 ("P2", "AGENTS.md:85-87（司令塔は採点しない）", "過不足なし",
  "司令塔を除くだけで、作り手が付ける場合は P13 が持つ。2 つ合わせて「生成者でも司令塔でもない者が付ける」になる。Triage の g は付いた重大度を上書きできない（Flow.tla:201）ので、by の欄の検査で足りる"),
 ("P3", "D1・files.tsv:7", "過不足なし",
  "drOK は設計への戻りのたびに FALSE に戻る（HandleDefect・Triage の戻り）ので「直前の設計に対する設計レビューの通過」を表す。SkipDR の変異で空虚でないことも確かめられている"),
 ("P4", "D1", "過不足なし（PR を出す＝ready の読み）",
  "PR の段で irOK を求める。人の指摘で設計に戻った後は pr=ready のまま design 以降に居るが、PR の段の外なので検査しない。開いた PR を直す間を禁じる決定は無いので妥当"),
 ("P4D", "D1（別の読み）", "決定に無い（解釈の片側）",
  "draft を含めて「PR を出す」と読む性質。決定は draft の扱いを決めていない。X2「登録まで進めて PR を出し」は出す時点を言うが draft には触れない。P4 と P4D のどちらを採るかは FQ1 の答えで決まる"),
 ("P5", "W4", "過不足なし（仮定に依存）",
  "式は W4 どおり。ただし Kind（真の重大度）で書き、AssignSev が常に Kind[f.d] を付ける（Flow.tla:176）ので、レビュー役の付け間違い（MEDIUM を LOW と付ける）は模型に現れない。decided の通過はこの仮定の下でだけ"),
 ("P6act", "W4「LOW は直さず」", "過不足なし",
  "振り分けで agent・bot の LOW を fixed にしないことを見る。同じ束に MEDIUM があって設計に戻る場合も LOW は fixed にならないことまで含む。仮定は P5 と同じ"),
 ("P6inv", "W4「追わない」", "強すぎ（解釈）",
  "「同じ LOW を PR 本文に載せ直さない」は W4 の「追わない」の読みで、決定の文には無い（brief の言い換え）。目的（purpose.txt 防ぐ失敗 1: 膨らみ）には沿う。Inc が 2 で頭打ちでも ≤1 の検査には足りる"),
 ("P7", "X3・D1", "過不足なし",
  "人の指摘は重大度を問わず設計に戻り fixed になる。経路が設計への戻りであることは D1「指摘を直接直さず設計に戻ってから実装する」から導ける"),
 ("P8", "Q5", "強すぎ（一つの読み）",
  "式は自己検査の欠陥を全て設計に戻す。Q5 は自己検査の欠陥を「設計に戻る」規則に含めると決め、後の W4 がその規則に閾値を入れた。合成すると自己検査の LOW は直さない読み（v4 の読み）も成り立つので、決定から一意でない（FQ8）"),
 ("P9", "Q10", "過不足なし",
  "段を変えず chk を idle に戻すことを見る。idle の後は Work（検査の成功）か SelfCheckFail（検査の失敗）なので「同じ検査のやり直し」に当たる。ただし分類（envR か defect か）が正しいかは表せない（Flow.tla:103-104 で chk' は真の原因と独立に選ばれる）"),
 ("P10", "Q9", "過不足なし", "除けない環境の原因は reported に入る。報告の中身（失敗と理由）は抽象化で落としている"),
 ("P11", "X2・Q9・AGENTS.md:70", "過不足なし",
  "agent の行動が尽きる状態を gate・merged・reported に限る。V10（利用者に問うて止まる）は決定に無いので AllowedStop に入れないのは正しい"),
 ("P12", "決定に無い（brief 由来）", "決定に無い・式は弱い",
  "「止まった状態ごとに次の行動が 1 つに決まる」は answers.txt に無く、AGENTS.md:70 の理由から brief が立てた。式は担い手の集合の包含で、行動の数は見ない（gate で人は HumanComment と HumanMerge の 2 つを持つ）。担い手で読むなら過不足なし"),
 ("P13", "AGENTS.md:76", "弱すぎ",
  "Review・AssignSev の担い手だけを見る。作り手が行う SelfCheckFail の分類と HandleEnvR（環境の原因と判じてやり直す）は対象外で、chk' が真の原因と独立に選ばれる（Flow.tla:103-104）ため誤分類が模型に現れない。V7 が「作業ルール (9) の例外として働く」とした自己判定はこの性質では検出できない（FQ4）"),
 ("P14", "Q9・X2・W4（brief の公平性）", "仮定に依存（弱い）",
  "戻りの辺は全て有限の量を消費する（Triage の戻りは fixS≠{} を fixed に、HandleDefect は 1 つを fixed に、HandleEnvR は envLeft を減らし、HumanComment は hc を増やす）。通過は F1〜F3 から構造上決まり、WF は足踏みを除くだけ。F1（修正が新しい欠陥を持ち込まない）は AGENTS.md:77-78 の「修正が持ち込む欠陥」と食い違い、W4 は回数の上限を置かないので、決定のもとでの終了は F1 に依る。F2（環境の失敗の上限）も決定に無い"),
 ("P15", "X1", "過不足なし", "place は 1 つの値で成果物ごとに分けないが、X1 は規模でだけ分けるので足りる"),
 ("P16", "X1・V7（決定でなく実行可能性）", "決定に無い・案 (a) に偏る",
  "模型は FixPurpose で place を決めると同時に書くと扱う（Flow.tla:78-82）ので、P16 は「書いた時点で置き場がある」を求める。X1 は書く時機を決めていない。FQ1 (b)（PR 作成時に写す）は今の式では P16 を破る形でしか表せず、(a) に有利に偏る"),
 ("P17", "W4・V7（決定でなく実行可能性）", "過不足なし（実行可能性の制約）",
  "「PR 本文に載せた」状態に PR があることは物理的な整合で、決定そのものではない。decided でも破れるので、決定に時機の欠落があることを示す（FQ1・FQ2）"),
])

A = ".work/agents-md/design-review-1/answers.txt"
F = ".work/agents-md/flow-model/Flow.tla"
w("rev.tsv", ["action", "verdict", "reason", "evidence_ref", "evidence_quote"], [
 ("FixPurpose", "決定どおり", "置き場を規模で決める（X1）。担い手を maker にしたのは main の作業ルールから導ける（FQ5 は導ける）", A + ":29", "typo 級は PR 本文、それ以外は commit"),
 ("FixPurpose[DraftForTypo]", "決定に無い（案として分離）", "FQ1 (a) の案。定数で切り替え、決定どおりの版（FALSE）と混ぜていない", F + ":81", "pr' = IF DraftForTypo /\\ scale = \"typo\" THEN \"draft\" ELSE pr"),
 ("FixPurpose（担い手）", "決定どおり", "司令塔は書かず builder 役が書く", "AGENTS.md:99", "生成は builder 役の agent へ dispatch し"),
 ("Work", "決定どおり", "design→dreview、impl→ireview。ガードに Latent={} が無いので検査の見逃しも表す（抽象化として妥当）", A + ":2", "作業の流れを「設計 → 設計レビュー → 実装 → 実装レビュー」に徹底させる"),
 ("SelfCheckFail", "決定どおり（抽象化の限界あり）", "3 つの結果は Q5・Q9・Q10 どおり。chk' は真の原因と独立に選ばれるので誤分類は表せない（P13・FQ4）。envLeft の上限（F2）は決定に無い", F + ":104", "envLeft > 0 /\\ chk' \\in {\"envR\", \"envU\"} /\\ chkD' = 0"),
 ("HandleDefect", "決定どおり（Q5 の一つの読み）", "自己検査の欠陥を全て設計へ戻す。W4 との合成の読みは FQ8。担い手 orch は段の選択（AGENTS.md:90）", A + ":11", "まだレビューに出していないものの欠陥も「設計に戻る」に含める"),
 ("HandleEnvR", "決定どおり", "段を変えずにやり直す。envLeft を減らすのは公平性 F2 のための上限で、決定には無い", A + ":16", "作り手が原因を除いて同じ検査をその場でやり直す（設計に戻らない）"),
 ("HandleEnvU", "決定どおり", "reported に入り止まる。報告を orch が中継するのは AGENTS.md の relay と整合", A + ":15", "失敗と理由を利用者に報告して止める"),
 ("Review", "決定どおり", "レビュー役は作り手と別。Open の任意の部分集合を報告するので見逃しと LOW の再報告を含む", "AGENTS.md:76", "自分が書いた成果物・修正に自分で合格判定を出さず"),
 ("AssignSev", "決定に無い制約（仮定）", "全ての出どころ（agent・bot・人）の重大度をレビュー役が付けると仮定（FQ3・FQ6・FQ7）。付ける値は常に真の重大度で、付け間違いを表せない（P5・P6 の通過はこの仮定に依る）", F + ":176", "pend' = (pend \\ {f}) \\cup {[f EXCEPT !.sev = Kind[f.d], !.by = who]}"),
 ("Triage（戻り）", "決定どおり", "agent・bot の MEDIUM 以上と人の指摘は設計へ（W4・X3）。担い手 orch は閾値による段の選択", A + ":31", "人の指摘は重大度を問わず直す"),
 ("Triage（人の指摘の経路）", "決定から導ける", "人の指摘を設計へ戻すのは D1 から導ける。FQ7 の経路の半分は問いでない", A + ":2", "指摘を直接直さず設計に戻ってから実装する"),
 ("Triage（LOW）", "決定どおり", "LOW は PR 本文（logged）。held は FQ2 の案で定数 HoldLow で分離", A + ":26", "LOW は直さず PR 本文に載せて追わない"),
 ("BotReview", "決定に無い制約（順序）", "bot の指摘の存在は X3 にある。bot→人間ゲートの順序と、PR の段に入るたびに bot が 1 回だけ走ることは模型の仮定（FQ6）", A + ":31", "LOW を追わないのは agent と bot の指摘に限る"),
 ("HumanComment", "決定に無い制約", "人の指摘を gate（bot の後）だけに置き、同じ欠陥は一度だけ（F3）。draft や bot の途中での人の指摘は表さない。X3 は時機を決めていない", A + ":31", "人の指摘は重大度を問わず直す"),
 ("HumanMerge", "決定どおり", "マージは人が行い終端に入る", A + ":30", "マージを人間が行う"),
 ("PubApprove・AskAnswer・ResumeAfterReport", "決定どおり（decided では無効）", "公開＝マージ（X2）なので pubgate は v4 版だけ。問いで止まる（V10）と報告後の再開は決定に無く、変異だけで使う", A + ":30", "マージが公開"),
 ("Done（reported を終端）", "決定どおり", "Q9 の「止める」を終端と読む。報告後に利用者が再開する遷移は決定に無いので持たない", A + ":15", "人間ゲート以外では止めないの止まってよい場所にこの場合を含める"),
 ("欠落の確認", "欠落なし（畳み込みあり）", "D3 の形式検証は自己検査に畳まれている（Q5 が作業段階の中の形式検証を自己検査に含める）。W5 の規模の比例は流れを変えないので遷移の差は無い。決定にある遷移で落ちたものは見つからなかった（D1〜D4・Q1〜Q10・V1〜V5・W1・W3〜W5・X1〜X3 の全行を読んで照らした範囲で）", A + ":11", "作業段階の中の形式検証"),
 ("trace.tsv（出典）", "誤り（軽微）", "answers.txt の行番号が 5 行ずれている（X1 を :24 と書くが今は :29）。answers.txt は 20:50 に D1〜D4 の 5 行が先頭に足され、模型（20:44）より新しい。引用は逐語で一致する。trace は D1〜D4 を一度も引いていない", A + ":29", "X1 成果物の置き場: 規模で分ける"),
])

w("v4.tsv", ["check", "result", "class", "faithful", "reason", "evidence_ref"], [
 ("v4_P1", "fail", "V1 の fail-open（v4 の欠陥）", "yes", "設計段の 6 体の output に重大度が無く、dtriage は重大度なしで振り分けられる（TriageGuard の緩和）", ".work/agents-md/design-v4/agents.tsv:2-8"),
 ("v4_P2", "fail", "模型の推定に依存", "partly", "v4 は付ける者を名指さない。V1 は「司令塔が付ければ (11) に反し、誰も付けなければ fail-open」の両枝を挙げるが、模型は付けるなら orch と置いた（Flow.tla:168）。付ける者の不在は本物の欠陥、P2 の破れという形は写し方の選択", ".work/agents-md/design-v4-review/aggregate/bundles.tsv:2"),
 ("v4_P3・P4・P4D", "pass", "-", "yes", "v4 も流れの順序は決定と同じ", ".work/agents-md/design-v4/files.tsv:7"),
 ("v4_P5", "fail", "V1 の fail-open（v4 の欠陥）", "yes", "重大度の無い MEDIUM を LOW として通す経路。P1 と同じ原因", ".work/agents-md/design-v4/agents.tsv:2-8"),
 ("v4_P6", "fail", "V1 の fail-open（v4 の欠陥）", "yes", "重大度の無い LOW を MEDIUM として戻す経路。P1 と同じ原因", ".work/agents-md/design-v4/agents.tsv:2-8"),
 ("v4_P7", "fail", "v4 より後の決定（X3）", "yes", "v4 は出所を問わず W4 を当てると明示しており、人の LOW を直さない。v4 の欠陥ではなく決定の変更", ".work/agents-md/design-v4/bundles-resolution.tsv:5"),
 ("v4_P8", "fail", "FQ8 次第（解釈の差）", "yes", "files.tsv:12 (4) は自己検査も重大度で振り分ける。これは Q5+W4 の合成の一つの読みで、P8（全て設計へ）が唯一の読みでない。本物の欠陥は自己検査の失敗に重大度の出どころが無いこと（V1 と同根）", ".work/agents-md/design-v4/files.tsv:12"),
 ("v4_P9・P10・P12・P13・P14", "pass", "-", "yes", "P13 の通過は decided と同じく分類の自己判定を見ない弱さを含む", ".work/agents-md/flow-model/Flow.tla:314"),
 ("v4_P11", "fail", "v4 より後の決定（X2）", "yes", "v4 の (7) は公開も止まってよい人間ゲートに含めるので v4 の内部では矛盾しない。pubgate を実装レビューの後・PR の前に置くのは (4)(7) の一つの読み（V16 が曖昧と指摘）", ".work/agents-md/design-v4/files.tsv:7"),
 ("v4_P15", "fail", "v4 より後の決定（X1）", "yes", "v4 の置き場は「PR から辿れる場所」で規模で分かれない", ".work/agents-md/design-v4/files.tsv:12"),
 ("v4_P16", "fail", "決定自体の欠落（v4 にもある）", "yes", "v4 は作業の最初に PR から辿れる場所へ書くが PR が無い（V7）。decided_P16 も破れるので X1 でも残る（FQ1）", ".work/agents-md/design-v4/files.tsv:12"),
 ("v4_P17", "fail", "決定自体の欠落（v4 固有でない）", "yes", "設計段の LOW を PR 本文に載せるが PR が無い。decided_P17 も同じく破れ、W4 の時機の欠落（FQ2）", ".work/agents-md/design-v4/files.tsv:12"),
 ("v4 版の bot 段", "-", "模型の追加（寛容側）", "no", "design-v4 の *.tsv に bot の語は 0 件（grep -c）。模型は X3 由来の bot 段を v4 版にも入れ、bot の重大度をレビュー役が付ける（Flow.tla:168 の orch への落としは dtriage と人だけ）。v4 版は bot の重大度の出どころが無いことを検出しない。破れた性質の判定は変えない", ".work/agents-md/flow-model/Flow.tla:168"),
])

raw = [l.rstrip("\n").split("\t") for l in open(O / "rerun.raw.tsv")][1:]
raw2 = [l.rstrip("\n").split("\t") for l in open(O / "rerun2.raw.tsv")]
exp = {r["check"]: r for r in csv.DictReader(open(O.parent / "flow-model" / "results.tsv"), delimiter="\t")}
def eprop(n):
    m = re.match(r"(Invariant \S+ is violated|Action property \S+ is violated|Temporal properties were violated)", exp[n]["note"])
    return m.group(1) if m else ""
rows = []
def add(name, kind, st, res, prop, note):
    e = exp[name]; ep = eprop(name)
    ok = (res == e["result"]) and ((st == e["states"]) if res == "pass" else (prop == ep))
    rows.append((name, kind, e["states"], e["result"], ep or "-", st, res, prop or "-", "yes" if ok else "no", note))
sel = "16 本の mut_* の check 名を整列し random.Random(7272).sample(·,3) で選んだ（rerun.py）"
for n, kind, _, _, st, res, _, prop in raw:
    note = sel if kind.startswith("mutation") else ""
    if res == "fail" and st != exp[n]["states"]:
        note = (note + "。" if note else "") + "状態数の差は -workers 4 の並列探索で違反時点が揺れるため（下の r2・r3 で確認）"
    add(n, kind, st, res, prop, note)
for n, tag, st, res, prop in raw2:
    kind = "control（Mut=none）" if tag == "ctl" else f"再走 {tag}"
    note = {"decided_P2": "mut_OrchSev_P2 の対照", "decided_P9": "mut_EnvRToDesign_P9 の対照", "decided_P13": "mut_SelfReview_P13 の対照"}.get(n, "同じコマンドで状態数が揺れることの確認")
    add(n, kind, st, res, prop, note)
w("rerun.tsv", ["check", "kind", "expected_states", "expected_result", "expected_property", "states", "result", "property", "match", "note"], rows)

w("qcheck.tsv", ["qid", "verdict", "merge_with", "reason"], [
 ("FQ1", "holds", "FQ2",
  "X1 は置き場を決め、X2 は PR を出す時点を登録の後と言うが、PR より前に作る成果物の書き先も draft の扱いも決めていない。選択肢は妥当。推奨 (a) の根拠に欠け: (a) の「出す＝ready」の再定義が X2「登録まで進めて PR を出し」と整合するかを問いに書くべき。(b) は再定義なしで P4D も保つが、下書きが作業ツリー外にあると AGENTS.md の push の規則（/tmp 系で消える実測）に触れる。この得失も並べるべき。また P16 の式は (a) に有利に偏る（props.tsv P16）"),
 ("FQ2", "holds", "FQ1",
  "FQ1 と同じ「PR より前に PR 本文へ書く」問題。(c) は FQ1 (a) そのもので、(a) の保留も置き場が要り、問い自身が「FQ1 と同じ決め方にする」と書く。1 問に束ねる"),
 ("FQ3", "holds", "FQ6・FQ7・FQ8",
  "決定は司令塔（AGENTS.md:85-87）と作り手（AGENTS.md:76）を除くまでで、残る 3 案は選べない。推奨 (a) の根拠は妥当（尺度の追加が要ることも書いている）。(c) は自由文の指摘に決定的な規則が当たる形でないと成り立たない。FQ6 の bot の重大度、FQ7 の人の指摘の重大度、FQ8 の自己検査の重大度は、どれも「どの指摘に重大度が要り、誰が付けるか」の 1 問に束ねられる"),
 ("FQ4", "holds", "",
  "Q10 は原因を除く担い手を作り手と決めるが、分類する者と記録・レビューは決めていない（V7）。迂回の筋は「環境の原因を除く」操作（設定・環境の変更）が欠陥を覆いうることで成り立つ。ただし模型では chk' が真の原因と独立に選ばれるので、この欠陥は TLC には現れない（props.tsv P13）。問いに足すべき点: 誤分類が続いたときのやり直しの上限（模型は EnvBudget=2 で打ち切るが決定には無い）"),
 ("FQ5", "derivable:main AGENTS.md:95-99（司令塔は成果物を書かない。「小さい修正だから」は合理化。生成は builder 役の agent へ dispatch）", "",
  "(c) は除かれ、(a) と (b) はどちらも builder 役の agent で模型の遷移（作り手≠司令塔≠レビュー役）には差が無い。推奨の根拠が引く「作業ルール (11)」は v4 の番号で、正本は main の AGENTS.md:95-99。どの既存スキルが段を兼ねるか（V8）は設計 v5 の対応表の問題で、流れの模型の問いではない"),
 ("FQ6", "holds", "FQ3",
  "重大度の出どころの半分は FQ3 に束ねる（X3 で bot の指摘も W4 の対象なので重大度が要る）。順序の半分（bot の振り分けの後に人間ゲートか、並行か）は決定に無い。推奨 (a) の根拠「次の担い手が人だけに決まる」は P12（brief 由来で決定に無い）に依る。決定からの根拠としては AGENTS.md:70「途中で止めず」（bot の指摘が残る間は agent の仕事が残っており止まれない）を引くほうが強い"),
 ("FQ7", "derivable:D1「指摘を直接直さず設計に戻ってから実装する」（経路の半分）", "FQ3",
  "経路は D1 で設計への戻りに決まり、選択肢 (c) は D1 に反する（問いも書いている）。残る重大度の半分は P1 の対象の問いで、FQ8 と同じく「どの指摘に重大度が要るか」なので FQ3 に束ねる。推奨 (b) は X3 と整合する"),
 ("FQ8", "holds", "FQ3",
  "Q5 は自己検査の欠陥を「設計に戻る」に含め、後の W4 がその規則に閾値を入れた。合成すると (b)（v4 の読み）も成り立つので一意でない。推奨 (a) の根拠「Q5 の決定と一致」は不完全で、(b) も Q5 と矛盾しない。(a) を推せる根拠は「自己検査は重大度を出さず、付ける者の問題を持ち込まない」の側だけ。重大度の対象の問いとして FQ3 に束ねる"),
])

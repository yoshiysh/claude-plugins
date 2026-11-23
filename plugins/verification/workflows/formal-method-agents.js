export const meta = {
  name: 'formal-method-agents',
  description: 'formal-method の CLI が開いた呼び出しの workers の行ごとに担当を 1 体起動する。1 体は claim で 1 つ以上の担当を取り、query・submit で CLI と直接やり取りし、submit の next で次の担当を受け取る。script が返すのは起動の記録と tokens だけ',
  whenToUse: 'formal-method スキルの司令塔が、CLI の status が run_agents のときに call.args_path の JSON をそのまま args に渡して呼ぶ。args が無いと起動直後に落ちるため直接は起動しない',
  requirements: ['fresh-thread', 'workspace-write'],
  phases: [
    { title: '起動', detail: 'workers の行ごとに、CLI が決めた model と effort のまま担当を 1 体起動する' },
  ],
}

// この script は判断しない（coverage-audit.js の起動部の型）。args は {state, callId, stage, workers} だけで、担当の入力（task・資料）は
// prompt に載せず、担当が claim と query で CLI から引く。担当の成果物は担当が submit で CLI に出し、CLI が照合して受理を決める。
// script は担当の出力を受け取らず、加工も集約もしない。返すのは起動の記録（agents）と tokens だけ（artifact-formats.md「Workflow の返り値」）。
const A = typeof args === 'string' ? JSON.parse(args) : args
const agents = []
// 消費量は、本体の始めと返す直前の 2 回の budget.spent() の読みの差。どちらかが数でなければ null。
const spentNow = () => { const v = typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null; return typeof v === 'number' && Number.isFinite(v) ? v : null }
const spentStart = spentNow()
const tokens = () => { const end = spentNow(); return spentStart === null || end === null ? null : end - spentStart }

const STAGES = ['洗い出し', 'モデル化', '計画', '確認']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
// shell の 1 語にする（' は '\'' に置き換える）。
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// CLI の入口。args で CLI の置き場を運ばないので、CLI が呼び出しのたびに run の領域に書く入口（本物の CLI を import するだけ）を使う。
// その後の query と submit は、claim の応答の最上位の query_cmd（task_id を引数で足す）・submit_cmd（本物の CLI の絶対パス）を流す。
const cliOf = (state) => `${String(state).replace(/[\\/]+$/, '')}/formal-method-cli.mjs`

const promptOf = (w) => `## 共通の前提
- 目的: formal-method の検証の担当を果たす。あなたは worker ${w.id}（役 ${w.role}、段 ${A.stage}）で、claim が返した担当の外を読まない。
- 1 回の claim は、この worker の出し終えていない担当を全て（1 つ以上）返す。担当ごとに役の指示が違うことがある（task の instructions に従う）。次の担当は、受理された submit の出力の next で受け取る。
- run の状態と台帳を書くのは CLI だけ。あなたの入力は claim・query・submit の出力と、そこが指すファイルにあり、出力は担当ごとの result_path に書いて submit で出す。返り値で内容を返さない。
- CLI の命令は、どれも Bash で timeout 120000 を明示して流す。出力は 1 行の JSON。ok が false で code が E_CALL・E_STALE なら、reason を notes に書いて終える（detail.reason が no_response のときだけ、同じ命令を 1 度流し直してよい）。
- ファイルは Write の tool で書く。shell で書くときは > でなく >| を使う（既にあるファイルでも失敗しない）。成果物・作業記録・返り値は task の attempt_dir に、成果物でない生成物（途中の抜き出しなど）は claim の出力の scratch_dir に置く。指紋は CLI が持つので求めない（query の hash と submit の照合）。他の場所（共有の一時ディレクトリなど）に書かない。

### 担当を取る命令（この行をそのまま Bash で流す）
printf '%s' ${sq(JSON.stringify({ run_dir: A.state, call_id: A.callId, worker: w.id }))} | node ${sq(cliOf(A.state))} claim

### 手順
1. 最初に取る命令を流す（流し直すのは 7 の場合だけ）。出力が done: true なら、手順を終えて返り値を返す。出力の最上位の query_cmd・submit_cmd・scratch_dir は、この worker の全ての担当に共通である。return_schemas は役ごとの返り値の形で、担当の task の role で引く（next の出力の return_schemas も、同じく役ごとに足す）。
2. 出力の tasks の担当ごとに、次の 3〜5 を順に行う。同じ instructions のファイルは 1 度読めばよく、既に query した担当は query し直さない。
3. task の instructions の 4 つのファイル（役の指示、役の分の義務、役の型の抜粋、文書の一般規約）を Read で全て読み、従う。task の context が担当の範囲で、return_schemas の task の role の値が返り値の形である。
4. query_cmd の後に空白と task_id を足して Bash で流す（<query_cmd> <task_id>）。出力の inputs が、この担当に渡された資料の全てである。資料はそこだけを読む（claim と query の出力の外を読まない）。hash を持つ要素はその path のファイルだけ、hash を持たない要素はその path のディレクトリの下を読む。ただし attempts/ の下のディレクトリは読まない（共通の義務のとおり、確認役・原因の分類役は作業記録の failures にその ref を書く）。entries を持つ要素（同じディレクトリの資料を畳んだもの）は、entry ごとに path と entry をつないだものを読み（/ で終わる entry はディレクトリ）、そのディレクトリの他のファイルを読まない。inputs の要素が spans（L<開始>-L<終了> の並び）を持てば、そのファイルはその行だけを開いて読む（範囲の外の行を読まない。範囲の外の文脈が要れば、共通の義務の書き方で記録する）。
5. 指示に従って、成果物と作業記録を task の attempt_dir の中に書き、返り値の JSON を task の result_path に Write で書く。書いたら submit_cmd をそのまま Bash で流す（担当ごとに流してよい。書き終えた担当から出す）。出力の results の要素ごとに:
   - ok が false で done が false なら、problems の欠陥を読んでその担当の成果物と返り値を直し、同じ submit_cmd を流し直す（欠陥が減らなくなると CLI が残った欠陥ごと受理する）。この出力には next が無い。
   - done が true なら、その担当は閉じた（受理された担当の成果物は書き換えない）。
6. results に done が false のものが無ければ、出力は next を持つ。next が done: true なら、手順を終えて返り値を返す（claim を流し直さない）。next が done: false なら、next の tasks を出力の tasks として 2 に戻る（まだ出していない担当と、前の担当が閉じて出せるようになった担当が来る）。
7. 取る命令を流し直すのは、今の担当が分からなくなったとき（submit の出力を読めなかったときなど）だけである。

### 返り値
気づいたこと（notes。命令が流せなかった・拒まれた・直せなかった問題など）だけ。成果物・判定・結論は返り値に書かない（CLI は返り値を読まない）。`

const WORKER_SCHEMA = { type: 'object', properties: { notes: { type: 'array', items: { type: 'string' } } }, required: ['notes'] }
// 行ごとに 1 体。モデルと effort は行の値（正本は scripts/lib/roles.mjs で、CLI が行に写す）。agent の失敗（throw）も起動の記録に残す。
async function launch(w) {
  const label = `${w.role}-${w.id}`
  let out = null
  try { out = await agent(promptOf(w), { label, phase: '起動', schema: WORKER_SCHEMA, model: w.model, effort: w.effort }) } catch (e) { log(`${label}: agent が失敗した（${String((e && e.message) || e).slice(0, 160)}）`) }
  agents.push({ role: w.role, label, model: w.model, effort: w.effort, ok: out != null })
}

const argProblems = []
if (!A || typeof A !== 'object') argProblems.push('args が object でない')
else {
  if (!STAGES.includes(A.stage)) argProblems.push(`stage が不正: ${A.stage}`)
  if (!isStr(A.state)) argProblems.push('state が無い')
  if (!isStr(A.callId)) argProblems.push('callId が無い')
  if (!Array.isArray(A.workers) || A.workers.length === 0 || !A.workers.every((w) => w && isStr(w.id) && isStr(w.role) && isStr(w.model) && isStr(w.effort))) argProblems.push('workers が {id, role, model, effort} の配列でない')
}
// args が壊れていれば起動しない（起動の記録が空の呼び出しとして、CLI が期限か close で閉じる）。
if (argProblems.length) log(`args の検査に落ちた: ${argProblems.join(' / ')}`)
else {
  phase('起動')
  await parallel(A.workers.map((w) => () => launch(w)))
}
return { agents, tokens: tokens() }

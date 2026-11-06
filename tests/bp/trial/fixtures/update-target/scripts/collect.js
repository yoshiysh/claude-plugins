export const meta = {
  name: 'release-notes-collect',
  description: 'マージ済みの PR ごとに要約を 1 つ作って返す',
}

const MAX_PRS = 50
const CONCURRENCY = 3

const prs = args.prs.slice(0, MAX_PRS)
const out = []
for (let i = 0; i < prs.length; i += CONCURRENCY) {
  const batch = prs.slice(i, i + CONCURRENCY)
  const summaries = await Promise.all(batch.map((pr) => agent(
    `PR #${pr.number}「${pr.title}」の変更を、利用者に向けた 1 文で要約する。本文:\n${pr.body}`,
    { label: `summarize:${pr.number}`, model: 'sonnet', effort: 'low' },
  )))
  out.push(...summaries.map((summary, j) => ({ number: batch[j].number, summary })))
}
return { summaries: out }

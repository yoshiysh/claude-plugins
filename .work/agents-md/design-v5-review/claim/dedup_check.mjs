import { readFileSync } from 'node:fs'
import { parseReadingTable } from '../../../../.agents/skills/repo-review/scripts/review-core.mjs'
const R = new URL('../../../../', import.meta.url).pathname
const review = readFileSync(R + 'REVIEW.md', 'utf8')
const BP = 'plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md'
const nums = (text) => parseReadingTable(text).docs.find((d) => d.path === BP).titles.map((x) => x.num).sort((a, b) => a - b)
console.log('now', JSON.stringify(nums(review)))
const row = '| `.claude/agents/*.md` | `docs/guidelines/review-lenses.md`、best-practices.md §3「Sub-agent 設計」 |\n'
const added = review.replace('| `*.md` |', row + '| `*.md` |')
console.log('with new row citing same §3 title', JSON.stringify(nums(added)))
const row2 = '| `.claude/agents/*.md` | `docs/guidelines/review-lenses.md`、best-practices.md §3「model と effort は役割ごとに組で選ぶ」 |\n'
console.log('with new row citing another §3 title', JSON.stringify(nums(review.replace('| `*.md` |', row2 + '| `*.md` |'))))

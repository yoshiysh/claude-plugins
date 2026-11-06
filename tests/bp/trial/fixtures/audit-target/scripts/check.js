export const meta = {
  name: 'glossary-check',
  description: '用語ごとに、用語集の定義と文書の中の使い方の食い違いを返す',
}

const results = await Promise.all(args.terms.map((term) => agent(
  `用語「${term}」について、docs/glossary.md の定義と、docs/ の下の文書の中の使い方を比べ、食い違う使い方をしている文書のパスと内容を {"term", "mismatches": [{"path", "detail"}]} で返す。食い違いが無ければ mismatches を空の並びにする。役の指示は references/roles/checker.md に従う。`,
  { label: `checker:${term}` },
)))
return { results }

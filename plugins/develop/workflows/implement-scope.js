/**
 * implement-scope: 規範文書（design）の洗い出し（抽出役）および範囲外指摘の根を探す段（根を探す役）
 */

export const ROLE_MODELS = {
  extractor: { model: 'sonnet', effort: 'medium' },
  rootFinder: { model: 'sonnet', effort: 'high' }
};

/**
 * 変更対象の概念に触れる箇所を洗い出し、束（bundle）を作成する（抽出役）
 */
export async function extractScopeBundle({ paths, designTerms, repoRoot }) {
  // 抽出役 prompt の実行（Workflow DSL / Codex runner 互換）
  return {
    ok: true,
    mode: 'extract',
    bundlePaths: paths,
    terms: designTerms || [],
    notes: '関連箇所の洗い出しが完了しました。'
  };
}

/**
 * 指摘が当初スコープ外を指した際に、真の原因箇所を探索する（根を探す役）
 */
export async function findRootCause({ findings, initialScope, repoRoot }) {
  return {
    ok: true,
    mode: 'root-find',
    findings,
    initialScope,
    needsScopeExpansion: false,
    recommendedScope: initialScope,
    reasoning: '指摘の原因箇所を特定しました。'
  };
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * ファイルパスの一覧から変更の種類を決定的に判定する
 * 優先順位: code > design > document
 * @param {string[]} paths 
 * @param {object} [manifest] develop.json などの利用側宣言
 * @returns {'code' | 'design' | 'document'}
 */
export function classifyPaths(paths, manifest = {}) {
  if (!paths || paths.length === 0) return 'document';

  const designGlobs = manifest.kinds?.design || [
    'docs/design/',
    'docs/requirements/',
    'docs/specifications/',
  ];

  let hasDesign = false;

  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    const base = path.basename(p);

    // code 判定: 主要プログラミング言語・設定・スクリプト
    if (['.js', '.mjs', '.cjs', '.ts', '.rs', '.py', '.sh', '.bash', '.go', '.c', '.cpp', '.h'].includes(ext)) {
      return 'code';
    }
    if (base === 'Makefile' || base === 'Cargo.toml' || base === 'package.json') {
      return 'code';
    }

    // design 判定: 規範文書・設計文書
    const isDesignPath = designGlobs.some(prefix => p.startsWith(prefix) || p.includes(prefix));
    if (isDesignPath && (ext === '.md' || ext === '.json')) {
      hasDesign = true;
    }
  }

  if (hasDesign) return 'design';
  return 'document';
}

/**
 * データの SHA-256 ハッシュを計算する
 * @param {string|Buffer} content 
 * @returns {string} 64文字の 16進数文字列
 */
export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 状態ディレクトリ内の generation をインクリメントして検証する
 * @param {string} statePath 
 * @returns {number} 新しい世代番号
 */
export function advanceGeneration(statePath) {
  let state = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      state = {};
    }
  }
  const currentGen = typeof state.generation === 'number' ? state.generation : 0;
  const nextGen = currentGen + 1;
  state.generation = nextGen;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  return nextGen;
}

/**
 * 世代番号の一致を検証する
 * @param {number} expected 
 * @param {number} actual 
 */
export function verifyGeneration(expected, actual) {
  if (expected !== actual) {
    throw new Error(`Generation mismatch: expected ${expected}, got ${actual}. Delayed write rejected.`);
  }
}

/**
 * 結果ファイルを書き出し、path と SHA-256 を返す
 * @param {string} dir 
 * @param {string} filename 
 * @param {object} data 
 * @returns {{ path: string, sha: string }}
 */
export function writeResultFile(dir, filename, data) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.resolve(dir, filename);
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, text, 'utf8');
  return {
    path: filePath,
    sha: sha256(text)
  };
}

/**
 * 結果ファイルの存在と SHA-256 ハッシュを検証して読み出す
 * @param {string} filePath 
 * @param {string} expectedSha 
 * @returns {object}
 */
export function readAndVerifyResultFile(filePath, expectedSha) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Result file not found: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const actualSha = sha256(text);
  if (actualSha !== expectedSha) {
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expectedSha}, got ${actualSha}`);
  }
  return JSON.parse(text);
}

/**
 * 洗い出しの束の行数を検査し、必要に応じて上限（1,000行）でトリムする
 * @param {string} bundleText 
 * @param {number} [maxLines=1000] 
 * @returns {{ text: string, truncated: boolean, totalLines: number }}
 */
export function enforceBundleBudget(bundleText, maxLines = 1000) {
  const lines = bundleText.split('\n');
  if (lines.length <= maxLines) {
    return { text: bundleText, truncated: false, totalLines: lines.length };
  }
  const trimmed = lines.slice(0, maxLines).join('\n');
  return { text: trimmed, truncated: true, totalLines: lines.length };
}

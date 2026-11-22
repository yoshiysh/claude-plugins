// 受付の段の対象の取得（artifact-formats.md「共通の型」の対象・テキストかどうか・版と指紋）。
// 依頼の検査・対象の取得・版の照合は、全て同じ読み込みのバイト列で行う。対象の写しは作らず（対象は run の間固定している前提）、
// 担当には元のファイルの絶対パスを渡す。固定の前提は集約の段で 1 度だけ照らす（targetChanges）。
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './canonical.mjs';
import { atomicWrite } from './storage.mjs';
import { cmpBytes, linesOf } from './checks/common.mjs';

const DECODER = new TextDecoder('utf-8', { fatal: true });

export function isText(bytes) {
  if (bytes.includes(0)) return false;
  try { DECODER.decode(bytes); return true; } catch { return false; }
}

// 行の数。行の数え方の正本は checks/common.mjs の linesOf（Span の行の規則）。
export const lineCount = (bytes) => linesOf(Buffer.from(bytes).toString('utf8')).length;

export function collectionHash(files) {
  return sha256Bytes(Buffer.from(files.map((f) => `${f.path}\0${f.content_hash}\n`).join(''), 'utf8'));
}

// abs は元のファイルの絶対パス（担当に渡す path）
const fileEntry = (path, abs, bytes) => {
  if (bytes === null) return { path, abs, content_hash: 'unreadable', text: false, bytes: null };
  return { path, abs, content_hash: sha256Bytes(bytes), text: isText(bytes), bytes };
};

// 1 つの対象を取得する。戻り値: { ok: true, target } | { ok: false, code, detail }
export function fetchTarget(t, { workspace }) {
  const unavailable = (detail) => ({ ok: false, code: 'target_unavailable', detail });
  let path;
  if (/^file:\/\//i.test(t.location)) {
    try { path = fileURLToPath(t.location); } catch { return unavailable('file:// の URI を path にできない'); }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t.location)) {
    return unavailable(`扱えない URI: ${t.location.split(':')[0]}`);
  } else path = isAbsolute(t.location) ? t.location : resolve(workspace, t.location);
  let st;
  try { st = lstatSync(path); } catch { return unavailable('location が無い'); }
  let resolvedLocation = null;
  if (st.isSymbolicLink()) {
    try {
      const target = readlinkSync(path);
      resolvedLocation = realpathSync(isAbsolute(target) ? target : resolve(dirname(path), target));
      path = resolvedLocation;
      st = statSync(path);
    } catch { return unavailable('location の symbolic link を解決できない'); }
  }
  let realWorkspaceStore = null;
  try { realWorkspaceStore = realpathSync(join(workspace, '.formal-method')); } catch { realWorkspaceStore = null; }
  if (t.revision) return fetchRevision(t, path, resolvedLocation);
  const files = [];
  const unread = [];
  const excluded = [];
  if (st.isFile()) {
    let bytes = null;
    try { bytes = readFileSync(path); } catch { bytes = null; }
    files.push(fileEntry(basename(path), path, bytes));
  } else if (st.isDirectory()) {
    try { readdirSync(path); } catch { return unavailable('根のディレクトリを読めない'); }
    const walk = (dir, rel) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch {
        unread.push({ file: `${rel}/`, reason: 'ディレクトリを読めない' });
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        let est;
        try { est = lstatSync(p); } catch { unread.push({ file: r, reason: '読めない' }); continue; }
        if (e.name === '.git') { excluded.push(est.isDirectory() ? `${r}/` : r); continue; }
        if (est.isSymbolicLink()) { unread.push({ file: r, reason: 'symbolic link はたどらない' }); continue; }
        if (est.isDirectory()) {
          let real = null;
          try { real = realpathSync(p); } catch { real = null; }
          if (realWorkspaceStore && real === realWorkspaceStore) { excluded.push(`${r}/`); continue; }
          walk(p, r);
          continue;
        }
        if (!est.isFile()) { unread.push({ file: r, reason: '通常のファイルでない' }); continue; }
        let bytes = null;
        try { bytes = readFileSync(p); } catch { bytes = null; }
        files.push(fileEntry(r, p, bytes));
      }
    };
    walk(path, '');
  } else return unavailable('location がファイルでもディレクトリでもない');
  return finish(t, files, unread, excluded, resolvedLocation, null, path);
}

function finish(t, files, unread, excluded, resolvedLocation, revision, root) {
  files.sort((a, b) => cmpBytes(a.path, b.path));
  for (const f of files) {
    if (f.content_hash === 'unreadable') unread.push({ file: f.path, reason: '読めないファイル' });
    else if (!f.text) unread.push({ file: f.path, reason: 'バイナリのファイル（NUL を含むか UTF-8 として読めない）' });
  }
  unread.sort((a, b) => cmpBytes(a.file, b.file));
  excluded.sort(cmpBytes);
  const contentHash = collectionHash(files);
  if (t.content_hash && t.content_hash !== contentHash) return { ok: false, code: 'revision_mismatch', detail: '依頼の content_hash が集まりの指紋と一致しない' };
  return { ok: true, target: { id: t.id, location: t.location, resolved_location: resolvedLocation, root, revision, content_hash: contentHash, files, unread, excluded } };
}

function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', cwd, ...args], { encoding, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

// revision を添えた依頼は、location を含む git の作業ツリーから、その版の tree の内容を取る。写しを作らず元のファイルを担当に渡すので、
// 作業ツリーのファイルの指紋がその版の blob と一致するときだけ受け付ける（一致しなければ revision_mismatch）
function fetchRevision(t, path, resolvedLocation) {
  const mismatch = (detail) => ({ ok: false, code: 'revision_mismatch', detail });
  let isDirectory;
  try { isDirectory = statSync(path).isDirectory(); } catch { return { ok: false, code: 'target_unavailable', detail: 'location が無い' }; }
  const dir = isDirectory ? path : dirname(path);
  let top;
  let commit;
  try {
    top = realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim());
    commit = git(top, ['rev-parse', '--verify', '--quiet', `${t.revision}^{commit}`]).trim();
  } catch { return mismatch('location が git の作業ツリーの外か、revision の版を取れない'); }
  const rel = relative(top, realpathSync(path)).split('\\').join('/');
  let listing;
  try { listing = git(top, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', rel || '.']); } catch { return mismatch('版の tree を読めない'); }
  const files = [];
  const unread = [];
  for (const rec of listing.split('\0').filter(Boolean)) {
    const m = rec.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
    if (!m) continue;
    const [, mode, type, sha, full] = m;
    let r = isDirectory ? (rel ? full.slice(rel.length + 1) : full) : basename(full);
    if (!r) r = basename(full);
    if (r.split('/').includes('.git')) continue;
    // submodule（gitlink）の中身はこの版の tree に無いので、読めない箇所として挙げる
    if (type === 'commit') { unread.push({ file: `${r}/`, reason: 'submodule（gitlink）の中身は版の tree に無いのでたどらない' }); continue; }
    if (type !== 'blob') continue;
    if (mode === '120000') { unread.push({ file: r, reason: 'symbolic link はたどらない' }); continue; }
    // 版の内容は、checkout と同じ変換（.gitattributes の eol・text、core.autocrlf などの filter）を通した形で取る（--filters）。
    // 作業ツリーのファイルとの照合・記録する指紋・集約の段の照合（changedFiles）は、全てこの形のバイト列で行う。
    // 版の blob を読めなければ受付で拒む（読めないファイルとして受け付けると、集約の段で作業ツリーの指紋と食い違う）
    let bytes;
    try { bytes = git(top, ['cat-file', '--filters', `${commit}:${full}`], 'buffer'); } catch { return { ok: false, code: 'target_unavailable', detail: `revision の版のファイル ${full}（blob ${sha}）を読めない` }; }
    const abs = join(top, full);
    let worktree = null;
    try { worktree = readFileSync(abs); } catch { worktree = null; }
    if (worktree === null || sha256Bytes(worktree) !== sha256Bytes(bytes)) return mismatch(`作業ツリーのファイル ${full} の内容が revision の版と一致しない（写しを作らないので、作業ツリーをその版にしてから依頼する）`);
    files.push(fileEntry(r, abs, bytes));
  }
  if (files.length === 0 && unread.length === 0) return mismatch('版の tree に location の内容が無い');
  return finish(t, files, unread, [], resolvedLocation, commit, path);
}

// 対象の一覧（targets/<id>/manifest.json）を書く。写しは書かない。ファイルごとに、対象の中の path・元の絶対パス・作業ツリーからの
// 相対パス（作業ツリーの外なら null）・指紋・テキストかを持つ。戻り値: 書いた記録の { ref, hash }
export function writeManifest(runDir, target, workspace) {
  // symbolic link を解決した実際の path で比べる（macOS の /var → /private/var など）。".." の path 部分だけを外とし、"..foo" の名前は中とする
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const ws = real(workspace);
  const rel = (abs) => { const r = relative(ws, real(abs)).split('\\').join('/'); return r === '' || r === '..' || r.startsWith('../') || isAbsolute(r) ? null : r; };
  const manifest = JSON.stringify({ root: target.root, files: target.files.map((f) => ({ path: f.path, abs_path: f.abs, workspace_path: rel(f.abs), content_hash: f.content_hash, text: f.text })) });
  const ref = join('targets', target.id, 'manifest.json');
  mkdirSync(join(runDir, 'targets', target.id), { recursive: true });
  atomicWrite(join(runDir, ref), manifest);
  return { ref, hash: sha256Bytes(Buffer.from(manifest, 'utf8')) };
}

// 固定の前提の照合（集約の段で 1 度だけ）: 受付で読んだ指紋と、元のファイルを読み直した指紋が違うファイルの一覧。
// revision つきの対象も作業ツリーのファイルを読み直す（受付の指紋は checkout と同じ変換を通した版の内容で、作業ツリーと一致したもの）。
// 受付で読めなかったファイル（unreadable）は、読み直しても読めなければ変わっていないとする。受付の後にディレクトリへ足されたファイルは照らさない。
export function changedFiles(target) {
  const out = [];
  for (const f of target.files) {
    let now = null;
    try { now = sha256Bytes(readFileSync(f.abs)); } catch { now = 'unreadable'; }
    if (now !== f.content_hash) out.push(f.path);
  }
  return out;
}

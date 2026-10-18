import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularFileBounded } from './safe-update-read.mjs';

const VERSION = 1;
const MAX_FILES = 500;
const MAX_DIRECTORIES = 2_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_CHANGED_PATHS = 1_000;
const SNAPSHOT_PREFIX = 'codex-skill-review-';
const SNAPSHOT_LAYOUT = Object.freeze({
  receipt: 'receipt.json',
  manifest: 'manifest.json',
  tree: 'tree',
  diff: 'diff.patch',
  changedPaths: 'changed-paths.json',
  evidencePack: 'evidence-pack.txt',
});
// evidence pack に入れる拡張子。review の finder / refuter が毎回 1 つずつ冷読みしていた文書をここで 1 回だけ
// 連結し、行番号を付けて配る。入れなかったファイル（scripts/ など）は pack の冒頭に一覧で宣言する。
const EVIDENCE_PACK_EXTENSIONS = Object.freeze(['.md']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compareNames = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeRelative(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative))
    throw Error(`invalid relative path: ${JSON.stringify(relative)}`);
  const resolved = path.resolve(root, relative);
  if (!within(root, resolved)) throw Error(`path escapes target: ${JSON.stringify(relative)}`);
  return resolved;
}

async function canonicalDirectory(input, label) {
  if (!input || typeof input !== 'string' || !path.isAbsolute(input)) throw Error(`${label} must be an absolute path`);
  const resolved = await fs.realpath(input);
  const info = await fs.lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error(`${label} is not a canonical regular directory`);
  return resolved;
}

async function git(args, cwd, maxBuffer = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBuffer) {
        overflow = true;
        child.kill('SIGTERM');
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes <= 1024 * 1024) stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout);
      const error = Buffer.concat(stderr).toString('utf8').trim();
      if (overflow) return reject(Error(`git output exceeds ${maxBuffer} bytes`));
      if (code !== 0) return reject(Error(`git ${args[0]} failed${error ? `: ${error}` : ''}`));
      resolve(output);
    });
  });
}

async function resolveDiff(targetRoot, diffRef) {
  if (typeof diffRef !== 'string' || !diffRef.trim() || diffRef.startsWith('-'))
    throw Error('diff scope requires a revision range, for example main...HEAD');
  const separator = diffRef.includes('...') ? '...' : '..';
  if (diffRef.split(separator).length !== 2 || diffRef.includes(separator === '...' ? '....' : '...'))
    throw Error('diffRef must be a two-endpoint git revision range using .. or ...');
  const split = diffRef.indexOf(separator);
  const left = diffRef.slice(0, split);
  const right = diffRef.slice(split + separator.length);
  if (!left || !right || !['..', '...'].includes(separator)) throw Error('invalid diffRef range');
  const target = await canonicalDirectory(targetRoot, 'target');
  const rootText = (await git(['rev-parse', '--show-toplevel'], target)).toString('utf8').trim();
  const gitRoot = await canonicalDirectory(rootText, 'git root');
  const repoPath = path.relative(gitRoot, target);
  if (!within(gitRoot, target)) throw Error('target is outside its git worktree');
  const resolveCommit = async (revision) => {
    const bytes = await git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], gitRoot);
    const oid = bytes.toString('utf8').trim();
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw Error(`git did not resolve ${revision} to a commit`);
    return oid;
  };
  const leftOid = await resolveCommit(left);
  const rightOid = await resolveCommit(right);
  const baseOid = separator === '...'
    ? (await git(['merge-base', leftOid, rightOid], gitRoot)).toString('utf8').trim()
    : leftOid;
  if (!/^[a-f0-9]{40,64}$/.test(baseOid)) throw Error('git merge-base did not return a commit');
  const pathspec = repoPath ? `:(literal)${repoPath}` : ':(literal).';
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', '--no-color', baseOid, rightOid, '--', pathspec];
  const diff = await git(diffArgs, gitRoot, MAX_DIFF_BYTES);
  const names = await git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', baseOid, rightOid, '--', pathspec], gitRoot, MAX_TOTAL_BYTES);
  const repoChangedPaths = names.toString('utf8').split('\0').filter(Boolean);
  if (repoChangedPaths.length > MAX_CHANGED_PATHS) throw Error(`diff exceeds ${MAX_CHANGED_PATHS} changed paths`);
  const changedPaths = repoChangedPaths.map((name) => {
    if (name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) throw Error(`unsafe path in git diff: ${JSON.stringify(name)}`);
    if (!repoPath) return name;
    if (name === repoPath) return '.';
    if (name.startsWith(`${repoPath}${path.posix.sep}`)) return name.slice(repoPath.length + 1);
    throw Error(`git diff returned a path outside target: ${JSON.stringify(name)}`);
  });
  return { gitRoot, repoPath, diffRef, baseOid, headOid: rightOid, diffArgs, changedPaths: changedPaths.sort(compareNames), diff };
}

async function collectTree(root, { copyTo = null } = {}) {
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error(`target tree changed type: ${root}`);
  const files = [];
  const directories = [];
  let totalBytes = 0;
  let entriesSeen = 0;

  const visit = async (directory, relativeDirectory = '') => {
    const absoluteDirectory = safeRelative(root, relativeDirectory || '.');
    const before = await fs.readdir(absoluteDirectory);
    before.sort(compareNames);
    entriesSeen += before.length;
    if (entriesSeen > MAX_FILES + MAX_DIRECTORIES) throw Error('target tree exceeds its entry limit');
    if (relativeDirectory) directories.push(relativeDirectory);
    if (copyTo) await fs.mkdir(safeRelative(copyTo, relativeDirectory || '.'), { recursive: true, mode: 0o700 });
    for (const name of before) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
        throw Error(`unsafe directory entry: ${JSON.stringify(name)}`);
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, name) : name;
      const source = safeRelative(root, relative);
      const info = await fs.lstat(source);
      if (info.isSymbolicLink()) throw Error(`symlink is not allowed in review target: ${relative}`);
      if (info.isDirectory()) {
        await visit(source, relative);
        continue;
      }
      if (!info.isFile()) throw Error(`special file is not allowed in review target: ${relative}`);
      if (files.length >= MAX_FILES) throw Error(`review target exceeds ${MAX_FILES} regular files`);
      if (info.size > MAX_FILE_BYTES) throw Error(`review file exceeds ${MAX_FILE_BYTES} bytes: ${relative}`);
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw Error(`review target exceeds ${MAX_TOTAL_BYTES} total bytes`);
      const bytes = await readRegularFileBounded(source, info, MAX_FILE_BYTES);
      const entry = { path: relative.split(path.sep).join('/'), size: bytes.length, sha256: sha256(bytes), executable: Boolean(info.mode & 0o111) };
      files.push(entry);
      if (copyTo) {
        const destination = safeRelative(copyTo, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.writeFile(destination, bytes, { mode: entry.executable ? 0o555 : 0o444, flag: 'wx' });
        await fs.chmod(destination, entry.executable ? 0o555 : 0o444);
      }
    }
    const after = await fs.readdir(absoluteDirectory);
    after.sort(compareNames);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error(`directory entries changed while snapshotting: ${relativeDirectory || '.'}`);
  };

  await visit(root);
  files.sort((a, b) => compareNames(a.path, b.path));
  directories.sort(compareNames);
  return { files, directories, totalBytes };
}

async function chmodSnapshot(snapshotDir) {
  const directories = [];
  const walk = async (directory) => {
    const names = await fs.readdir(directory);
    for (const name of names) {
      const file = path.join(directory, name);
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw Error(`snapshot unexpectedly contains a symlink: ${file}`);
      if (info.isDirectory()) {
        directories.push(file);
        await walk(file);
      } else if (info.isFile()) await fs.chmod(file, (info.mode & 0o111) ? 0o555 : 0o444);
      else throw Error(`snapshot unexpectedly contains a special file: ${file}`);
    }
  };
  await walk(snapshotDir);
  directories.sort((a, b) => b.length - a.length);
  for (const directory of directories) await fs.chmod(directory, 0o555);
  await fs.chmod(snapshotDir, 0o555);
}

// 元ファイルの相対パスと行番号で引用できるよう、各行を `<元の行番号>| <本文>` の形で書く。pack 自体の行番号は使わない。
async function buildEvidencePack(snapshotDir, files) {
  const included = files.filter((f) => EVIDENCE_PACK_EXTENSIONS.includes(path.posix.extname(f.path)));
  const excluded = files.filter((f) => !included.includes(f)).map((f) => f.path);
  const sections = [];
  const index = [];
  for (const file of included) {
    const lines = (await fs.readFile(safeRelative(snapshotDir, file.path), 'utf8')).split('\n');
    if (lines.at(-1) === '') lines.pop();
    index.push(`- ${file.path}（${lines.length} 行）`);
    sections.push([`===== FILE: ${file.path} =====`, ...lines.map((line, n) => `${n + 1}| ${line}`)].join('\n'));
  }
  const header = [
    '# evidence pack（review snapshot から決定的に生成）',
    `入れた拡張子: ${EVIDENCE_PACK_EXTENSIONS.join(', ')}`,
    '各行は `<元ファイルの行番号>| <本文>`。引用は `===== FILE: <相対パス> =====` の相対パスとこの行番号で書く。',
    '',
    `## 入れたファイル（${included.length} 件）`,
    ...index,
    '',
    `## 入れなかったファイル（${excluded.length} 件。要るときは snapshot から個別に読む）`,
    ...excluded.map((name) => `- ${name}`),
    '',
  ].join('\n');
  return { bytes: Buffer.from(`${[header, ...sections].join('\n\n')}\n`), included: included.map((f) => f.path), excluded };
}

async function createSnapshot({ target, scope, diffRef }) {
  const targetRoot = await canonicalDirectory(target, 'target');
  if (!['full', 'diff'].includes(scope)) throw Error('scope must be full or diff');
  if (scope === 'diff' && !diffRef) throw Error('diff scope requires --diff-ref');
  if (scope === 'full' && diffRef) throw Error('full scope cannot use --diff-ref');
  const diffInfo = scope === 'diff' ? await resolveDiff(targetRoot, diffRef) : null;
  const snapshotRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), SNAPSHOT_PREFIX));
  await fs.chmod(snapshotRoot, 0o700);
  const snapshotDir = path.join(snapshotRoot, SNAPSHOT_LAYOUT.tree);
  await fs.mkdir(snapshotDir, { mode: 0o700 });
  try {
    const inventory = await collectTree(targetRoot, { copyTo: snapshotDir });
    const sourceAfter = await collectTree(targetRoot);
    if (stableJson(inventory) !== stableJson(sourceAfter)) throw Error('target changed while its review snapshot was being prepared');
    if (diffInfo) {
      await fs.writeFile(path.join(snapshotRoot, SNAPSHOT_LAYOUT.diff), diffInfo.diff, { mode: 0o400, flag: 'wx' });
      await fs.writeFile(path.join(snapshotRoot, SNAPSHOT_LAYOUT.changedPaths), stableJson(diffInfo.changedPaths), { mode: 0o400, flag: 'wx' });
    }
    await chmodSnapshot(snapshotDir);
    const pack = await buildEvidencePack(snapshotDir, inventory.files);
    const evidencePackPath = path.join(snapshotRoot, SNAPSHOT_LAYOUT.evidencePack);
    await fs.writeFile(evidencePackPath, pack.bytes, { mode: 0o400, flag: 'wx' });
    const manifest = {
      version: VERSION,
      scope,
      targetRoot,
      snapshotDir,
      files: inventory.files,
      directories: inventory.directories,
      totalBytes: inventory.totalBytes,
      limits: {
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxDiffBytes: MAX_DIFF_BYTES,
      },
      evidencePack: {
        path: evidencePackPath,
        sha256: sha256(pack.bytes),
        bytes: pack.bytes.length,
        extensions: EVIDENCE_PACK_EXTENSIONS,
        includedFiles: pack.included,
        excludedFiles: pack.excluded,
      },
      ...(diffInfo ? {
        diffRef: diffInfo.diffRef,
        gitRoot: diffInfo.gitRoot,
        repoPath: diffInfo.repoPath,
        baseOid: diffInfo.baseOid,
        headOid: diffInfo.headOid,
        changedPaths: diffInfo.changedPaths,
        diffPath: path.join(snapshotRoot, SNAPSHOT_LAYOUT.diff),
        changedPathsPath: path.join(snapshotRoot, SNAPSHOT_LAYOUT.changedPaths),
        diffBytes: diffInfo.diff.length,
        diffSha256: sha256(diffInfo.diff),
      } : { diffRef: null, changedPaths: [], diffPath: null, changedPathsPath: null, diffBytes: 0, diffSha256: null }),
    };
    const manifestPath = path.join(snapshotRoot, SNAPSHOT_LAYOUT.manifest);
    const manifestBytes = Buffer.from(stableJson(manifest));
    await fs.writeFile(manifestPath, manifestBytes, { mode: 0o400, flag: 'wx' });
    const receipt = {
      version: VERSION,
      status: 'ready',
      scope,
      targetRoot,
      snapshotRoot,
      snapshotDir,
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      diffRef: diffRef || null,
      diffPath: manifest.diffPath,
      changedPathsPath: manifest.changedPathsPath,
      diffSha256: manifest.diffSha256,
      changedPaths: manifest.changedPaths,
      evidencePackPath,
      evidencePackSha256: manifest.evidencePack.sha256,
    };
    const receiptPath = path.join(snapshotRoot, SNAPSHOT_LAYOUT.receipt);
    await fs.writeFile(receiptPath, stableJson(receipt), { mode: 0o400, flag: 'wx' });
    return { ...receipt, receiptPath, fileCount: inventory.files.length, byteCount: inventory.totalBytes,
      changedPathCount: diffInfo?.changedPaths.length || 0 };
  } catch (error) {
    await fs.chmod(snapshotDir, 0o700).catch(() => {});
    await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readReceipt(receiptPath) {
  if (!receiptPath || !path.isAbsolute(receiptPath)) throw Error('--receipt must be an absolute path');
  const receiptInfo = await fs.lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw Error('review snapshot receipt is not a regular file');
  if (await fs.realpath(receiptPath) !== receiptPath) throw Error('review snapshot receipt path is not canonical');
  const receiptBytes = await fs.readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt.version !== VERSION || receipt.status !== 'ready') throw Error('invalid or unsupported review snapshot receipt');
  if (!/^[a-f0-9]{64}$/.test(receipt.manifestSha256)) throw Error('receipt has invalid manifest SHA-256');
  if (receipt.snapshotRoot !== path.dirname(receiptPath) || receipt.manifestPath !== path.join(receipt.snapshotRoot, SNAPSHOT_LAYOUT.manifest) ||
      receipt.snapshotDir !== path.join(receipt.snapshotRoot, SNAPSHOT_LAYOUT.tree)) throw Error('receipt paths do not match its snapshot root');
  const canonicalRoot = await fs.realpath(receipt.snapshotRoot);
  if (canonicalRoot !== receipt.snapshotRoot || path.dirname(receipt.snapshotRoot) !== await fs.realpath(os.tmpdir()) ||
      !path.basename(receipt.snapshotRoot).startsWith(SNAPSHOT_PREFIX))
    throw Error('review snapshot root is not a canonical managed temporary directory');
  const manifestInfo = await fs.lstat(receipt.manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 4 * 1024 * 1024)
    throw Error('review snapshot manifest is not a bounded regular file');
  const manifestBytes = await fs.readFile(receipt.manifestPath);
  if (sha256(manifestBytes) !== receipt.manifestSha256) throw Error('review snapshot manifest hash mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.version !== VERSION || manifest.targetRoot !== receipt.targetRoot || manifest.snapshotDir !== receipt.snapshotDir || manifest.scope !== receipt.scope)
    throw Error('review snapshot receipt and manifest do not match');
  if (!manifest.evidencePack || receipt.evidencePackPath !== path.join(receipt.snapshotRoot, SNAPSHOT_LAYOUT.evidencePack) ||
      manifest.evidencePack.path !== receipt.evidencePackPath || manifest.evidencePack.sha256 !== receipt.evidencePackSha256)
    throw Error('review snapshot receipt and manifest disagree on the evidence pack');
  return { receipt, manifest };
}

async function verifySnapshot(receiptPath) {
  const { receipt, manifest } = await readReceipt(receiptPath);
  const targetRoot = await canonicalDirectory(receipt.targetRoot, 'receipt target');
  if (targetRoot !== receipt.targetRoot) throw Error('canonical target path changed');
  const snapshotInfo = await fs.lstat(receipt.snapshotDir);
  if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) throw Error('snapshot directory is missing or invalid');
  const snapshotNow = await collectTree(receipt.snapshotDir);
  const expected = { files: manifest.files, directories: manifest.directories, totalBytes: manifest.totalBytes };
  if (stableJson(snapshotNow) !== stableJson(expected)) throw Error('frozen target snapshot drifted from its manifest');
  const packInfo = await fs.lstat(manifest.evidencePack.path);
  if (!packInfo.isFile() || packInfo.isSymbolicLink() || packInfo.size !== manifest.evidencePack.bytes ||
      sha256(await fs.readFile(manifest.evidencePack.path)) !== manifest.evidencePack.sha256)
    throw Error('evidence pack drifted from its manifest');
  const sourceNow = await collectTree(targetRoot);
  if (stableJson(sourceNow) !== stableJson(expected)) throw Error('live target changed after snapshot preparation');
  if (manifest.scope === 'diff') {
    const diffInfo = await resolveDiff(targetRoot, manifest.diffRef);
    if (diffInfo.gitRoot !== manifest.gitRoot || diffInfo.repoPath !== manifest.repoPath || diffInfo.baseOid !== manifest.baseOid ||
        diffInfo.headOid !== manifest.headOid || stableJson(diffInfo.changedPaths) !== stableJson(manifest.changedPaths) ||
        sha256(diffInfo.diff) !== manifest.diffSha256 || diffInfo.diff.length !== manifest.diffBytes)
      throw Error('git diff or changed paths changed after snapshot preparation');
    for (const [filePath, maxBytes] of [[manifest.diffPath, MAX_DIFF_BYTES], [manifest.changedPathsPath, MAX_TOTAL_BYTES]]) {
      const info = await fs.lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw Error(`frozen diff artifact is not a bounded regular file: ${filePath}`);
    }
    const diffBytes = await fs.readFile(manifest.diffPath);
    const changedBytes = await fs.readFile(manifest.changedPathsPath);
    if (sha256(diffBytes) !== manifest.diffSha256 || stableJson(JSON.parse(changedBytes.toString('utf8'))) !== stableJson(manifest.changedPaths))
      throw Error('frozen diff files drifted from their manifest');
  }
  return {
    status: 'verified',
    scope: receipt.scope,
    targetRoot: receipt.targetRoot,
    snapshotDir: receipt.snapshotDir,
    manifestSha256: receipt.manifestSha256,
    fileCount: manifest.files.length,
    byteCount: manifest.totalBytes,
    changedPathCount: manifest.changedPaths.length,
  };
}

async function cleanupSnapshot(receiptPath) {
  if (!receiptPath || !path.isAbsolute(receiptPath)) throw Error('--receipt must be an absolute path');
  const root = path.dirname(await fs.realpath(receiptPath));
  const tmpRoot = await fs.realpath(os.tmpdir());
  if (path.dirname(root) !== tmpRoot || !path.basename(root).startsWith(SNAPSHOT_PREFIX))
    throw Error('refusing to remove a path outside the managed review snapshot directory');
  const makeWritable = async (directory) => {
    await fs.chmod(directory, 0o700).catch(() => {});
    for (const name of await fs.readdir(directory).catch(() => [])) {
      const child = path.join(directory, name);
      const info = await fs.lstat(child);
      if (info.isSymbolicLink()) await fs.unlink(child);
      else if (info.isDirectory()) await makeWritable(child);
      else if (info.isFile()) await fs.chmod(child, 0o600);
      else throw Error(`refusing to clean a special file: ${child}`);
    }
  };
  await makeWritable(root);
  await fs.rm(root, { recursive: true, force: true });
  return { status: 'removed', snapshotRoot: root };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === '--target' || key === '--scope' || key === '--diff-ref' || key === '--receipt') {
      const value = rest[++i];
      if (!value) throw Error(`${key} requires a value`);
      const field = { '--target': 'target', '--scope': 'scope', '--diff-ref': 'diffRef', '--receipt': 'receipt' }[key];
      if (args[field] !== undefined) throw Error(`${key} was provided more than once`);
      args[field] = value;
    } else throw Error(`unknown argument: ${key}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'prepare') return await createSnapshot(args);
  if (args.command === 'verify') return await verifySnapshot(args.receipt);
  if (args.command === 'cleanup') return await cleanupSnapshot(args.receipt);
  throw Error('usage: review-snapshot.mjs prepare --target ABSOLUTE_PATH --scope full|diff [--diff-ref BASE...HEAD] | verify|cleanup --receipt ABSOLUTE_PATH');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => process.stdout.write(`${stableJson(result)}`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  EVIDENCE_PACK_EXTENSIONS,
  MAX_DIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  SNAPSHOT_LAYOUT,
  SNAPSHOT_PREFIX,
  VERSION,
  cleanupSnapshot,
  createSnapshot,
  verifySnapshot,
};

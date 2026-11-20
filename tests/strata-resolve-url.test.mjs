import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVE_SCRIPT = path.join(REPO_ROOT, 'plugins/strata/scripts/resolve-strata-url.sh');
const PLUGIN_MCP = path.join(REPO_ROOT, 'plugins/strata/scripts/strata-mcp');
const TOOLS_MCP = path.join(REPO_ROOT, 'tools/strata-mcp');

function makeTempDir(t, prefix = 'strata-resolve-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setupMockBin(dir) {
  const binDir = path.join(dir, 'bin');
  const logFile = path.join(dir, 'calls.log');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logFile, '');

  const sshPath = path.join(binDir, 'ssh');
  writeFileSync(
    sshPath,
    `#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> "${logFile}"
if [ "\${1:-}" = "-G" ]; then
  if [ -n "\${MOCK_SSH_IP:-}" ]; then
    printf 'hostname %s\\n' "$MOCK_SSH_IP"
  fi
  exit 0
fi
if [ -n "\${MOCK_WIN_NAME:-}" ]; then
  printf '%s\\n' "$MOCK_WIN_NAME"
fi
`,
  );
  chmodSync(sshPath, 0o755);

  const curlPath = path.join(binDir, 'curl');
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "${logFile}"
url=""
for arg in "$@"; do
  url="$arg"
done
for ok in \${MOCK_CURL_OK_PATTERNS:-}; do
  case "$url" in
    *"$ok"*) exit 0 ;;
  esac
done
exit 1
`,
  );
  chmodSync(curlPath, 0o755);

  return { binDir, logFile };
}

function readCalls(logFile) {
  const content = readFileSync(logFile, 'utf8').trim();
  return content === '' ? [] : content.split('\n');
}

const RESOLVE_URL_ENV_CASES = [
  {
    id: 'TC-01',
    name: 'TC-01: STRATA_BASE_URL が設定されていれば即座に返し ssh/curl を呼ばない',
    env: { STRATA_BASE_URL: 'http://192.168.1.99:9999/v1' },
    expected: 'http://192.168.1.99:9999/v1',
    expectSshCalled: false,
    expectCurlCalled: false,
  },
  {
    id: 'TC-02',
    name: 'TC-02: STRATA_BASE_URL が空文字なら未設定扱いとなり 127.0.0.1:8080 にフォールバックする',
    env: { STRATA_BASE_URL: '' },
    expected: 'http://127.0.0.1:8080/v1',
    expectSshCalled: false,
    expectCurlCalled: false,
  },
  {
    id: 'TC-03',
    name: 'TC-03: 既定（全環境変数未設定）では ssh/curl を呼ばず 127.0.0.1:8080 にフォールバックする',
    env: {},
    expected: 'http://127.0.0.1:8080/v1',
    expectSshCalled: false,
    expectCurlCalled: false,
  },
  {
    id: 'TC-04',
    name: 'TC-04: STRATA_PORT=18080 指定時は ssh/curl を呼ばず 127.0.0.1:18080 にフォールバックする',
    env: { STRATA_PORT: '18080' },
    expected: 'http://127.0.0.1:18080/v1',
    expectSshCalled: false,
    expectCurlCalled: false,
  },
  {
    id: 'TC-05',
    name: 'TC-05: STRATA_LAN_RESOLVE=0 時は STRATA_LAN_HOST があっても ssh/curl を呼ばず 127.0.0.1:8080 を返す',
    env: { STRATA_LAN_RESOLVE: '0', STRATA_LAN_HOST: '192.168.1.50' },
    expected: 'http://127.0.0.1:8080/v1',
    expectSshCalled: false,
    expectCurlCalled: false,
  },
];

for (const tc of RESOLVE_URL_ENV_CASES) {
  test(`resolve-url-env: ${tc.name}`, t => {
    const dir = makeTempDir(t);
    const { binDir, logFile } = setupMockBin(dir);
    const env = {
      PATH: `${binDir}:/usr/bin:/bin`,
      ...tc.env,
    };
    const stdout = execFileSync('/bin/bash', [RESOLVE_SCRIPT], { env, encoding: 'utf8' });
    assert.equal(stdout.trim(), tc.expected);

    const calls = readCalls(logFile);
    assert.equal(calls.some(c => c.startsWith('ssh ')), tc.expectSshCalled);
    assert.equal(calls.some(c => c.startsWith('curl ')), tc.expectCurlCalled);
  });
}

const RESOLVE_URL_DISCOVERY_CASES = [
  {
    id: 'TC-06',
    name: 'TC-06: STRATA_LAN_HOST 指定時は ssh を呼ばず curl のみで疎通確認し成功 URL を返す',
    env: {
      STRATA_LAN_HOST: '192.168.1.50',
      MOCK_CURL_OK_PATTERNS: '192.168.1.50:8080',
    },
    expected: 'http://192.168.1.50:8080/v1',
    expectSshCalled: false,
    expectCurlCalled: true,
  },
  {
    id: 'TC-07',
    name: 'TC-07: STRATA_LAN_HOST 指定時に curl が疎通失敗したら 127.0.0.1:8080 にフォールバックする',
    env: {
      STRATA_LAN_HOST: '192.168.1.50',
      MOCK_CURL_OK_PATTERNS: '',
    },
    expected: 'http://127.0.0.1:8080/v1',
    expectSshCalled: false,
    expectCurlCalled: true,
  },
  {
    id: 'TC-08',
    name: 'TC-08: PATH に curl が無い場合もエラーにならず 127.0.0.1:8080 にフォールバックする',
    env: {
      STRATA_LAN_HOST: '192.168.1.50',
    },
    omitCurlFromPath: true,
    expected: 'http://127.0.0.1:8080/v1',
    expectSshCalled: false,
    expectCurlCalled: false,
  },
  {
    id: 'TC-09',
    name: 'TC-09: STRATA_LAN_RESOLVE=1 時は .local を優先して疎通確認する',
    env: {
      STRATA_LAN_RESOLVE: '1',
      MOCK_WIN_NAME: 'winbox-host',
      MOCK_SSH_IP: '192.168.1.20',
      MOCK_CURL_OK_PATTERNS: 'winbox-host.local:8080 192.168.1.20:8080',
    },
    expected: 'http://winbox-host.local:8080/v1',
    expectSshCalled: true,
    expectCurlCalled: true,
  },
  {
    id: 'TC-10',
    name: 'TC-10: STRATA_LAN_RESOLVE=1 で .local 不可時は ssh -G の IP にフォールバックする',
    env: {
      STRATA_LAN_RESOLVE: '1',
      MOCK_WIN_NAME: 'winbox-host',
      MOCK_SSH_IP: '192.168.1.20',
      MOCK_CURL_OK_PATTERNS: '192.168.1.20:8080',
    },
    expected: 'http://192.168.1.20:8080/v1',
    expectSshCalled: true,
    expectCurlCalled: true,
  },
  {
    id: 'TC-11',
    name: 'TC-11: STRATA_LAN_RESOLVE=1 で候補が空配列でも set -u で unbound variable にならずフォールバックする',
    env: {
      STRATA_LAN_RESOLVE: '1',
      MOCK_WIN_NAME: '',
      MOCK_SSH_IP: '',
    },
    expected: 'http://127.0.0.1:8080/v1',
    expectSshCalled: true,
    expectCurlCalled: false,
  },
];

for (const tc of RESOLVE_URL_DISCOVERY_CASES) {
  test(`resolve-url-discovery: ${tc.name}`, t => {
    const dir = makeTempDir(t);
    const { binDir, logFile } = setupMockBin(dir);
    const emptyBin = path.join(dir, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });

    const env = {
      PATH: tc.omitCurlFromPath ? emptyBin : `${binDir}:/usr/bin:/bin`,
      ...tc.env,
    };
    const stdout = execFileSync('/bin/bash', [RESOLVE_SCRIPT], { env, encoding: 'utf8' });
    assert.equal(stdout.trim(), tc.expected);

    const calls = readCalls(logFile);
    assert.equal(calls.some(c => c.startsWith('ssh ')), tc.expectSshCalled);
    assert.equal(calls.some(c => c.startsWith('curl ')), tc.expectCurlCalled);
  });
}

function setupWrapperSandbox(t, { wrapResolveScript = false } = {}) {
  const root = makeTempDir(t, 'strata-wrapper-');
  const pluginScripts = path.join(root, 'plugins/strata/scripts');
  const pluginMeta = path.join(root, 'plugins/strata/.claude-plugin');
  const toolsDir = path.join(root, 'tools');
  const pathBin = path.join(root, 'path-bin');
  const xdgDir = path.join(root, 'xdg');
  const resolveLog = path.join(root, 'resolve-calls.log');

  mkdirSync(pluginScripts, { recursive: true });
  mkdirSync(pluginMeta, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(pathBin, { recursive: true });
  mkdirSync(xdgDir, { recursive: true });
  writeFileSync(resolveLog, '');

  copyFileSync(PLUGIN_MCP, path.join(pluginScripts, 'strata-mcp'));
  chmodSync(path.join(pluginScripts, 'strata-mcp'), 0o755);

  const sandboxResolve = path.join(pluginScripts, 'resolve-strata-url.sh');
  if (wrapResolveScript) {
    const realResolve = path.join(pluginScripts, 'resolve-strata-url.real.sh');
    copyFileSync(RESOLVE_SCRIPT, realResolve);
    chmodSync(realResolve, 0o755);
    writeFileSync(
      sandboxResolve,
      `#!/usr/bin/env bash
printf 'called\\n' >> "${resolveLog}"
exec "${realResolve}" "$@"
`,
    );
  } else {
    copyFileSync(RESOLVE_SCRIPT, sandboxResolve);
  }
  chmodSync(sandboxResolve, 0o755);

  writeFileSync(path.join(pluginMeta, 'plugin.json'), '{"version":"0.1.0"}\n');

  copyFileSync(TOOLS_MCP, path.join(toolsDir, 'strata-mcp'));
  chmodSync(path.join(toolsDir, 'strata-mcp'), 0o755);

  const mockStrataScript = `#!/usr/bin/env bash
printf 'STRATA_BASE_URL=%s ARGS=%s\\n' "\${STRATA_BASE_URL:-}" "$*"
`;
  writeFileSync(path.join(toolsDir, 'strata'), mockStrataScript);
  chmodSync(path.join(toolsDir, 'strata'), 0o755);
  writeFileSync(path.join(pathBin, 'strata'), mockStrataScript);
  chmodSync(path.join(pathBin, 'strata'), 0o755);

  return {
    pluginMcp: path.join(pluginScripts, 'strata-mcp'),
    toolsMcp: path.join(toolsDir, 'strata-mcp'),
    pathBin,
    xdgDir,
    resolveLog,
  };
}

const WRAPPER_CASES = [
  {
    id: 'TC-12',
    name: 'TC-12: 両ラッパーが resolve-strata-url.sh の結果を STRATA_BASE_URL に export し、tools/resolve-strata-url.sh が存在しない',
    env: { STRATA_PORT: '19090' },
    expectedLine: 'STRATA_BASE_URL=http://127.0.0.1:19090/v1 ARGS=mcp --stdio',
    expectResolveCalled: true,
    checkRepoLayout: true,
  },
  {
    id: 'TC-13',
    name: 'TC-13: STRATA_BASE_URL が設定済みの場合は resolve-strata-url.sh を呼ばず既存の値を保持する',
    env: { STRATA_BASE_URL: 'http://preset:7777/v1' },
    expectedLine: 'STRATA_BASE_URL=http://preset:7777/v1 ARGS=mcp --stdio',
    expectResolveCalled: false,
    checkRepoLayout: false,
  },
];

for (const tc of WRAPPER_CASES) {
  test(`wrapper-integration: ${tc.name}`, t => {
    if (tc.checkRepoLayout) {
      assert.equal(existsSync(path.join(REPO_ROOT, 'tools/resolve-strata-url.sh')), false);
      assert.equal(existsSync(RESOLVE_SCRIPT), true);
    }

    const sandbox = setupWrapperSandbox(t, { wrapResolveScript: true });
    const env = {
      PATH: `${sandbox.pathBin}:/usr/bin:/bin`,
      XDG_DATA_HOME: sandbox.xdgDir,
      ...tc.env,
    };

    const pluginOut = execFileSync('/bin/bash', [sandbox.pluginMcp, '--stdio'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(pluginOut.trim(), tc.expectedLine);

    const toolsOut = execFileSync('/bin/bash', [sandbox.toolsMcp, '--stdio'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(toolsOut.trim(), tc.expectedLine);

    const resolveCalls = readCalls(sandbox.resolveLog);
    assert.equal(resolveCalls.length, tc.expectResolveCalled ? 2 : 0);
  });
}

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { exactObject } from './inputs.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);

// Host-owned settings only: no arbitrary CLI options, instruction replacement,
// permission changes, catalog truncation, or inferred model/skill selection.
export function contextPolicy(input) {
  if (input === undefined) return {
    validate() {},
    async prepare() { return { status: 'host-context-unverified' }; },
    async select() { return { sdkConfig: {}, receipt: { status: 'host-context-unverified' } }; },
  };
  exactObject(input, ['profiles', 'assignments', 'defaultProfile'], 'context');
  exactObject(input.profiles, Object.keys(input.profiles ?? {}), 'context.profiles');
  exactObject(input.assignments, Object.keys(input.assignments ?? {}), 'context.assignments');
  const profiles = new Map(), assignments = new Map(Object.entries(input.assignments));
  const defaultProfile = input.defaultProfile;
  if (!Object.keys(input.profiles).length || (!assignments.size && defaultProfile === undefined)) throw Error('context requires profiles and assignments or defaultProfile');
  if (Object.keys(input.profiles).length > 32 || assignments.size > 256) throw Error('context inventory exceeds limit');
  for (const [id, value] of Object.entries(input.profiles)) {
    if (!name(id)) throw Error('invalid context profile name');
    exactObject(value, ['memory', 'apps', 'plugins', 'references'], 'context profile');
    for (const key of ['memory', 'apps', 'plugins'])
      if (!['inherit', 'off'].includes(value[key])) throw Error(`context profile requires ${key}: inherit or off`);
    if (!Array.isArray(value.references)) throw Error('context profile requires references array');
    if (value.references.length > 256) throw Error('context file inventory exceeds limit');
    const references = value.references.map(ref => {
      exactObject(ref, ['path', 'sha256'], 'context reference');
      if (typeof ref.path !== 'string' || !isAbsolute(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? ''))
        throw Error('context reference requires absolute path and sha256');
      return { ...ref };
    });
    profiles.set(id, { memory: value.memory, apps: value.apps, plugins: value.plugins, references });
  }
  for (const [label, id] of assignments)
    if (typeof label !== 'string' || !label.trim() || label.length > 256 || !profiles.has(id))
      throw Error('invalid context label assignment');
  if (defaultProfile !== undefined && (!name(defaultProfile) || !profiles.has(defaultProfile)))
    throw Error('invalid default context profile');

  function validate(options) {
    if (!assignments.has(options.label) && defaultProfile === undefined) throw Error(`unassigned context label: ${options.label ?? '(missing)'}`);
  }
  // One immutable file snapshot per backend. Recheck before every dispatch. Keep
  // the in-flight first preparation shared when multiple callers arrive together.
  let first;
  async function inspect() {
    const entries = [];
    for (const [id, profile] of profiles) {
      const references = [];
      for (const ref of profile.references) {
        const canonical = await realpath(ref.path);
        const info = await stat(canonical);
        if (!info.isFile() || info.size > 1000000) throw Error('reference must be a file of at most 1000000 bytes');
        if (references.some(x => x.path === canonical)) throw Error('duplicate context reference');
        const digest = sha256(await readFile(canonical));
        if (digest !== ref.sha256) throw Error(`context reference changed: ${ref.path}`);
        references.push({ path: canonical, sha256: digest });
      }
      entries.push([id, { memory: profile.memory, apps: profile.apps, plugins: profile.plugins, references }]);
    }
    return entries;
  }
  async function prepare() {
    if (!first) first = inspect();
    const baseline = await first;
    const current = await inspect();
    if (JSON.stringify(baseline) !== JSON.stringify(current)) throw Error('context file inventory drift');
    return {
      status: 'configured-not-runtime-certified',
      profiles: Object.fromEntries(baseline), assignments: Object.fromEntries(assignments),
      ...(defaultProfile === undefined ? {} : { defaultProfile }),
      boundary: 'File provenance and requested settings only. Not a tool allowlist, skill-discovery receipt, proof of reading, or token reduction measurement.',
    };
  }
  return {
    validate, prepare,
    async select(options) {
      validate(options);
      const policy = await prepare();
      const assigned = assignments.has(options.label);
      const id = assigned ? assignments.get(options.label) : defaultProfile, profile = policy.profiles[id];
      const sdkConfig = { features: {} };
      if (profile.memory === 'off') sdkConfig.memories = { use_memories: false, generate_memories: false };
      if (profile.apps === 'off') sdkConfig.features.apps = false;
      if (profile.plugins === 'off') { sdkConfig.features.plugins = false; sdkConfig.features.remote_plugin = false; }
      return { sdkConfig, receipt: { status: policy.status, label: options.label, profile: id,
        selection: assigned ? 'exact-label' : 'host-default',
        settingsHash: sha256(JSON.stringify(sdkConfig)), settings: sdkConfig,
        references: profile.references, boundary: policy.boundary } };
    },
  };
}

export function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unsupported ${name} field: ${key}`);
  }
  return value;
}

export const requestKeys = ['scriptPath', 'args'];
export const backendKeys = ['cwd', 'modelMap', 'codexPathOverride', 'model', 'modelReasoningEffort', 'CodexClass', 'workspace', 'environment'];
export const limitKeys = ['maxAgents', 'concurrency', 'timeoutMs', 'maxOutputBytes'];

export function validateRequirements(requirements = [], capabilities = ['read-only', 'fresh-thread']) {
  if (!Array.isArray(requirements) || requirements.some(x => typeof x !== 'string'))
    throw new Error('requirements must be an array of strings');
  for (const capability of requirements) {
    if (!capabilities.includes(capability))
      throw new Error(`unsupported runtime requirement: ${capability}`);
  }
}

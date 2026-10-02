export const reasoningEfforts = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
const efforts = new Set(reasoningEfforts);

export function validateEffort(effort) {
  if (effort !== undefined && !efforts.has(effort)) throw new Error('invalid agent effort');
}

// This is operator policy, not a claim of cross-provider model equivalence.
export function modelResolver({ model, modelReasoningEffort, modelMap = {} } = {}) {
  function selection(value) {
    const item = typeof value === 'string' ? { model: value } : value;
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['model', 'modelReasoningEffort'].includes(key)) ||
        typeof item.model !== 'string' || !item.model.trim() ||
        (item.modelReasoningEffort !== undefined && !efforts.has(item.modelReasoningEffort)))
      throw new Error('invalid explicit model mapping');
    return Object.freeze({ ...item });
  }
  if (!modelMap || typeof modelMap !== 'object' || Array.isArray(modelMap))
    throw new Error('invalid modelMap');
  if (model === undefined && modelReasoningEffort !== undefined)
    throw new Error('reasoning effort requires an explicit default model');
  const fallback = model === undefined ? undefined : selection({ model, modelReasoningEffort });
  const mappings = new Map(Object.entries(modelMap).map(([key, value]) => [key, selection(value)]));
  return (requested, effort) => {
    validateEffort(effort);
    if (requested !== undefined && !mappings.has(requested))
      throw new Error(`explicit model mapping required: ${requested}`);
    const resolved = requested === undefined ? fallback : mappings.get(requested);
    return { requested: requested ?? null, origin: resolved ? 'explicit' : 'host-default',
      ...(resolved ?? {}), ...(effort === undefined ? {} : { modelReasoningEffort: effort }) };
  };
}

export const UPDATE_REQUIREMENTS = Object.freeze([
  'staging-write',
  'artifact-manifest',
  'fresh-reverify',
  'hash-bound-action-package',
]);

export function rejectUpdateWorkflow(request, host, sourceRequirements = []) {
  const declaredRequirements = [
    ...(Array.isArray(host.requirements) ? host.requirements : []),
    ...(Array.isArray(host.backend?.capabilities) ? host.backend.capabilities : []),
    ...(Array.isArray(sourceRequirements) ? sourceRequirements : []),
  ];
  if (request.args?.mode === 'update' || host.backend?.updateContract !== undefined ||
      declaredRequirements.some(requirement => UPDATE_REQUIREMENTS.includes(requirement)))
    throw Error('update workflows are not supported by the Codex runner');
}

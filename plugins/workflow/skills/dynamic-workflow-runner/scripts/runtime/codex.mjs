import { Codex } from '@openai/codex-sdk';
import { modelResolver } from './models.mjs';
import { exactObject, backendKeys } from './inputs.mjs';
import { workspacePolicy } from './workspaces.mjs';

// Transport only: keep the caller schema unchanged for runtime validation.
const transportSchema = { type: 'object', properties: { json: { type: 'string' } },
  required: ['json'], additionalProperties: false };

// No aliases or automatic provider substitution. Caller owns the mapping.
export function codexBackend(config = {}) {
  exactObject(config, backendKeys, 'Codex backend');
  const { cwd, modelMap = {}, codexPathOverride, model, modelReasoningEffort, CodexClass = Codex } = config;
  if (!cwd) throw new Error('explicit worker cwd required');
  const workspaces = workspacePolicy(cwd, config.workspace);
  const resolveModel = modelResolver({ model, modelReasoningEffort, modelMap });
  const codex = new CodexClass({ codexPathOverride,
    config: { features: { multi_agent: false }, model_provider: 'openai' } });
  return {
    capabilities: workspaces.capabilities,
    prepare: workspaces.prepare,
    validate(options) {
      resolveModel(options.model);
      workspaces.validate(options);
    },
    async run(prompt, options, { signal, emit }) {
      const selection = resolveModel(options.model);
      const policy = await workspaces.prepare();
      const directory = await workspaces.allocate(options, { signal, emit });
      emit({ type: 'model.selected', ...selection });
      const thread = codex.startThread({ workingDirectory: directory, skipGitRepoCheck: true,
        sandboxMode: policy.mode, approvalPolicy: 'never', webSearchMode: 'disabled',
        networkAccessEnabled: false, model: selection.model,
        modelReasoningEffort: selection.modelReasoningEffort });
      let answer, completed = false, failure;
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const sdkPrompt = options.schema === undefined ? prompt : `${prompt}\n\n[OUTPUT TRANSPORT]\nReturn an object with a single string field "json". That string must contain the JSON serialization of your role result satisfying this original schema: ${JSON.stringify(options.schema)}. The envelope is transport only; do not add it inside the role result.`;
      try {
      const { events } = await thread.runStreamed(sdkPrompt, { signal: controller.signal,
        outputSchema: options.schema === undefined ? undefined : transportSchema });
      for await (const event of events) {
        // Do not stream full tool output into the parent conversation or journal.
        if (event.type === 'thread.started') emit(event);
        if (event.type === 'item.completed' && event.item.type === 'agent_message') answer = event.item.text;
        if (event.type === 'turn.completed') { completed = true; emit(event); }
        // Drain the SDK generator so its process cleanup finishes before returning.
        if (event.type === 'turn.failed' || event.type === 'error') failure ??= new Error(event.error?.message ?? event.message);
      }
      if (failure) throw failure;
      if (!completed || answer === undefined) throw new Error('incomplete Codex turn');
      if (options.schema === undefined) return answer;
      const envelope = JSON.parse(answer);
      if (!envelope || Array.isArray(envelope) || typeof envelope.json !== 'string' ||
          Object.keys(envelope).length !== 1) throw new Error('invalid structured output envelope');
      return JSON.parse(envelope.json);
      } finally {
        // SDK removes process error listeners at cleanup; never abort it again later.
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

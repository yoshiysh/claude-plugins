import { Codex } from '@openai/codex-sdk';
import { modelResolver } from './models.mjs';
import { exactObject, backendKeys } from './inputs.mjs';

// No aliases or automatic provider substitution. Caller owns the mapping.
export function codexBackend(config = {}) {
  exactObject(config, backendKeys, 'Codex backend');
  const { cwd, modelMap = {}, codexPathOverride, model, modelReasoningEffort, CodexClass = Codex } = config;
  if (!cwd) throw new Error('explicit worker cwd required');
  const resolveModel = modelResolver({ model, modelReasoningEffort, modelMap });
  const codex = new CodexClass({ codexPathOverride,
    config: { features: { multi_agent: false }, model_provider: 'openai' } });
  return {
    validate(options) {
      resolveModel(options.model);
    },
    async run(prompt, options, { signal, emit }) {
      const selection = resolveModel(options.model);
      emit({ type: 'model.selected', ...selection });
      const thread = codex.startThread({ workingDirectory: cwd, skipGitRepoCheck: true,
        sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled',
        networkAccessEnabled: false, model: selection.model,
        modelReasoningEffort: selection.modelReasoningEffort });
      let answer, completed = false;
      const { events } = await thread.runStreamed(prompt, { signal, outputSchema: options.schema });
      for await (const event of events) {
        // Do not stream full tool output into the parent conversation or journal.
        if (event.type === 'thread.started') emit(event);
        if (event.type === 'item.completed' && event.item.type === 'agent_message') answer = event.item.text;
        if (event.type === 'turn.completed') { completed = true; emit(event); }
        if (event.type === 'turn.failed' || event.type === 'error') throw new Error(event.error?.message ?? event.message);
      }
      if (!completed || answer === undefined) throw new Error('incomplete Codex turn');
      return options.schema ? JSON.parse(answer) : answer;
    },
  };
}

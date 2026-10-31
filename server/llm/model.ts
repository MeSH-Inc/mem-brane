import { createDeepSeek } from '@ai-sdk/deepseek';
import { modelProvider } from './provider.js';
import { representationText } from '../../shared/representations.js';
import { streamText, type ModelMessage, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { RunInput } from '../../shared/types/domain.js';
import { machineOutput, type MachineOutput } from '../../shared/machine-output.js';
export interface ModelRequest {
  model: string;
  maxOutputTokens: number;
  inputs: RunInput[];
  signal: AbortSignal;
  actor?: string;
  messages?: ModelMessage[];
}
export interface ModelResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}
export type ModelExecutor = (
  request: ModelRequest,
  onChunk: (text: string) => void,
) => Promise<ModelResult>;
export function buildMessages(inputs: RunInput[]): ModelMessage[] {
  return inputs.map((input) => ({
    role:
      input.kind === 'source' || input.kind === 'reference' || input.kind === 'lineage_reference'
        ? 'user'
        : input.role,
    content:
      input.kind === 'source' || input.kind === 'reference' || input.kind === 'lineage_reference'
        ? `[Reference material: ${input.label}; revision ${input.revision_id}]\n${representationText(input.content)}${input.content.url ? `\nSource: ${input.content.url}` : ''}${input.content.format === 'image' ? '\n[Attached image from frozen revision; detail: low]' : ''}\n[End reference]`
        : input.kind === 'relation'
          ? `[Relation between reference materials] ${representationText(input.content)}`
          : representationText(input.content),
  }));
}
// The mock's answer to a prompt that asks for cards: the sentences of what was sent, as
// numbered items, and for a diagram each later item supporting the first.
function mockParts(texts: string[], output: MachineOutput) {
  const sentences = texts.flatMap((text) =>
    text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 4),
  );
  const items = (
    sentences.length >= 2 ? sentences : ['The main idea.', 'What follows from it.']
  ).slice(0, 8);
  const lines = items.map((item, index) => `${index + 1}. ${item}`);
  if (output === 'diagram')
    lines.push('', ...items.slice(1).map((_, index) => `${index + 2} —supports→ 1`));
  return lines.join('\n');
}
export const executeModel: ModelExecutor = async (request, onChunk) => {
  if (request.model === 'mock') {
    const prompt = request.inputs.filter((i) => i.kind === 'prompt').at(-1)?.content.text ?? '';
    const refs = request.inputs.filter((i) => i.kind === 'source' || i.kind === 'reference');
    const relations = request.inputs
      .filter((i) => i.kind === 'relation')
      .map((i) => `Relation: ${representationText(i.content)}\n\n`)
      .join('');
    const shape = machineOutput(prompt);
    const text =
      shape !== 'card'
        ? mockParts(
            refs.map((r) => representationText(r.content)),
            shape,
          )
        : `A little room to think.\n\n${prompt}\n\n${refs.length ? refs.map((r) => `${r.label}: ${representationText(r.content)}`).join('\n\n') : 'Add a block with “Use as context” to explore your notes.'}\n\n${relations}This is a deterministic mock response. Your submitted context is frozen; you can keep editing the brane.`.slice(
            0,
            request.maxOutputTokens * 4,
          );
    let output = '';
    for (let i = 0; i < text.length; i += 18) {
      request.signal.throwIfAborted();
      await new Promise((r) => setTimeout(r, 35));
      request.signal.throwIfAborted();
      const chunk = text.slice(i, i + 18);
      output += chunk;
      onChunk(chunk);
    }
    return { text: output };
  }
  return executeWithModel(
    request,
    onChunk,
    modelProvider(request.model) === 'deepseek'
      ? createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(request.model)
      : createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(request.model),
  );
};
export async function executeWithModel(
  request: ModelRequest,
  onChunk: (text: string) => void,
  model: LanguageModel,
): Promise<ModelResult> {
  const result = streamText({
    model,
    messages: request.messages ?? buildMessages(request.inputs),
    maxOutputTokens: request.maxOutputTokens,
    abortSignal: request.signal,
    maxRetries: 0,
    providerOptions:
      modelProvider(request.model) === 'deepseek'
        ? { deepseek: { thinking: { type: 'disabled' } } }
        : undefined,
    // The worker logs sanitized lifecycle metadata; SDK defaults can print full request bodies.
    onError: () => {},
  });
  let text = '';
  let completed = false;
  for await (const part of result.fullStream) {
    if (part.type === 'error') throw part.error;
    if (part.type === 'abort') throw new Error('Provider stream aborted');
    if (part.type === 'text-delta') {
      text += part.text;
      onChunk(part.text);
    }
    if (part.type === 'finish') completed = part.finishReason === 'stop';
  }
  request.signal.throwIfAborted();
  if (!completed) throw new Error('Provider did not confirm successful completion');
  return { text, usage: await result.usage };
}

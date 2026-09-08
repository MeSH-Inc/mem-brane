import { streamText, type ModelMessage, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { RunInput } from '../../shared/types/domain.js';
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
        ? `[Reference material: ${input.label}; revision ${input.revision_id}]\n${input.content.text}${input.content.url ? `\nSource: ${input.content.url}` : ''}${input.content.assetId ? '\n[Attached image from frozen revision; detail: low]' : ''}\n[End reference]`
        : input.content.text,
  }));
}
export const executeModel: ModelExecutor = async (request, onChunk) => {
  if (request.model === 'mock') {
    const prompt = request.inputs.filter((i) => i.kind === 'prompt').at(-1)?.content.text ?? '';
    const refs = request.inputs.filter((i) => i.kind === 'source' || i.kind === 'reference');
    const text =
      `A little room to think.\n\n${prompt}\n\n${refs.length ? refs.map((r) => `${r.label}: ${r.content.text}`).join('\n\n') : 'Add a block with “Use as context” to explore your notes.'}\n\nThis is a deterministic mock response. Your submitted context is frozen; you can keep editing the brane.`.slice(
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
    createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(request.model),
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

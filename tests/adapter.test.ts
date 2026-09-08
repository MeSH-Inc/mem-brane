import { expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { executeWithModel } from '../server/llm/model';
import { resolveMessages } from '../server/llm/assets';
import { openDatabase } from '../server/db/index';
import { uid } from '../server/services/content';
import { R2AssetStore } from '../server/storage/assets';
import type { RunInput } from '../shared/types/domain';
async function localServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
it('AI SDK sends exact frozen text and image bytes to a local provider, then records streamed usage', async () => {
  const db = openDatabase(':memory:'),
    actor = uid(),
    asset = uid(),
    bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    hash = createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'local',
    'local@test.test',
    0,
    0,
  );
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(
    asset,
    actor,
    asset,
    'image/png',
    bytes.length,
    0,
  );
  const input: RunInput = {
    position: 0,
    kind: 'reference',
    label: 'Reference 1',
    role: 'user',
    revision_id: uid(),
    content: {
      format: 'image',
      filename: 'image',
      representation: 'original-image-v1',
      text: 'Frozen caption',
      assetId: asset,
      assetHash: hash,
      mimeType: 'image/png',
    },
  };
  const store = {
    get: async () => bytes,
    put: async () => {},
    delete: async () => {},
    createReadUrl: async () => '',
  };
  const messages = await resolveMessages(db, store, actor, [input]);
  let submitted: any,
    calls = 0;
  const server = await localServer(async (req, res) => {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    submitted = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Local response' }, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  try {
    const chunks: string[] = [];
    const result = await executeWithModel(
      {
        model: 'test-model',
        maxOutputTokens: 30,
        inputs: [input],
        messages,
        signal: AbortSignal.timeout(3000),
      },
      (c) => chunks.push(c),
      createOpenAI({ apiKey: 'local-test-only', baseURL: server.url }).chat('test-model'),
    );
    expect(result.text).toBe('Local response');
    expect(result.usage?.inputTokens).toBe(12);
    expect(calls).toBe(1);
    expect(JSON.stringify(submitted.messages)).toContain(
      hash === null ? 'impossible' : 'Frozen caption',
    );
    expect(JSON.stringify(submitted.messages)).toContain(
      `data:image/png;base64,${bytes.toString('base64')}`,
    );
    await expect(
      resolveMessages(db, { ...store, get: async () => Buffer.from('changed') }, actor, [input]),
    ).rejects.toThrow('no longer matches');
    await expect(resolveMessages(db, store, uid(), [input])).rejects.toThrow('not found');
  } finally {
    await server.close();
    db.close();
  }
});
it('R2 adapter round-trips against a local S3-compatible HTTP fixture without external credentials', async () => {
  const objects = new Map<string, Buffer>();
  const server = await localServer(async (req, res) => {
    const key = req.url!.split('?')[0];
    if (req.method === 'PUT') {
      if (objects.has(key)) {
        res.writeHead(412);
        res.end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { ETag: '"test-etag"' });
      res.end();
    } else if (req.method === 'GET') {
      const bytes = objects.get(key);
      res.writeHead(bytes ? 200 : 404, { 'content-type': 'image/png' });
      res.end(bytes);
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(400);
      res.end();
    }
  });
  try {
    const store = new R2AssetStore('test-bucket', server.url, 'local-key', 'local-secret'),
      key = uid(),
      bytes = new Uint8Array([1, 2, 3, 4]);
    await store.put(key, bytes, 'image/png');
    expect(await store.get(key)).toEqual(bytes);
    await expect(store.put(key, bytes, 'image/png')).rejects.toThrow();
    expect(await store.createReadUrl(key)).toContain('X-Amz-Expires=60');
    await store.delete(key);
    expect(objects.size).toBe(0);
  } finally {
    await server.close();
  }
});

it('production Responses protocol streams locally and never retries provider failures automatically', async () => {
  let calls = 0;
  const server = await localServer(async (req, res) => {
    calls++;
    for await (const _ of req) {
    }
    if (calls > 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Local failure', type: 'server_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_local', created_at: 0, model: 'test-model' },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_local' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_local',
        delta: 'Responses verified locally',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg_local' },
      },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } },
      },
    ];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  try {
    const model = createOpenAI({ apiKey: 'local-test-only', baseURL: server.url })('test-model');
    const request = {
      model: 'test-model',
      maxOutputTokens: 30,
      inputs: [
        {
          position: 0,
          kind: 'prompt' as const,
          label: 'Prompt',
          role: 'user' as const,
          revision_id: uid(),
          content: { format: 'text' as const, text: 'Local test' },
        },
      ],
      signal: AbortSignal.timeout(3000),
    };
    const result = await executeWithModel(request, () => {}, model);
    expect(result.text).toBe('Responses verified locally');
    expect(result.usage?.outputTokens).toBe(4);
    await expect(executeWithModel(request, () => {}, model)).rejects.toThrow();
    expect(calls).toBe(2);
  } finally {
    await server.close();
  }
});

it.each(['eof', 'failed', 'incomplete'])(
  'rejects partial Responses output ending with %s',
  async (ending) => {
    const server = await localServer(async (req, res) => {
      for await (const _ of req) {
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events: unknown[] = [
        {
          type: 'response.created',
          response: { id: 'resp_partial', created_at: 0, model: 'test-model' },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_partial' },
        },
        { type: 'response.output_text.delta', item_id: 'msg_partial', delta: 'Partial answer' },
      ];
      if (ending === 'failed')
        events.push({
          type: 'error',
          code: 'server_error',
          message: 'Fixture failure',
          param: null,
        });
      if (ending === 'incomplete')
        events.push({
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          },
        });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    try {
      const chunks: string[] = [];
      await expect(
        executeWithModel(
          {
            model: 'test-model',
            maxOutputTokens: 30,
            inputs: [],
            messages: [{ role: 'user', content: 'Test' }],
            signal: AbortSignal.timeout(3000),
          },
          (chunk) => chunks.push(chunk),
          createOpenAI({ apiKey: 'fixture', baseURL: server.url })('test-model'),
        ),
      ).rejects.toThrow();
      expect(chunks.join('')).toBe('Partial answer');
    } finally {
      await server.close();
    }
  },
);

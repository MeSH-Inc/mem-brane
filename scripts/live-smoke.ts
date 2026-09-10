import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import {
  configurationResponse,
  estimateResponse,
  importReceiptResponse,
  runDetailResponse,
  braneResponse,
  workspaceResponse,
  revisionResponse,
} from '../shared/contracts.js';
import { submissionReceipt } from '../shared/schemas/index.js';

// Exercise the real API and its spend ledger. Never invoke a provider directly
// with a scratch ledger: that would bypass the deployment's shared budget caps.
const origin = process.env.SMOKE_ORIGIN;
const email = process.env.SMOKE_EMAIL,
  password = process.env.SMOKE_PASSWORD;
if (!origin || !email || !password)
  throw new Error(
    'Set SMOKE_ORIGIN, SMOKE_EMAIL and SMOKE_PASSWORD for a test account. No secrets are printed.',
  );
const url = new URL(origin);
if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Smoke credentials require HTTPS except on loopback.');
const cap = Number(process.env.SMOKE_MAX_USD ?? '0.05');
if (!Number.isFinite(cap) || cap <= 0 || cap > 1)
  throw new Error('SMOKE_MAX_USD must be positive and at most 1 USD.');
let cookie = '';
async function request(path: string, body?: unknown) {
  const response = await fetch(`${url.origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: url.origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined || body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (path.startsWith('/auth/'))
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  if (!response.ok)
    throw new Error(
      `Smoke API request failed: ${path}, HTTP ${response.status}. Inspect server logs without exposing credentials.`,
    );
  return response;
}
await request('/auth/sign-in/email', { email, password });
try {
  const config = configurationResponse.parse(await (await request('/config')).json());
  const model = process.env.SMOKE_MODEL ?? config.defaultModel;
  if (model === 'mock' && !process.argv.includes('--allow-mock'))
    throw new Error('Select a live model, or use --allow-mock for a local rehearsal.');
  if (!config.models.includes(model) || !config.modelCapabilities[model]?.vision)
    throw new Error('The smoke model must be allowlisted and support image input.');
  const brane = braneResponse.parse(
    await (
      await request('/branes', { title: `Integration smoke ${new Date().toISOString()}` })
    ).json(),
  );
  const bytes = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#df281e' },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'smoke-red.png');
  form.set(
    'intent',
    JSON.stringify({
      key: randomUUID(),
      braneId: brane.id,
      target: 'canvas',
      geometry: { x: 0, y: 0, width: 320, height: 220 },
    }),
  );
  const imported = importReceiptResponse.parse(await (await request('/imports', form)).json());
  const workspace = workspaceResponse.parse(await (await request(`/branes/${brane.id}`)).json());
  const assetId = workspace.blocks.find((b: { id: string }) => b.id === imported.blockId)?.content
    .assetId;
  if (!assetId) throw new Error('Upload receipt did not resolve to an image asset.');
  const downloaded = Buffer.from(await (await request(`/assets/${assetId}`)).arrayBuffer());
  if (!bytes.equals(downloaded)) throw new Error('Uploaded/downloaded asset bytes differ.');
  const input = {
    key: randomUUID(),
    braneId: brane.id,
    model,
    prompt: 'Reply briefly with smoke test ok, then name the dominant color of the attached image.',
    references: [imported.blockId],
    edits: [],
    maxOutputTokens: 64,
    maxReservedMicrousd: Math.floor(cap * 1e6),
  };
  const estimate = estimateResponse.parse(await (await request('/runs/estimate', input)).json());
  if (!estimate.canAfford || estimate.reservedMicrousd > cap * 1e6)
    throw new Error(
      'Smoke run exceeds its configured cap or available budget. No model request was submitted.',
    );
  const receipt = submissionReceipt.parse(await (await request('/runs', input)).json());
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const run = runDetailResponse.parse(await (await request(`/runs/${receipt.runId}`)).json());
    if (run.status === 'completed') {
      if (model !== 'mock' && run.cost?.status !== 'confirmed')
        throw new Error('Provider completed without confirmed accounting.');
      if (!run.output) throw new Error('Completed run is missing its persisted output.');
      const generated = revisionResponse.parse(
        await (await request(`/revisions/${run.output.revision_id}`)).json(),
      );
      if (
        !generated.content.text.trim() ||
        (model !== 'mock' && !/\bred\b/i.test(generated.content.text))
      )
        throw new Error('Smoke output did not identify the red image. Inspect the retained run.');
      console.log(
        `Smoke passed: authenticated upload/download, text + image invocation, completion and accounting. ${model === 'mock' ? 'LOCAL MOCK ONLY; live providers unverified.' : 'Live provider used.'} Reserved at most $${(estimate.reservedMicrousd / 1e6).toFixed(6)}. Review the retained smoke brane at ${url.origin}/b/${brane.id}.`,
      );
      break;
    }
    if (['failed', 'interrupted', 'cancelled'].includes(run.status))
      throw new Error(`Smoke run ended ${run.status}. No automatic paid retry was attempted.`);
    await delay(500);
    if (Date.now() >= deadline)
      throw new Error(
        `Smoke timed out. Inspect run ${receipt.runId}; do not assume the provider was free.`,
      );
  }
} finally {
  await request('/auth/sign-out', {});
}

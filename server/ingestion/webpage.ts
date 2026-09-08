import { abortable } from '../app/abort.js';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';
import type { DB } from '../db/index.js';
import { now } from '../services/content.js';
export function isPublicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
export async function validateDestination(
  raw: string,
  resolver: Resolver = (hostname) => lookup(hostname, { all: true }),
) {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new Error('Only public HTTP(S) destinations on standard ports are allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  )
    throw new Error('Private host is not allowed');
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }]
    : await resolver(hostname);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error('Private or reserved address is not allowed');
  return { url, address: addresses[0] };
}
export async function boundedBody(body: AsyncIterable<Uint8Array>, max: number) {
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > max) throw new Error('Webpage exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function fetchWebpage(
  raw: string,
  maxBytes: number,
  signal: AbortSignal = AbortSignal.timeout(10000),
  dependencies: { resolve?: Resolver; fetch?: typeof fetch } = {},
) {
  let target = raw;
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted();
    const { url, address } = await abortable(
      validateDestination(target, dependencies.resolve),
      signal,
    );
    const agent = new Agent({
      connect: {
        lookup: ((_host: any, options: any, callback: any) => {
          if (options?.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }) as any,
      },
    });
    try {
      const response = await (dependencies.fetch ?? fetch)(url, {
        dispatcher: agent,
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'mem-brane/0.1', accept: 'text/html,text/plain' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Invalid redirect');
        target = new URL(location, url).href;
        continue;
      }
      if (!response.ok) throw new Error('Webpage request failed');
      const type = response.headers.get('content-type') ?? '';
      if (!/text\/(html|plain)/i.test(type)) throw new Error('Expected HTML or plain text');
      if (Number(response.headers.get('content-length')) > maxBytes)
        throw new Error('Webpage exceeds size limit');
      if (!response.body) throw new Error('Empty response');
      const body = await boundedBody(response.body, maxBytes);
      const text = type.includes('html')
        ? body
            .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim()
        : body;
      return { text, url: url.href, status: 'ready' as const };
    } finally {
      await agent.destroy();
    }
  }
  throw new Error('Too many redirects');
}
export class IngestionWorker {
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | null = null;
  private abort?: AbortController;
  constructor(
    private db: DB,
    private maxBytes: number,
    private onFatal?: (error: unknown) => void,
  ) {}
  private failed = false;
  get healthy() {
    return !this.failed;
  }
  private fail(error: unknown) {
    this.failed = true;
    if (this.timer) clearInterval(this.timer);
    this.onFatal?.(error);
  }
  start() {
    this.db.prepare("UPDATE ingestions SET status='queued' WHERE status='running'").run();
    this.timer = setInterval(() => {
      if (!this.active) {
        this.active = this.next()
          .catch((error) => this.fail(error))
          .finally(() => {
            this.active = null;
          });
      }
    }, 500);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    await this.active;
  }
  private async next() {
    const row = this.db
      .prepare(
        "SELECT i.block_id,l.content_json,l.version FROM ingestions i JOIN block_live_state l ON l.block_id=i.block_id WHERE i.status='queued' LIMIT 1",
      )
      .get() as any;
    if (!row) return;
    this.db.prepare("UPDATE ingestions SET status='running' WHERE block_id=?").run(row.block_id);
    this.abort = new AbortController();
    let content = JSON.parse(row.content_json),
      status = 'ready',
      error: string | null = null;
    try {
      content = await fetchWebpage(
        content.url,
        this.maxBytes,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
      );
    } catch {
      status = 'failed';
      error = 'Import failed. Paste webpage text as a fallback.';
      content = { ...content, status, error };
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE block_live_state SET content_json=?,version=version+1,updated_at=? WHERE block_id=? AND version=?',
        )
        .run(JSON.stringify(content), now(), row.block_id, row.version);
      this.db
        .prepare("UPDATE ingestions SET status=?,error=? WHERE block_id=? AND status='running'")
        .run(status, error, row.block_id);
    })();
  }
}

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../app/config.js';
export interface AssetStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  createReadUrl(key: string): Promise<string>;
}
export class FileAssetStore implements AssetStore {
  constructor(private directory: string) {}
  private path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid asset key');
    return join(this.directory, key);
  }
  async put(key: string, bytes: Uint8Array) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(key), bytes, { flag: 'wx' });
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async delete(key: string) {
    await unlink(this.path(key));
  }
  async createReadUrl(key: string) {
    this.path(key);
    return `/api/assets/${key}`;
  }
}
export class R2AssetStore implements AssetStore {
  private client: S3Client;
  constructor(
    private bucket: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) {
    this.client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  async put(key: string, bytes: Uint8Array, mime: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        IfNoneMatch: '*',
      }),
    );
  }
  async get(key: string) {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return (await response.Body?.transformToByteArray()) ?? new Uint8Array();
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async createReadUrl(key: string) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: 60,
    });
  }
}
export function assetStore(): AssetStore {
  if (process.env.R2_ENDPOINT) {
    for (const key of ['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
      if (!process.env[key]) throw new Error(`Missing ${key}`);
    return new R2AssetStore(
      process.env.R2_BUCKET!,
      process.env.R2_ENDPOINT,
      process.env.R2_ACCESS_KEY_ID!,
      process.env.R2_SECRET_ACCESS_KEY!,
    );
  }
  return new FileAssetStore(config.ASSET_DIRECTORY);
}
export function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const head = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.endsWith('WEBP')) return 'image/webp';
  return null;
}

import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { config } from '../server/app/config.js';
import { assetStore } from '../server/storage/assets.js';
import { backupPrefix, backupToRemote } from '../server/storage/remote-backup.js';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const bucket = required('BACKUP_BUCKET');
const s3 = new S3Client({
  endpoint: required('BACKUP_ENDPOINT'),
  region: required('BACKUP_REGION'),
  credentials: {
    accessKeyId: required('BACKUP_ACCESS_KEY_ID'),
    secretAccessKey: required('BACKUP_SECRET_ACCESS_KEY'),
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const sendOptions = () => ({ abortSignal: AbortSignal.timeout(120000) });
try {
  const result = await backupToRemote(
    config.DATABASE_PATH,
    assetStore(),
    {
      async exists(Key) {
        try {
          await s3.send(
            new HeadObjectCommand({ Bucket: bucket, Key: `${Key}.verified` }),
            sendOptions(),
          );
          return true;
        } catch (error) {
          if (error instanceof Error && error.name === 'NotFound') return false;
          throw error;
        }
      },
      async upload(Key, path, ContentLength) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key,
            Body: createReadStream(path),
            ContentLength,
            ContentType: 'application/gzip',
          }),
          sendOptions(),
        );
      },
      async checksum(Key) {
        const response = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key }),
          sendOptions(),
        );
        if (!(response.Body instanceof Readable)) throw new Error('Missing backup response stream');
        const digest = createHash('sha256');
        for await (const chunk of response.Body) digest.update(chunk);
        return digest.digest('hex');
      },
      async complete(Key, checksum) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${Key}.verified`,
            Body: checksum,
            ContentType: 'text/plain',
          }),
          sendOptions(),
        );
      },
      async keys() {
        const keys: string[] = [];
        let ContinuationToken: string | undefined;
        do {
          const result = await s3.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: backupPrefix, ContinuationToken }),
            sendOptions(),
          );
          for (const object of result.Contents ?? []) if (object.Key) keys.push(object.Key);
          ContinuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
        } while (ContinuationToken);
        return keys;
      },
      async remove(Key) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: `${Key}.verified` }),
          sendOptions(),
        );
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }), sendOptions());
      },
    },
    new Date(),
    process.argv.includes('--force'),
  );
  console.log(JSON.stringify({ event: 'remote_backup', ...result }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'remote_backup_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
  process.exitCode = 1;
} finally {
  s3.destroy();
}

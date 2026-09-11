import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';

// Device checks need a secure context for the application's native browser APIs.
// The temporary certificate is accepted only by the WebDriver test session; this
// command installs no certificate or trust profile on a device or the host.
const directory = mkdtempSync(join(tmpdir(), 'membrane-device-tls-'));
const key = join(directory, 'key.pem'),
  cert = join(directory, 'cert.pem');
const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a?.family === 'IPv4')
  .map((a) => a!.address);
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=mem-brane-local-fixture',
      '-addext',
      `subjectAltName=DNS:localhost,${addresses.map((a) => `IP:${a}`).join(',')}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const server = await preview({
    configFile: 'vite.stress.config.ts',
    preview: {
      host: '0.0.0.0',
      port: 4188,
      strictPort: true,
      https: { key: readFileSync(key), cert: readFileSync(cert) },
    },
  });
  server.printUrls();
  const close = () =>
    server.httpServer.close(() => {
      rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}

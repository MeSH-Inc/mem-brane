import { defineRailway, preserve, project, service, volume } from 'railway/iac';

export default defineRailway(() => {
  const memBraneVolume = volume('mem-brane-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'sfo',
    sizeMB: 5000,
  });
  const memBrane = service('mem-brane', {
    build: { buildEnvironment: 'V3', builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    healthcheck: '/health',
    healthcheckTimeout: 120,
    replicas: { sfo: 1 },
    deploy: { drainingSeconds: 25, restartPolicyMaxRetries: 5 },
    domains: [
      { domain: 'mem-brane.com', port: 3001 },
      { domain: 'www.mem-brane.com', port: 3001 },
    ],
    volumeMounts: { '/data': memBraneVolume },
    env: {
      APP_ORIGIN: preserve(),
      ASSET_DIRECTORY: preserve(),
      BETTER_AUTH_SECRET: preserve(),
      DAILY_USER_SPEND_LIMIT: preserve(),
      DATABASE_PATH: preserve(),
      GLOBAL_DAILY_SPEND_LIMIT: preserve(),
      GLOBAL_MONTHLY_SPEND_LIMIT: preserve(),
      HOST: preserve(),
      MODEL_ALLOWLIST: preserve(),
      MODEL_DEFAULT: preserve(),
      MODEL_PRICING_JSON: preserve(),
      NODE_ENV: preserve(),
      OCR_PROVIDER: preserve(),
      PORT: preserve(),
      REDIRECT_HOSTS: preserve(),
      SHUTDOWN_MS: preserve(),
      SIGNUP_INVITE_CODE: preserve(),
      SIGNUP_MODE: preserve(),
    },
  });

  return project('mem-brane', {
    resources: [memBrane, memBraneVolume],
  });
});

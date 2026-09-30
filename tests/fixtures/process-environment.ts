// Child fixtures inherit only OS runtime settings. In particular, credentials,
// provider endpoints, NODE_OPTIONS and dotenv preload settings never cross over.
const runtimeKeys = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'];

export function testProcessEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const runtime = Object.fromEntries(
    runtimeKeys.flatMap((key) => (inherited[key] === undefined ? [] : [[key, inherited[key]]])),
  );
  return {
    ...runtime,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    SIGNUP_MODE: 'open',
    GUEST_MODE: 'enabled',
    BETTER_AUTH_SECRET: 'isolated-fixture-only-mem-brane-auth-secret',
    MODEL_ALLOWLIST: 'mock',
    MODEL_DEFAULT: 'mock',
    MODEL_PRICING_JSON: '{}',
    OCR_PROVIDER: 'disabled',
    SHUTDOWN_MS: '3000',
    ...overrides,
  };
}

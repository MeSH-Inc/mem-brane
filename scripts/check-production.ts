import { config, costPolicy } from '../server/app/config.js';
const issues: string[] = [];
if (process.env.NODE_ENV !== 'production') issues.push('Set NODE_ENV=production.');
if (
  !config.APP_ORIGIN.startsWith('https://') ||
  new URL(config.APP_ORIGIN).hostname.endsWith('example.com')
)
  issues.push('Set APP_ORIGIN to the actual HTTPS origin.');
const secret = process.env.BETTER_AUTH_SECRET ?? '';
if (secret.length < 32 || secret.startsWith('replace-'))
  issues.push('Generate BETTER_AUTH_SECRET with at least 32 random bytes.');
const paid = config.models.filter((model) => model !== 'mock');
if (paid.length) {
  if (!process.env.OPENAI_API_KEY) issues.push('Set OPENAI_API_KEY on the server.');
  if (
    ![
      config.DAILY_USER_SPEND_LIMIT,
      config.GLOBAL_DAILY_SPEND_LIMIT,
      config.GLOBAL_MONTHLY_SPEND_LIMIT,
    ].every((value) => value > 0)
  )
    issues.push('Paid models require positive actor, global daily, and global monthly budgets.');
  for (const model of paid)
    if (!costPolicy.prices[model])
      issues.push(`Add verified pricing and capabilities for ${model}.`);
}
const r2 = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
if (r2.some((key) => process.env[key]) && !r2.every((key) => process.env[key]))
  issues.push('Set all four R2 settings or leave all four empty.');
if (process.env.R2_ENDPOINT && !process.env.R2_ENDPOINT.startsWith('https://'))
  issues.push('Use an HTTPS R2 endpoint.');
if (issues.length) {
  for (const issue of issues) console.error(issue);
  process.exitCode = 1;
} else
  console.log(
    `Production configuration is structurally valid. Models: ${paid.length ? paid.join(', ') : 'mock only'}. Storage: ${process.env.R2_ENDPOINT ? 'R2' : 'local files'}. Credentials and provider behavior still require the live smoke test.`,
  );

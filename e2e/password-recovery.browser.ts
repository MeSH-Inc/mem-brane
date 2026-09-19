import { test, expect } from '@playwright/test';

test('recovery requests are neutral and reset tokens leave the URL before password entry', async ({
  page,
}) => {
  const requests: { path: string; body: unknown }[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST')
      requests.push({ path, body: route.request().postDataJSON() });
    const json = path.endsWith('/session')
      ? null
      : path.endsWith('/entry-policy')
        ? { guest: false }
        : path.endsWith('/signup-policy')
          ? { mode: 'closed' }
          : path.endsWith('/recovery-policy')
            ? { enabled: true }
            : { status: true };
    await route.fulfill({ json });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email', { exact: true }).fill('unknown@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
  expect(requests[0]).toEqual({
    path: '/api/auth/request-password-reset',
    body: { email: 'unknown@example.com' },
  });
  await page.goto('/reset-password#token=browser-fixture-token');
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel('New password', { exact: true }).fill('new-browser-password');
  await page.getByLabel('Confirm new password').fill('mismatched-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert')).toContainText('Passwords must match');
  expect(requests).toHaveLength(1);
  await page.getByLabel('Confirm new password').fill('new-browser-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status')).toContainText('Sign in again on each device');
  expect(requests[1]).toEqual({
    path: '/api/auth/reset-password',
    body: { token: 'browser-fixture-token', newPassword: 'new-browser-password' },
  });
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Pick up a thought.' })).toBeVisible();
});

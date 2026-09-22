import type { Page } from '@playwright/test';

// React Flow measures nodes with a ResizeObserver. When a measurement changes layout,
// browsers (WebKit most often) defer the notification to the next frame and report this
// benign message. Every other page error still fails the test.
const deferredResize = 'ResizeObserver loop completed with undelivered notifications.';

export function collectPageErrors(page: Page, { console = false } = {}): string[] {
  const errors: string[] = [];
  const add = (message: string) => {
    if (message !== deferredResize) errors.push(message);
  };
  page.on('pageerror', (error) => add(error.message));
  if (console)
    page.on('console', (message) => {
      if (message.type() === 'error') add(message.text());
    });
  return errors;
}

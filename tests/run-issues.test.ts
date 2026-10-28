import { expect, it } from 'vitest';
import { ApiError } from '../src/services/transport';
import {
  estimateIssue,
  runIssueAction,
  runIssueOf,
  runIssueText,
} from '../src/services/run-issues';
import type { Estimate } from '../shared/contracts';

const estimate = (canAfford: boolean) => ({ canAfford, reservedMicrousd: 10 }) as Estimate;

it('offers the one action that can help for each refusal', () => {
  const issue = (code: ApiError['code']) => runIssueOf(new ApiError(429, 'Refused', code));
  const models = ['mock', 'deepseek-chat'];
  expect(runIssueAction(issue('guest_limit'), 'deepseek-chat', models)).toBe('account');
  expect(runIssueAction(issue('budget'), 'deepseek-chat', models)).toBe('mock_model');
  expect(runIssueAction(issue('budget'), 'mock', models)).toBeUndefined();
  expect(runIssueAction(issue('budget'), 'deepseek-chat', ['deepseek-chat'])).toBeUndefined();
  expect(runIssueAction(issue('capacity'), 'mock', models)).toBe('run_again');
  expect(runIssueAction(issue('rate_limited'), 'mock', models)).toBe('run_again');
  expect(runIssueAction(issue('invalid_request'), 'mock', models)).toBeUndefined();
  expect(runIssueAction(runIssueOf(new TypeError('Failed to fetch')), 'mock', models)).toBe(
    undefined,
  );
});

it('blocks Run only when the estimate proves the request will be refused', () => {
  expect(estimateIssue('deepseek-chat', estimate(true), undefined)).toBeUndefined();
  expect(estimateIssue('deepseek-chat', estimate(false), undefined)).toMatchObject({
    code: 'budget',
    blocking: true,
  });
  expect(estimateIssue('mock', estimate(false), undefined)).toBeUndefined();
  expect(
    estimateIssue(
      'deepseek-chat',
      undefined,
      new ApiError(403, 'Paid runs require verified model pricing', 'budget'),
    ),
  ).toMatchObject({ blocking: true, message: 'Paid runs require verified model pricing' });
  expect(
    estimateIssue('deepseek-chat', undefined, new ApiError(429, 'Too many', 'rate_limited')),
  ).toBeUndefined();
  expect(estimateIssue('mock', undefined, new TypeError('offline'))).toBeUndefined();
});

it('reads as sentences and adds a hint only where the message lacks one', () => {
  expect(
    runIssueText({ message: 'Concurrent run limit reached', code: 'capacity', blocking: false }),
  ).toBe('Concurrent run limit reached. Run again when a running response finishes.');
  expect(
    runIssueText({
      message: 'Guest workspace limit reached. Sign in to keep working.',
      code: 'guest_limit',
      blocking: false,
    }),
  ).toBe('Guest workspace limit reached. Sign in to keep working.');
  expect(
    runIssueText({ message: 'Context is too large', code: 'invalid_request', blocking: true }),
  ).toBe('Context is too large.');
});

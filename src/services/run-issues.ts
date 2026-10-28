import { ApiError } from './transport';
import type { ErrorCode } from '../../shared/errors';
import type { Estimate } from '../../shared/contracts';

// Why the next Run cannot start or did not start. A blocking issue disables Run,
// because sending the same request is certain to be refused.
export type RunIssue = { message: string; code?: ErrorCode; blocking: boolean };
export type RunIssueAction = 'account' | 'mock_model' | 'run_again';

export function runIssueOf(error: unknown): RunIssue {
  if (error instanceof ApiError)
    return { message: error.message, code: error.code, blocking: false };
  return {
    message: error instanceof Error ? error.message : 'Run could not start',
    blocking: false,
  };
}

export function estimateIssue(
  model: string,
  estimate: Estimate | undefined,
  error: unknown,
): RunIssue | undefined {
  if (error instanceof ApiError)
    return { message: error.message, code: error.code, blocking: !error.retryable };
  if (error) return { message: 'Cost estimate unavailable', blocking: false };
  if (model !== 'mock' && estimate && !estimate.canAfford)
    return {
      message: 'This prompt exceeds the remaining daily budget.',
      code: 'budget',
      blocking: true,
    };
}

export function runIssueAction(
  issue: RunIssue,
  model: string,
  models: string[],
): RunIssueAction | undefined {
  switch (issue.code) {
    case 'guest_limit':
      return 'account';
    case 'budget':
      return model !== 'mock' && models.includes('mock') ? 'mock_model' : undefined;
    case 'capacity':
    case 'rate_limited':
    case 'unavailable':
    case 'internal':
      return issue.blocking ? undefined : 'run_again';
    default:
      return undefined;
  }
}

export const runIssueHints: Partial<Record<ErrorCode, string>> = {
  capacity: 'Other responses are using every slot. Run again when one finishes.',
  rate_limited: 'Wait a moment, then run again.',
  budget: 'The budget resets daily. The local mock model has no spend.',
  guest_limit: 'A free account keeps everything in this guest workspace.',
};

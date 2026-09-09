import type { RequestJournal } from './request-journal';
import { ApiError } from './api';
export type SubmissionState<T> =
  | { status: 'idle' | 'preparing' | 'rejected' | 'accepted' }
  | { status: 'sending' | 'uncertain'; request: T };

// An uncertain request is immutable until its original key is reconciled.
export class Submission<T> {
  state: SubmissionState<T> = { status: 'idle' };
  constructor(
    private journal?: RequestJournal<T>,
    private lane = 'run',
  ) {
    const request = journal && !journal.error ? journal.get(lane) : undefined;
    if (request !== undefined) this.state = { status: 'uncertain', request };
  }
  async send<R>(
    prepare: () => Promise<T>,
    transport: (request: T) => Promise<R>,
  ): Promise<{ request: T; receipt: R }> {
    if (this.state.status === 'sending' || this.state.status === 'preparing')
      throw new Error('Submission already in progress');
    if (this.journal?.error) throw new Error(this.journal.error);
    const previous = this.state;
    let request: T;
    if (previous.status === 'uncertain') request = previous.request;
    else {
      this.state = { status: 'preparing' };
      try {
        request = structuredClone(await prepare());
      } catch (error) {
        this.state = { status: 'rejected' };
        throw error;
      }
    }
    try {
      this.journal?.set(this.lane, request);
    } catch (error) {
      this.state = previous;
      throw error;
    }
    this.state = { status: 'sending', request };
    try {
      const receipt = await transport(request);
      this.journal?.delete(this.lane);
      this.state = { status: 'accepted' };
      return { request, receipt };
    } catch (error) {
      const rejected =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408;
      this.state = { status: 'uncertain', request };
      if (rejected) {
        this.journal?.delete(this.lane);
        this.state = { status: 'rejected' };
      }
      throw error;
    }
  }
}

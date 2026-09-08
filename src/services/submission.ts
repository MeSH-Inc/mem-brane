import { ApiError } from './api';
export type SubmissionState<T> =
  | { status: 'idle' | 'preparing' | 'rejected' | 'accepted' }
  | { status: 'sending' | 'uncertain'; request: T };

// An uncertain request is immutable until its original key is reconciled.
export class Submission<T> {
  state: SubmissionState<T> = { status: 'idle' };
  async send(prepare: () => Promise<T>, transport: (request: T) => Promise<unknown>): Promise<T> {
    if (this.state.status === 'sending' || this.state.status === 'preparing')
      throw new Error('Submission already in progress');
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
    this.state = { status: 'sending', request };
    try {
      await transport(request);
      this.state = { status: 'accepted' };
      return request;
    } catch (error) {
      this.state =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
          ? { status: 'rejected' }
          : { status: 'uncertain', request };
      throw error;
    }
  }
}

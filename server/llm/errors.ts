// Only trusted preflight code may use this marker. Provider failures never imply zero billing.
export class BeforeInvocationError extends Error {
  constructor() {
    super('Model request preparation failed before provider invocation');
  }
}

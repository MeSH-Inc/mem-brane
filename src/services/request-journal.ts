// Persist before transport. Losing an acknowledgement must not create a new operation key.
// This journal has the same tab-session lifetime as workspace composer drafts.
export class RequestJournal<T> {
  private entries = new Map<string, T>();
  readonly error?: string;
  constructor(
    private key: string,
    validate: (value: unknown) => boolean,
    private storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
  ) {
    try {
      const raw = JSON.parse(storage.getItem(key) ?? '[]');
      if (
        !Array.isArray(raw) ||
        raw.some(
          (entry) =>
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            !validate(entry[1]),
        )
      )
        throw new Error('Invalid request journal');
      this.entries = new Map(raw);
    } catch {
      this.error =
        'Pending request recovery is unavailable. Submission is blocked to avoid duplicating an uncertain operation.';
    }
  }
  get(id: string) {
    if (this.error) throw new Error(this.error);
    const value = this.entries.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
  keys() {
    return this.entries.keys();
  }
  set(id: string, value: T) {
    this.write(new Map(this.entries).set(id, structuredClone(value)));
  }
  delete(id: string) {
    const next = new Map(this.entries);
    next.delete(id);
    this.write(next);
  }
  private write(next: Map<string, T>) {
    if (this.error) throw new Error(this.error);
    try {
      this.storage.setItem(this.key, JSON.stringify([...next]));
    } catch {
      throw new Error(
        'Could not preserve the request for safe retry. Keep this tab open and restore browser storage before retrying.',
      );
    }
    this.entries = next;
  }
}

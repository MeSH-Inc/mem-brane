export type AccountPrompt = { mode: 'signin' | 'signup'; reason?: string };
export const accountFeatureReason =
  'AI, webpage imports and snapshots need a free account. Everything in this guest workspace comes with you.';
// The shell owns the account dialog; features only describe why they need it.
export function requestAccount(prompt: AccountPrompt = { mode: 'signup' }) {
  window.dispatchEvent(new CustomEvent<AccountPrompt>('brane:sign-in', { detail: prompt }));
}
export const accountPromptOf = (event: Event): AccountPrompt =>
  (event as CustomEvent<AccountPrompt | undefined>).detail ?? { mode: 'signin' };

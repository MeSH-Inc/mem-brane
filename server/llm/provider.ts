// Provider identity is derived once for execution, accounting, and deployment checks.
// The local mocks ('mock', and 'mock-brief', which answers in one line) run in process,
// cost nothing and need no key.
export const LOCAL_MODELS = ['mock', 'mock-brief'];
export function modelProvider(model: string) {
  if (LOCAL_MODELS.includes(model)) return 'mock';
  return model.startsWith('deepseek-') ? 'deepseek' : 'openai';
}
export function providerKeyName(model: string) {
  return modelProvider(model) === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
}

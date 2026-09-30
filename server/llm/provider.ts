// Provider identity is derived once for execution, accounting, and deployment checks.
export function modelProvider(model: string) {
  if (model === 'mock') return 'mock';
  return model.startsWith('deepseek-') ? 'deepseek' : 'openai';
}
export function providerKeyName(model: string) {
  return modelProvider(model) === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
}

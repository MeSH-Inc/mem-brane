export function lifecycleLog(event: string, fields: Record<string, string | number>) {
  if (process.env.NODE_ENV === 'test') return;
  console.info(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

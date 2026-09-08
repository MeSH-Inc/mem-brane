export type CanvasTool = 'write' | 'pan' | 'select';
export const canvasTools: { id: CanvasTool; label: string }[] = [
  { id: 'write', label: '↗ Write' },
  { id: 'pan', label: '✥ Pan' },
  { id: 'select', label: '▱ Select' },
];

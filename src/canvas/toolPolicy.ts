import type { CanvasTool } from './tools';
export function toolPolicy(tool: CanvasTool) {
  return {
    hint: {
      write: 'Click to write · Drag to size a thought · Middle mouse to pan',
      pan: 'Drag to pan · Editors and block actions remain available',
      select: 'Click to select · Drag empty canvas to select several · Shift-click to toggle',
    }[tool],
  };
}

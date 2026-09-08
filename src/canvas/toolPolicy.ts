import { SelectionMode } from '@xyflow/react';

export type CanvasTool = 'write' | 'pan' | 'select';
export const canvasTools: { id: CanvasTool; label: string }[] = [
  { id: 'write', label: '↗ Write' },
  { id: 'pan', label: '✥ Pan' },
  { id: 'select', label: '▱ Select' },
];
const secondaryButtons = [1, 2];
const allButtons = [0, 1, 2];
export function toolPolicy(tool: CanvasTool) {
  return {
    panOnDrag: tool === 'pan' ? allButtons : secondaryButtons,
    nodesDraggable: tool !== 'pan',
    elementsSelectable: tool !== 'pan',
    selectionOnDrag: tool === 'select',
    selectionMode: SelectionMode.Partial,
    // Shift toggles cards; it must not capture gestures over editors or grips.
    selectionKeyCode: null,
    // Explicit tools own primary drag; avoid a second, implicit Space tool.
    panActivationKeyCode: null,
    multiSelectionKeyCode: 'Shift',
    hint: {
      write: 'Drag to make a thought · Shift-click to select several · Middle mouse to pan',
      pan: 'Drag to pan · Editors and block actions remain available',
      select: 'Drag empty canvas to select · Shift-click to toggle · Drag a header to move selection',
    }[tool],
  };
}

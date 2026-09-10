import type { ButtonHTMLAttributes } from 'react';
import { useStore } from 'zustand';
import { commandPending, type CommandTasks } from '../services/command-tasks';
export function CommandButton({
  tasks,
  taskKey,
  pendingLabel,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tasks: CommandTasks;
  taskKey: string;
  pendingLabel: string;
}) {
  const task = useStore(tasks.store, (state) => state[taskKey]);
  const pending = commandPending(task);
  return (
    <button {...props} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending ? pendingLabel : children}
    </button>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';

export function ActionMenu({
  label,
  children,
  className = '',
  align = 'left',
}: {
  label: string;
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  return (
    <details
      ref={ref}
      className={`action-menu ${className}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          ref.current?.removeAttribute('open');
          ref.current?.querySelector('summary')?.focus();
        }
      }}
    >
      <summary role="button" aria-label={label}>
        {label}
      </summary>
      <div
        className={`menu-content align-${align}`}
        onClick={(event) => {
          if ((event.target as Element).closest('button')) {
            ref.current?.removeAttribute('open');
            ref.current?.querySelector('summary')?.focus();
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}

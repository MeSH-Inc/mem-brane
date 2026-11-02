import { useEffect, useRef, type ReactNode } from 'react';

export function ActionMenu({
  label,
  text,
  children,
  className = '',
  align = 'left',
  onOpen,
}: {
  // Called each time the menu opens, for content worth reading only when it is seen.
  onOpen?: () => void;
  label: string;
  // Visible summary content when it differs from the accessible label.
  text?: ReactNode;
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
      onToggle={(event) => event.currentTarget.open && onOpen?.()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          ref.current?.removeAttribute('open');
          ref.current?.querySelector('summary')?.focus();
        }
      }}
    >
      <summary role="button" aria-label={label} title={text ? label : undefined}>
        {text ?? label}
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

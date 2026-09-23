import { useLayoutEffect } from 'react';

// dvh follows browser chrome, but does not consistently exclude the software
// keyboard. Keep the workspace inside the visible area without rerendering its
// editors on every keyboard animation frame.
export function useVisualViewport() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Preserve native page magnification; do not reflow the app under a
        // user's accessibility zoom. Canvas pinch has its own transform.
        if (viewport.scale !== 1) return;
        root.style.setProperty('--workspace-height', `${viewport.height}px`);
        root.style.setProperty('--workspace-top', `${viewport.offsetTop}px`);
      });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--workspace-height');
      root.style.removeProperty('--workspace-top');
    };
  }, []);
}

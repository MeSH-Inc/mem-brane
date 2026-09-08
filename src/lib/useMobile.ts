import { useSyncExternalStore } from 'react';
const query = () => window.matchMedia('(max-width: 760px)');
const subscribe = (callback: () => void) => {
  const media = query();
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
};
export const useMobile = () =>
  useSyncExternalStore(
    subscribe,
    () => query().matches,
    () => false,
  );

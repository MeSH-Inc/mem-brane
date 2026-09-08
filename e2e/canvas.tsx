import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useSearch,
} from '@tanstack/react-router';
import { BraneView } from '../src/routes/BraneView';
import '../src/app/styles.css';
function Harness() {
  const search = useSearch({ strict: false });
  return <BraneView braneId="b" view={search.view} focus={search.focus} />;
}
const validateSearch = (s: Record<string, unknown>) => ({
  view: s.view as 'canvas' | 'focus' | undefined,
  focus: s.focus as string | undefined,
});
const root = createRootRoute();
const route = createRoute({
  getParentRoute: () => root,
  path: '/e2e/canvas.html',
  validateSearch,
  component: Harness,
});
// The real navigation destination preserves BraneView across view changes.
const brane = createRoute({
  getParentRoute: () => root,
  path: '/b/$braneId',
  validateSearch,
  component: Harness,
});
const router = createRouter({ routeTree: root.addChildren([route, brane]) });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

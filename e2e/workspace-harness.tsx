import { useState } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useSearch,
} from '@tanstack/react-router';
import { BraneView } from '../src/routes/BraneView';
function Harness() {
  const search = useSearch({ strict: false });
  return <BraneView braneId="b" view={search.view} focus={search.focus} />;
}
const validateSearch = (s: Record<string, unknown>) => ({
  view: s.view as 'canvas' | 'focus' | undefined,
  focus: s.focus as string | undefined,
});
export function WorkspaceHarness({ entry = '/e2e/canvas.html' }: { entry?: string }) {
  const [router] = useState(() => {
    const root = createRootRoute();
    const route = createRoute({
      getParentRoute: () => root,
      path: entry,
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
    return createRouter({ routeTree: root.addChildren([route, brane]) });
  });
  return <RouterProvider router={router} />;
}

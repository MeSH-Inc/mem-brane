import { useInteraction } from '../src/stores/interaction';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceHarness } from './workspace-harness';
import '../src/app/styles.css';
void useInteraction
  .getState()
  .initialize('browser-fixture')
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <WorkspaceHarness />
      </StrictMode>,
    );
  });

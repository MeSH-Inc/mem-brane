import { useInteraction } from '../../src/stores/interaction';
import { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceHarness } from '../workspace-harness';
import { RenderObserver } from '../../src/lib/render-observer';
import { StressMetrics } from './metrics';
import { StressServer, placementId } from './server';
import '../../src/app/styles.css';
import './style.css';
const server = new StressServer();
server.install();
const metrics = new StressMetrics();
window.stress = { server, metrics };
declare global {
  interface Window {
    stress: { server: StressServer; metrics: StressMetrics };
  }
}
function Controls() {
  const [streaming, setStreaming] = useState(false);
  return (
    <div className="stress-controls" aria-label="Stress fixture controls">
      <strong>500 cards · four streams</strong>
      <button
        onClick={() => {
          streaming ? server.stopStreams() : server.startStreams();
          setStreaming(!streaming);
        }}
      >
        {streaming ? 'Stop streams' : 'Start streams'}
      </button>
      <label>
        Save delay{' '}
        <select
          aria-label="Save delay"
          defaultValue="350"
          onChange={(e) => {
            server.delayMs = Number(e.target.value);
          }}
        >
          <option value="0">0 ms</option>
          <option value="350">350 ms</option>
          <option value="1500">1500 ms</option>
        </select>
      </label>
      <button onClick={() => server.conflict(placementId(0))}>Conflict next move of card 1</button>
      <button onClick={() => metrics.reset('manual')}>Reset metrics</button>
      <button
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(metrics.report(), null, 2)], { type: 'application/json' }),
          );
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = 'canvas-stress.json';
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Export metrics
      </button>
      <small>Local fixture · simulated transport · no model calls</small>
    </div>
  );
}
void useInteraction
  .getState()
  .initialize('browser-fixture')
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <>
        <Controls />
        <RenderObserver.Provider value={metrics.onRender}>
          <Profiler id="workspace" onRender={metrics.onRender}>
            <WorkspaceHarness entry="/e2e/stress/index.html" />
          </Profiler>
        </RenderObserver.Provider>
      </>,
    );
  });

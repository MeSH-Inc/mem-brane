import { createContext, type ProfilerOnRenderCallback } from 'react';

// Opt-in profiling for the stress harness. Normal workspaces create no Profiler
// boundaries; this observes commits without depending on React fiber internals.
export const RenderObserver = createContext<ProfilerOnRenderCallback | null>(null);

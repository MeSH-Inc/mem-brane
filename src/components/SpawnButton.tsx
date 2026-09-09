import { modelCompatibility } from '../../shared/representations';
import type { Block } from '../../shared/types/domain';
export function SpawnButton({
  block,
  busy,
  retry,
  onSpawn,
}: {
  block: Block;
  busy?: boolean;
  retry?: boolean;
  onSpawn: () => void;
}) {
  const incompatibility = modelCompatibility(block.content);
  const ready =
    !incompatibility &&
    (block.origin === 'generated'
      ? Boolean(block.messageId)
      : block.kind !== 'webpage' || block.content.status === 'ready');
  return (
    <button
      className="spawn-button"
      disabled={busy || (!retry && !ready)}
      title={
        ready
          ? 'Generate a new artifact from this. Develops the selected artifact using the current model.'
          : (incompatibility ?? 'Wait for this artifact to finish before spawning.')
      }
      onClick={onSpawn}
    >
      {busy ? 'Spawning…' : retry ? 'Retry Spawn' : 'Spawn'}
    </button>
  );
}

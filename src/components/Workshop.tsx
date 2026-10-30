import { useEffect, useState } from 'react';
import type { Workshop as WorkshopItems } from '../../shared/contracts';
import { machineSlots } from '../../shared/machines';
import { client } from '../services/client';
import { Dialog } from './Dialog';

// The Workshop: machines to take out onto the table. Taking one out places a new
// machine with a copy of the prompt, so editing it never changes the Workshop's.
export function Workshop({
  onTakeOut,
  onClose,
}: {
  onTakeOut: (template: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<WorkshopItems>();
  const [error, setError] = useState('');
  const load = () =>
    client
      .workshop()
      .then(setItems)
      .catch(() =>
        setError('The Workshop could not be loaded. Check the connection and reopen it.'),
      );
  useEffect(() => void load(), []);
  const item = (name: string, template: string, remove?: () => void) => (
    <li key={`${name}:${template}`} className="workshop-item">
      <button
        className="workshop-take"
        title="Place a copy of this machine on the table"
        onClick={() => onTakeOut(template)}
      >
        <strong>{name}</strong>
        <span className="workshop-slots">
          {machineSlots(template)
            .map((slot) => `{${slot}}`)
            .join(' ')}
        </span>
        <span className="workshop-template">{template}</span>
      </button>
      {remove && (
        <button
          className="text-button"
          aria-label={`Remove ${name} from the Workshop`}
          onClick={remove}
        >
          ×
        </button>
      )}
    </li>
  );
  return (
    <Dialog title="Workshop" onClose={onClose}>
      <section className="workshop" aria-label="Workshop">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <span className="eyebrow">Built in</span>
        <ul>{items?.builtIn.map((m) => item(m.name, m.template))}</ul>
        <span className="eyebrow">Saved</span>
        {items && !items.saved.length && (
          <p className="muted">Save a machine from its ⋯ menu to keep it here.</p>
        )}
        <ul>
          {items?.saved.map((m) =>
            item(
              m.name,
              m.template,
              () =>
                void client
                  .removeFromWorkshop(m.id)
                  .then(load)
                  .catch(() => setError('This machine could not be removed. Try again.')),
            ),
          )}
        </ul>
      </section>
    </Dialog>
  );
}

import { openDatabase } from '../../server/db/index';
import { RunWorker } from '../../server/jobs/worker';
import { EventHub } from '../../server/sse/hub';
const db = openDatabase(process.env.TEST_DATABASE!);
const worker = new RunWorker(
  db,
  new EventHub(),
  async (request, chunk) => {
    process.send?.({ event: 'invoked' });
    chunk('Durable partial output');
    if (process.env.TEST_COMPLETE === 'yes')
      return {
        text: 'Completed after explicit retry',
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    await new Promise((_, reject) =>
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
    );
    return { text: '' };
  },
  { concurrency: 1, leaseMs: 500, checkpointMs: 30, checkpointCharacters: 1 },
);
worker.start();
process.send?.({ event: 'ready' });
process.on('SIGTERM', async () => {
  await worker.stop();
  db.close();
  process.exit(0);
});

import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAuth } from './auth.mjs';
import { createAuthBridge } from './auth-bridge.mjs';
import { KoalaCatalog } from './catalog.mjs';
import { KoalaGroups } from './groups.mjs';
import { subscribeStatus } from './events.mjs';
import { openTask } from './herdr.mjs';
import { WaitingTone } from './sound.mjs';

const shutdown = new AbortController();
const tone = new WaitingTone();
let catalog;
let groups;
let bridge;
let message = 'connecting.';
let soundError = null;
tone.onFailure = () => {
  soundError = 'couldn’t play sound. check ffplay and your audio device; toggle sound to retry.';
  publish(false);
};
function stop() { shutdown.abort(); tone.stop(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', stop);
function publish(updateSound = true) {
  const rows = catalog?.rows() ?? [];
  const view = { server: catalog?.server ?? '', fresh: catalog?.fresh ?? false, message: soundError || message,
    groups: groups?.project(rows) ?? [], sound: groups?.sound ?? false };
  const output = JSON.stringify(view) + '\n';
  // The UI cannot safely consume an unbounded stream if it stops reading.
  if (process.stdout.writableLength + Buffer.byteLength(output) > 1024 * 1024) { stop(); return; }
  process.stdout.write(output);
  const count = groups?.sound ? catalog.waitingCount(groups.selected(rows)) : 0;
  if (!count) tone.stop();
  if (updateSound && !soundError && !shutdown.signal.aborted) void tone.update(count).catch(() => {
    soundError = 'couldn’t play sound. check ffplay and your audio device; toggle sound to retry.';
    tone.stop();
    publish(false);
  });
}
const input = createInterface({ input: process.stdin });
let commands = Promise.resolve();
input.on('line', line => {
  if (line.length > 8192) { stop(); return; }
  commands = commands.then(async () => {
    const command = JSON.parse(line);
    if (command.type === 'shutdown') { stop(); return; }
    if (!groups || !catalog) throw new Error('koala is not configured.');
    if (command.type === 'open') {
      const task = catalog.rows().find(row => row.id === command.id);
      if (!task) throw new Error('task is no longer active.');
      await openTask(task, catalog.server, command.workspace, undefined, bridge?.path);
    } else {
      await groups.apply(command);
      if (command.type === 'sound') { soundError = null; tone.failure = null; }
    }
    message = catalog.fresh ? 'live.' : 'reconnecting; status is stale.';
    publish();
  }).catch(error => {
    message = error instanceof SyntaxError ? 'invalid adapter command.' : error.message;
    publish();
  });
});
input.on('close', stop);

try {
  const auth = createAuth();
  const server = await auth.resolveServer();
  bridge = await createAuthBridge(auth, server);
  catalog = new KoalaCatalog(server);
  groups = await KoalaGroups.load(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), server);
  let backoff = 250;
  while (!shutdown.signal.aborted) {
    try {
      const headers = await auth.headers(server);
      await subscribeStatus({ server, headers, catalog, signal: shutdown.signal,
        publish: () => { message = catalog.fresh ? 'live.' : 'reconnecting; status is stale.'; publish(); } });
      backoff = 250;
    } catch (error) {
      // Auth and protocol errors are already sanitized; fetch errors may contain credentials.
      message = /koala|server needs/.test(error.message) && !(error instanceof TypeError)
        ? error.message : 'couldn’t connect to koala. retrying.';
      publish();
    }
    if (!shutdown.signal.aborted) await delay(backoff, undefined, { signal: shutdown.signal }).catch(() => {});
    backoff = Math.min(backoff * 2, 10_000);
  }
} catch (error) {
  message = error.message;
  publish();
} finally { stop(); input.close(); await bridge?.close(); }

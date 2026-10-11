import { setTimeout as delay } from 'node:timers/promises';

function activity(task) {
  if (task.pty?.running === false) return 'stopped';
  if (task.pty?.running !== true) return 'unknown';
  const waiting = task.needsInput;
  if (waiting === true || (waiting && typeof waiting === 'object' &&
      Number.isFinite(Date.parse(waiting.since)))) return 'waiting';
  // Output recency cannot establish whether an agent is working or awaiting input.
  return 'unknown';
}

async function readTasks(response) {
  if ([401, 403].includes(response.status)) throw new Error('koala sign-in refused. run koala login again.');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) {
    throw new Error('couldn’t fetch koala tasks.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 4 * 1024 * 1024) throw new Error('koala task list too large.');
    chunks.push(Buffer.from(chunk));
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid koala task list.'); }
  const tasks = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task !== 'object' ||
      typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.status !== 'string')) {
    throw new Error('invalid koala task list.');
  }
  return tasks.filter(task => task.status === 'active').map(task => ({
    id: task.id, title: task.title, lifecycle: 'active', activity: activity(task),
  }));
}

/** Sequential legacy requests; a failure retains stale rows and silences waiting tones. */
export async function pollStatus({ server, getHeaders, catalog, signal, publish,
  fetchImpl = fetch, intervalMs = 3000, timeoutMs = 15000 }) {
  const generation = catalog.connect();
  let revision = 0;
  let previous = new Set();
  publish();
  try {
    while (!signal.aborted) {
      const request = new AbortController();
      const timeout = setTimeout(() => request.abort(), timeoutMs);
      let tasks;
      try {
        const headers = await getHeaders();
        const response = await fetchImpl(`${server}/api/tasks?status=active`, {
          headers: { ...headers, Accept: 'application/json' }, redirect: 'error',
          signal: AbortSignal.any([signal, request.signal]),
        });
        tasks = await readTasks(response);
      } finally { clearTimeout(timeout); request.abort(); }
      if (signal.aborted) break;
      const current = new Set(tasks.map(task => task.id.toLowerCase()));
      const event = revision === 0 ? { type: 'snapshot', tasks } : {
        type: 'change', upsert: tasks, remove: [...previous].filter(id => !current.has(id)),
      };
      catalog.apply(generation, { version: 1, epoch: 'polling', revision: revision++, ...event });
      previous = current;
      publish();
      await delay(intervalMs, undefined, { signal });
    }
  } finally { catalog.disconnect(generation); publish(); }
}

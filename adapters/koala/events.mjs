/** Incremental SSE decoder. Heartbeats are comments; events have bounded memory. */
export async function* statusEvents(body, onBytes = () => {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let size = 0;
  for await (const bytes of body) {
    onBytes();
    buffer += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line === '') {
        if (data.length) yield JSON.parse(data.join('\n'));
        data = []; size = 0;
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        size += value.length;
        if (size > 1024 * 1024) throw new Error('koala status event too large.');
        data.push(value);
      }
    }
    if (buffer.length + size > 1024 * 1024) throw new Error('koala status event too large.');
  }
  if (buffer || data.length) throw new Error('incomplete koala status event.');
}

export class StatusStreamUnavailable extends Error {
  constructor() { super('server needs the koala task-events capability.'); }
}

/** A single attempt. Caller owns reconnect/backoff and generation fencing. */
export async function subscribeStatus({ server, headers, catalog, signal, publish, fetchImpl = fetch }) {
  const generation = catalog.connect();
  publish();
  const transport = new AbortController();
  let heartbeat;
  const touch = () => {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => transport.abort(), 45_000);
  };
  touch();
  try {
    const response = await fetchImpl(`${server}/api/task-events`, {
      headers: { ...headers, Accept: 'text/event-stream' },
      redirect: 'error', signal: AbortSignal.any([signal, transport.signal]),
    });
    if ([401, 403].includes(response.status)) throw new Error('koala sign-in refused. run koala login again.');
    const contentType = response.headers.get('content-type') ?? '';
    if ([404, 405, 501].includes(response.status) || (response.ok && contentType.includes('text/html'))) {
      await response.body?.cancel();
      throw new StatusStreamUnavailable();
    }
    if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
      throw new Error('couldn’t connect to koala status stream.');
    }
    for await (const event of statusEvents(response.body, touch)) {
      if (catalog.apply(generation, event)) publish();
    }
  } finally {
    clearTimeout(heartbeat);
    transport.abort();
    catalog.disconnect(generation);
    publish();
  }
}

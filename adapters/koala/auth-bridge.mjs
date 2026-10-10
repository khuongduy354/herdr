import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeServer } from './catalog.mjs';

const LIMIT = 64 * 1024;
const unavailable = () => new Error('koala authentication bridge is unavailable. reopen the agent from herd.');
function headersValid(headers) {
  return headers && typeof headers === 'object' && !Array.isArray(headers)
    && Object.entries(headers).every(([key, value]) => ['Authorization', 'X-Koala-Token'].includes(key)
      && typeof value === 'string' && /^[\x20-\x7e]+$/.test(value));
}

/** Credentials cross a private, temporary local socket; only its path reaches pane launch state. */
export async function createAuthBridge(auth, server) {
  let allowed;
  try { allowed = normalizeServer(server); } catch { throw unavailable(); }
  const directory = await mkdtemp(join(tmpdir(), 'herd-auth-'));
  const path = join(directory, 'auth.sock');
  const connections = new Set();
  let closing;
  const listener = createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let requested = false;
    socket.on('data', async bytes => {
      if (requested) { socket.destroy(); return; }
      if (buffer.length + bytes.length > 8192) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, bytes]);
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      requested = true;
      try {
        const request = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (typeof request?.server !== 'string' || normalizeServer(request.server) !== allowed) {
          throw unavailable();
        }
        const headers = await auth.headers(allowed);
        if (!headersValid(headers)) throw unavailable();
        const response = JSON.stringify({ headers }) + '\n';
        if (Buffer.byteLength(response) > LIMIT || socket.destroyed || closing) throw unavailable();
        socket.end(response);
      } catch {
        if (!socket.destroyed) socket.end('{"error":"authentication unavailable"}\n');
      }
    });
  });
  listener.on('error', () => { for (const socket of connections) socket.destroy(); });
  const close = () => closing ??= (async () => {
    for (const socket of connections) socket.destroy();
    if (listener.listening) await new Promise(resolve => listener.close(resolve));
    await rm(directory, { recursive: true, force: true });
  })();
  try {
    await chmod(directory, 0o700);
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(path, () => { listener.off('error', reject); resolve(); });
    });
    await chmod(path, 0o600);
    return { path, close };
  } catch {
    await close();
    throw unavailable();
  }
}

/** A bridge failure never falls back to another credential source. */
export async function bridgeHeaders(path, server) {
  let target;
  try { target = normalizeServer(server); } catch { throw unavailable(); }
  return new Promise((resolve, reject) => {
    let socket;
    let finished = false;
    const finish = (headers) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket?.destroy();
      if (headers === undefined) reject(unavailable()); else resolve(headers);
    };
    const timeout = setTimeout(() => finish(), 30_000);
    try {
      socket = createConnection(path);
      let buffer = Buffer.alloc(0);
      socket.once('connect', () => socket.write(JSON.stringify({ server: target }) + '\n'));
      socket.on('error', () => finish());
      socket.once('close', () => finish());
      socket.on('data', bytes => {
        if (buffer.length + bytes.length > LIMIT) { finish(); return; }
        buffer = Buffer.concat([buffer, bytes]);
        const newline = buffer.indexOf(10);
        if (newline === -1) return;
        try {
          const result = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
          if (result.error || !headersValid(result.headers)) throw unavailable();
          finish(result.headers);
        } catch { finish(); }
      });
    } catch { finish(); }
  });
}

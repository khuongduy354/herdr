import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createAuth } from './auth.mjs';
import { bridgeHeaders } from './auth-bridge.mjs';
import { normalizeServer, taskKey } from './catalog.mjs';
import { herdrRequest } from './herdr.mjs';

/** Replay gates input; disconnected keystrokes are dropped, never queued. */
export class AttachSession {
  ready = false;
  exited = false;
  constructor(send, output) { this.send = send; this.output = output; }
  input(bytes) { if (this.ready) this.send(Buffer.concat([Buffer.from([0]), bytes])); }
  resize(cols, rows) {
    if (this.ready) this.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ cols, rows }))]));
  }
  receive(frame) {
    if (!frame.length) throw new Error('invalid terminal frame.');
    if (frame[0] === 0) this.output(frame.subarray(1));
    else if (frame[0] === 3) {
      const message = JSON.parse(frame.subarray(1).toString());
      if (message.type === 'replay-done') this.ready = true;
    } else if (frame[0] === 4) {
      this.ready = false; this.exited = true;
    }
  }
  disconnect() { this.ready = false; }
}

export async function attach(server, id) {
  server = normalizeServer(server);
  taskKey(server, id);
  if (!process.stdin.isTTY) throw new Error('attach needs an interactive terminal.');
  const auth = createAuth();
  const shutdown = new AbortController();
  let session;
  let socket;
  const previousRaw = process.stdin.isRaw;
  const stop = () => { shutdown.abort(); session?.disconnect(); socket?.close(); };
  const input = bytes => {
    if (bytes.includes(0x1d)) { stop(); return; }
    if (!shutdown.signal.aborted) session?.input(bytes);
  };
  const resize = () => session?.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  process.stdin.setRawMode(true);
  process.stdin.on('data', input);
  process.stdin.resume();
  process.stdout.on('resize', resize);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    let backoff = 100;
    while (!shutdown.signal.aborted) {
      const headers = process.env.HERDR_KOALA_AUTH_SOCKET
        ? await bridgeHeaders(process.env.HERDR_KOALA_AUTH_SOCKET, server) : await auth.headers(server);
      if (shutdown.signal.aborted) break;
      await new Promise(resolve => {
        const url = `${server.replace(/^http/, 'ws')}/ws/attach/${id}`;
        socket = new WebSocket(url, { headers, followRedirects: false, handshakeTimeout: 15_000,
          maxPayload: 2 * 1024 * 1024 });
        session = new AttachSession(frame => {
          if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 1024 * 1024) socket.send(frame);
          else socket.terminate();
        }, bytes => {
          if (!process.stdout.write(bytes)) {
            const current = socket;
            current.pause();
            process.stdout.once('drain', () => { if (current.readyState === WebSocket.OPEN) current.resume(); });
          }
        });
        let lastPong = Date.now();
        const heartbeat = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPong > 45_000) socket.terminate();
          else socket.ping();
        }, 15_000);
        socket.on('pong', () => { lastPong = Date.now(); });
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          if ([401, 403, 404, 410].includes(response.statusCode)) stop();
          socket.terminate();
        });
        const timer = setTimeout(() => { if (!session.ready) socket.terminate(); }, 20_000);
        const abort = () => socket.terminate();
        shutdown.signal.addEventListener('abort', abort, { once: true });
        socket.once('open', () => {
          process.stdout.write('\x1bc');
          backoff = 100;
        });
        socket.on('message', (data, binary) => {
          if (!binary) { socket.terminate(); return; }
          const ready = session.ready;
          try { session.receive(Buffer.from(data)); }
          catch { socket.terminate(); return; }
          if (!ready && session.ready) resize();
          if (session.exited) stop();
        });
        socket.once('error', () => {});
        socket.once('close', () => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          shutdown.signal.removeEventListener('abort', abort);
          session.disconnect();
          resolve();
        });
      });
      if (!shutdown.signal.aborted) {
        process.stdout.write('\r\n[connection lost; input disabled; reconnecting]\r\n');
        await delay(backoff, undefined, { signal: shutdown.signal }).catch(() => {});
        backoff = Math.min(5000, backoff * 2);
      }
    }
  } finally {
    stop();
    process.stdin.off('data', input);
    process.stdout.off('resize', resize);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    process.stdin.setRawMode(previousRaw ?? false);
    process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\r\n');
    if (process.env.HERDR_PANE_ID && process.env.HERDR_KOALA_SOCKET) {
      await herdrRequest('pane.report_metadata', { pane_id: process.env.HERDR_PANE_ID,
        source: 'koala-herd', tokens: { koala_task: null } }).catch(() => {});
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  attach(process.argv[2], process.argv[3]).catch(() => {
    console.error('couldn’t attach to koala. check sign-in and server availability.');
    process.exitCode = 1;
  });
}

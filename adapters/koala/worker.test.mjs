import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

test('worker falls back from the HTML app shell and keeps polling across a transient failure', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'herd-fallback-'));
  let streamCalls = 0;
  let polls = 0;
  const id = '12345678-1234-1234-1234-123456789abc';
  const server = createServer((req, res) => {
    assert.equal(req.headers['x-koala-token'], 'koala_test');
    if (req.url === '/api/task-events') {
      streamCalls++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>Koala</html>');
    } else if (req.url === '/api/tasks?status=active') {
      polls++;
      if (polls === 2) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id, title: 'legacy agent', status: 'active',
        pty: { running: true }, needsInput: { since: '2026-10-11T00:00:00Z' } }] }));
    } else { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
    env: { ...process.env, KOALA_SERVER: origin, KOALA_TOKEN: 'koala_test', XDG_STATE_HOME: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: worker.stdout });
  let sawLive = false;
  let sawStale = false;
  try {
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('worker exited before polling recovered')));
      lines.on('line', line => {
        try {
          const view = JSON.parse(line);
          if (sawLive && !view.fresh && view.groups.at(-1)?.tasks[0]?.stale) sawStale = true;
          if (view.fresh) {
            assert.equal(view.message, 'polling every 3s.');
            assert.equal(view.groups.at(-1).tasks[0].activity, 'waiting');
            sawLive = true;
            if (sawStale) resolve();
          }
        } catch (error) { reject(error); }
      });
    });
    assert.equal(streamCalls, 1);
    assert.equal(polls, 3);
    worker.stdin.end();
    const [code] = await once(worker, 'close');
    assert.equal(code, 0);
  } finally {
    worker.kill(); lines.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('worker streams status and persists group commands through real pipes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herd-worker-'));
  await writeFile(join(root, 'ffplay'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = ${JSON.stringify(join(root, 'audio.log'))};\nfs.appendFileSync(path, 'started\\n');\nprocess.on('SIGTERM', () => { fs.appendFileSync(path, 'stopped\\n'); process.exit(); });\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const id = '12345678-1234-1234-1234-123456789abc';
  let stream;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/task-events');
    assert.equal(req.headers['x-koala-token'], 'koala_test');
    stream = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ version: 1, epoch: 'test', revision: 0, type: 'snapshot',
      tasks: [{ id, title: 'remote agent', lifecycle: 'active', activity: 'waiting' }] })}\n\n`);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(root, 'credentials.json'), JSON.stringify({ defaultServer: origin,
    profiles: { [origin]: { method: 'static-token', token: 'koala_test' } } }), { mode: 0o600 });
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
    env: { ...process.env, PATH: root + ':' + process.env.PATH, KOALA_DIR: root, KOALA_SERVER: '', KOALA_TOKEN: '', XDG_STATE_HOME: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const views = [];
  const lines = createInterface({ input: worker.stdout });
  lines.on('line', line => views.push(JSON.parse(line)));
  const wait = async predicate => {
    for (let n = 0; n < 100; n++) {
      const found = views.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('worker view timed out');
  };
  const send = value => worker.stdin.write(JSON.stringify(value) + '\n');
  try {
    const live = await wait(view => view.fresh);
    assert.equal(live.groups.at(-1).tasks[0].activity, 'waiting');
    send({ type: 'create', name: 'Work' });
    const grouped = await wait(view => view.groups[0]?.name === 'Work');
    send({ type: 'move', id, group: grouped.groups[0].id });
    send({ type: 'track', id });
    await wait(view => view.groups[0]?.tasks[0]?.tracked);
    send({ type: 'sound' });
    const audioWait = async text => {
      for (let n = 0; n < 100; n++) {
        if ((await readFile(join(root, 'audio.log'), 'utf8').catch(() => '')).includes(text)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('sound process did not ' + text);
    };
    await audioWait('started');
    stream.end();
    await wait(view => !view.fresh && view.groups[0]?.tasks[0]?.stale);
    await audioWait('stopped');
    worker.stdin.end();
    const [code] = await once(worker, 'close');
    assert.equal(code, 0);
  } finally {
    worker.kill(); lines.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

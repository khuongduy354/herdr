import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { createAuthBridge, bridgeHeaders } from './auth-bridge.mjs';

const server = 'https://koala.example';

test('bridge refreshes through worker auth and restricts requests to its exact origin', async t => {
  let calls = 0;
  const bridge = await createAuthBridge({ headers: async target => {
    assert.equal(target, server);
    return { Authorization: `Bearer token-${++calls}` };
  } }, server);
  t.after(() => bridge.close());
  assert.equal((await stat(dirname(bridge.path))).mode & 0o777, 0o700);
  assert.equal((await stat(bridge.path)).mode & 0o777, 0o600);
  assert.deepEqual(await bridgeHeaders(bridge.path, 'https://KOALA.example:443/'), { Authorization: 'Bearer token-1' });
  assert.deepEqual(await bridgeHeaders(bridge.path, server), { Authorization: 'Bearer token-2' });
  for (const target of ['https://other.example', server + '/another', server + '?secret=token']) {
    await assert.rejects(bridgeHeaders(bridge.path, target), /bridge is unavailable/);
  }
  assert.equal(calls, 2);
});

test('bridge failure and invalid credentials never expose auth errors or headers', async t => {
  let mode = 'throw';
  const bridge = await createAuthBridge({ headers: async () => {
    if (mode === 'throw') throw new Error('private-token-secret');
    if (mode === 'invalid') return { Authorization: 'private-token\r\nsecret' };
    return { 'X-Koala-Token': 'x'.repeat(70 * 1024) };
  } }, server);
  t.after(() => bridge.close());
  for (mode of ['throw', 'invalid', 'oversized']) {
    await assert.rejects(bridgeHeaders(bridge.path, server), error => !error.message.includes('private-token'));
  }
});

test('close terminates unfinished connections and removes the private socket directory', async () => {
  const bridge = await createAuthBridge({ headers: async () => ({}) }, server);
  const socket = createConnection(bridge.path);
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write('{"server":');
  await Promise.all([bridge.close(), bridge.close()]);
  await closed;
  await assert.rejects(stat(dirname(bridge.path)), { code: 'ENOENT' });
  await assert.rejects(bridgeHeaders(bridge.path, server), /bridge is unavailable/);
});

test('oversized requests close without invoking authentication', async t => {
  let called = false;
  const bridge = await createAuthBridge({ headers: async () => { called = true; return {}; } }, server);
  t.after(() => bridge.close());
  const socket = createConnection(bridge.path);
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write('x'.repeat(9000));
  await closed;
  assert.equal(called, false);
});

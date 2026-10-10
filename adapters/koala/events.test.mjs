import test from 'node:test';
import assert from 'node:assert/strict';
import { statusEvents, subscribeStatus } from './events.mjs';
import { KoalaCatalog } from './catalog.mjs';

async function* chunks(text, size = 1) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}
async function collect(source) { const values = []; for await (const value of source) values.push(value); return values; }

test('decodes split UTF-8, CRLF, multiple data lines, and heartbeats', async () => {
  const text = ': heartbeat\r\n\r\ndata: {"title":\r\ndata: "Duy’s 🐨"}\r\n\r\ndata: {"next":true}\n\n';
  assert.deepEqual(await collect(statusEvents(chunks(text))), [{ title: 'Duy’s 🐨' }, { next: true }]);
});
test('rejects truncated and oversized events', async () => {
  await assert.rejects(collect(statusEvents(chunks('data: {}\n'))), /incomplete/);
  await assert.rejects(collect(statusEvents(chunks('data: ' + 'a'.repeat(1024 * 1024 + 1), 4096))), /too large/);
});
test('stream updates arrive before response closes; close retains stale catalog', async () => {
  const catalog = new KoalaCatalog('https://koala.example');
  const task = { id: '12345678-1234-1234-1234-123456789abc', title: 'agent', lifecycle: 'active', activity: 'waiting' };
  const event = { version: 1, type: 'snapshot', epoch: 'e', revision: 0, tasks: [task] };
  const fresh = [];
  let requests = 0;
  await subscribeStatus({ server: catalog.server, headers: { Authorization: 'test-only' }, catalog,
    signal: new AbortController().signal, publish: () => fresh.push(catalog.fresh),
    fetchImpl: async (_url, options) => {
      requests++;
      assert.equal(options.redirect, 'error');
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  assert.deepEqual(fresh, [false, true, false]);
  assert.equal(requests, 1);
  assert.equal(catalog.rows()[0].stale, true);
});
test('missing capability fails without switching to REST polling', async () => {
  const catalog = new KoalaCatalog('https://koala.example');
  let calls = 0;
  await assert.rejects(subscribeStatus({ server: catalog.server, headers: {}, catalog,
    signal: new AbortController().signal, publish() {},
    fetchImpl: async () => { calls++; return new Response('not found', { status: 404 }); } }), /capability/);
  assert.equal(calls, 1);
  assert.equal(catalog.fresh, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pollStatus } from './polling.mjs';
import { KoalaCatalog } from './catalog.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const other = '12345678-1234-1234-1234-123456789abd';
const task = { id, title: 'agent', status: 'active', pty: { running: true },
  needsInput: { since: '2026-10-11T12:00:00Z', question: false } };
const json = value => Response.json(value);
const setup = () => {
  const catalog = new KoalaCatalog('https://koala.example');
  const controller = new AbortController();
  return { catalog, controller, server: catalog.server, signal: controller.signal,
    getHeaders: async () => ({}), publish() {}, intervalMs: 1 };
};

test('polling refreshes auth, replaces task lists, and silences stale waiting rows on failure', async () => {
  const options = setup();
  const views = [];
  let calls = 0;
  let authCalls = 0;
  await assert.rejects(pollStatus({ ...options,
    getHeaders: async () => ({ 'X-Koala-Token': `koala_${++authCalls}` }),
    publish: () => views.push({ fresh: options.catalog.fresh, rows: options.catalog.rows(),
      waiting: options.catalog.waitingCount(new Set([`${options.server}#${id}`])) }),
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, options.server + '/api/tasks?status=active');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['X-Koala-Token'], `koala_${calls}`);
      if (calls === 1) return json({ items: [task, { ...task, id: other, needsInput: undefined }] });
      if (calls === 2) return json([{ ...task, title: 'renamed' }]);
      return new Response('unavailable', { status: 503 });
    },
  }), /fetch koala tasks/);
  assert.equal(authCalls, 3);
  assert.equal(views[1].rows.length, 2);
  assert.equal(views[1].waiting, 1);
  assert.equal(views[1].rows.find(row => row.id === other).activity, 'unknown');
  assert.equal(views[2].rows.length, 1);
  assert.equal(views[2].rows[0].title, 'renamed');
  assert.equal(views.at(-1).fresh, false);
  assert.equal(views.at(-1).waiting, 0);
  assert.equal(views.at(-1).rows[0].stale, true);
});

test('polling filters inactive tasks and requires positive waiting evidence from a running PTY', async () => {
  const options = setup();
  const inputs = [
    [task, 'waiting'], [{ ...task, pty: { running: false } }, 'stopped'],
    [{ ...task, pty: undefined }, 'unknown'], [{ ...task, needsInput: {} }, 'unknown'],
    [{ ...task, needsInput: undefined, pty: { running: true, lastOutputAt: new Date().toISOString() } }, 'unknown'],
  ];
  let calls = 0;
  await assert.rejects(pollStatus({ ...options, fetchImpl: async () => json([
    inputs[calls++][0], { ...task, id: other, status: 'done' },
  ]), publish() {
    if (!options.catalog.fresh) return;
    assert.equal(options.catalog.rows().length, 1);
    assert.equal(options.catalog.rows()[0].activity, inputs[calls - 1][1]);
    if (calls === inputs.length) options.controller.abort();
  } }), { name: 'AbortError' });
});

test('malformed or duplicate polling data cannot partially replace the last good list', async () => {
  for (const invalid of [{}, { items: [null] }, { items: [{ ...task, id: 'invalid' }] }, { items: [task, task] }]) {
    const options = setup();
    let calls = 0;
    await assert.rejects(pollStatus({ ...options, fetchImpl: async () => json(++calls === 1 ? [task] : invalid) }));
    assert.equal(options.catalog.rows().length, 1);
    assert.equal(options.catalog.rows()[0].id, id);
    assert.equal(options.catalog.fresh, false);
  }
});

test('empty successful responses remove tasks and cancellation interrupts the polling delay', async () => {
  const options = setup();
  let calls = 0;
  await assert.rejects(pollStatus({ ...options, fetchImpl: async () => json(++calls === 1 ? [task] : []),
    publish() { if (options.catalog.fresh && calls === 2) options.controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(calls, 2);
  assert.deepEqual(options.catalog.rows(), []);
});

test('timeouts and shutdown abort an in-flight request', async () => {
  for (const shutdown of [false, true]) {
    const options = setup();
    await assert.rejects(pollStatus({ ...options, timeoutMs: 10,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (shutdown) options.controller.abort();
      }),
    }), { name: 'AbortError' });
    assert.equal(options.catalog.fresh, false);
  }
});

test('polling rejects oversized responses and sanitizes authentication errors', async () => {
  for (const response of [new Response('secret-token', { status: 401 }),
    new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(pollStatus({ ...setup(), fetchImpl: async () => response }),
      error => !error.message.includes('secret-token') && /koala/.test(error.message));
  }
});

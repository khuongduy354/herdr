import test from 'node:test';
import assert from 'node:assert/strict';
import { KoalaCatalog, normalizeServer, taskKey } from './catalog.mjs';

const server = 'https://koala.example';
const first = '12345678-1234-1234-1234-123456789abc';
const second = '12345678-1234-1234-1234-123456789def';
const task = (id = first, extra = {}) => ({ id, title: 'agent', lifecycle: 'active', activity: 'waiting', ...extra });
const snapshot = (tasks, extra = {}) => ({ version: 1, type: 'snapshot', epoch: 'server-boot', revision: 0, tasks, ...extra });
const change = (revision, upsert = [], remove = []) => ({ version: 1, type: 'change', epoch: 'server-boot', revision, upsert, remove });
function connected(tasks = [task()]) {
  const catalog = new KoalaCatalog(server);
  const generation = catalog.connect();
  catalog.apply(generation, snapshot(tasks));
  return { catalog, generation };
}

test('normalizes identity, isolates servers, and rejects credential-bearing URLs', () => {
  assert.equal(normalizeServer('https://KOALA.example:443/'), server);
  assert.equal(taskKey(server, first.toUpperCase()), taskKey(server + '/', first));
  assert.notEqual(taskKey(server, first), taskKey('https://other.example', first));
  assert.throws(() => normalizeServer('https://secret@koala.example'));
  assert.throws(() => normalizeServer(server + '?token=secret'));
  assert.throws(() => taskKey(server, '../attach'));
});

test('unopened active tasks appear; unknown activity never becomes running', () => {
  const { catalog } = connected([task(first, { activity: undefined }), task(second, { lifecycle: 'shelved' })]);
  assert.deepEqual(catalog.rows().map(row => [row.id, row.activity, row.stale]), [[first, 'unknown', false]]);
  assert.equal(catalog.waitingCount(new Set([taskKey(server, first)])), 0);
});

test('disconnect retains rows as stale and silences waiting; reconnect replaces snapshot', () => {
  const { catalog, generation } = connected();
  const selected = new Set([taskKey(server, first)]);
  assert.equal(catalog.waitingCount(selected), 1);
  catalog.disconnect(generation);
  assert.equal(catalog.rows()[0].stale, true);
  assert.equal(catalog.waitingCount(selected), 0);
  const next = catalog.connect();
  catalog.apply(next, snapshot([task(second)], { epoch: 'restarted', revision: 42 }));
  assert.deepEqual(catalog.rows().map(row => row.id), [second]);
  assert.equal(catalog.apply(generation, change(1, [task()])), false);
  catalog.disconnect(generation);
  assert.equal(catalog.fresh, true);
});

test('ordered changes update state, remove tasks, ignore duplicate revisions', () => {
  const { catalog, generation } = connected();
  catalog.apply(generation, change(1, [task(first, { activity: 'working' }), task(second)]));
  assert.equal(catalog.rows()[0].activity, 'working');
  assert.equal(catalog.apply(generation, change(1, [], [first])), false);
  assert.equal(catalog.rows().length, 2);
  catalog.apply(generation, change(2, [], [first]));
  assert.deepEqual(catalog.rows().map(row => row.id), [second]);
});

test('revision gaps require resnapshot and retain last known rows', () => {
  const { catalog, generation } = connected();
  assert.throws(() => catalog.apply(generation, change(2, [], [first])), /gap/);
  assert.equal(catalog.fresh, false);
  assert.equal(catalog.rows()[0].id, first);
  assert.throws(() => catalog.apply(generation, change(1)), /snapshot required/);
});

test('malformed batches cannot partially mutate catalog', () => {
  const { catalog, generation } = connected();
  assert.throws(() => catalog.apply(generation, change(1, [task(second), task('invalid')], [first])));
  assert.deepEqual(catalog.rows().map(row => row.id), [first]);
  assert.equal(catalog.revision, 0);
  assert.equal(catalog.fresh, false);
});

test('duplicate snapshot identities and ambiguous changes fail closed', () => {
  const catalog = new KoalaCatalog(server);
  const generation = catalog.connect();
  assert.throws(() => catalog.apply(generation, snapshot([task(), task()])), /duplicate/);
  catalog.apply(generation, snapshot([task()]));
  assert.throws(() => catalog.apply(generation, change(1, [task()], [first])), /conflicting/);
  assert.equal(catalog.rows().length, 1);
});

test('changes before snapshot, changed epochs, and unknown versions are rejected', () => {
  const catalog = new KoalaCatalog(server);
  const generation = catalog.connect();
  assert.throws(() => catalog.apply(generation, change(1)), /snapshot required/);
  catalog.apply(generation, snapshot([task()]));
  assert.throws(() => catalog.apply(generation, { ...change(1), epoch: 'other' }), /snapshot required/);
  assert.throws(() => catalog.apply(generation, snapshot([], { version: 2 })), /unsupported/);
  assert.equal(catalog.fresh, false);
});

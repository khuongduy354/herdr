import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KoalaGroups } from './groups.mjs';
import { taskKey } from './catalog.mjs';
const server = 'https://koala.example';
const id = '12345678-1234-1234-1234-123456789abc';
const rows = [{ id, key: taskKey(server, id), activity: 'waiting' }];
test('groups and selection survive restart, disappearances, rename and deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herd-groups-'));
  try {
    const groups = await KoalaGroups.load(root, server);
    await groups.apply({ type: 'create', name: 'Work' });
    const group = groups.project([])[0].id;
    await groups.apply({ type: 'move', id, group });
    await groups.apply({ type: 'track', id });
    await groups.apply({ type: 'collapse', group });
    await groups.apply({ type: 'sound' });
    const saved = await KoalaGroups.load(root, server + '/');
    assert.equal(saved.project([])[0].tasks.length, 0);
    assert.equal(saved.project(rows)[0].tasks[0].tracked, true);
    assert.equal(saved.project(rows)[0].collapsed, true);
    assert.equal(saved.sound, true);
    assert.equal(saved.selected(rows).has(rows[0].key), true);
    await saved.apply({ type: 'rename', group, name: 'Personal' });
    assert.equal(saved.project(rows)[0].name, 'Personal');
    await saved.apply({ type: 'delete', group });
    assert.equal(saved.project(rows)[0].name, 'Ungrouped');
    assert.equal(saved.project(rows)[0].tasks[0].tracked, true);
    assert.equal((await KoalaGroups.load(root, 'https://other.example')).selected(rows).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid commands and corrupt state preserve saved preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herd-groups-'));
  try {
    const groups = await KoalaGroups.load(root, server);
    await groups.apply({ type: 'track', id });
    await assert.rejects(groups.apply({ type: 'move', id, group: 'missing' }));
    assert.equal((await KoalaGroups.load(root, server)).selected(rows).size, 1);
    await writeFile(groups.path, '{broken');
    await assert.rejects(KoalaGroups.load(root, server), /couldn’t read/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('imports legacy selection once and leaves the original file untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herd-import-'));
  try {
    await mkdir(join(root, 'client-tracking'));
    const path = join(root, 'client-tracking', createHash('sha256').update(server).digest('hex') + '.json');
    const original = JSON.stringify({ defaultTracked: true, exceptions: [id] });
    await writeFile(path, original);
    const groups = await KoalaGroups.load(root, server, root);
    assert.equal(groups.project(rows)[0].tasks[0].tracked, false);
    const another = { ...rows[0], id: 'aaaaaaaa-1234-1234-1234-123456789abc' };
    assert.equal(groups.project([another])[0].tasks[0].tracked, true);
    assert.equal(groups.sound, false);
    await groups.apply({ type: 'track', id });
    assert.equal((await KoalaGroups.load(root, server, root)).project(rows)[0].tasks[0].tracked, true);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('independent workers preserve concurrent edits and reload before later commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'herd-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await KoalaGroups.load(root, server, root);
  const second = await KoalaGroups.load(root, server, root);
  await Promise.all([
    first.apply({ type: 'create', name: 'Work' }),
    second.apply({ type: 'track', id }),
  ]);
  let saved = await KoalaGroups.load(root, server, root);
  const group = saved.project(rows)[0].id;
  assert.equal(saved.project(rows)[0].name, 'Work');
  assert.equal(saved.selected(rows).has(rows[0].key), true);
  await second.apply({ type: 'move', id, group });
  await first.apply({ type: 'rename', group, name: 'Renamed' });
  saved = await KoalaGroups.load(root, server, root);
  assert.equal(saved.project(rows)[0].name, 'Renamed');
  assert.equal(saved.project(rows)[0].tasks[0].tracked, true);
  assert.equal(first.project(rows)[0].tasks[0].id, id);
});

test('abandoned lock fails without deleting it; corruption cannot be overwritten', async t => {
  const root = await mkdtemp(join(tmpdir(), 'herd-locked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const groups = await KoalaGroups.load(root, server, root);
  await groups.apply({ type: 'track', id });
  const before = await readFile(groups.path, 'utf8');
  await mkdir(`${groups.path}.lock`);
  await assert.rejects(groups.apply({ type: 'sound' }), /close other herd clients/);
  await assert.rejects(mkdir(`${groups.path}.lock`), { code: 'EEXIST' });
  assert.equal(await readFile(groups.path, 'utf8'), before);
  await rm(`${groups.path}.lock`, { recursive: true });
  await writeFile(groups.path, '{broken');
  await assert.rejects(groups.apply({ type: 'sound' }), /repair the state file/);
  assert.equal(await readFile(groups.path, 'utf8'), '{broken');
  await mkdir(`${groups.path}.lock`); // Failed mutations released their own lock.
});

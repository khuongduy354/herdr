import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

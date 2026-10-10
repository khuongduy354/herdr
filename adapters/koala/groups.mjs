import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeServer, taskKey } from './catalog.mjs';

const empty = () => ({ version: 1, groups: [], tasks: {}, sound: false, defaultTracked: false });
function validate(state, server) {
  if (state?.version !== 1 || !Array.isArray(state.groups) || typeof state.tasks !== 'object' || !state.tasks ||
      Array.isArray(state.tasks) || typeof state.sound !== 'boolean') throw new Error('invalid saved koala groups.');
  state.defaultTracked ??= false;
  if (typeof state.defaultTracked !== 'boolean') throw new Error('invalid sound selection default.');
  const ids = new Set();
  for (const group of state.groups) {
    if (typeof group.id !== 'string' || !group.id || ids.has(group.id) ||
        typeof group.name !== 'string' || !group.name.trim() || typeof group.collapsed !== 'boolean') {
      throw new Error('invalid saved koala group.');
    }
    ids.add(group.id);
  }
  for (const [id, value] of Object.entries(state.tasks)) {
    taskKey(server, id);
    if (!value || typeof value.tracked !== 'boolean' || (value.group !== null && !ids.has(value.group))) {
      throw new Error('invalid saved koala task preferences.');
    }
  }
  return state;
}

/** Commands are serialized by the worker; writes commit before memory changes. */
export class KoalaGroups {
  #state;
  constructor(root, server, state) {
    this.server = normalizeServer(server);
    this.directory = join(root, 'koala-herd');
    this.path = join(this.directory, `${createHash('sha256').update(this.server).digest('hex')}.json`);
    this.#state = validate(state, this.server);
  }
  static async load(root, server, legacyRoot = process.env.KOALA_DIR || join(homedir(), '.koala')) {
    const groups = new KoalaGroups(root, server, empty());
    try { groups.#state = validate(JSON.parse(await readFile(groups.path, 'utf8')), groups.server); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('couldn’t read saved koala groups. repair the state file before continuing.');
      const legacyPath = join(legacyRoot, 'client-tracking', `${createHash('sha256').update(groups.server).digest('hex')}.json`);
      try {
        const legacy = JSON.parse(await readFile(legacyPath, 'utf8'));
        if (typeof legacy.defaultTracked !== 'boolean' || !Array.isArray(legacy.exceptions)) throw new Error('invalid selection');
        groups.#state.defaultTracked = legacy.defaultTracked;
        for (const id of legacy.exceptions) {
          taskKey(groups.server, id);
          groups.#state.tasks[id.toLowerCase()] = { group: null, tracked: !legacy.defaultTracked };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('couldn’t import saved koala sound selections.');
      }
    }
    return groups;
  }
  get sound() { return this.#state.sound; }
  selected(rows) {
    return new Set(rows.filter(row => (this.#state.tasks[row.id]?.tracked ?? this.#state.defaultTracked)).map(row => row.key));
  }
  project(rows) {
    const groups = [...this.#state.groups, { id: null, name: 'Ungrouped', collapsed: false }];
    return groups.map(group => ({ ...group, tasks: rows
      .filter(row => (this.#state.tasks[row.id]?.group ?? null) === group.id)
      .map(row => ({ ...row, tracked: (this.#state.tasks[row.id]?.tracked ?? this.#state.defaultTracked) })) }));
  }
  async apply(command) {
    const next = structuredClone(this.#state);
    const group = next.groups.find(value => value.id === command.group);
    const name = typeof command.name === 'string' ? command.name.trim() : '';
    if (['create', 'rename'].includes(command.type) && (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))) {
      throw new Error('group name must contain 1–80 visible characters.');
    }
    switch (command.type) {
      case 'create': next.groups.push({ id: randomUUID(), name, collapsed: false }); break;
      case 'rename':
      case 'collapse':
      case 'delete':
        if (!group) throw new Error('koala group not found.');
        if (command.type === 'rename') group.name = name;
        else if (command.type === 'collapse') group.collapsed = !group.collapsed;
        else {
          next.groups = next.groups.filter(value => value.id !== group.id);
          for (const task of Object.values(next.tasks)) if (task.group === group.id) task.group = null;
        }
        break;
      case 'move':
      case 'track': {
        taskKey(this.server, command.id);
        const id = command.id.toLowerCase();
        const preferences = next.tasks[id] ?? { group: null, tracked: next.defaultTracked };
        if (command.type === 'move') {
          if (command.group !== null && !group) throw new Error('koala group not found.');
          preferences.group = command.group;
        } else preferences.tracked = !preferences.tracked;
        next.tasks[id] = preferences;
        break;
      }
      case 'sound': next.sound = !next.sound; break;
      default: throw new Error('unknown koala group command.');
    }
    validate(next, this.server);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.path);
      this.#state = next;
    } finally { await unlink(temp).catch(() => {}); }
  }
}

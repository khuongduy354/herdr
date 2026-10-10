/** Pure Koala status projection. No credentials, network, timers, or pane identity. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITIES = new Set(['unknown', 'stopped', 'idle', 'working', 'waiting']);
const LIFECYCLES = new Set(['active', 'shelved', 'closed']);

export function normalizeServer(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid koala server url.');
  }
  return url.href.replace(/\/+$/, '');
}

export function taskKey(server, id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid koala task id.');
  return `${normalizeServer(server)}#${id.toLowerCase()}`;
}

function taskRecord(server, task) {
  const key = taskKey(server, task?.id);
  if (typeof task.title !== 'string' || !LIFECYCLES.has(task.lifecycle)) {
    throw new Error('invalid koala task record.');
  }
  // New activities from newer servers remain unknown; absence never means working.
  const activity = ACTIVITIES.has(task.activity) ? task.activity : 'unknown';
  return Object.freeze({ key, id: task.id.toLowerCase(), title: task.title.replace(/[\x00-\x1f\x7f]/g, ' '),
    lifecycle: task.lifecycle, activity });
}

/** One instance per server. Each connection must begin with a fresh snapshot. */
export class KoalaCatalog {
  #tasks = new Map();
  #epoch = null;
  #revision = -1;
  #fresh = false;
  #awaitingSnapshot = true;
  #generation = 0;

  constructor(server) { this.server = normalizeServer(server); }
  get fresh() { return this.#fresh; }
  get revision() { return this.#revision; }

  /** Fences callbacks from obsolete transports while retaining visible stale rows. */
  connect() {
    this.#fresh = false;
    this.#awaitingSnapshot = true;
    return ++this.#generation;
  }

  disconnect(generation) {
    if (generation !== this.#generation) return;
    this.#fresh = false;
    this.#awaitingSnapshot = true;
  }

  apply(generation, event) {
    if (generation !== this.#generation) return false;
    try {
      return this.#apply(event);
    } catch (error) {
      this.disconnect(generation);
      throw error;
    }
  }

  #apply(event) {
    if (event?.version !== 1 || typeof event.epoch !== 'string' || !event.epoch ||
        !Number.isSafeInteger(event.revision) || event.revision < 0) {
      throw new Error('unsupported or invalid koala status event.');
    }
    if (event.type === 'snapshot') {
      if (!this.#awaitingSnapshot || !Array.isArray(event.tasks)) {
        throw new Error('unexpected koala status snapshot.');
      }
      const next = new Map();
      for (const value of event.tasks) {
        const task = taskRecord(this.server, value);
        if (next.has(task.key)) throw new Error('duplicate koala task.');
        next.set(task.key, task);
      }
      this.#tasks = next;
      this.#epoch = event.epoch;
      this.#revision = event.revision;
      this.#fresh = true;
      this.#awaitingSnapshot = false;
      return true;
    }
    if (this.#awaitingSnapshot || event.epoch !== this.#epoch) {
      throw new Error('koala status snapshot required.');
    }
    if (event.type !== 'change' || !Array.isArray(event.upsert) || !Array.isArray(event.remove)) {
      throw new Error('invalid koala status change.');
    }
    if (event.revision <= this.#revision) return false;
    if (event.revision !== this.#revision + 1) throw new Error('koala status event gap.');
    const upsert = event.upsert.map(task => taskRecord(this.server, task));
    const remove = event.remove.map(id => taskKey(this.server, id));
    const changed = [...upsert.map(task => task.key), ...remove];
    if (new Set(changed).size !== changed.length) throw new Error('conflicting koala status change.');
    const next = new Map(this.#tasks);
    for (const key of remove) next.delete(key);
    for (const task of upsert) next.set(task.key, task);
    this.#tasks = next;
    this.#revision = event.revision;
    return true;
  }

  /** Active-only presentation; grouping/selection are separately persisted by key. */
  rows() {
    return [...this.#tasks.values()].filter(task => task.lifecycle === 'active')
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(task => ({ ...task, stale: !this.#fresh }));
  }

  waitingCount(selected) {
    return this.#fresh ? this.rows().filter(task => task.activity === 'waiting' && selected.has(task.key)).length : 0;
  }
}

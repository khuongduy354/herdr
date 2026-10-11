import { StringDecoder } from 'node:string_decoder';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function herdrRequest(method, params, socketPath = process.env.HERDR_KOALA_SOCKET) {
  if (!socketPath) return Promise.reject(new Error('herdr API socket is unavailable.'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const fail = () => { socket.destroy(); reject(new Error('couldn’t reach the local herdr runtime.')); };
    socket.setTimeout(10_000, fail);
    socket.on('error', fail);
    socket.once('connect', () => socket.write(JSON.stringify({ id: randomUUID(), method, params }) + '\n'));
    socket.on('data', bytes => {
      buffer += decoder.write(bytes);
      if (buffer.length > 1024 * 1024) return fail();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.error || !response.result) throw new Error('herdr rejected the action.');
        resolve(response.result);
      } catch { reject(new Error('herdr rejected the action.')); }
    });
    socket.on('end', () => { if (!buffer.includes('\n')) fail(); });
  });
}

// Preserve ownership if registration and rollback both fail; retries must not duplicate.
const pendingAttachments = new Map();

export async function openTask(task, server, workspaceId, request = herdrRequest, authSocket) {
  if (task.stale || task.activity === 'stopped') throw new Error('task is stale or stopped. refresh before opening.');
  const { panes } = await request('pane.list', {});
  const existing = panes.find(pane => pane.tokens?.koala_task === task.key
    || pane.pane_id === pendingAttachments.get(task.key));
  if (existing) {
    if (pendingAttachments.has(task.key)) {
      await request('pane.report_metadata', { pane_id: existing.pane_id,
        source: 'koala-herd', tokens: { koala_task: task.key }, title: task.title });
      pendingAttachments.delete(task.key);
    }
    return request('pane.focus', { pane_id: existing.pane_id });
  }
  pendingAttachments.delete(task.key);
  const result = await request('layout.apply', {
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    tab_label: task.title, focus: true,
    root: { type: 'pane', label: task.title,
      command: [process.execPath, fileURLToPath(new URL('./attach.mjs', import.meta.url)), server, task.id],
      env: { HERDR_KOALA_SOCKET: process.env.HERDR_KOALA_SOCKET ?? '',
        ...(authSocket ? { HERDR_KOALA_AUTH_SOCKET: authSocket } : {}),
        ...(process.env.KOALA_DIR ? { KOALA_DIR: process.env.KOALA_DIR } : {}) } },
  });
  const paneId = result.layout.focused_pane_id;
  pendingAttachments.set(task.key, paneId);
  try {
    await request('pane.report_metadata', { pane_id: paneId,
      source: 'koala-herd', tokens: { koala_task: task.key }, title: task.title });
    pendingAttachments.delete(task.key);
  } catch (error) {
    // This only closes the local attachment created above, never the Koala task.
    await request('pane.close', { pane_id: paneId })
      .then(() => pendingAttachments.delete(task.key)).catch(() => {});
    throw error;
  }
  // layout.apply changes runtime focus; pane.focus also updates attached clients.
  await request('pane.focus', { pane_id: result.layout.focused_pane_id });
  return result;
}

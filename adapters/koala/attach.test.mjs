import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachSession } from './attach.mjs';
import { openTask } from './herdr.mjs';

test('forwards binary output and gates input through replay and disconnect', () => {
  const sent = [], output = [];
  const session = new AttachSession(frame => sent.push(frame), bytes => output.push(bytes));
  session.input(Buffer.from('old'));
  session.resize(120, 40);
  session.receive(Buffer.from([0, 0xff, 0x1b, 0x41]));
  assert.deepEqual(output, [Buffer.from([0xff, 0x1b, 0x41])]);
  assert.equal(sent.length, 0);
  // Byte tags and replay marker are Koala's external terminal wire contract.
  session.receive(Buffer.concat([Buffer.from([3]), Buffer.from('{"type":"replay-done"}')]));
  session.input(Buffer.from('new'));
  session.resize(120, 40);
  assert.deepEqual(sent[0], Buffer.from([0, 110, 101, 119]));
  assert.deepEqual(JSON.parse(sent[1].subarray(1)), { cols: 120, rows: 40 });
  session.disconnect();
  session.input(Buffer.from('never resend'));
  assert.equal(sent.length, 2);
  session.receive(Buffer.from([4]));
  assert.equal(session.exited, true);
});
test('focuses matching attachment and creates argv-based tab only when absent', async () => {
  const task = { id: 'task', key: 'server#task', title: 'a; shell injection', stale: false, activity: 'waiting' };
  const calls = [];
  let panes = [{ pane_id: 'p1', tokens: { koala_task: task.key } }];
  const request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'pane.list') return { panes };
    return { layout: { focused_pane_id: 'p2' } };
  };
  await openTask(task, 'https://koala.example', 'w1', request);
  assert.deepEqual(calls.map(call => call[0]), ['pane.list', 'pane.focus']);
  panes = []; calls.length = 0;
  await openTask(task, 'https://koala.example', 'w1', request);
  const layout = calls.find(call => call[0] === 'layout.apply')[1];
  assert.equal(layout.tab_id, undefined); // Existing tabs must never be replaced.
  assert.equal(layout.workspace_id, 'w1');
  assert.ok(Array.isArray(layout.root.command));
  assert.equal(layout.root.command.includes(task.title), false);
  assert.deepEqual(calls.find(call => call[0] === 'pane.report_metadata')[1].tokens, { koala_task: task.key });
  assert.deepEqual(calls.at(-1), ['pane.focus', { pane_id: 'p2' }]);
  await assert.rejects(openTask({ ...task, stale: true }, 'https://koala.example', 'w1', request));
});

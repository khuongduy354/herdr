import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('desktop launcher uses the installed Node runtime with a minimal desktop PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herd-launcher-'));
  try {
    await copyFile(new URL('./run.sh', import.meta.url), join(root, 'run.sh'));
    await writeFile(join(root, 'node-path'), process.execPath + '\n');
    await writeFile(join(root, 'herdr'), `#!/bin/sh
node -e 'console.log(JSON.stringify({node:process.execPath,adapter:process.env.HERDR_KOALA_ADAPTER,socket:process.env.HERDR_SOCKET_PATH,args:process.argv.slice(1)}))' -- "$@"
`, { mode: 0o755 });
    const result = spawnSync('/bin/sh', [join(root, 'run.sh'), '--version'], {
      env: { HOME: root, PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: '/wrong-session' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.node, process.execPath);
    assert.equal(output.adapter, join(root, 'worker.mjs'));
    assert.equal(output.socket, undefined);
    assert.deepEqual(output.args, ['--session', 'duys-koala-herd', '--version']);

    await writeFile(join(root, 'node-path'), join(root, 'missing-node') + '\n');
    const missing = spawnSync('/bin/sh', [join(root, 'run.sh')], {
      env: { HOME: root, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /runtime is missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

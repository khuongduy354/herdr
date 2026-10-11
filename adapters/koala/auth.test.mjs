import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from './auth.mjs';

const server = 'https://koala.example';
const other = 'https://other.example';
const token = { method: 'static-token', token: 'koala_saved' };
const iap = { method: 'iap-oauth', clientId: 'client', clientSecret: 'client-secret', refreshToken: 'refresh-secret' };
async function fixture(t, profile = token, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'herd-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const write = data => writeFile(path, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  await write({ defaultServer: server, profiles: { [server]: profile } });
  return { path, write, auth: createAuth({ credentialsPath: path, env: {}, ...options }) };
}

test('uses saved default and exact normalized profile only; never writes credentials', async t => {
  const { path, auth } = await fixture(t);
  const before = await readFile(path);
  assert.equal(await auth.resolveServer(), server);
  assert.deepEqual(await auth.headers('https://KOALA.example:443/'), { 'X-Koala-Token': 'koala_saved' });
  assert.deepEqual(await auth.headers(other), {});
  assert.deepEqual(await auth.headers(server + '/other'), {});
  assert.deepEqual(await readFile(path), before);
});

test('env token applies only with matching explicit env server', async t => {
  const { path } = await fixture(t);
  const auth = createAuth({ credentialsPath: path, env: { KOALA_SERVER: other + '/', KOALA_TOKEN: 'env-assertion' } });
  assert.equal(await auth.resolveServer(), other);
  assert.deepEqual(await auth.headers(other), { Authorization: 'Bearer env-assertion' });
  assert.deepEqual(await auth.headers(server), { 'X-Koala-Token': 'koala_saved' });
  const unpaired = createAuth({ credentialsPath: path, env: { KOALA_TOKEN: 'koala_env' } });
  assert.deepEqual(await unpaired.headers(other), {});
  assert.deepEqual(await unpaired.headers(server), { 'X-Koala-Token': 'koala_saved' });
});

test('static and device tokens never become proxy bearer assertions', async t => {
  const { auth, write } = await fixture(t, { method: 'static-token', token: 'opaque' });
  assert.deepEqual(await auth.headers(server), { 'X-Koala-Token': 'opaque' });
  await write({ profiles: { [server]: { method: 'device-flow', token: 'device' } } });
  assert.deepEqual(await auth.headers(server), { 'X-Koala-Token': 'device' });
});

test('refuses loose permissions, corrupt files, malformed profiles and invalid defaults', async t => {
  const { auth, path, write } = await fixture(t);
  if (process.platform !== 'win32') {
    await chmod(path, 0o640);
    await assert.rejects(auth.headers(server), /loose permissions/);
    await chmod(path, 0o600);
  }
  for (const data of ['{secret-broken', { profiles: [] }, { profiles: { [server]: { method: 'exec' } } },
    { profiles: { [server]: token }, defaultServer: other },
    { profiles: { [server]: token }, defaultServer: 'https://secret@koala.example' }]) {
    await write(data);
    await assert.rejects(auth.resolveServer(), error => !error.message.includes('secret'));
    await assert.rejects(auth.headers(other));
  }
});

test('rejects unsafe headers without disclosing their content', async t => {
  const { auth } = await fixture(t, { ...token, token: 'private-secret\r\nInjected: yes' });
  await assert.rejects(auth.headers(server), error => /invalid credential/.test(error.message) && !error.message.includes('private-secret'));
});

test('oauth uses pinned client, prevents redirects, deduplicates and caches refreshes', async t => {
  let calls = 0;
  const { auth } = await fixture(t, iap, { fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(request.redirect, 'error');
    assert.equal(request.body.get('client_id'), 'client');
    assert.equal(request.body.get('client_secret'), 'client-secret');
    assert.equal(request.body.get('refresh_token'), 'refresh-secret');
    return { ok: true, json: async () => ({ id_token: 'id-token', expires_in: 3600 }) };
  } });
  const responses = await Promise.all([auth.headers(server), auth.headers(server)]);
  assert.deepEqual(responses[0], { Authorization: 'Bearer id-token' });
  assert.deepEqual(await auth.headers(server), responses[1]);
  assert.equal(calls, 1);
});

test('oauth rechecks expiry and profile rotation; pinned id cannot inherit env secret', async t => {
  const seen = [];
  const { auth, write } = await fixture(t, { ...iap, clientSecret: undefined }, {
    env: { KOALA_IAP_OAUTH_CLIENT_SECRET: 'wrong-secret' },
    fetchImpl: async (_url, request) => {
      seen.push(request.body.get('client_secret'));
      return { ok: true, json: async () => ({ id_token: 'id-token', expires_in: seen.length === 1 ? 30 : 3600 }) };
    },
  });
  await auth.headers(server);
  await auth.headers(server);
  await write({ profiles: { [server]: { ...iap, refreshToken: 'rotated-secret' } } });
  await auth.headers(server);
  assert.deepEqual(seen, [null, null, 'client-secret']);
});

test('oauth defaults and sanitized failures never forward server error bodies', async t => {
  let fail = true;
  let calls = 0;
  const { auth } = await fixture(t, { method: 'iap-oauth', refreshToken: 'refresh-secret' }, {
    env: { KOALA_IAP_OAUTH_CLIENT_ID: 'default-id', KOALA_IAP_OAUTH_CLIENT_SECRET: 'default-secret' },
    fetchImpl: (_url, request) => {
      calls++;
      assert.equal(request.body.get('client_id'), 'default-id');
      assert.equal(request.body.get('client_secret'), 'default-secret');
      if (fail) throw new Error('refresh-secret client-secret leaked by network');
      return { ok: false, json: async () => ({ error_description: 'refresh-secret' }) };
    },
  });
  await assert.rejects(auth.headers(server), error => !error.message.includes('secret'));
  fail = false;
  await assert.rejects(auth.headers(server), error => !error.message.includes('secret'));
  assert.equal(calls, 2);
});

test('exec credentials remain server-scoped; failures never echo command or output', { skip: process.platform === 'win32' }, async t => {
  const { auth, write } = await fixture(t, { method: 'exec', command: "printf koala_exec" });
  assert.deepEqual(await auth.headers(other), {});
  assert.deepEqual(await auth.headers(server), { 'X-Koala-Token': 'koala_exec' });
  await write({ profiles: { [server]: { method: 'exec', command: 'printf private-secret; printf private-secret >&2; exit 1' } } });
  await assert.rejects(auth.headers(server), error => /command failed/.test(error.message) && !error.message.includes('private-secret'));
});

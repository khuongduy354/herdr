import { exec } from 'node:child_process';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeServer } from './catalog.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const failure = message => new Error(message);
function serverKey(value) {
  try { return normalizeServer(value); }
  catch { throw failure('invalid koala server url.'); }
}
function safeCredential(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    throw failure('invalid credential header. check the saved sign-in.');
  }
  return value;
}
function credentialHeaders(value) {
  safeCredential(value);
  return value.startsWith('koala_') ? { 'X-Koala-Token': value } : { Authorization: `Bearer ${value}` };
}
function profileValid(profile) {
  if (!record(profile)) return false;
  for (const key of ['token', 'clientId', 'clientSecret', 'refreshToken', 'command']) {
    if (profile[key] !== undefined && !text(profile[key])) return false;
  }
  switch (profile.method) {
    case 'static-token': case 'device-flow': return text(profile.token);
    case 'iap-oauth': return text(profile.refreshToken);
    case 'exec': return text(profile.command);
    default: return false;
  }
}
async function readProfiles(path) {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') return { profiles: new Map() };
    throw failure("couldn't read koala credentials.");
  }
  try {
    const stat = await file.stat().catch(() => { throw failure("couldn't read koala credentials."); });
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw failure('koala credentials have loose permissions. use chmod 600.');
    }
    if (!stat.isFile() || stat.size > 1024 * 1024) throw failure('invalid koala credentials file.');
    let data;
    try { data = JSON.parse(await file.readFile('utf8')); }
    catch { throw failure("couldn't parse koala credentials. run koala login again."); }
    if (!record(data) || !record(data.profiles)) throw failure('invalid koala credential profiles.');
    const profiles = new Map();
    for (const [url, profile] of Object.entries(data.profiles)) {
      const key = serverKey(url);
      if (profiles.has(key) || !profileValid(profile)) throw failure('invalid koala credential profile.');
      profiles.set(key, profile);
    }
    const defaultServer = data.defaultServer === undefined ? undefined : serverKey(data.defaultServer);
    if (defaultServer !== undefined && !profiles.has(defaultServer)) {
      throw failure('saved default server has no sign-in. run koala login again.');
    }
    return { profiles, defaultServer };
  } finally { await file.close().catch(() => {}); }
}
function runCredential(command, env) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(failure('credential command failed. check the saved sign-in.'));
    try { exec(command, { env, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { failed(); return; }
      const value = stdout.trim();
      try { resolve(safeCredential(value)); }
      catch (error) { reject(error); }
    }); } catch { failed(); }
  });
}

/** Read-only credentials shared with koala login; secrets never enter diagnostics or disk writes. */
export function createAuth({ env = process.env, credentialsPath, fetchImpl = fetch } = {}) {
  const path = credentialsPath ?? join(env.KOALA_DIR || join(homedir(), '.koala'), 'credentials.json');
  const cache = new Map();
  async function oauth(server, profile) {
    const clientId = profile.clientId ?? env.KOALA_IAP_OAUTH_CLIENT_ID?.trim();
    // An explicitly pinned client must never inherit another client's default secret.
    const clientSecret = profile.clientSecret ?? (profile.clientId === undefined
      ? env.KOALA_IAP_OAUTH_CLIENT_SECRET?.trim() : undefined);
    if (!text(clientId)) throw failure('no iap oauth client configured. check koala login settings.');
    const identity = JSON.stringify([clientId, clientSecret, profile.refreshToken]);
    const cached = cache.get(server);
    if (cached?.identity === identity && (cached.pending || cached.expiresAt - Date.now() > 60_000)) {
      return { Authorization: `Bearer ${await (cached.pending ?? cached.token)}` };
    }
    const entry = { identity };
    entry.pending = Promise.resolve().then(async () => {
      try {
        const body = new URLSearchParams({ client_id: clientId, refresh_token: profile.refreshToken,
          grant_type: 'refresh_token' });
        if (clientSecret) body.set('client_secret', clientSecret);
        const response = await fetchImpl(TOKEN_URL, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        if (!response.ok) throw failure('refused');
        const result = await response.json();
        const token = safeCredential(result?.id_token);
        const ttl = result.expires_in ?? 3600;
        if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw failure('invalid expiry');
        entry.token = token;
        entry.expiresAt = Date.now() + ttl * 1000;
        return token;
      } catch {
        if (cache.get(server) === entry) cache.delete(server);
        throw failure("couldn't refresh google sign-in. run koala login again.");
      } finally { entry.pending = undefined; }
    });
    cache.set(server, entry);
    return { Authorization: `Bearer ${await entry.pending}` };
  }
  return {
    async resolveServer() {
      if (text(env.KOALA_SERVER)) return serverKey(env.KOALA_SERVER);
      const { defaultServer } = await readProfiles(path);
      if (!defaultServer) throw failure('no koala server configured. run koala login.');
      return defaultServer;
    },
    async headers(server) {
      const target = serverKey(server);
      if (text(env.KOALA_TOKEN) && text(env.KOALA_SERVER) && target === serverKey(env.KOALA_SERVER)) {
        return credentialHeaders(env.KOALA_TOKEN.trim());
      }
      const profile = (await readProfiles(path)).profiles.get(target);
      if (!profile) return {};
      switch (profile.method) {
        case 'static-token': case 'device-flow': return { 'X-Koala-Token': safeCredential(profile.token) };
        case 'exec': return credentialHeaders(await runCredential(profile.command, env));
        case 'iap-oauth': return oauth(target, profile);
      }
    },
  };
}

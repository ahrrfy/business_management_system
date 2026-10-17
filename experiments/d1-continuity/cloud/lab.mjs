import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../commands.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const approved = Object.freeze({ accountId: 'd4a91e89f1fe496f6a3d7f18dee6938c',
  databaseId: '90a4dd83-614f-42ad-b9f7-43ec8c411843', name: 'erp-d1-poc-20261017-887100' });
const approvedRestore = Object.freeze({ accountId: approved.accountId,
  databaseId:'9594cf92-a2aa-49ea-8f75-e15d5cb88d3b',name:'erp-d1-poc-20261017-c60ca2',
  createdAt:'2026-10-17T18:43:20.619Z',sourceDatabaseId:approved.databaseId });
const markerName = 'lab_cloud_marker';
const purpose = 'synthetic-only-d1-cloud-20261017-v1';
const runFile = promisify(execFile);
const budgetQueues = new WeakMap();
const readOnly = sql => !sql.trim().replace(/;$/,'').includes(';') && /^\s*(SELECT\b|PRAGMA\s+(?:table_info|foreign_key_check|foreign_keys)\b[^=]*$)/i.test(sql);
const failure = (code, message = code) => Object.assign(new Error(message), { code, status: 502 });

export function validateCloudManifest(manifest, { recoverImportedSource = false, initialize = true } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw failure('CLOUD_RESOURCE_NOT_APPROVED');
  const resource = manifest.databaseId === approvedRestore.databaseId ? approvedRestore : approved;
  if (Object.entries(resource).some(([key,value]) => manifest[key] !== value) || !/^erp-d1-poc-20261017-/.test(manifest.name)) {
    throw failure('CLOUD_RESOURCE_NOT_APPROVED');
  }
  if (recoverImportedSource && (resource !== approvedRestore || initialize !== false)) throw failure('CLOUD_RECOVERY_TARGET_NOT_APPROVED');
  return resource;
}

export function createCloudBudget(limit = 700) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 700) throw failure('INVALID_CLOUD_BUDGET');
  return { limit, requests: 0, inflight: 0, maxInflight: 0, rowsRead: 0, rowsWritten: 0,
    sqlDurationMs: 0, httpWallMs: 0, responses: [], errors: [], commands: [] };
}

async function privateCliToken(manifest) {
  const env = {};
  for (const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.WRANGLER_SEND_METRICS = 'false';
  // Wrangler logs logger.log output (including auth JSON) to disk by default.
  env.WRANGLER_WRITE_LOGS = 'false';
  let captured;
  try {
    captured = await runFile(process.execPath,
      [path.join(path.dirname(manifest.wranglerModule), 'bin', 'wrangler.js'), 'auth', 'token', '--json'],
      { cwd: os.tmpdir(), env, windowsHide: true, timeout: 30000, maxBuffer: 65536 });
    const parsed = JSON.parse(captured.stdout);
    if (typeof parsed.token !== 'string' || parsed.token.length < 20) throw failure('CLOUD_AUTH_UNAVAILABLE');
    return parsed.token;
  } catch { throw failure('CLOUD_AUTH_UNAVAILABLE'); }
  finally { captured = undefined; }
}

export async function createCloudLab({ confirmSyntheticSandbox = false, manifest, manifestPath,
  budget = createCloudBudget(), initialize = true, recoverImportedSource = false } = {}) {
  if (confirmSyntheticSandbox !== true) throw failure('CONFIRM_SYNTHETIC_SANDBOX_REQUIRED');
  if (manifestPath && !['cloud-runtime.json','cloud-restore-runtime.json'].some(name=>path.resolve(manifestPath)===path.resolve(root,'../../../.superpowers/sdd',name))) throw failure('CLOUD_MANIFEST_PATH_NOT_APPROVED');
  manifest ??= JSON.parse(await readFile(manifestPath ?? path.resolve(root, '../../../.superpowers/sdd/cloud-runtime.json'), 'utf8'));
  const resource = validateCloudManifest(manifest, { recoverImportedSource, initialize });
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || budget.limit > 700 || !Number.isSafeInteger(budget.requests) || budget.requests < 0) throw failure('INVALID_CLOUD_BUDGET');
  const schema = await readFile(path.join(root, '../schema.sql'), 'utf8');
  const schemaHash = createHash('sha256').update(schema).digest('hex');
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (lab_[a-z_]+)/g)].map(match => match[1]);
  const allowed = new Set([...tables, markerName, 'lab_cloud_probe']);
  const base = `https://api.cloudflare.com/client/v4/accounts/${resource.accountId}/d1/database/${resource.databaseId}`;
  let token = await privateCliToken(manifest), closed = false, admitted = false;
  const waiters = budgetQueues.get(budget) ?? [];
  budgetQueues.set(budget, waiters);
  async function request(method, body) {
    if (closed) throw failure('CLOUD_CLIENT_CLOSED');
    while (budget.inflight >= 4) await new Promise(resolve => waiters.push(resolve));
    if (budget.requests >= budget.limit || budget.rowsRead >= 2000000 || budget.rowsWritten >= 50000) {
      waiters.shift()?.(); throw failure('CLOUD_BUDGET_EXHAUSTED');
    }
    budget.requests++; budget.inflight++; budget.maxInflight = Math.max(budget.maxInflight, budget.inflight);
    const start = performance.now();
    try {
      let response;
      try {
        response = await fetch(method === 'GET' ? base : `${base}/query`, { method, redirect: 'error',
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
      } catch { throw failure('CLOUD_TRANSPORT_ERROR'); }
      let envelope;
      try { envelope = await response.json(); } catch { throw failure(`CLOUD_HTTP_${response.status}_INVALID_JSON`); }
      const results = Array.isArray(envelope.result) ? envelope.result : [];
      for (const result of results) {
        const meta = result.meta ?? {};
        budget.rowsRead += meta.rows_read ?? 0; budget.rowsWritten += meta.rows_written ?? 0;
        budget.sqlDurationMs += meta.timings?.sql_duration_ms ?? meta.duration ?? 0;
      }
      budget.responses.push({ method, status: response.status, wallMs: performance.now() - start,
        statements: results.length, metadata: results.map(result => result.meta ?? {}) });
      if (!response.ok || !envelope.success || results.some(result => result.success === false)) {
        const errors = [...(envelope.errors ?? []), ...results.filter(result => result.success === false)];
        const messages = errors.map(error => String(error.message ?? error.error ?? '')).join(' ');
        const constraint = ['CHECK constraint failed','UNIQUE constraint failed','FOREIGN KEY constraint failed','NOT NULL constraint failed','SQLITE_BUSY','database is locked'].find(value => messages.includes(value));
        throw failure(constraint ? 'CLOUD_SQL_CONSTRAINT' : `CLOUD_HTTP_${response.status}`, constraint ?? `CLOUD_HTTP_${response.status}`);
      }
      return envelope.result;
    } catch (error) { budget.errors.push({ code: error.code ?? 'CLOUD_ERROR', message: error.message }); throw error; }
    finally { budget.httpWallMs += performance.now() - start; budget.inflight--; waiters.shift()?.(); }
  }
  const identity = await request('GET');
  if (identity.uuid !== resource.databaseId || identity.name !== resource.name ||
    (resource === approvedRestore && new Date(identity.created_at).toISOString() !== approvedRestore.createdAt)) throw failure('CLOUD_REMOTE_IDENTITY_MISMATCH');

  async function query(body, { bootstrap = false } = {}) {
    const statements = body.batch ?? [body];
    for (const statement of statements) {
      if (typeof statement.sql !== 'string' || /\b(?:ATTACH|DETACH)\b/i.test(statement.sql)) throw failure('CLOUD_SQL_NOT_ALLOWED');
      if (!readOnly(statement.sql) && !bootstrap && !admitted) throw failure('CLOUD_LAB_MARKER_REQUIRED');
      if (!readOnly(statement.sql) && /\b(?:sqlite_|_cf_)[a-z_0-9]*/i.test(statement.sql)) throw failure('CLOUD_INTERNAL_TABLE_WRITE_FORBIDDEN');
      for (const match of statement.sql.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|(?:CREATE|DROP|ALTER)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+["`\[]?([a-z_][a-z_0-9]*)/gi)) {
        if (!allowed.has(match[1])) throw failure('CLOUD_NON_LAB_WRITE_FORBIDDEN');
      }
    }
    return request('POST', body);
  }
  class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new Statement(this.sql, params); }
    async all() { return (await query({ sql: this.sql, params: this.params }))[0]; }
    async first(column) { const row = (await this.all()).results?.[0] ?? null; return column && row ? row[column] : row; }
    async run() { return this.all(); }
  }
  const db = { prepare: sql => new Statement(sql),
    batch: statements => query({ batch: statements.map(statement => ({ sql: statement.sql, params: statement.params })) }),
    exec: sql => query({ sql, params: [] }) };
  async function inventory() {
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(row => row.name);
    const unknown = names.filter(name => !allowed.has(name) && !/^sqlite_|^_cf_/i.test(name));
    if (unknown.length) throw failure('CLOUD_NON_LAB_TABLES_PRESENT', `CLOUD_NON_LAB_TABLES_PRESENT: ${unknown.join(',')}`);
    return names;
  }
  async function verifyMarker() {
    await inventory();
    const marker = await db.prepare(`SELECT * FROM ${markerName} WHERE id=?`).bind(purpose).first();
    const markerIdentity = recoverImportedSource ? approved.databaseId : resource.databaseId;
    if (!marker || marker.databaseId !== markerIdentity || marker.schemaHash !== schemaHash) throw failure('CLOUD_LAB_MARKER_MISMATCH');
    admitted = true;
  }
  const names = await inventory();
  if (!names.includes(markerName)) {
    if (names.some(name => tables.includes(name))) throw failure('CLOUD_UNMARKED_LAB_DATA_REFUSED');
    if (names.includes('lab_cloud_probe') && (await db.prepare('SELECT COUNT(*) AS n FROM lab_cloud_probe').first()).n !== 0) throw failure('CLOUD_UNMARKED_PROBE_DATA_REFUSED');
    if (!initialize) throw failure('CLOUD_LAB_MARKER_REQUIRED');
    await query({ sql: `CREATE TABLE ${markerName}(id TEXT PRIMARY KEY,databaseId TEXT NOT NULL,schemaHash TEXT NOT NULL) STRICT`, params: [] }, { bootstrap: true });
    await query({ sql: `INSERT INTO ${markerName} VALUES (?,?,?)`, params: [purpose, resource.databaseId, schemaHash] }, { bootstrap: true });
    admitted = true;
    await db.exec(schema);
  }
  await verifyMarker();
  return { db, budget, identity: { ...resource, version: identity.version, region: identity.created_in_region }, schemaHash,
    recoveredImportedSourceMarker:recoverImportedSource,
    networkAttempts: [], hostinger: 'unavailable-modeled-no-request',
    async command(input, controls = {}) {
      const errorStart = budget.errors.length;
      try {
        const result = await execute(db, input, controls);
        budget.commands.push({ input: structuredClone(input), controls: structuredClone(controls), result });
        return controls.dropResponse ? { status: 503, body: { error: 'RESPONSE_DROPPED_AFTER_COMMIT' } } : { status: 200, body: result };
      } catch (error) {
        const infrastructureError = budget.errors.slice(errorStart).find(item => item.code !== 'CLOUD_SQL_CONSTRAINT');
        if (infrastructureError) throw failure(infrastructureError.code);
        if (error.status !== 409) throw error;
        budget.commands.push({ input: structuredClone(input), controls: structuredClone(controls), domainError: error.code });
        return { status: 409, body: { error: error.code } };
      }
    },
    async reset() {
      await verifyMarker();
      const statements = [{ sql: 'PRAGMA defer_foreign_keys = ON', params: [] },
        ...tables.slice().reverse().map(name => ({ sql: `DELETE FROM ${name}`, params: [] }))];
      for (const company of ['c1','c2']) {
        statements.push({ sql: 'INSERT INTO lab_companies VALUES (?)', params: [company] });
        for (const branch of ['b1','b2']) {
          for (const [sql, params] of [
            ['INSERT INTO lab_branches VALUES (?,?,1)', [company,branch]],
            ['INSERT INTO lab_actors VALUES (?,?,?,1,0)', [company,`a-${branch}`,branch]],
            ['INSERT INTO lab_control VALUES (?,?,1,1,0)', [company,branch]],
            ["INSERT INTO lab_stock VALUES (?,?,'sku',100,0,0)", [company,branch]],
            ["INSERT INTO lab_customers VALUES (?,?,'customer','0.00','100.00',0)", [company,branch]],
            ["INSERT INTO lab_approvals VALUES (?,?,'approval','customer','100.00',1,0)", [company,branch]],
            ["INSERT INTO lab_coupons VALUES (?,?,'coupon',1,'1.00',0)", [company,branch]],
            ['INSERT INTO lab_counters VALUES (?,?,1,0)', [company,branch]],
            ["INSERT INTO lab_cash VALUES (?,?,'1000.00',0)", [company,branch]],
            ["INSERT INTO lab_wallets VALUES (?,?,'wallet','100.00',0)", [company,branch]]]) statements.push({ sql, params });
        }
      }
      return query({ batch: statements });
    },
    async close() { closed = true; token = undefined; }
  };
}

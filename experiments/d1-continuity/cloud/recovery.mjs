import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPayload } from '../commands.mjs';
import { createCloudLab, createCloudBudget, validateCloudManifest } from './lab.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../../..');
const runFile = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

// This runner has no side effects on import and is never part of the root suite.
export async function runRecovery({ confirmSyntheticSandbox = false } = {}) {
  if (confirmSyntheticSandbox !== true) throw new Error('CONFIRM_SYNTHETIC_SANDBOX_REQUIRED');
  const sourceManifest = JSON.parse(await readFile(path.join(repo, '.superpowers/sdd/cloud-runtime.json'), 'utf8'));
  const restoreManifest = JSON.parse(await readFile(path.join(repo, '.superpowers/sdd/cloud-restore-runtime.json'), 'utf8'));
  // Pin both resources before even invoking Wrangler; import itself is a mutation.
  validateCloudManifest(sourceManifest, { initialize: false });
  validateCloudManifest(restoreManifest, { initialize: false, recoverImportedSource: true });
  assert.equal(restoreManifest.accountId, sourceManifest.accountId);
  assert.equal(restoreManifest.sourceDatabaseId, sourceManifest.databaseId);
  assert.notEqual(restoreManifest.databaseId, sourceManifest.databaseId);
  assert.match(restoreManifest.name, /^erp-d1-poc-20261017-[0-9a-f]{6}$/);
  assert.match(restoreManifest.createdAt, /^2026-10-17T/);
  const schema = await readFile(path.join(directory, '../schema.sql'), 'utf8');
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (lab_[a-z_]+)/g)].map(match => match[1]).sort();
  const sourceHashes = {};
  for (const file of ['commands.mjs', 'schema.sql', 'cloud/lab.mjs', 'cloud/recovery.mjs']) {
    sourceHashes[file] = sha256(await readFile(path.join(directory, '..', file)));
  }
  const runId = randomUUID();
  const resultsPath = path.join(directory, 'results', `recovery-${runId}`);
  await mkdir(resultsPath, { recursive: true });
  const evidence = { runId, startedAt: new Date().toISOString(), source: sourceManifest.name,
    restore: restoreManifest.name, sourceHashes, passed: false, phases: [],
    limitations: ['Synthetic command model; no production application or region outage.',
      'Recovery of post-backup writes requires the externally preserved complete original command log.',
      'No automatic or complete production disaster recovery system is implemented.'] };
  const evidenceFile = path.join(resultsPath, 'result.json');
  const save = async () => writeFile(evidenceFile, json(evidence));
  const cliRoot = await mkdtemp(path.join(os.tmpdir(), 'erp-d1-recovery-cli-'));
  const cliConfig = path.join(cliRoot, 'wrangler.json');
  await writeFile(cliConfig, json({ name: 'erp-d1-recovery-lab', account_id: sourceManifest.accountId,
    compatibility_date: '2026-10-17', send_metrics: false,
    d1_databases: [sourceManifest, restoreManifest].map((item, i) => ({ binding: i ? 'RESTORE' : 'SOURCE',
      database_name: item.name, database_id: item.databaseId })) }));
  const cli = path.join(path.dirname(sourceManifest.wranglerModule), 'bin/wrangler.js');
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CLOUDFLARE_ACCOUNT_ID = sourceManifest.accountId;
  env.WRANGLER_SEND_METRICS = 'false';
  env.WRANGLER_WRITE_LOGS = 'false';
  async function cliRun(args, parse = false) {
    let captured;
    try {
      captured = await runFile(process.execPath, [cli, ...args, '--config', cliConfig],
        { cwd: cliRoot, env, windowsHide: true, timeout: 60000, maxBuffer: 1048576 });
      return parse ? JSON.parse(captured.stdout) : undefined;
    } catch {
      // Do not print CLI stdout/stderr: credentials and logs remain private.
      throw new Error(`RECOVERY_CLI_FAILED_${args[1]?.toUpperCase() ?? 'UNKNOWN'}`);
    } finally { captured = undefined; }
  }
  async function checkIdentity(manifest, empty = false) {
    const info = await cliRun(['d1', 'info', manifest.name, '--json'], true);
    assert.equal(info.uuid, manifest.databaseId);
    assert.equal(info.name, manifest.name);
    if (manifest.createdAt) assert.equal(info.created_at, manifest.createdAt);
    if (empty) assert.equal(info.num_tables, 0, 'Restore target must still be fresh and empty; no overwrite.');
  }
  const budget = createCloudBudget(350);
  let source, restored;
  async function snapshot(lab) {
    const data = {};
    for (const table of tables) {
      const rows = (await lab.db.prepare(`SELECT * FROM ${table}`).all()).results;
      data[table] = rows.map(row => canonicalPayload(row)).sort();
    }
    const hashes = Object.fromEntries(tables.map(table => [table, sha256(canonicalPayload(data[table]))]));
    return { data, hashes, hash: sha256(canonicalPayload(hashes)), tables: tables.length,
      rows: Object.values(data).reduce((sum, values) => sum + values.length, 0) };
  }
  try {
    await checkIdentity(sourceManifest);
    await checkIdentity(restoreManifest, true);
    source = await createCloudLab({ confirmSyntheticSandbox: true, initialize: false, budget });
    assert.equal(source.schemaHash, sha256(schema));
    const command = { companyId: 'c1', actorId: 'a-b1', branchId: 'b1', epoch: 1,
      clientRequestId: `restore_${runId.replaceAll('-', '')}`, kind: 'SALE', mode: 'CASH',
      sku: 'sku', quantity: 1, unitPrice: '123.45', discount: '0.01', taxRate: '5', deliveryFee: '2' };
    const control = await source.db.prepare('SELECT * FROM lab_control WHERE companyId=? AND branchId=?').bind('c1', 'b1').first();
    assert.equal(control.epoch, 1);
    assert.equal(control.periodOpen, 1);
    const probePrefix = `restore_${runId}`;
    await source.db.batch([
      source.db.prepare('INSERT INTO lab_money_probe VALUES (?,?)').bind(`${probePrefix}_max`, '999999999999999999.99'),
      source.db.prepare('INSERT INTO lab_money_probe VALUES (?,?)').bind(`${probePrefix}_min`, '-999999999999999999.99')
    ]);
    const before = await snapshot(source);
    await writeFile(path.join(resultsPath, 'before.json'), json(before));
    const exportPath = path.join(resultsPath, 'snapshot.sql');
    // The parent must first stop the cloud case runner: exports block database requests.
    await cliRun(['d1', 'export', sourceManifest.name, '--remote', '--output', exportPath, '-y']);
    const exportBytes = await readFile(exportPath);
    evidence.exportSha256 = sha256(exportBytes);
    evidence.exportBytes = exportBytes.length;
    evidence.phases.push('exported-quiescent-source');
    await save();

    const clientLogFile = path.join(resultsPath, 'external-command-log.json');
    await writeFile(clientLogFile, json({ command, state: 'PENDING' }));
    const sale = await source.command(command);
    assert.equal(sale.status, 200);
    assert.equal(sale.body.total, '131.61');
    await writeFile(clientLogFile, json({ command, result: sale.body, state: 'COMMITTED' }));
    const latest = await snapshot(source);
    assert.notEqual(latest.hash, before.hash);
    await writeFile(path.join(resultsPath, 'source-latest.json'), json(latest));
    evidence.phases.push('post-backup-sale-committed-with-preserved-original-command');
    await save();

    await checkIdentity(restoreManifest, true);
    await cliRun(['d1', 'execute', restoreManifest.name, '--remote', '--file', exportPath, '-y']);
    restored = await createCloudLab({ confirmSyntheticSandbox: true, manifestPath: path.join(repo, '.superpowers/sdd/cloud-restore-runtime.json'),
      initialize: false, recoverImportedSource: true, budget });
    const recoveredBackup = await snapshot(restored);
    assert.equal(recoveredBackup.hash, before.hash, 'Imported backup must exactly match every synthetic application table.');
    assert.deepEqual(await restored.db.prepare('SELECT * FROM lab_operations WHERE companyId=? AND clientRequestId=?')
      .bind(command.companyId, command.clientRequestId).first(), null);
    for (const [suffix, expected] of [['max', '999999999999999999.99'], ['min', '-999999999999999999.99']]) {
      const row = await restored.db.prepare('SELECT amount,typeof(amount) AS type FROM lab_money_probe WHERE id=?').bind(`${probePrefix}_${suffix}`).first();
      assert.deepEqual(row, { amount: expected, type: 'text' });
    }
    evidence.phases.push('backup-matched-all-tables-and-exact-signed-money;post-backup-sale-absent');
    await save();

    const externalLog = JSON.parse(await readFile(clientLogFile, 'utf8'));
    const replay = await restored.command(externalLog.command);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, externalLog.result);
    const once = await snapshot(restored);
    assert.equal(once.hash, latest.hash, 'Replay must restore the exact latest logical application state.');
    await restored.close(); restored = undefined;
    restored = await createCloudLab({ confirmSyntheticSandbox: true, manifestPath: path.join(repo, '.superpowers/sdd/cloud-restore-runtime.json'),
      initialize: false, recoverImportedSource: true, budget });
    assert.deepEqual(await restored.command(externalLog.command), replay);
    const twice = await snapshot(restored);
    assert.equal(twice.hash, once.hash, 'Repeated original command must leave all source/effect rows unchanged.');
    const fk = await restored.db.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(fk.results, []);
    evidence.phases.push('external-command-replayed-once;reconnect-and-repeat-unchanged;foreign-keys-clean');
    evidence.hashes = { backup: before.hash, restoredBackup: recoveredBackup.hash,
      sourceLatest: latest.hash, restoredLatest: once.hash, afterRepeatedReplay: twice.hash };
    evidence.tables = tables.length;
    evidence.rows = { backup: before.rows, latest: latest.rows };
    evidence.command = externalLog;
    evidence.passed = true;
  } catch (error) {
    evidence.error = { code: error.code, message: error.message };
    throw error;
  } finally {
    await source?.close(); await restored?.close();
    evidence.finishedAt = new Date().toISOString();
    evidence.metrics = budget;
    await save();
    await writeFile(path.join(directory, 'results/recovery-latest.json'), json(evidence));
    console.log(JSON.stringify({ passed: evidence.passed, evidenceFile, phases: evidence.phases,
      tables: evidence.tables, requests: budget.requests, rowsRead: budget.rowsRead, rowsWritten: budget.rowsWritten }));
  }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--confirm-synthetic-sandbox') {
    console.error('Explicit --confirm-synthetic-sandbox required; source must be quiescent and restore target empty.');
    process.exitCode = 1;
  } else {
    await runRecovery({ confirmSyntheticSandbox: true });
  }
}

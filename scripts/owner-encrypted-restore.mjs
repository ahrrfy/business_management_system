import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
import { ownerRestoreRequest } from "../shared/ownerRestore.ts";
import { hasOwnerRestoreFence, ownerRestorePaths, ownerRestoreTarget } from "../server/lib/ownerRestoreFiles.ts";
import { resolveRecordedArchive } from "../server/lib/backupEvidence.ts";
import { prepareEncryptedRestore, gpgForPlatform } from "./decrypt-restore-archive.mjs";
import { encryptBackupWithOwnedAgent } from "./lib/backup-gpg.mjs";
import { fingerprint, publishEncryptedBackup, sameFingerprint } from "./lib/backup-publication.mjs";
import { acquireMaintenanceLock } from "./lib/maintenance-lock.mjs";
import { assertLocalEndpoint } from "./isolated-local-restore.mjs";
import { assertPrivateRecoveryDirectory } from "./lib/recovery-mysql.mjs";

const runFile = promisify(execFile);
const leaseName = "alroya_owner_encrypted_restore";
const script = name => path.resolve("scripts", name);
const activePhases = new Set(["PREPARING", "MAINTENANCE", "BACKING_UP", "RESTORING", "ROLLING_BACK"]);
const requireCondition = (condition, code) => { if (!condition) throw Error(code); };
const errorCode = (error, fallback) => /^[A-Z0-9_]{3,64}$/.test(error?.message ?? "") ? error.message : fallback;
const digest = ticket => createHash("sha256").update(ticket).digest("hex");

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableFile(file, data, mode) {
  const handle = await open(file, "wx", mode);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

async function writeState(file, state) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await durableFile(temporary, JSON.stringify(state) + "\n", 0o640);
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await unlink(temporary).catch(() => {}); }
}

function sameTarget(a, b) {
  return a.host === b.host && a.port === b.port && a.database === b.database && a.user === b.user;
}

function controllerConfiguration(env) {
  const paths = ownerRestorePaths(env.ERP_OWNER_RESTORE_DIRECTORY?.trim());
  const app = ownerRestoreTarget(env.DATABASE_URL);
  const control = ownerRestoreTarget(env.ERP_OWNER_RESTORE_CONTROL_DATABASE_URL);
  const importer = ownerRestoreTarget(env.ERP_OWNER_RESTORE_IMPORT_DATABASE_URL);
  const uuid = env.DB_TARGET_EXPECTED_UUID?.toLowerCase();
  const passphrase = env.BACKUP_GPG_PASSPHRASE;
  const container = env.DB_CONTAINER;
  requireCondition(paths && app && control && importer && !env.CONTROL_DATABASE_URL && app.user !== "root" &&
    sameTarget(app, { ...control, user: app.user }) && sameTarget(app, { ...importer, user: app.user }) &&
    new Set([app.user, control.user, importer.user]).size === 3 &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid ?? "") &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(container ?? "") && passphrase, "RESTORE_CONTROLLER_CONFIGURATION_INVALID");
  return { paths, app, uuid, passphrase, container,
    appUrl: env.DATABASE_URL, controlUrl: env.ERP_OWNER_RESTORE_CONTROL_DATABASE_URL, importUrl: env.ERP_OWNER_RESTORE_IMPORT_DATABASE_URL,
    backups: path.resolve(env.BACKUP_DIR ?? "backups"), offsite: env.BACKUP_OFFSITE_DIR?.trim(),
    dockerContext: env.ERP_OWNER_RESTORE_DOCKER_CONTEXT || (process.platform === "win32" ? "desktop-linux" : "default") };
}

function connect(rawUrl, useDatabase = true) {
  const url = new URL(rawUrl);
  return mysql.createConnection({
    host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ...(useDatabase ? { database: decodeURIComponent(url.pathname.slice(1)) } : {}),
    connectTimeout: 5000, enableKeepAlive: true,
  });
}

const rows = async (db, sql, parameters = []) => (await db.query(sql, parameters))[0];
const one = async (db, sql, parameters = []) => (await rows(db, sql, parameters))[0];

async function foreground(db) {
  return rows(db, "SELECT PROCESSLIST_ID AS id, PROCESSLIST_USER AS user FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_ID IS NOT NULL AND PROCESSLIST_ID<>CONNECTION_ID() AND NOT (NAME IN ('thread/sql/event_scheduler','thread/sql/compress_gtid_table') AND PROCESSLIST_COMMAND='Daemon')");
}

async function assertNoSessions(db) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const live = await foreground(db);
    const transactions = await one(db, "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX");
    if (live.length === 0 && Number(transactions.n) === 0) return;
    await delay(200);
  }
  throw Error("RESTORE_DATABASE_NOT_QUIESCENT");
}

async function assertNoEvents(db) {
  const events = await one(db, "SELECT COUNT(*) AS n FROM information_schema.EVENTS WHERE STATUS='ENABLED'");
  requireCondition(Number(events.n) === 0, "RESTORE_ENABLED_DATABASE_EVENTS");
}

async function persistedSettings(db) {
  const settings = new Map((await rows(db, "SELECT VARIABLE_NAME AS name, VARIABLE_VALUE AS value FROM performance_schema.persisted_variables WHERE VARIABLE_NAME IN ('offline_mode','event_scheduler')"))
    .map(row => [row.name, ({ "1": "ON", "0": "OFF", ON: "ON", OFF: "OFF" })[String(row.value).toUpperCase()]]));
  requireCondition([...settings.values()].every(Boolean), "RESTORE_PERSISTED_SETTINGS_INVALID");
  return settings;
}

async function assertDatabaseDefiners(db, database, allowed) {
  const definers = await rows(db, `
    SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?
    UNION SELECT DEFINER FROM information_schema.VIEWS WHERE TABLE_SCHEMA=?
    UNION SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=?
    UNION SELECT DEFINER FROM information_schema.EVENTS WHERE EVENT_SCHEMA=?`, Array(4).fill(database));
  requireCondition(definers.every(row => allowed.includes(row.DEFINER)), "RESTORE_LIVE_DEFINER_NOT_ALLOWED");
}

async function verifyImporter(config) {
  const db = await connect(config.importUrl);
  try {
    const identity = await one(db, "SELECT @@server_uuid AS uuid, DATABASE() AS db, CURRENT_USER() AS definer");
    requireCondition(identity.uuid === config.uuid && identity.db === config.app.database, "RESTORE_DATABASE_IDENTITY_CHANGED");
    const grants = (await rows(db, "SHOW GRANTS FOR CURRENT_USER()")).map(row => String(Object.values(row)[0]));
    const expectedScope = " ON `" + config.app.database + "`.*";
    const databaseGrants = new Set();
    const globalGrants = new Set();
    for (const grant of grants) {
      requireCondition(!/\bWITH\s+(?:GRANT|ADMIN)\s+OPTION\b/i.test(grant), "RESTORE_IMPORT_PRIVILEGES_TOO_BROAD");
      const [privilege] = grant.split(" TO ", 1);
      if (privilege.endsWith(expectedScope)) {
        for (const name of privilege.slice("GRANT ".length, -expectedScope.length).split(/,\s*/)) databaseGrants.add(name);
        continue;
      }
      const names = /^GRANT ([A-Z ,_]+) ON \*\.\*$/.exec(privilege)?.[1].split(/,\s*/);
      requireCondition(names?.every(name => ["USAGE", "CONNECTION_ADMIN", "SET_USER_ID"].includes(name)),
        "RESTORE_IMPORT_PRIVILEGES_TOO_BROAD");
      for (const name of names) globalGrants.add(name);
    }
    const required = ["ALTER", "ALTER ROUTINE", "CREATE", "CREATE ROUTINE", "CREATE TEMPORARY TABLES", "CREATE VIEW",
      "DELETE", "DROP", "EVENT", "EXECUTE", "INDEX", "INSERT", "LOCK TABLES", "REFERENCES", "SELECT", "SHOW VIEW", "TRIGGER", "UPDATE"];
    requireCondition(globalGrants.has("CONNECTION_ADMIN") && globalGrants.has("SET_USER_ID") &&
      (databaseGrants.has("ALL PRIVILEGES") || required.every(name => databaseGrants.has(name))), "RESTORE_IMPORT_PRIVILEGES_INSUFFICIENT");
    return identity.definer;
  } finally { await db.end(); }
}

async function environment(config, directory) {
  const allowed = ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "ProgramFiles",
    "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "DOCKER_CONFIG"];
  const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.dockerContext), "RESTORE_LOCAL_DOCKER_REQUIRED");
  const context = await runFile("docker", ["context", "inspect", config.dockerContext, "--format", "{{.Endpoints.docker.Host}}"],
    { env, encoding: "utf8", timeout: 5000, windowsHide: true });
  const endpoint = context.stdout.trim();
  assertLocalEndpoint(endpoint);
  return { ...env, DOCKER_HOST: endpoint, DATABASE_URL: config.importUrl, DB_CONTAINER: config.container,
    DB_TARGET_EXPECTED_UUID: config.uuid, BACKUP_DIR: directory, MAINTENANCE_LOCK_HELD_BY_PARENT: "1",
    DOTENV_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null", TZ: "UTC" };
}

async function runScript(name, args, env, code) {
  try {
    return (await runFile(process.execPath, [script(name), ...args], {
      env, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20 * 60_000,
    })).stdout;
  } catch (error) {
    if (code === "RESTORE_SQL_VALIDATION_FAILED" && /(?:^|\s)RESTORE_DEFINER_NOT_ALLOWED\s/.test(error.stderr ?? "")) {
      throw Error("RESTORE_DEFINER_NOT_ALLOWED");
    }
    throw Error(code);
  }
}

async function verifyCore(db, database) {
  const tableCount = await one(db, "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'", [database]);
  const counts = [Number(tableCount.n)];
  for (const table of ["users", "branches", "invoices", "products", "__drizzle_migrations"]) {
    const result = await one(db, "SELECT COUNT(*) AS n FROM " + database + "." + table);
    counts.push(Number(result.n));
  }
  requireCondition(counts.every(value => Number.isSafeInteger(value) && value >= 0) && counts[0] >= 5 && counts[1] > 0, "RESTORE_CORE_READS_INVALID");
  const owners = await one(db, "SELECT COUNT(*) AS n FROM " + database + ".users WHERE isActive=1 AND isOwner=1");
  requireCondition(Number(owners.n) > 0, "RESTORE_ACTIVE_OWNER_MISSING");
  await assertNoEvents(db);
  return [...counts, Number(owners.n)].join(":");
}

async function databaseDefaults(db, database) {
  const result = await one(db, "SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database]);
  const defaults = result && result.charset + ":" + result.collation;
  requireCondition(/^[a-z0-9_]+:[a-z0-9_]+$/i.test(defaults ?? ""), "RESTORE_DATABASE_DEFAULTS_INVALID");
  return defaults;
}

async function removePrivateSql(file) {
  if (file) await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
}

async function restoreVariables(db, changed, prior) {
  for (const name of changed) {
    if (name !== "log_bin_trust_function_creators") {
      const persisted = prior.persisted.get(name);
      if (persisted == null) await db.query("RESET PERSIST IF EXISTS " + name);
      else await db.query("SET PERSIST_ONLY " + name + " = " + persisted);
    }
    await db.query("SET GLOBAL " + name + " = " + prior.runtime[name]);
  }
  const state = await one(db, "SELECT @@GLOBAL.offline_mode AS offline, @@GLOBAL.event_scheduler AS scheduler, @@GLOBAL.log_bin_trust_function_creators AS trust");
  const persisted = await persistedSettings(db);
  requireCondition(Number(state.offline) === 0 && state.scheduler === prior.runtime.event_scheduler &&
    Number(state.trust) === Number(prior.runtime.log_bin_trust_function_creators === "ON"),
    "RESTORE_RUNTIME_SETTINGS_NOT_RESTORED");
  requireCondition(changed.every(name => persisted.get(name) === prior.persisted.get(name)),
    "RESTORE_PERSISTED_SETTINGS_NOT_RESTORED");
}

export async function executeOwnerRestore(config, job) {
  const { paths, app } = config;
  const directory = path.join(paths.root, job.status.id);
  const candidate = path.join(directory, "candidate.sql");
  const receipt = path.join(directory, "receipt.json");
  let privateDirectoryReady = false;
  const save = async () => {
    if (privateDirectoryReady) {
      const { ticketDigest: _digest, ...record } = job;
      await writeState(receipt, record);
    }
    await writeState(paths.state, job);
  };
  const update = async (phase, error = null) => {
    job.status = { ...job.status, phase, error, updatedAt: new Date().toISOString() };
    await save();
  };
  let controlDb, releaseLock, safetySql, safetyFingerprint, markerOwned = false, destructive = false, baseline, prior;
  let phase = "FAILED", failure = null;
  const changed = [];
  let definer, env, defaults;
  const definerOptions = [];
  const assertFence = async () => {
    const fence = await one(controlDb, "SELECT @@server_uuid AS uuid, @@GLOBAL.offline_mode AS offline, @@GLOBAL.event_scheduler AS scheduler, @@GLOBAL.log_bin AS binlog, @@GLOBAL.log_bin_trust_function_creators AS trust, IS_USED_LOCK(?)=CONNECTION_ID() AS lease", [leaseName]);
    requireCondition(fence.uuid === config.uuid && Number(fence.offline) === 1 && fence.scheduler !== "ON" &&
      (Number(fence.binlog) === 0 || Number(fence.trust) === 1) && Number(fence.lease) === 1 &&
      hasOwnerRestoreFence(paths.fence), "RESTORE_DATABASE_FENCE_LOST");
    await assertNoSessions(controlDb);
  };
  const validate = file => runScript("restore.mjs", [file, "--validate-only", ...definerOptions], env, "RESTORE_SQL_VALIDATION_FAILED");
  const apply = (file, rollback = false) => runScript("restore.mjs", [
    file, "--confirm", "RESTORE", "--no-backup", ...definerOptions, "--database-defaults", defaults,
    ...(rollback ? ["--skip-migrations"] : []),
  ], env, "RESTORE_SQL_APPLY_FAILED");
  try {
    requireCondition(!process.env.MAINTENANCE_LOCK_HELD_BY_PARENT, "RESTORE_CONTROLLER_LOCK_CONFIGURATION_INVALID");
    releaseLock = acquireMaintenanceLock();
    await mkdir(directory, { mode: 0o700 });
    await assertPrivateRecoveryDirectory(directory, { restrictNewWindowsDirectory: true });
    privateDirectoryReady = true;
    await save();
    const archive = await resolveRecordedArchive(config.backups, config.offsite, job.request.name + ".gpg");
    requireCondition(archive && sameFingerprint(archive.manifest, job.request.source), "RESTORE_APPROVED_ARCHIVE_CHANGED");
    await prepareEncryptedRestore({ archive: archive.file, sqlFile: candidate, requireManifest: true, passphrase: config.passphrase });
    const candidateFingerprint = await fingerprint(candidate);
    requireCondition(sameFingerprint(candidateFingerprint, archive.manifest.source) &&
      sameFingerprint(await fingerprint(archive.file), job.request.source), "RESTORE_APPROVED_ARCHIVE_CHANGED");

    env = await environment(config, directory);
    const appDb = await connect(config.appUrl);
    try {
      const identity = await one(appDb, "SELECT @@server_uuid AS uuid, DATABASE() AS db, CURRENT_USER() AS definer");
      requireCondition(identity.uuid === config.uuid && identity.db === app.database &&
        identity.definer.split("@", 1)[0] === app.user, "RESTORE_DATABASE_IDENTITY_CHANGED");
      definer = identity.definer;
    } finally { await appDb.end(); }
    const importDefiner = await verifyImporter(config);
    definerOptions.push("--expected-definer", definer, "--expected-definer", importDefiner);
    await validate(candidate);
    controlDb = await connect(config.controlUrl, false);
    const state = await one(controlDb, "SELECT @@server_uuid AS uuid, @@GLOBAL.offline_mode AS offline, @@GLOBAL.event_scheduler AS scheduler, @@GLOBAL.persisted_globals_load AS persistEnabled, @@GLOBAL.log_bin AS binlog, @@GLOBAL.log_bin_trust_function_creators AS trust");
    requireCondition(state.uuid === config.uuid && Number(state.offline) === 0 && Number(state.persistEnabled) === 1 &&
      ["ON", "OFF", "DISABLED"].includes(state.scheduler), "RESTORE_DATABASE_TARGET_NOT_READY");
    const lease = await one(controlDb, "SELECT GET_LOCK(?,0) AS acquired", [leaseName]);
    requireCondition(Number(lease.acquired) === 1, "RESTORE_DATABASE_BUSY");
    const other = await one(controlDb, "SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys',?)", [app.database]);
    const replication = await one(controlDb, "SELECT (SELECT COUNT(*) FROM performance_schema.replication_connection_status) + (SELECT COUNT(*) FROM performance_schema.replication_applier_status) AS n");
    requireCondition(Number(other.n) === 0 && Number(replication.n) === 0 &&
      (await foreground(controlDb)).every(session => session.user === app.user), "RESTORE_EXTERNAL_WRITERS_PRESENT");
    await assertNoEvents(controlDb);
    await assertDatabaseDefiners(controlDb, app.database, [definer, importDefiner]);
    const persisted = await persistedSettings(controlDb);
    prior = { persisted, runtime: {
      offline_mode: "OFF", event_scheduler: state.scheduler, log_bin_trust_function_creators: Number(state.trust) === 1 ? "ON" : "OFF",
    } };
    job.previousDatabaseSettings = { runtime: prior.runtime, persisted: Object.fromEntries(prior.persisted) };
    await save();
    await durableFile(paths.fence, job.status.id + "\n", 0o640);
    markerOwned = true;
    await update("MAINTENANCE");
    if (state.scheduler === "ON") {
      changed.push("event_scheduler");
      await controlDb.query("SET PERSIST event_scheduler = OFF");
    }
    changed.push("offline_mode");
    await controlDb.query("SET PERSIST offline_mode = ON");
    const appCanConnect = await connect(config.appUrl).then(async connection => { await connection.end(); return true; }, error => {
      if (error.code !== "ER_SERVER_OFFLINE_MODE") throw Error("RESTORE_DATABASE_FENCE_UNPROVEN");
      return false;
    });
    requireCondition(!appCanConnect, "RESTORE_DATABASE_FENCE_UNPROVEN");
    for (const session of await foreground(controlDb)) {
      requireCondition(session.user === app.user && Number.isSafeInteger(Number(session.id)), "RESTORE_EXTERNAL_WRITERS_PRESENT");
      await controlDb.query("KILL CONNECTION " + Number(session.id)).catch(error => { if (error.code !== "ER_NO_SUCH_THREAD") throw error; });
    }
    await assertNoSessions(controlDb);
    if (Number(state.binlog) === 1 && Number(state.trust) === 0) {
      changed.unshift("log_bin_trust_function_creators");
      await controlDb.query("SET GLOBAL log_bin_trust_function_creators = ON");
    }
    await assertFence();
    baseline = await verifyCore(controlDb, app.database);
    defaults = await databaseDefaults(controlDb, app.database);
    await runScript("db-verify-schema.mjs", [], env, "RESTORE_BASELINE_SCHEMA_INVALID");

    await update("BACKING_UP");
    const backup = await runScript("backup.mjs", ["--no-rotate", "--print-receipt"], env, "RESTORE_SAFETY_BACKUP_FAILED");
    const names = [...backup.matchAll(/^ERP_BACKUP_RESULT: ([A-Za-z0-9_.$-]+\.sql)\s*$/gm)];
    requireCondition(names.length === 1 && !names[0][1].includes(".."), "RESTORE_SAFETY_BACKUP_RECEIPT_INVALID");
    safetySql = path.join(directory, names[0][1]);
    await validate(safetySql);
    safetyFingerprint = await fingerprint(safetySql);
    const publication = await publishEncryptedBackup({
      sqlFile: safetySql,
      encrypt: partialFile => encryptBackupWithOwnedAgent({
        ...gpgForPlatform(), sqlFile: safetySql, partialFile, passphrase: config.passphrase,
      }),
    });
    requireCondition(sameFingerprint(publication.source, safetyFingerprint) &&
      sameFingerprint(await fingerprint(safetySql + ".gpg"), publication), "RESTORE_SAFETY_BACKUP_INVALID");
    for (const file of [safetySql, safetySql + ".gpg", safetySql + ".gpg.manifest.json"]) {
      const handle = await open(file, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await syncDirectory(directory);
    job.status.safetyArchive = publication.file;
    await assertFence();
    requireCondition(sameFingerprint(await fingerprint(candidate), candidateFingerprint), "RESTORE_APPROVED_ARCHIVE_CHANGED");
    await update("RESTORING");
    destructive = true;
    await apply(candidate);
    await assertFence();
    requireCondition(await databaseDefaults(controlDb, app.database) === defaults, "RESTORE_DATABASE_DEFAULTS_CHANGED");
    await verifyCore(controlDb, app.database);
    phase = "RESTORED";
  } catch (error) {
    failure = errorCode(error, "RESTORE_OPERATION_FAILED");
    if (destructive) {
      try {
        await update("ROLLING_BACK", failure).catch(() => {});
        await assertFence();
        requireCondition(sameFingerprint(await fingerprint(safetySql), safetyFingerprint), "RESTORE_SAFETY_BACKUP_INVALID");
        await apply(safetySql, true);
        await assertFence();
        requireCondition(await verifyCore(controlDb, app.database) === baseline &&
          await databaseDefaults(controlDb, app.database) === defaults, "RESTORE_ROLLBACK_READS_MISMATCH");
        phase = "ROLLED_BACK";
      } catch {
        phase = "RECOVERY_REQUIRED";
        failure = "RESTORE_ROLLBACK_FAILED";
      }
    }
  }
  try {
    if (markerOwned && phase !== "RECOVERY_REQUIRED") {
      try {
        job.verifiedOutcome = phase;
        await save();
        if (changed.length) await restoreVariables(controlDb, changed, prior);
        await unlink(paths.fence);
        await syncDirectory(paths.root);
      } catch {
        phase = "RECOVERY_REQUIRED";
        failure = "RESTORE_MAINTENANCE_RELEASE_FAILED";
      }
    }
    await update(phase, failure);
  } finally {
    await controlDb?.end().catch(() => {});
    releaseLock?.();
    await removePrivateSql(candidate).catch(() => console.error("RESTORE_PRIVATE_SQL_CLEANUP_FAILED"));
    await removePrivateSql(safetySql).catch(() => console.error("RESTORE_PRIVATE_SQL_CLEANUP_FAILED"));
  }
}

export async function startOwnerRestoreController(env = process.env) {
  const config = controllerConfiguration(env);
  const { paths } = config;
  const root = await lstat(paths.root);
  requireCondition(root.isDirectory() && path.relative(paths.root, await realpath(paths.root)) === "" &&
    (process.platform === "win32" || (root.mode & 0o022) === 0), "RESTORE_CONTROLLER_DIRECTORY_NOT_PRIVATE");
  let busy = true;
  const respond = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/ready") return respond(res, 200, { ready: !busy && !hasOwnerRestoreFence(paths.fence) });
    if (req.method !== "POST" || req.url !== "/start") return respond(res, 404, {});
    let request;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) throw Error("RESTORE_REQUEST_TOO_LARGE");
      }
      request = ownerRestoreRequest.parse(JSON.parse(body));
    } catch { return respond(res, 400, {}); }
    if (!sameTarget(request.target, config.app)) return respond(res, 403, {});
    if (busy || hasOwnerRestoreFence(paths.fence)) return respond(res, 409, {});
    busy = true;
    const ticket = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const job = { request, ticketDigest: digest(ticket), status: {
      id: randomUUID(), name: request.name, phase: "PREPARING", startedAt: now, updatedAt: now, safetyArchive: null, error: null,
    } };
    try { await writeState(paths.state, job); }
    catch { busy = false; return respond(res, 500, {}); }
    respond(res, 200, { ticket, status: job.status });
    void executeOwnerRestore(config, job).catch(() => console.error("RESTORE_STATE_WRITE_FAILED")).finally(() => { busy = false; });
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socket, resolve); });
  try {
    if (process.platform !== "win32") await chmod(paths.socket, 0o660);
    const interrupted = await readFile(paths.state, "utf8").then(JSON.parse).catch(() => null);
    if (interrupted && activePhases.has(interrupted.status?.phase)) {
      interrupted.status.phase = hasOwnerRestoreFence(paths.fence) ? "RECOVERY_REQUIRED" : "FAILED";
      interrupted.status.error = "RESTORE_CONTROLLER_INTERRUPTED";
      interrupted.status.updatedAt = new Date().toISOString();
      await writeState(paths.state, interrupted);
    }
    busy = false;
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startOwnerRestoreController().then(() => console.log("Owner restore controller ready")).catch(error => {
    console.error(errorCode(error, "RESTORE_CONTROLLER_START_FAILED"));
    process.exitCode = 1;
  });
}

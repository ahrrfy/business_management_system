// Offline recovery evidence only. No existing database/container is selected or removed.
import { createReadStream } from "node:fs";
import { mkdir, writeFile, stat, readFile, realpath, rename, unlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, createDecipheriv } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fingerprint, readEncryptedPublication, sameFingerprint } from "./lib/backup-publication.mjs";
import { verifyRecoveryAttachments } from "./lib/recovery-attachments.mjs";
import { prepareRecoveryMysql, bootstrapRecoveryAdmin, assertPrivateRecoveryDirectory } from "./lib/recovery-mysql.mjs";
import { prepareEncryptedRestore } from "./decrypt-restore-archive.mjs";

export function assertLocalEndpoint(endpoint) {
  if (!/^(npipe:\/\/\/\/\.\/pipe\/[^\s]+|unix:\/\/\/[^\s]+)$/.test(endpoint)) throw new Error("LOCAL_DOCKER_REQUIRED");
}
export function assertIsolation(c, name, token) {
  if (c.Name !== `/${name}` || c.Config?.Labels?.["alroya.recovery.token"] !== token ||
      c.HostConfig?.NetworkMode !== "none" || c.HostConfig?.Privileged ||
      Object.keys(c.HostConfig?.PortBindings ?? {}).length ||
      c.HostConfig?.Binds?.length || c.Mounts?.some(m => m.Type !== "volume") ||
      c.HostConfig?.RestartPolicy?.Name !== "no") throw new Error("ISOLATION_VIOLATION");
}
export function verifySecret(ciphertext, raw) {
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64");
  const [v, iv, tag, body, extra] = ciphertext.split(":");
  if (key.length !== 32 || v !== "v1" || extra !== undefined || !body ||
      Buffer.from(iv, "base64").length !== 12 || Buffer.from(tag, "base64").length !== 16)
    throw new Error("INVALID_ENCRYPTED_SECRET");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]);
  plain.fill(0); // Never return or print recovered credentials.
}

export async function exerciseTargetRollback(sql, directory) {
  const baseline = "erp_drill_baseline";
  const marker = randomBytes(16).toString("hex");
  sql(`CREATE DATABASE \`${baseline}\`;
    CREATE TABLE \`${baseline}\`.drill_marker (value CHAR(32) NOT NULL);
    INSERT INTO \`${baseline}\`.drill_marker VALUES ('${marker}');`);
  const selector = join(directory, "exercise-target");
  const select = async database => {
    const pending = selector + ".next";
    await writeFile(pending, database, { flag: "wx", mode: 0o600 });
    await rename(pending, selector);
  };
  const querySelected = async query => {
    const selected = await readFile(selector, "utf8");
    if (selected !== baseline && selected !== "erp") throw Error("DRILL_TARGET_INVALID");
    return sql(query, selected);
  };
  const baselineProbe = "SELECT DATABASE(),value FROM drill_marker";
  const expected = `${baseline}\t${marker}`;
  await select(baseline);
  if (await querySelected(baselineProbe) !== expected) throw Error("DRILL_BASELINE_INVALID");
  await select("erp");
  try {
    if (await querySelected("SELECT DATABASE()") !== "erp") throw Error("DRILL_CANDIDATE_TARGET_INVALID");
    throw Error("INJECTED_HEALTH_FAILURE");
  } catch (error) {
    await select(baseline);
    if (await querySelected(baselineProbe) !== expected) throw Error("DRILL_ROLLBACK_FAILED");
    if (error.message !== "INJECTED_HEALTH_FAILURE") throw error;
  }
  return { status: "VERIFIED", trigger: "INJECTED_HEALTH_FAILURE" };
}

export async function main(args = process.argv.slice(2)) {
  const value = flag => args[args.indexOf(flag) + 1];
  const encrypted = args.includes("--encrypted");
  const exercise = args.includes("--screen-exercise");
  if (encrypted === args.includes("--sql") || !args.includes("--evidence") || !args.includes("--context"))
    throw new Error("REQUIRE_ONE_SOURCE_EVIDENCE_AND_CONTEXT");
  if (exercise && (!encrypted || args.includes("--prepare-mysql") || args.includes("--bootstrap-admin")))
    throw new Error("SCREEN_EXERCISE_INPUT_INVALID");
  const source = resolve(value(encrypted ? "--encrypted" : "--sql"));
  if (!source.endsWith(encrypted ? ".sql.gpg" : ".sql") || !(await stat(source)).isFile()) throw new Error("LOCAL_BACKUP_REQUIRED");
  const requestedDir = resolve(value("--evidence"));
  await mkdir(requestedDir, { mode: 0o700 }); // Must be new; never overwrite prior evidence.
  const dir = await realpath(requestedDir);
  // Parse only the explicitly supplied escrow file. Never load its database/host settings.
  const keys = args.includes("--secrets-file")
    ? (await import("dotenv")).parse(await readFile(resolve(value("--secrets-file"))))
    : exercise ? {
        BACKUP_GPG_PASSPHRASE: process.env.BACKUP_GPG_PASSPHRASE,
        INTEGRATIONS_ENCRYPTION_KEY: process.env.INTEGRATIONS_ENCRYPTION_KEY,
      } : {};
  const integrationKey = keys.INTEGRATIONS_ENCRYPTION_KEY;
  let sqlFile = source;
  const context = value("--context");
  const token = randomUUID();
  const name = `erp-recovery-${token}`;
  const password = randomBytes(32).toString("hex");
  const dockerEnv = { ...process.env, MYSQL_ROOT_PASSWORD: password, MYSQL_PWD: password };
  for (const key of ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
    "BACKUP_GPG_PASSPHRASE", "INTEGRATIONS_ENCRYPTION_KEY"]) delete dockerEnv[key];
  let endpoint;
  const docker = (a, input) => {
    const flags = a[0] === "context" ? [] : ["--host", endpoint];
    const r = spawnSync("docker", [...flags, ...a], {
      env: dockerEnv, input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000,
    });
    if (r.status !== 0) throw new Error(`DOCKER_${a[0].toUpperCase()}_FAILED`);
    return r.stdout.trim(); // Errors and SQL values are never sent to logs.
  };
  const inspect = () => JSON.parse(docker(["inspect", name]))[0];
  const guard = () => {
    const sandbox = inspect();
    assertIsolation(sandbox, name, token);
    return sandbox;
  };
  const sql = (q, database = "erp") => {
    guard();
    return docker(["exec", "-i", "-e", "MYSQL_PWD", name, "mysql", "-uroot", "--batch", "--skip-column-names", "--raw", "--binary-mode=1", "--local-infile=0", database], q);
  };
  const report = { version: 1, source, startedAt: new Date().toISOString(), container: name,
    status: "NOT_RESTORE_VERIFIED", productionContact: false, deletions: false,
    encryptedBackup: encrypted ? "GPG_NOT_TESTED" : "NOT_TESTED_SQL_INPUT", applicationRecovery: "NOT_TESTED",
    escrow: "NOT_VERIFIED", media: { status: "NOT_FULLY_VERIFIED", columns: [] } };
  if (exercise) report.screenExercise = true;
  let created = false;
  try {
    report.sourceBefore = await fingerprint(source);
    if (report.sourceBefore.size < 512) throw new Error("SOURCE_TOO_SMALL");
    if (encrypted || args.includes("--bootstrap-admin")) {
      await assertPrivateRecoveryDirectory(dir, { restrictNewWindowsDirectory: exercise });
    }
    let publication;
    if (encrypted) {
      publication = await readEncryptedPublication(source, report.sourceBefore);
      if (exercise && !publication) throw new Error("BACKUP_MANIFEST_INVALID");
      if (!exercise && !args.includes("--gpg")) throw new Error("EXPLICIT_GPG_REQUIRED");
      if (!keys.BACKUP_GPG_PASSPHRASE) throw new Error("BACKUP_KEY_REQUIRED");
      sqlFile = join(dir, "restored-source.sql");
      const gpgOptions = args.includes("--gpg") ? { gpg: value("--gpg"), msys: args.includes("--gpg-msys") } : undefined;
      await prepareEncryptedRestore({
        archive: source, sqlFile, requireManifest: exercise, passphrase: keys.BACKUP_GPG_PASSPHRASE, gpgOptions,
      });
      report.encryptedBackup = "GPG_AUTHENTICATED_DECRYPTION_PASSED";
      report.escrow = exercise && !args.includes("--secrets-file") ? "LOCAL_BACKUP_KEY_VERIFIED" : "LOCAL_FILE_BACKUP_KEY_VERIFIED";
    }
    report.sqlFingerprint = await fingerprint(sqlFile);
    if (publication && !sameFingerprint(report.sqlFingerprint, publication.source)) throw new Error("DECRYPTED_SQL_FINGERPRINT_MISMATCH");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context)) throw Error("LOCAL_DOCKER_REQUIRED");
    endpoint = docker(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]);
    assertLocalEndpoint(endpoint);
    if (docker(["info", "--format", "{{.OSType}}"]) !== "linux") throw Error("LOCAL_LINUX_DOCKER_REQUIRED");
    // Pin an already installed image ID; never pull or reuse an existing container.
    const image = docker(["image", "inspect", "mysql:8.0.46", "--format", "{{.Id}}"]);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error("DOCKER_IMAGE_ID_INVALID");
    report.image = image;
    docker(["create", "--name", name, "--label", `alroya.recovery.token=${token}`,
      "--network", "none", "--restart", "no", "--cpus", "1", "--memory", "1g",
      "-e", "MYSQL_ROOT_PASSWORD", "-e", "MYSQL_DATABASE=erp", image,
      "--event-scheduler=OFF", "--skip-log-bin", "--local-infile=0"]);
    created = true;
    guard();
    docker(["start", name]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if (sql("SELECT 1") === "1") { ready = true; break; } } catch { /* fresh initialization */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!ready) throw new Error("MYSQL_NOT_READY");
    guard();
    const started = Date.now();
    await new Promise((ok, fail) => {
      const child = spawn("docker", ["--host", endpoint, "exec", "-i", "-e", "MYSQL_PWD", name,
        "mysql", "-uroot", "--binary-mode=1", "--local-infile=0", "erp"],
      { env: dockerEnv, stdio: ["pipe", "ignore", "ignore"] });
      const stream = createReadStream(sqlFile);
      const timer = setTimeout(() => { child.kill(); fail(new Error("IMPORT_TIMEOUT")); }, 15 * 60 * 1000);
      child.on("error", () => { clearTimeout(timer); stream.destroy(); fail(new Error("IMPORT_START_FAILED")); });
      child.stdin.on("error", () => {}); // A nonzero close is the import failure authority.
      stream.on("error", () => { child.kill(); fail(new Error("SOURCE_READ_FAILED")); });
      child.on("close", code => { clearTimeout(timer); stream.destroy(); code === 0 ? ok() : fail(new Error("IMPORT_FAILED")); });
      stream.pipe(child.stdin);
    });
    report.importSeconds = (Date.now() - started) / 1000;
    if (sql("SELECT @@event_scheduler,@@local_infile") !== "OFF\t0") throw new Error("MYSQL_SAFETY_CHANGED");
    const tables = sql("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='erp' AND TABLE_TYPE='BASE TABLE'").split("\n");
    report.tableCount = tables.length;
    report.rowCounts = {};
    for (const table of ["users", "branches", "invoices", "products", "__drizzle_migrations"]) {
      if (!tables.includes(table)) throw new Error("CORE_TABLE_MISSING");
      report.rowCounts[table] = Number(sql(`SELECT COUNT(*) FROM \`${table}\``));
    }
    report.migrations = sql("SELECT COUNT(*),MAX(created_at) FROM __drizzle_migrations");
    if (args.includes("--prepare-mysql")) report.mysqlPreparation = prepareRecoveryMysql(sql, guard);
    if (args.includes("--bootstrap-admin")) {
      if (!args.includes("--prepare-mysql")) throw new Error("MYSQL_PREPARATION_REQUIRED");
      report.recoveryAdmin = await bootstrapRecoveryAdmin(sql, guard, credential =>
        writeFile(join(dir, "recovery-admin.private.json"), JSON.stringify(credential), { flag: "wx", mode: 0o600 }));
    }
    const columns = sql("SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='erp' AND DATA_TYPE IN ('varchar','text','mediumtext','longtext')").split("\n").map(x => x.split("\t"));
    const identifier = s => { if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error("INVALID_SCHEMA_IDENTIFIER"); return `\`${s}\``; };
    report.secrets = { keyAvailable: !!integrationKey, encryptedRows: 0, verified: 0, failed: 0 };
    for (const [table, column] of columns) {
      if (/encrypted|ciphertext/i.test(column)) {
        const values = sql(`SELECT ${identifier(column)} FROM ${identifier(table)} WHERE ${identifier(column)} IS NOT NULL AND ${identifier(column)}<>''`).split("\n").filter(Boolean);
        report.secrets.encryptedRows += values.length;
        if (report.secrets.keyAvailable) for (const v of values) {
          try { verifySecret(v, integrationKey); report.secrets.verified++; }
          catch { report.secrets.failed++; }
        }
      }
      if (/^(objectKey|originalKey|url|originalUrl|processedUrl|thumbnailUrl|thumbDataUrl|imageUrl|attachmentUrl|fileUrl)$/i.test(column)) {
        const c = identifier(column);
        const counts = sql(`SELECT COUNT(*),COALESCE(SUM(${c} LIKE 'data:%'),0),COALESCE(SUM(${c} LIKE 'http%'),0) FROM ${identifier(table)} WHERE ${c} IS NOT NULL AND ${c}<>''`);
        report.media.columns.push({ table, column, counts: counts.split("\t").map(Number) });
      }
    }
    report.attachmentCheck = await verifyRecoveryAttachments(sql, columns, args.includes("--attachment-mirror") ? value("--attachment-mirror") : undefined);
    if (exercise) report.rollback = await exerciseTargetRollback(sql, dir);
    report.sourceAfter = await fingerprint(source);
    if (report.sourceAfter.sha256 !== report.sourceBefore.sha256 || report.sourceAfter.size !== report.sourceBefore.size)
      throw new Error("SOURCE_CHANGED_DURING_DRILL");
    if (report.secrets.failed) throw new Error("INTEGRATION_KEY_MISMATCH");
    report.status = "SQL_RESTORED_CORE_READS_PASSED";
  } catch (error) {
    report.failure = /^[A-Z0-9_]+$/.test(error.message) ? error.message : "LOCAL_DRILL_FAILED";
    throw error;
  } finally {
    // Operator drills retain the stopped candidate; screen exercises discard their own candidate.
    if (created) {
      try {
        if (guard().State.Running) docker(["stop", "--time", "30", name]);
        const stopped = guard();
        report.stopped = stopped.State.Running === false;
        if (exercise && report.stopped && /^[a-f0-9]{64}$/.test(stopped.Id)) {
          docker(["rm", "--volumes", stopped.Id]);
          report.candidateRemoved = true;
        }
      }
      catch { report.stopped = false; report.stopFailure = "MANUAL_REVIEW_REQUIRED"; }
    }
    if (exercise && sqlFile !== source) {
      await unlink(sqlFile).catch(error => { if (error.code !== "ENOENT") report.cleanupFailure = true; });
    }
    if (exercise && ((created && !report.candidateRemoved) || report.cleanupFailure)) {
      report.status = "NOT_RESTORE_VERIFIED";
      report.failure = "SANDBOX_CLEANUP_FAILED";
    }
    if (report.sourceBefore && !report.sourceAfter) report.sourceAfter = await fingerprint(source).catch(() => undefined);
    report.finishedAt = new Date().toISOString();
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // New sandbox credential only, never a production secret. Kept out of the public report.
    if (created && !exercise) await writeFile(join(dir, "sandbox-credential.txt"), password, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ report: join(dir, "report.json"), status: report.status, stopped: report.stopped }));
    if (created && !report.stopped) throw new Error("SANDBOX_STOP_FAILED");
    if (report.failure === "SANDBOX_CLEANUP_FAILED") throw new Error(report.failure);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("Isolated drill failed; inspect the redacted report."); process.exitCode = 1; });

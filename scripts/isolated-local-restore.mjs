// Offline recovery evidence only. No existing database/container is selected or removed.
import { createReadStream } from "node:fs";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, createDecipheriv } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fingerprint } from "./lib/backup-publication.mjs";

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

export async function main(args = process.argv.slice(2)) {
  const value = flag => args[args.indexOf(flag) + 1];
  const encrypted = args.includes("--encrypted");
  if (encrypted === args.includes("--sql") || !args.includes("--evidence") || !args.includes("--context"))
    throw new Error("REQUIRE_ONE_SOURCE_EVIDENCE_AND_CONTEXT");
  const source = resolve(value(encrypted ? "--encrypted" : "--sql"));
  if (!source.endsWith(encrypted ? ".sql.gpg" : ".sql") || !(await stat(source)).isFile()) throw new Error("LOCAL_BACKUP_REQUIRED");
  const dir = resolve(value("--evidence"));
  await mkdir(dir); // Must be new; never overwrite prior evidence.
  // Parse only the explicitly supplied escrow file. Never load its database/host settings.
  const keys = args.includes("--secrets-file")
    ? (await import("dotenv")).parse(await readFile(resolve(value("--secrets-file")))) : {};
  const integrationKey = keys.INTEGRATIONS_ENCRYPTION_KEY;
  let sqlFile = source;
  const context = value("--context");
  const token = randomUUID();
  const name = `erp-recovery-${token}`;
  const password = randomBytes(32).toString("hex");
  const dockerEnv = { ...process.env, MYSQL_ROOT_PASSWORD: password, MYSQL_PWD: password };
  const docker = (a, input) => {
    const r = spawnSync("docker", ["--context", context, ...a], {
      env: dockerEnv, input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000,
    });
    if (r.status !== 0) throw new Error(`DOCKER_${a[0].toUpperCase()}_FAILED`);
    return r.stdout.trim(); // Errors and SQL values are never sent to logs.
  };
  const inspect = () => JSON.parse(docker(["inspect", name]))[0];
  const guard = () => assertIsolation(inspect(), name, token);
  const sql = q => {
    guard();
    return docker(["exec", "-i", "-e", "MYSQL_PWD", name, "mysql", "-uroot", "--batch", "--skip-column-names", "--raw", "--binary-mode=1", "--local-infile=0", "erp"], q);
  };
  const report = { version: 1, source, startedAt: new Date().toISOString(), container: name,
    status: "NOT_RESTORE_VERIFIED", productionContact: false, deletions: false,
    encryptedBackup: "NOT_TESTED_SQL_INPUT", applicationRecovery: "NOT_TESTED",
    escrow: "NOT_VERIFIED", media: { status: "NOT_FULLY_VERIFIED", columns: [] } };
  let created = false;
  try {
    assertLocalEndpoint(docker(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]));
    report.sourceBefore = await fingerprint(source);
    if (report.sourceBefore.size < 512) throw new Error("SOURCE_TOO_SMALL");
    if (encrypted) {
      if (!keys.BACKUP_GPG_PASSPHRASE || !args.includes("--gpg")) throw new Error("EXPLICIT_GPG_AND_KEY_REQUIRED");
      const home = join(dir, "gpg-home");
      await mkdir(home, { mode: 0o700 });
      sqlFile = join(dir, "restored-source.sql");
      const gp = p => args.includes("--gpg-msys")
        ? p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replaceAll("\\", "/") : p;
      const result = spawnSync(value("--gpg"), ["--homedir", home, "--batch", "--no-symkey-cache", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--output", sqlFile, "--decrypt", source].map(gp),
        { input: keys.BACKUP_GPG_PASSPHRASE, timeout: 120000, maxBuffer: 1024 * 1024 });
      if (result.status !== 0) throw new Error("BACKUP_KEY_OR_CIPHERTEXT_FAILED");
      report.encryptedBackup = "GPG_AUTHENTICATED_DECRYPTION_PASSED";
      report.escrow = "LOCAL_FILE_BACKUP_KEY_VERIFIED";
    }
    report.sqlFingerprint = await fingerprint(sqlFile);
    // Pin an already installed image ID; never pull or reuse an existing container.
    const image = docker(["image", "inspect", "mysql:8.0.46", "--format", "{{.Id}}"]);
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
      const child = spawn("docker", ["--context", context, "exec", "-i", "-e", "MYSQL_PWD", name,
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
    report.sourceAfter = await fingerprint(source);
    if (report.sourceAfter.sha256 !== report.sourceBefore.sha256 || report.sourceAfter.size !== report.sourceBefore.size)
      throw new Error("SOURCE_CHANGED_DURING_DRILL");
    if (report.secrets.failed) throw new Error("INTEGRATION_KEY_MISMATCH");
    report.status = "SQL_RESTORED_CORE_READS_PASSED";
  } catch (error) {
    report.failure = /^[A-Z0-9_]+$/.test(error.message) ? error.message : "LOCAL_DRILL_FAILED";
    throw error;
  } finally {
    // Retain the container and its volume, but release compute even after failure.
    if (created) {
      try { guard(); docker(["stop", "--time", "30", name]); report.stopped = !inspect().State.Running; }
      catch { report.stopped = false; report.stopFailure = "MANUAL_REVIEW_REQUIRED"; }
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // New sandbox credential only, never a production secret. Kept out of the public report.
    if (created) await writeFile(join(dir, "sandbox-credential.txt"), password, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ report: join(dir, "report.json"), status: report.status, stopped: report.stopped }));
    if (created && !report.stopped) throw new Error("SANDBOX_STOP_FAILED");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("Isolated drill failed; inspect the redacted report."); process.exitCode = 1; });

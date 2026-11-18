import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";
import {
  activeInventoryManifest,
  assertBootInterlock,
  assertInventoryReadinessLifecycle,
  redactDiagnosticText,
} from "./inventory-activation-journal.mjs";
import { parseDbTarget } from "./db-target.mjs";
import {
  acquireInventoryGate,
  assertNoUnownedSessions,
  CAPABILITY,
  JOURNAL_NAME,
  readActivationJournal,
  runInventoryActivation,
  writeActivationJournal,
} from "./inventory-activation-fence.mjs";
import { assertForwardSchemaRecovery } from "./fractional-inventory-schema.mjs";

export const hashFile = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function withInventoryConnectionDeadline(connection, timeoutMs = 15000) {
  const bounded = new Set([
    "query",
    "beginTransaction",
    "commit",
    "rollback",
    "end",
  ]);
  return new Proxy(connection, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (!bounded.has(key)) return value.bind(target);
      return (...args) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            try {
              target.destroy();
            } catch {}
            reject(new Error("INVENTORY_DATABASE_OPERATION_TIMEOUT"));
          }, timeoutMs);
          Promise.resolve()
            .then(() => value.apply(target, args))
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        });
    },
  });
}
const inside = (root, file) => {
  const p = path.relative(root, file);
  return (
    p !== "" &&
    !p.startsWith(`..${path.sep}`) &&
    p !== ".." &&
    !path.isAbsolute(p)
  );
};
export function readProcessIdentity(pid, procRoot = "/proc") {
  try {
    const stat = fs.readFileSync(
      path.join(procRoot, String(pid), "stat"),
      "utf8",
    );
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const status = fs.readFileSync(
      path.join(procRoot, String(pid), "status"),
      "utf8",
    );
    const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
    return {
      pid: Number(pid),
      parent: Number(fields[1]),
      startTime: fields[19],
      uid,
      state: fields[0],
    };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ESRCH") return null;
    throw e;
  }
}
const same = (a, b) =>
  !!a &&
  !!b &&
  a.pid === b.pid &&
  a.startTime === b.startTime &&
  a.uid === b.uid;
export function processInventory(procRoot = "/proc") {
  const pids = fs.readdirSync(procRoot).filter((x) => /^\d+$/.test(x));
  if (pids.length > 4096) throw new Error("INVENTORY_PROCESS_CENSUS_LIMIT");
  return pids.map((x) => readProcessIdentity(x, procRoot)).filter(Boolean);
}

export function readProcCmdline(pid, procRoot = "/proc", maxLength = 240) {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8");
    const formatted = raw.replace(/\0+/g, " ").trim();
    const redacted = redactDiagnosticText(formatted);
    return redacted.length > maxLength
      ? `${redacted.slice(0, maxLength)}...[truncated]`
      : redacted;
  } catch {
    return null;
  }
}

function fingerprintProcess(
  p,
  procRoot = "/proc",
  currentIdentity = (pid) => readProcessIdentity(pid, procRoot),
) {
  const dir = path.join(procRoot, String(p.pid));
  try {
    const result = {
      ...p,
      cwd: fs.realpathSync(path.join(dir, "cwd")),
      exe: fs.realpathSync(path.join(dir, "exe")),
      command: hashFile(path.join(dir, "cmdline")),
    };
    if (!same(p, currentIdentity(p.pid)))
      throw new Error("INVENTORY_PROCESS_IDENTITY_CHANGED");
    return result;
  } catch (e) {
    if (["ENOENT", "ESRCH"].includes(e.code) && !currentIdentity(p.pid))
      return null;
    throw e;
  }
}

function expandDescendants(identities, inventory, uid) {
  const key = (p) => `${p.pid}:${p.startTime}:${p.uid}`;
  const tracked = new Set(identities.map(key));
  const children = new Map();
  for (const p of inventory) {
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(p);
  }
  const queue = inventory.filter((p) => tracked.has(key(p)));
  for (let n = 0; n < queue.length; n++) {
    for (const child of children.get(queue[n].pid) ?? []) {
      if (tracked.has(key(child))) continue;
      if (child.uid !== uid) throw new Error("INVENTORY_CHILD_UID_CHANGED");
      if (identities.length >= 4096)
        throw new Error("INVENTORY_PROCESS_CENSUS_LIMIT");
      tracked.add(key(child));
      identities.push(child);
      queue.push(child);
    }
  }
}

export function buildAllowedUidProcesses({
  pm2Home,
  procRoot = "/proc",
  uid,
  inventory,
  initialRows,
  excludedRows = [],
  excludedIdentities = [],
  currentIdentity = (pid) => readProcessIdentity(pid, procRoot),
}) {
  const ancestors = new Set([process.pid]);
  for (
    let p = currentIdentity(process.pid);
    p && p.parent > 1;
    p = currentIdentity(p.parent)
  )
    ancestors.add(p.parent);
  const daemonPid = Number(
    fs.readFileSync(path.join(pm2Home, "pm2.pid"), "utf8").trim(),
  );
  const daemon = inventory.find((p) => p.pid === daemonPid);
  const daemonTitle = fs.readFileSync(
    path.join(procRoot, String(daemonPid), "cmdline"),
    "utf8",
  );
  if (
    !daemon ||
    daemon.uid !== uid ||
    !daemonTitle.includes(`God Daemon (${pm2Home})`)
  )
    throw new Error("INVENTORY_PM2_DAEMON_OWNERSHIP_UNPROVEN");
  ancestors.add(daemonPid);
  const permitted = [];
  for (const row of initialRows.filter((r) => !excludedRows.includes(r))) {
    const identity = inventory.find((p) => p.pid === Number(row.pid));
    if (identity?.uid === uid) permitted.push(identity);
  }
  expandDescendants(permitted, inventory, uid);
  // The ownership census covers this service UID; sudo/SSH ancestors of
  // another UID are not exemptions and may deny access to cwd/exe.
  permitted.push(...inventory.filter((p) => p.uid === uid && ancestors.has(p.pid)));
  // Descendant expansion above must never make ERP children exempt via the
  // PM2 daemon/control ancestry: remove every already-owned ERP identity.
  return permitted
    .filter((p) => !excludedIdentities.some((i) => same(i, p)))
    .map((p) => fingerprintProcess(p, procRoot, currentIdentity))
    .filter(Boolean);
}

export function verifyUidProcessOwnership({
  inventory,
  uid,
  erpIdentities = [],
  allowedProcesses = [],
  allowErp = false,
  procRoot = "/proc",
  currentIdentity = (pid) => readProcessIdentity(pid, procRoot),
}) {
  const offendingProcesses = [];
  for (const p of inventory.filter((entry) => entry.uid === uid)) {
    if (erpIdentities.some((i) => same(i, p))) {
      if (!allowErp) throw new Error("INVENTORY_ERP_PROCESS_REMAINS");
      continue;
    }
    const trusted = allowedProcesses.find((i) => same(i, p));
    const current = fingerprintProcess(p, procRoot, currentIdentity);
    if (!current) continue;
    if (
      !trusted ||
      current.command !== trusted.command ||
      current.cwd !== trusted.cwd ||
      current.exe !== trusted.exe
    ) {
      offendingProcesses.push({
        pid: current.pid,
        uid: current.uid,
        ppid: current.parent,
        exe: current.exe,
        cwd: current.cwd,
        cmdline: readProcCmdline(current.pid, procRoot),
        reason: !trusted
          ? "untrusted_pid"
          : current.command !== trusted.command
            ? "cmdline_changed"
            : current.cwd !== trusted.cwd
              ? "cwd_changed"
              : "exe_changed",
      });
    }
  }
  if (offendingProcesses.length) {
    console.error(
      `[INVENTORY_UNCLASSIFIED_PROCESS] ${JSON.stringify({ offendingProcesses })}`,
    );
    throw Object.assign(new Error("INVENTORY_UNCLASSIFIED_PROCESS"), {
      code: "INVENTORY_UNCLASSIFIED_PROCESS",
      offendingProcesses,
    });
  }
  return inventory;
}

function preservePreActivationDump(pm2Home, dump) {
  let dumpStat;
  try {
    dumpStat = fs.lstatSync(dump);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!dumpStat.isFile() || dumpStat.isSymbolicLink() || dumpStat.size > 16 * 1024 * 1024) {
    return;
  }
  const raw = fs.readFileSync(dump, "utf8");
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    !Array.isArray(rows) ||
    !rows.some((r) => ["erp-server", "erp-hr-bridge"].includes(r?.name))
  ) {
    return;
  }
  const preActivation = `${dump}.pre-activation`;
  try {
    if (fs.lstatSync(preActivation).isSymbolicLink()) {
      throw new Error("INVENTORY_PM2_PRE_ACTIVATION_DUMP_UNTRUSTED");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${preActivation}.tmp-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, raw, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, preActivation);
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {}
  }
  if (process.platform === "linux") {
    const dirFd = fs.openSync(pm2Home, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}

export function savePm2Dump(
  pm2Home,
  execute,
  { preservePreActivation = false } = {},
) {
  const dump = path.join(pm2Home, "dump.pm2");
  if (preservePreActivation) {
    preservePreActivationDump(pm2Home, dump);
  }
  execute("pm2", ["save", "--force"]);
  const fd = fs.openSync(dump, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // PM2's automatic .bak fallback must never resurrect the former ERP graph.
  fs.copyFileSync(dump, `${dump}.bak`);
  const b = fs.openSync(`${dump}.bak`, "r+");
  try {
    fs.fsyncSync(b);
  } finally {
    fs.closeSync(b);
  }
  if (process.platform === "linux") {
    const d = fs.openSync(pm2Home, "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  }
}
export function classifyErpProcesses(rows, projectRoot, processes, uid) {
  if (!Array.isArray(rows)) throw new Error("INVENTORY_PM2_LIST_INVALID");
  const erp = [],
    names = new Set(["erp-server", "erp-hr-bridge", "erp-provision-worker"]);
  for (const row of rows) {
    const env = row.pm2_env ?? row,
      name = row.name ?? env.name;
    const cwd = env.pm_cwd;
    const script = env.pm_exec_path;
    const ownsRoot =
      typeof cwd === "string" && path.resolve(cwd) === projectRoot;
    if (names.has(name)) {
      if (
        !ownsRoot ||
        !Number.isSafeInteger(row.pm_id ?? env.pm_id) ||
        !script ||
        !inside(projectRoot, path.resolve(script))
      )
        throw new Error("INVENTORY_PM2_OWNERSHIP_AMBIGUOUS");
      const identity =
        Number(row.pid) > 0
          ? processes.find((p) => p.pid === Number(row.pid))
          : null;
      if (
        Number(row.pid) > 0 &&
        (!identity || identity.uid !== uid || identity.state === "Z")
      )
        throw new Error("INVENTORY_PROCESS_IDENTITY_AMBIGUOUS");
      erp.push({ row, name, identity });
    } else if (
      ownsRoot ||
      (script && inside(projectRoot, path.resolve(script)))
    )
      throw new Error("INVENTORY_UNKNOWN_ERP_PROCESS");
  }
  if (!erp.some((x) => x.name === "erp-server" && x.identity))
    throw new Error("INVENTORY_OLD_WEB_WORKERS_MISSING");
  return erp;
}
export function assertWorkerAttestations(
  expected,
  identities,
  replies,
  journal,
) {
  if (
    identities.length !== expected.reduce((n, a) => n + a.instances, 0) ||
    replies.length !== identities.length ||
    new Set(replies.map((r) => r.pid)).size !== identities.length
  )
    throw new Error("INVENTORY_WORKER_SET_MISMATCH");
  for (const artifact of expected) {
    const workers = replies.filter((r) => r.name === artifact.name);
    if (workers.length !== artifact.instances)
      throw new Error("INVENTORY_WORKER_COUNT_MISMATCH");
    for (const r of workers) {
      const identity = identities.find((p) => p.pid === r.pid);
      if (
        !identity ||
        identity.startTime !== r.startTime ||
        r.bundle !== artifact.bundle ||
        r.hash !== artifact.hash ||
        r.capability !== CAPABILITY ||
        r.activationId !== journal.id ||
        r.database !== journal.database ||
        r.serverUuid !== journal.serverUuid ||
        r.held !== true
      )
        throw new Error("INVENTORY_WORKER_ATTESTATION_MISMATCH");
    }
  }
}
export async function queryWorkerAttestation(socketPath, nonce) {
  const challenge = randomBytes(32).toString("hex");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = "";
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("INVENTORY_ATTEST_TIMEOUT")),
    );
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ nonce, challenge })}\n`),
    );
    socket.on("data", (bytes) => {
      input += bytes.toString();
      if (input.length > 8192)
        socket.destroy(new Error("INVENTORY_ATTEST_OVERSIZED"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const r = JSON.parse(input);
        if (r.challenge !== challenge)
          throw new Error("INVENTORY_ATTEST_CHALLENGE_MISMATCH");
        resolve(r);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function createLinuxActivationOperations({
  projectRoot,
  pm2Home,
  journal,
  connectionA,
  connectionB,
  candidateWebApp,
  bridgeConfigPath,
  installCandidate,
  restoreArtifact,
  execute = (file, args) =>
    execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    }),
  procRoot = "/proc",
  uid = process.getuid?.(),
  platform = process.platform,
  externalWritersExcluded = false,
  installedHelperPath = "/usr/local/libexec/erp/pm2-systemd-start.mjs",
  requestAttestation = queryWorkerAttestation,
  drainTimeoutMs = 45000,
  preflightDbRetryMs = 8000,
  preflightDbRetryIntervalMs = 500,
  initialReadyVersion = undefined,
  prepareSchema,
  forwardRecoveryJournal = null,
}) {
  const file = path.join(pm2Home, JOURNAL_NAME);
  const rows = () => JSON.parse(execute("pm2", ["jlist"]));
  let old = [],
    oldIdentities = [],
    candidateIdentities = [],
    oldApps = [],
    gate,
    allowedProcesses = [];
  const currentIdentity = (pid) => readProcessIdentity(pid, procRoot);
  const configFile = path.join(
    projectRoot,
    ".runtime",
    `inventory-web-${journal.id}.json`,
  );
  const oldConfig = path.join(
    projectRoot,
    ".runtime",
    `inventory-prior-${journal.id}.json`,
  );
  const writePrivate = (target, value) => {
    const fd = fs.openSync(target, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  function saveDump(options = {}) {
    savePm2Dump(pm2Home, execute, options);
  }
  // Bound the census; unknown same-service-UID processes are never assumed safe.
  // Only verified control ancestors/daemon and existing unrelated PM2 trees are
  // exempt. Their kernel identity and execution fingerprint must remain stable.
  const census = () => processInventory(procRoot);
  function refreshOwnership({ allowErp = false } = {}) {
    const inventory = census();
    expandDescendants(oldIdentities, inventory, uid);
    expandDescendants(candidateIdentities, inventory, uid);
    return verifyUidProcessOwnership({
      inventory,
      uid,
      erpIdentities: [...oldIdentities, ...candidateIdentities],
      allowedProcesses,
      allowErp,
      procRoot,
      currentIdentity,
    });
  }
  async function removeErp(identities, { preservePreActivation = false } = {}) {
    // Capture children immediately before each parent deletion. A child born
    // during delete/reparenting is caught by the full-UID census afterwards.
    const list = rows().filter((r) =>
      ["erp-server", "erp-hr-bridge", "erp-provision-worker"].includes(r.name),
    );
    for (const r of list) {
      const current = currentIdentity(r.pid);
      if (
        path.resolve(r.pm2_env?.pm_cwd ?? "") !== projectRoot ||
        !inside(projectRoot, path.resolve(r.pm2_env?.pm_exec_path ?? "")) ||
        !Number.isSafeInteger(r.pm_id) ||
        (current && current.uid !== uid)
      )
        throw new Error("INVENTORY_STOP_OWNERSHIP_CHANGED");
      if (current && !identities.some((i) => same(i, current)))
        identities.push(current);
    }
    refreshOwnership({ allowErp: true });
    for (const r of list) {
      refreshOwnership({ allowErp: true });
      if (r.pid > 0 && !identities.some((i) => same(i, currentIdentity(r.pid))))
        throw new Error("INVENTORY_STOP_OWNERSHIP_CHANGED");
      execute("pm2", ["delete", String(r.pm_id)]);
    }
    saveDump({ preservePreActivation });
    const deadline = Date.now() + drainTimeoutMs;
    while (
      [...oldIdentities, ...candidateIdentities].some((i) =>
        same(i, currentIdentity(i.pid)),
      )
    ) {
      refreshOwnership({ allowErp: true });
      if (Date.now() >= deadline)
        throw new Error("INVENTORY_OLD_PROCESS_STILL_ALIVE");
      await wait(100);
    }
    refreshOwnership();
  }
  return {
    async preflight() {
      if (
        platform !== "linux" ||
        !Number.isInteger(uid) ||
        !externalWritersExcluded
      )
        throw new Error("INVENTORY_EXTERNAL_WRITER_EXCLUSION_REQUIRED");
      assertBootInterlock({ projectRoot, installedHelperPath, execute });
      const [grants] = await connectionA.query("SHOW GRANTS FOR CURRENT_USER");
      if (
        !grants.some((r) =>
          /GRANT (?:ALL PRIVILEGES|[^\n]*\bPROCESS\b[^\n]*) ON \*\.\*/.test(
            Object.values(r).join(" "),
          ),
        )
      )
        throw new Error("INVENTORY_SESSION_VISIBILITY_REQUIRED");
      const [[settings]] = await connectionA.query(
        "SELECT @@GLOBAL.event_scheduler AS scheduler",
      );
      if (String(settings.scheduler).toUpperCase() === "ON")
        throw new Error("INVENTORY_DATABASE_EVENT_WRITER_UNSUPPORTED");
      const [replicas] = await connectionA.query(
        "SELECT CHANNEL_NAME FROM performance_schema.replication_connection_status WHERE SERVICE_STATE='ON'",
      );
      if (replicas.length)
        throw new Error("INVENTORY_REPLICATION_WRITER_UNSUPPORTED");

      // PRE_STOP_DB_CHECK: verify no non-erp_app external/root/replication DB
      // sessions remain BEFORE acquireGate() or stopOld() disrupt live workers.
      const [[connARow]] = await connectionA.query("SELECT CONNECTION_ID() AS id");
      const [[connBRow]] = connectionB
        ? await connectionB.query("SELECT CONNECTION_ID() AS id")
        : [[null]];
      const controlIds = new Set(
        [Number(connARow?.id), Number(connBRow?.id)].filter(Number.isFinite),
      );
      const retryDeadline = Date.now() + Math.max(0, Number(preflightDbRetryMs));
      for (;;) {
        const [threadRows] = await connectionA.query(
          "SELECT PROCESSLIST_ID AS id, PROCESSLIST_USER AS user, PROCESSLIST_HOST AS host, PROCESSLIST_DB AS db, PROCESSLIST_COMMAND AS command, PROCESSLIST_TIME AS timeSec, PROCESSLIST_STATE AS state, LEFT(PROCESSLIST_INFO, 160) AS info, NAME AS name FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_ID IS NOT NULL AND NOT (NAME='thread/sql/compress_gtid_table' AND PROCESSLIST_USER IS NULL AND PROCESSLIST_COMMAND='Daemon')",
        );
        const hasSessionMetadata =
          threadRows.length > 0 &&
          threadRows.some(
            (r) =>
              "user" in r ||
              "PROCESSLIST_USER" in r ||
              "command" in r ||
              "PROCESSLIST_COMMAND" in r,
          );
        if (threadRows.length > 0 && !hasSessionMetadata) {
          break;
        }
        const normalizedThreads = threadRows.map((row) => ({
          id: Number(row.id ?? row.PROCESSLIST_ID),
          user:
            row.user !== undefined ? row.user : (row.PROCESSLIST_USER ?? null),
          host:
            row.host !== undefined ? row.host : (row.PROCESSLIST_HOST ?? null),
          db: row.db !== undefined ? row.db : (row.PROCESSLIST_DB ?? null),
          command:
            row.command !== undefined
              ? row.command
              : (row.PROCESSLIST_COMMAND ?? null),
          timeSec:
            (row.timeSec ?? row.PROCESSLIST_TIME) != null
              ? Number(row.timeSec ?? row.PROCESSLIST_TIME)
              : null,
          state:
            row.state !== undefined
              ? row.state
              : (row.PROCESSLIST_STATE ?? null),
          info: redactDiagnosticText(
            row.info !== undefined ? row.info : (row.PROCESSLIST_INFO ?? null),
          ),
          name: row.name !== undefined ? row.name : (row.NAME ?? null),
        }));
        const externalSessions = normalizedThreads.filter((session) => {
          if (controlIds.has(session.id)) return false;
          if (
            session.user === "erp_app" &&
            !["Binlog Dump", "Binlog Dump GTID"].includes(session.command)
          ) {
            return false;
          }
          return true;
        });
        if (threadRows.length > 0 && externalSessions.length === 0) {
          break;
        }
        if (Date.now() >= retryDeadline) {
          const payload = {
            journalId: journal.id,
            emptyThreadCensus: !threadRows.length,
            allowedSessionIds: [...controlIds],
            unownedSessionIds: externalSessions.map((s) => s.id),
            externalSessions,
            unownedSessionDetails: externalSessions,
          };
          console.error(
            `[INVENTORY_PREFLIGHT_EXTERNAL_DB_SESSION] ${JSON.stringify(payload)}`,
          );
          throw Object.assign(
            new Error("INVENTORY_PREFLIGHT_EXTERNAL_DB_SESSION"),
            {
              code: "INVENTORY_PREFLIGHT_EXTERNAL_DB_SESSION",
              ...payload,
            },
          );
        }
        await wait(
          Math.max(
            1,
            Math.min(
              Number(preflightDbRetryIntervalMs) || 500,
              retryDeadline - Date.now(),
            ),
          ),
        );
      }

      const inventory = census();
      const initialRows = rows();
      old = classifyErpProcesses(initialRows, projectRoot, inventory, uid);
      if (old.some((r) => r.name === "erp-provision-worker"))
        throw new Error("INVENTORY_PROVISIONING_CLASSIFICATION_REQUIRED");
      const previous = readActivationJournal(file);
      if (forwardRecoveryJournal) {
        if (previous?.id !== forwardRecoveryJournal.id) throw new Error("FRACTIONAL_FORWARD_RECOVERY_JOURNAL_CHANGED");
        assertForwardSchemaRecovery(previous, { database: journal.database, serverUuid: journal.serverUuid });
        // A crash may leave a subset of the failed candidate running. Only that
        // exact immutable candidate may be stopped; old artifacts cannot reappear.
        for (const item of old) {
          const artifact = [...previous.artifacts, ...(previous.recoveryArtifacts ?? [])].find((a) => a.name === item.name && path.resolve(item.row.pm2_env.pm_exec_path) === a.script);
          if (!artifact || hashFile(artifact.bundle) !== artifact.hash || hashFile(artifact.script) !== artifact.scriptHash) throw new Error("FRACTIONAL_FORWARD_RECOVERY_PROCESS_MISMATCH");
        }
      }
      const priorActive = activeInventoryManifest(previous);
      if (priorActive) {
        for (const item of old) {
          const artifact = priorActive.artifacts.find(
            (a) => a.name === item.name,
          );
          if (
            !artifact ||
            path.resolve(item.row.pm2_env.pm_exec_path) !== artifact.script ||
            hashFile(artifact.bundle) !== artifact.hash ||
            hashFile(artifact.script) !== artifact.scriptHash
          )
            throw new Error("INVENTORY_PRIOR_CAPABILITY_UNPROVEN");
        }
        if (
          priorActive.artifacts.some(
            (a) => old.filter((o) => o.name === a.name).length !== a.instances,
          )
        )
          throw new Error("INVENTORY_PRIOR_WORKER_SET_CHANGED");
      }
      oldIdentities = old.map((r) => r.identity).filter(Boolean);
      expandDescendants(oldIdentities, inventory, uid);
      allowedProcesses = buildAllowedUidProcesses({
        pm2Home,
        procRoot,
        uid,
        inventory,
        initialRows,
        excludedRows: old.map((o) => o.row),
        excludedIdentities: oldIdentities,
        currentIdentity,
      });
      refreshOwnership({ allowErp: true });
      oldApps = old.map(({ row, name }) => ({
        name,
        script: row.pm2_env.pm_exec_path,
        cwd: projectRoot,
        instances: 1,
        exec_mode:
          row.pm2_env.exec_mode === "cluster_mode" ? "cluster" : "fork",
        interpreter: row.pm2_env.exec_interpreter,
        node_args: row.pm2_env.node_args,
        args: row.pm2_env.args,
        autorestart: row.pm2_env.autorestart,
        cron_restart: row.pm2_env.cron_restart,
        wait_ready: row.pm2_env.wait_ready,
        listen_timeout: row.pm2_env.listen_timeout,
        kill_timeout: row.pm2_env.kill_timeout,
        filter_env: [""],
        env: row.pm2_env.env,
      }));
      // Cluster rows are represented once with their exact prior instance count.
      oldApps = oldApps
        .filter((a, i, all) => all.findIndex((b) => b.name === a.name) === i)
        .map((a) => ({
          ...a,
          instances: old.filter((o) => o.name === a.name).length,
        }));
      writePrivate(oldConfig, { apps: oldApps });
      writePrivate(configFile, { apps: [candidateWebApp] });
    },
    async acquireGate() {
      gate = await acquireInventoryGate(connectionA, journal);
      return gate;
    },
    async stopOld() {
      let replicationConnections = [];
      try {
        const [replicaRows] = await connectionA.query(
          "SELECT CHANNEL_NAME AS channelName, SERVICE_STATE AS serviceState FROM performance_schema.replication_connection_status",
        );
        replicationConnections = replicaRows;
      } catch (error) {
        replicationConnections = [
          { error: redactDiagnosticText(error?.message ?? String(error)) },
        ];
      }
      console.error(
        `[INVENTORY_PRE_STOP_SNAPSHOT] ${JSON.stringify({
          journalId: journal.id,
          commit: journal.commit,
          initialReadyVersion:
            initialReadyVersion ??
            journal.initialReadyVersion ??
            (journal.priorActive ? 1 : 0),
          hasSchemaTransition: Boolean(journal.schemaTransition),
          oldIdentities: oldIdentities.map((p) => ({
            pid: p.pid,
            uid: p.uid,
            parent: p.parent,
            startTime: p.startTime,
            state: p.state,
          })),
          replicationConnections,
        })}`,
      );
      await removeErp(oldIdentities, { preservePreActivation: true });
    },
    async assertQuiescent() {
      refreshOwnership();
      if (
        rows().some((r) =>
          ["erp-server", "erp-hr-bridge", "erp-provision-worker"].includes(
            r.name,
          ),
        )
      )
        throw new Error("INVENTORY_ERP_DEFINITION_REAPPEARED");
      if (
        oldIdentities.some((i) => same(i, currentIdentity(i.pid))) ||
        candidateIdentities.some((i) => same(i, currentIdentity(i.pid)))
      )
        throw new Error("INVENTORY_ERP_PROCESS_REMAINS");
      const [[b]] = await connectionB.query("SELECT CONNECTION_ID() AS id");
      await assertNoUnownedSessions(
        connectionA,
        new Set([gate.connectionId, Number(b.id)]),
      );
    },
    installCandidate,
    prepareSchema,
    async startCandidates() {
      execute("pm2", ["start", configFile, "--only", "erp-server"]);
      if (bridgeConfigPath)
        execute("pm2", ["start", bridgeConfigPath, "--only", "erp-hr-bridge"]);
    },
    async verifyCandidates(current) {
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          const actual = rows().filter((r) =>
            ["erp-server", "erp-hr-bridge", "erp-provision-worker"].includes(
              r.name,
            ),
          );
          if (actual.some((r) => r.name === "erp-provision-worker"))
            throw new Error("INVENTORY_PROVISION_REAPPEARED");
          // Keep live identities available for rollback without poisoning the
          // ownership census when PM2 reports a stopped/restarting candidate.
          candidateIdentities = actual
            .map((r) => currentIdentity(r.pid))
            .filter(Boolean);
          if (
            candidateIdentities.length !== actual.length ||
            candidateIdentities.some((i) => i.uid !== uid)
          )
            throw new Error("INVENTORY_CANDIDATE_PID_MISSING");
          for (const r of actual) {
            const artifact = journal.artifacts.find((a) => a.name === r.name);
            if (
              !artifact ||
              path.resolve(r.pm2_env.pm_exec_path) !== artifact.script ||
              path.resolve(r.pm2_env.pm_cwd) !== projectRoot
            )
              throw new Error("INVENTORY_CANDIDATE_SCRIPT_MISMATCH");
          }
          refreshOwnership({ allowErp: true });
          if (oldIdentities.some((i) => same(i, currentIdentity(i.pid))))
            throw new Error("INVENTORY_OLD_PROCESS_STILL_ALIVE");
          const replies = await Promise.all(
            candidateIdentities.map((i) =>
              requestAttestation(
                path.join(pm2Home, `ia-${i.pid}.sock`),
                current.nonce,
              ),
            ),
          );
          assertWorkerAttestations(
            journal.artifacts,
            candidateIdentities,
            replies,
            current,
          );
          if (candidateIdentities.some((i) => !same(i, currentIdentity(i.pid))))
            throw new Error("INVENTORY_CANDIDATE_REPLACED");
          return;
        } catch (e) {
          if (Date.now() >= deadline) throw e;
          await gate.assertLocked();
          await wait(200);
        }
      }
    },
    async saveCompatibleRestartDefinitions() {
      refreshOwnership({ allowErp: true });
      if (
        candidateIdentities.length !==
          journal.artifacts.reduce((n, a) => n + a.instances, 0) ||
        oldIdentities.some((i) => same(i, currentIdentity(i.pid)))
      )
        throw new Error("INVENTORY_CANDIDATE_CHILD_UNATTESTED");
      saveDump();
      const dump = JSON.parse(
        fs.readFileSync(path.join(pm2Home, "dump.pm2"), "utf8"),
      );
      for (const a of journal.artifacts) {
        const matches = dump.filter((r) => r.name === a.name);
        if (
          matches.length !== a.instances ||
          matches.some(
            (r) =>
              path.resolve(r.pm_exec_path) !== a.script ||
              path.resolve(r.pm_cwd) !== projectRoot,
          ) ||
          hashFile(a.bundle) !== a.hash ||
          hashFile(a.script) !== a.scriptHash
        )
          throw new Error("INVENTORY_RESTART_DEFINITION_MISMATCH");
      }
      if (dump.some((r) => r.name === "erp-provision-worker"))
        throw new Error("INVENTORY_PROVISION_DUMP_UNSAFE");
      if (candidateIdentities.some((i) => !same(i, currentIdentity(i.pid))))
        throw new Error("INVENTORY_CANDIDATE_REPLACED");
    },
    async stopCandidates() {
      candidateIdentities.push(
        ...rows()
          .filter((r) => ["erp-server", "erp-hr-bridge"].includes(r.name))
          .map((r) => currentIdentity(r.pid))
          .filter(Boolean),
      );
      await removeErp(candidateIdentities);
    },
    restoreArtifact,
    async restartOld() {
      const rolledBack = readActivationJournal(file);
      if (rolledBack?.phase !== "ROLLED_BACK")
        throw new Error("INVENTORY_ROLLBACK_NOT_COMMITTED");
      const approved =
        activeInventoryManifest(rolledBack)?.artifacts ??
        rolledBack.priorArtifacts;
      if (
        !Array.isArray(approved) ||
        approved.length !== oldApps.length ||
        oldApps.some(
          (app) =>
            !approved.some(
              (a) =>
                a.name === app.name &&
                a.script === app.script &&
                a.instances === app.instances &&
                hashFile(a.bundle) === a.hash &&
                hashFile(a.script) === a.scriptHash,
            ),
        )
      )
        throw new Error("INVENTORY_ROLLBACK_ARTIFACT_MISMATCH");
      execute("pm2", ["start", oldConfig]);
      saveDump();
    },
  };
}

export function forwardRecoveryProjectionBaseline(existing, state) {
  assertForwardSchemaRecovery(existing);
  if (Number(state?.readyVersion) === 0 && existing.initialReadyVersion === 0) return null;
  if (Number(state?.readyVersion) !== 1) throw new Error("FRACTIONAL_FORWARD_RECOVERY_PROJECTION_MISMATCH");
  let active = existing.priorActive;
  if (!active && existing.initialReadyVersion === 0 && state.activatedCommit === existing.commit) {
    active = { readyVersion: 1, activationId: existing.id, commit: existing.commit, projectionCommit: existing.commit, database: existing.database, serverUuid: existing.serverUuid, artifacts: existing.artifacts };
  }
  if (!active || active.projectionCommit !== state.activatedCommit) throw new Error("FRACTIONAL_FORWARD_RECOVERY_PROJECTION_MISMATCH");
  // Validate retained evidence without inventing a durable rollback transition.
  return activeInventoryManifest({ ...existing, id: active.activationId, phase: "RELEASED", commit: active.commit, artifacts: active.artifacts, active });
}

/**
 * Requires explicit external-writer attestation (`=1`) for initial activation or
 * schema cutovers. Routine code deploys with an already-active prior manifest
 * still enforce live MySQL `assertNoUnownedSessions`, `event_scheduler=OFF`,
 * `replication=OFF`, and UID process census without requiring manual `.env` edits,
 * unless explicitly disabled with `=0`.
 */
export function resolveExternalWritersExcluded(
  environment,
  { priorActive, schemaTransition } = {},
) {
  const flag = environment?.ERP_INVENTORY_EXTERNAL_WRITERS_EXCLUDED;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !schemaTransition && Boolean(priorActive);
}

export async function executeInventoryDeployment(options) {
  const {
    projectRoot,
    pm2Home,
    environment,
    artifacts,
    priorArtifacts,
    commit,
  } = options;
  const file = path.join(pm2Home, JOURNAL_NAME);
  const existing = readActivationJournal(file);
  const forwardRecovery = options.forwardRecoveryActivationId !== undefined;
  if (forwardRecovery) {
    assertForwardSchemaRecovery(existing);
    if (options.forwardRecoveryActivationId !== existing.id) throw new Error("FRACTIONAL_FORWARD_RECOVERY_JOURNAL_CHANGED");
    if (options.schemaTransition?.id !== existing.schemaTransition.id || options.schemaTransition.started !== true || options.schemaTransition.rollbackPolicy !== "FORWARD_ONLY" || typeof options.prepareSchema !== "function") throw new Error("FRACTIONAL_FORWARD_RECOVERY_PREPARATION_REQUIRED");
  } else if (existing && !["RELEASED", "ROLLED_BACK"].includes(existing.phase))
    throw new Error("INVENTORY_ACTIVATION_RECOVERY_REQUIRED");
  // Runtime multi-tenancy routes ordinary getDb through company context. It needs
  // an explicitly enumerated multi-database fence, never a guessed DATABASE_URL.
  if (environment.CONTROL_DATABASE_URL)
    throw new Error("INVENTORY_MULTI_DATABASE_CLASSIFICATION_REQUIRED");
  const url =
    environment.ERP_INVENTORY_CONTROL_DATABASE_URL || environment.DATABASE_URL;
  if (!url) throw new Error("INVENTORY_DATABASE_UNCONFIGURED");
  const runtime = parseDbTarget(environment.DATABASE_URL);
  const control = parseDbTarget(url);
  if (
    runtime.host !== control.host ||
    runtime.port !== control.port ||
    runtime.db !== control.db
  )
    throw new Error("INVENTORY_RUNTIME_DATABASE_TARGET_MISMATCH");
  const a = withInventoryConnectionDeadline(await mysql.createConnection(url));
  let b;
  try {
    b = withInventoryConnectionDeadline(await mysql.createConnection(url));
    const [[target]] = await a.query(
      "SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid",
    );
    if (
      !options.expectedServerUuid ||
      target.serverUuid !== options.expectedServerUuid
    )
      throw new Error("INVENTORY_BACKUP_TARGET_IDENTITY_CHANGED");
    if (target.databaseName !== runtime.db)
      throw new Error("INVENTORY_RUNTIME_DATABASE_TARGET_MISMATCH");
    if (forwardRecovery) assertForwardSchemaRecovery(existing, { database: target.databaseName, serverUuid: target.serverUuid });
    if (
      existing &&
      (existing.database !== target.databaseName ||
        existing.serverUuid !== target.serverUuid)
    )
      throw new Error("INVENTORY_TARGET_IDENTITY_CHANGED");
    const [[state]] = await b.query(
      "SELECT readyVersion,activatedCommit FROM inventoryProjectionState WHERE id=1",
    );
    if (options.schemaTransition && Number(state?.readyVersion) !== 1) throw new Error("FRACTIONAL_SCHEMA_CUTOVER_REQUIRES_READY_PROJECTION");
    const priorActive = forwardRecovery ? forwardRecoveryProjectionBaseline(existing, state) : assertInventoryReadinessLifecycle(existing, state);
    const recoveryArtifacts = forwardRecovery ? [...new Map([...existing.artifacts, ...(existing.recoveryArtifacts ?? [])].map((artifact) => [`${artifact.script}:${artifact.hash}`, artifact])).values()] : undefined;
    if (recoveryArtifacts?.length > 64) throw new Error("INVENTORY_RECOVERY_ARTIFACTS_LIMIT");
    const journal = {
      version: 1,
      id: randomUUID(),
      phase: "PREPARED",
      commit,
      database: target.databaseName,
      serverUuid: target.serverUuid,
      nonce: randomBytes(32).toString("hex"),
      artifacts,
      priorArtifacts: forwardRecovery && priorActive ? priorActive.artifacts : priorArtifacts,
      priorActive,
      bridgeBaseline: options.bridgeBaseline,
      schemaTransition: options.schemaTransition,
      resumedFrom: forwardRecovery ? existing.id : undefined,
      recoveryArtifacts,
    };
    const operations = createLinuxActivationOperations({
      ...options,
      journal,
      connectionA: a,
      connectionB: b,
      initialReadyVersion: Number(state.readyVersion),
      externalWritersExcluded: resolveExternalWritersExcluded(environment, {
        priorActive,
        schemaTransition: options.schemaTransition,
      }),
      forwardRecoveryJournal: forwardRecovery ? existing : null,
    });
    return await runInventoryActivation({
      journal,
      connectionB: b,
      initialReadyVersion: Number(state.readyVersion),
      persist: (j) => writeActivationJournal(file, j),
      operations,
    });
  } finally {
    // Fatal paths retain the durable interlock. Closing a lost A cannot authorize boot.
    await b?.end().catch(() => {});
    await a.end().catch(() => {});
  }
}

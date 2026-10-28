import { execFileSync as runFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { dockerBinding, mysqlCommand, resolveDbTarget } from "./db-target.mjs";

// Official client artifact, independent of the database-server image/version.
// MySQL 8.0 lacks mysqldump --init-command (introduced in 8.2).
export const BACKUP_CLIENT_IMAGE =
  "mysql@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084";
export const BACKUP_CLIENT_VERSION = "8.4.9";
const RUN_LABEL = "alroya.backup-client.run";
const PROCESS_OPTIONS = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 30000,
};

function pinCapableHelp(command, prefix, execute) {
  try {
    const help = execute(
      command,
      [...prefix, "--no-defaults", "--help"],
      PROCESS_OPTIONS,
    );
    return /(?:^|\n)\s*--init-command(?:=|\s)/.test(help) ? help : null;
  } catch {
    return null;
  }
}

function isolatedPrefix(network) {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "32",
    "--memory",
    "256m",
    "--user",
    "65534:65534",
    "--log-driver",
    "none",
  ];
}

function preparedImage(execute) {
  let image;
  try {
    image = JSON.parse(
      execute(
        "docker",
        ["image", "inspect", BACKUP_CLIENT_IMAGE],
        PROCESS_OPTIONS,
      ),
    )[0];
  } catch {
    throw new Error(
      "BACKUP_CLIENT_NOT_PREPARED: شغّل node scripts/provision-backup-client.mjs --pull أثناء تجهيز النشر؛ النسخ لا ينزّل صوراً من الشبكة.",
    );
  }
  const expectedDigest = BACKUP_CLIENT_IMAGE.split("@")[1];
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? "") ||
    !image.RepoDigests?.some((ref) => ref.split("@")[1] === expectedDigest)
  ) {
    throw new Error("BACKUP_CLIENT_IMAGE_MISMATCH");
  }
  const help = pinCapableHelp(
    "docker",
    [
      ...isolatedPrefix("none"),
      "--entrypoint",
      "mysqldump",
      BACKUP_CLIENT_IMAGE,
    ],
    execute,
  );
  if (
    !help ||
    !new RegExp(
      `\\bVer\\s+${BACKUP_CLIENT_VERSION.replaceAll(".", "\\.")}\\b`,
    ).test(help)
  ) {
    throw new Error(
      "BACKUP_CLIENT_CAPABILITY_MISMATCH: prepared client version/pin option is invalid",
    );
  }
  return { imageId: image.Id };
}

/** Explicit preparation only: routine backups never invoke docker pull. */
export async function provisionBackupClient({
  pull = false,
  forceIsolated = false,
  rawUrl,
  container,
  resolveTarget = resolveDbTarget,
  execFileSync = runFile,
} = {}) {
  if (rawUrl) {
    const target = await resolveTarget(rawUrl, {
      adapter: "native",
      allowMissingDatabase: true,
    });
    if (isLegacyServer(target))
      return resolveLegacyClient(rawUrl, target, {
        container,
        execFileSync,
        resolveTarget,
        allowMissingDatabase: true,
      });
  }
  if (!forceIsolated && pinCapableHelp("mysqldump", [], execFileSync))
    return { kind: "native" };
  try {
    return { kind: "isolated", ...preparedImage(execFileSync) };
  } catch (error) {
    if (!pull || !error.message.startsWith("BACKUP_CLIENT_NOT_PREPARED:"))
      throw error;
    execFileSync("docker", ["pull", BACKUP_CLIENT_IMAGE], {
      stdio: "inherit",
      timeout: 10 * 60_000,
    });
    return { kind: "isolated", ...preparedImage(execFileSync) };
  }
}

export async function resolveBackupClient(
  rawUrl,
  { container, execFileSync = runFile, resolveTarget = resolveDbTarget } = {},
) {
  // Client option support alone is insufficient: newer mysqldump clients use
  // SHOW BINARY LOG STATUS against 8.0, breaking --source-data (MySQL #115752).
  const nativeTarget = await resolveTarget(rawUrl, { adapter: "native" });
  if (isLegacyServer(nativeTarget))
    return resolveLegacyClient(rawUrl, nativeTarget, {
      container,
      execFileSync,
      resolveTarget,
    });
  if (pinCapableHelp("mysqldump", [], execFileSync)) {
    return {
      target: nativeTarget,
      kind: "native",
    };
  }
  let target;
  try {
    target = await resolveTarget(rawUrl, { adapter: "docker", container });
  } catch (error) {
    throw new Error(
      `BACKUP_CLIENT_CONFIG: لا يوجد عميل محلي يدعم تثبيت الاتصال ولا حاوية قاعدة مطابقة. حدّث عميل النسخ فقط أو اضبط DB_CONTAINER المطابق؛ خادم القاعدة لا يحتاج ترقية. (${error.message})`,
    );
  }
  if (
    pinCapableHelp(
      "docker",
      ["exec", target.containerId, "mysqldump"],
      execFileSync,
    )
  ) {
    return { target, kind: "container" };
  }
  return { target, kind: "isolated", ...preparedImage(execFileSync) };
}

/** Modern clients use an actual connection guard; legacy stock Docker uses continuity. */
export function backupDumpCommand(
  selection,
  flags,
  { execFileSync = runFile, runId = randomUUID() } = {},
) {
  const { target } = selection;
  const legacy = selection.kind === "legacy-container";
  if (selection.kind !== "isolated" && !legacy)
    return mysqlCommand(target, "mysqldump", flags);
  if (
    target.adapter !== "docker" ||
    !target.containerId ||
    !/^[A-Za-z0-9-]+$/.test(runId)
  )
    throw new Error("BACKUP_CLIENT_CONFIG");
  const name = `erp-backup-client-${runId}`;
  const guarded = mysqlCommand(
    {
      ...target,
      adapter: "native",
      host: "127.0.0.1",
      port: target.containerPort,
    },
    legacy ? "mysql" : "mysqldump",
    flags,
  );
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    let current;
    try {
      current = JSON.parse(
        execFileSync("docker", ["inspect", name], PROCESS_OPTIONS),
      )[0];
    } catch {
      removed = true;
      return;
    } // --rm normally already removed it.
    // Never remove a pre-existing/unrelated container after a name collision.
    if (
      current?.Config?.Labels?.[RUN_LABEL] !== runId ||
      current.Image !== selection.imageId
    )
      return;
    try {
      execFileSync("docker", ["rm", "--force", current.Id], {
        stdio: "ignore",
        timeout: 10000,
      });
      removed = true;
    } catch {
      /* daemon unavailable; no unverified deletion fallback */
    }
  };
  return {
    command: "docker",
    args: [
      ...isolatedPrefix(`container:${target.containerId}`),
      "--name",
      name,
      "--label",
      `${RUN_LABEL}=${runId}`,
      "-e",
      "MYSQL_PWD",
      "--entrypoint",
      "mysqldump",
      legacy ? selection.imageId : BACKUP_CLIENT_IMAGE,
      "--no-defaults",
      ...(legacy ? [] : ["--no-login-paths"]),
      ...guarded.args,
    ],
    cleanup,
  };
}

function isLegacyServer(target) {
  if (!/^\d+\.\d+\.\d+/.test(target.serverVersion ?? ""))
    throw new Error(
      "BACKUP_CLIENT_CONFIG: cannot determine database server version",
    );
  return /^8\.0\./.test(target.serverVersion);
}

function officialEntrypoint(value) {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    ["docker-entrypoint.sh", "/usr/local/bin/docker-entrypoint.sh"].includes(
      value[0],
    )
  );
}

function serverCommand(value) {
  if (!Array.isArray(value) || !value.length) return false;
  const options = value[0] === "mysqld" ? value.slice(1) : value;
  return options.every(
    (option) =>
      typeof option === "string" &&
      /^--[A-Za-z0-9][A-Za-z0-9_-]*(?:=.*)?$/.test(option),
  );
}

/** Restricted to the stock, direct Docker mysqld topology, never a proxy. */
function legacyEpoch(target, expectedImage, execute) {
  const { inspection, containerId, containerPort } = dockerBinding(
    target,
    target.containerId,
    execute,
  );
  if (
    !/^[a-f0-9]{64}$/.test(containerId) ||
    containerId !== target.containerId ||
    !/^sha256:[a-f0-9]{64}$/.test(inspection.Image ?? "") ||
    inspection.Image !== expectedImage ||
    containerPort !== target.containerPort ||
    inspection.State?.Restarting ||
    inspection.State?.Paused ||
    !Number.isInteger(inspection.State?.Pid) ||
    inspection.State.Pid <= 0 ||
    !inspection.State?.StartedAt ||
    !Number.isInteger(inspection.RestartCount) ||
    inspection.RestartCount < 0 ||
    !officialEntrypoint(inspection.Config?.Entrypoint) ||
    !serverCommand(inspection.Config?.Cmd) ||
    !/^(?:mysql|docker\.io\/library\/mysql):8\.0(?:\.\d+)?(?:@sha256:[a-f0-9]{64})?$/.test(
      inspection.Config?.Image ?? "",
    ) ||
    !inspection.HostConfig?.NetworkMode ||
    /^(?:host|none|container:)/.test(inspection.HostConfig.NetworkMode) ||
    (inspection.HostConfig.PidMode ?? "") !== ""
  )
    throw new Error(
      "BACKUP_TARGET_CONTINUITY: requires a stock direct MySQL 8.0 Docker target",
    );
  const comm = execute(
    "docker",
    ["exec", containerId, "cat", "/proc/1/comm"],
    PROCESS_OPTIONS,
  ).trim();
  const stat = execute(
    "docker",
    ["exec", containerId, "cat", "/proc/1/stat"],
    PROCESS_OPTIONS,
  ).trim();
  const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (
    comm !== "mysqld" ||
    !stat.startsWith("1 (mysqld) ") ||
    !/^\d+$/.test(startTime ?? "")
  )
    throw new Error(
      "BACKUP_TARGET_CONTINUITY: PID 1 must be the direct mysqld process",
    );
  return JSON.stringify({
    containerId,
    imageId: inspection.Image,
    containerPort,
    startedAt: inspection.State.StartedAt,
    restartCount: inspection.RestartCount,
    pid: inspection.State.Pid,
    startTime,
    network: inspection.HostConfig.NetworkMode,
    entrypoint: inspection.Config.Entrypoint,
    command: inspection.Config.Cmd,
  });
}

async function resolveLegacyClient(
  rawUrl,
  nativeTarget,
  {
    container,
    execFileSync: execute,
    resolveTarget,
    allowMissingDatabase = false,
  },
) {
  let target;
  try {
    target = await resolveTarget(rawUrl, {
      adapter: "docker",
      container,
      expectedUuid: nativeTarget.serverUuid,
      allowMissingDatabase,
    });
    if (
      !isLegacyServer(target) ||
      target.serverUuid !== nativeTarget.serverUuid
    )
      throw new Error("DB_TARGET_IDENTITY_MISMATCH");
    const inspected = dockerBinding(
      target,
      target.containerId,
      execute,
    ).inspection;
    legacyEpoch(target, inspected.Image, execute);
    const image = JSON.parse(
      execute("docker", ["image", "inspect", inspected.Image], PROCESS_OPTIONS),
    )[0];
    if (
      image?.Id !== inspected.Image ||
      !officialEntrypoint(image.Config?.Entrypoint) ||
      image.Config?.Cmd?.length !== 1 ||
      image.Config.Cmd[0] !== "mysqld" ||
      !image.RepoDigests?.some((ref) =>
        /^(?:mysql|docker\.io\/library\/mysql)@sha256:[a-f0-9]{64}$/.test(ref),
      )
    )
      throw new Error(
        "BACKUP_TARGET_CONTINUITY: matching official image is unavailable",
      );
    const help = execute(
      "docker",
      [
        ...isolatedPrefix("none"),
        "--entrypoint",
        "mysqldump",
        inspected.Image,
        "--no-defaults",
        "--help",
      ],
      PROCESS_OPTIONS,
    );
    const version = target.serverVersion.match(/^8\.0\.\d+/)[0];
    if (
      !new RegExp(`\\bVer\\s+${version.replaceAll(".", "\\.")}\\b`).test(
        help,
      ) ||
      !/--source-data(?:\[|=|\s)/.test(help)
    )
      throw new Error(
        "BACKUP_TARGET_CONTINUITY: matching client version/source-data support is unavailable",
      );
    return { target, kind: "legacy-container", imageId: inspected.Image };
  } catch (error) {
    throw new Error(
      `BACKUP_CLIENT_CONFIG: MySQL 8.0 backup requires its verified stock direct Docker container and matching cached client image; remote/native 8.0 needs an explicitly supported backup setup. (${error.message})`,
    );
  }
}

const SENTINEL_SQL =
  "SELECT @@server_uuid AS serverUuid, CONNECTION_ID() AS connectionId, DATABASE() AS db, @@port AS port, @@pid_file AS pidFile, @@version AS serverVersion";

function verifyPidFile(target, pidFile, execute) {
  if (
    typeof pidFile !== "string" ||
    pidFile.length > 512 ||
    !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(pidFile) ||
    pidFile.split("/").some((part) => part === "." || part === "..") ||
    /^\/(?:proc|sys|dev)\//.test(pidFile)
  )
    throw new Error("BACKUP_TARGET_CONTINUITY: invalid mysqld PID file path");
  if (
    execute(
      "docker",
      ["exec", target.containerId, "cat", "--", pidFile],
      PROCESS_OPTIONS,
    ).trim() !== "1"
  )
    throw new Error(
      "BACKUP_TARGET_CONTINUITY: mysqld PID file must identify PID 1",
    );
}

export async function openLegacyBackupGuard(
  selection,
  {
    createConnection = (url) => mysql.createConnection(url),
    execFileSync = runFile,
    heartbeatMs = 1000,
    queryTimeoutMs = 5000,
  } = {},
) {
  const { target } = selection;
  if (selection.kind !== "legacy-container") return null;
  const epoch = legacyEpoch(target, selection.imageId, execFileSync);
  let connection,
    tuple,
    timer,
    heartbeat,
    failure,
    closing = false;
  const callbacks = new Set(),
    observed = [];
  const latch = (error) => {
    if (closing || failure) return;
    failure = error;
    for (const callback of callbacks) {
      try {
        callback(error);
      } catch {
        /* caller cleanup is best effort here */
      }
    }
  };
  const disconnected = () =>
    latch(new Error("BACKUP_TARGET_CONTINUITY: sentinel connection closed"));
  const healthy = () => {
    if (failure) throw failure;
  };
  const query = async () => {
    healthy();
    let deadline;
    try {
      const rows = await Promise.race([
        connection.query({ sql: SENTINEL_SQL, timeout: queryTimeoutMs }),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => {
            const error = new Error(
              "BACKUP_TARGET_CONTINUITY: sentinel heartbeat timeout",
            );
            latch(error);
            connection.destroy();
            reject(error);
          }, queryTimeoutMs);
        }),
      ]);
      healthy();
      return rows[0][0];
    } catch (error) {
      latch(
        error.message?.startsWith("DB_TARGET_")
          ? error
          : new Error("BACKUP_TARGET_CONTINUITY: sentinel query failed"),
      );
      healthy();
    } finally {
      clearTimeout(deadline);
    }
  };
  const sameTuple = (actual) => {
    if (actual?.serverUuid !== target.serverUuid || actual.db !== target.db)
      throw new Error(
        "DB_TARGET_IDENTITY_MISMATCH: legacy sentinel UUID or schema changed",
      );
    if (
      !/^8\.0\./.test(actual.serverVersion ?? "") ||
      String(actual.port) !== target.containerPort ||
      !Number.isInteger(actual.connectionId) ||
      actual.connectionId <= 0 ||
      (tuple && JSON.stringify(actual) !== JSON.stringify(tuple))
    )
      throw new Error(
        "BACKUP_TARGET_CONTINUITY: sentinel session identity changed",
      );
  };
  const guard = {
    onFailure(callback) {
      callbacks.add(callback);
      if (failure) callback(failure);
      return () => callbacks.delete(callback);
    },
    async verify() {
      clearInterval(timer);
      await heartbeat;
      healthy();
      if (legacyEpoch(target, selection.imageId, execFileSync) !== epoch)
        throw new Error(
          "BACKUP_TARGET_CONTINUITY: Docker or mysqld process epoch changed",
        );
      verifyPidFile(target, tuple.pidFile, execFileSync);
      sameTuple(await query());
      healthy();
    },
    async close() {
      closing = true;
      clearInterval(timer);
      for (const [emitter, event] of observed)
        emitter.removeListener(event, disconnected);
      if (connection) {
        if (failure) connection.destroy();
        else {
          try {
            await connection.end();
          } catch {
            connection.destroy();
          }
        }
      }
    },
  };
  try {
    connection = await createConnection(target.url);
    for (const emitter of new Set(
      [connection, connection.connection, connection.connection?.stream].filter(
        Boolean,
      ),
    ))
      for (const event of ["error", "end", "close"]) {
        emitter.on(event, disconnected);
        observed.push([emitter, event]);
      }
    tuple = await query();
    sameTuple(tuple);
    verifyPidFile(target, tuple.pidFile, execFileSync);
    if (legacyEpoch(target, selection.imageId, execFileSync) !== epoch)
      throw new Error(
        "BACKUP_TARGET_CONTINUITY: Docker or mysqld process epoch changed",
      );
    timer = setInterval(() => {
      if (heartbeat || failure) return;
      heartbeat = (async () => {
        try {
          sameTuple(await query());
        } catch (error) {
          latch(error);
        } finally {
          heartbeat = undefined;
        }
      })();
    }, heartbeatMs);
    return guard;
  } catch (error) {
    await guard.close();
    throw error;
  }
}

/** dump resolves only after its owned child and output sink have both closed. */
export async function completeBackupDump(
  selection,
  { dump, publish, discard },
  options,
) {
  let guard;
  try {
    guard = await openLegacyBackupGuard(selection, options);
    await dump(guard);
    await guard?.verify();
    return publish();
  } catch (error) {
    await discard();
    throw error;
  } finally {
    await guard?.close();
  }
}

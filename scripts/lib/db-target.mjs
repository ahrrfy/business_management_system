import { execFileSync as runFile } from "node:child_process";
import mysql from "mysql2/promise";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const IDENTITY_SQL = "SELECT @@server_uuid, DATABASE(), @@version";

export function identitySql(target) {
  return target.allowMissingDatabase
    ? `SELECT @@server_uuid, COALESCE((SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME = BINARY '${target.db}'), ''), @@version`
    : IDENTITY_SQL;
}

export function parseDbTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("DB_TARGET_URL_INVALID");
  }
  const db = decodeURIComponent(parsed.pathname.slice(1));
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Query options must never silently override the endpoint selected by the URL.
  if (
    parsed.protocol !== "mysql:" ||
    !host ||
    !parsed.username ||
    !/^[A-Za-z0-9_$-]+$/.test(db) ||
    parsed.hash ||
    parsed.port === "0" ||
    [...parsed.searchParams.keys()].some((key) =>
      /^(host|port|database|user|password|socketPath|uri)$/i.test(key),
    )
  ) {
    throw new Error("DB_TARGET_URL_INVALID");
  }
  // Children consume the canonical database path too (some metadata tools read pathname directly).
  parsed.pathname = `/${db}`;
  return Object.freeze({
    url: parsed.toString(),
    host,
    port: parsed.port || "3306",
    db,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  });
}

async function readIdentity(target) {
  let connection;
  try {
    const connectionUrl = new URL(target.url);
    if (target.allowMissingDatabase) connectionUrl.pathname = "/";
    connection = await mysql.createConnection(connectionUrl.toString());
    const [rows, fields] = await connection.query(identitySql(target));
    return {
      serverUuid: rows[0]?.[fields[0]?.name],
      db: rows[0]?.[fields[1]?.name] || null,
      serverVersion: rows[0]?.[fields[2]?.name],
    };
  } catch {
    throw new Error("DB_TARGET_IDENTITY_UNAVAILABLE");
  } finally {
    await connection?.end();
  }
}

export function dockerBinding(target, container, execFileSync = runFile) {
  if (!LOOPBACK.has(target.host))
    throw new Error(
      "DB_TARGET_DOCKER_REMOTE: use a native client for a remote URL",
    );
  let inspected;
  try {
    inspected = JSON.parse(
      execFileSync("docker", ["inspect", container], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      }),
    )[0];
  } catch {
    throw new Error("DB_TARGET_CONTAINER_UNAVAILABLE");
  }
  if (!inspected?.Id || !inspected.State?.Running)
    throw new Error("DB_TARGET_CONTAINER_UNAVAILABLE");
  const ports = [];
  for (const [internal, bindings] of Object.entries(
    inspected.NetworkSettings?.Ports ?? {},
  )) {
    if (!/^\d+\/tcp$/.test(internal)) continue;
    for (const binding of bindings ?? []) {
      const ip = binding.HostIp?.replace(/^\[|\]$/g, "");
      const hostMatches =
        target.host === ip ||
        (target.host !== "::1" && ip === "0.0.0.0") ||
        (target.host === "::1" && ip === "::") ||
        (target.host === "localhost" &&
          ["127.0.0.1", "::1", "::"].includes(ip));
      if (binding.HostPort === target.port && hostMatches)
        ports.push(internal.split("/")[0]);
    }
  }
  if (new Set(ports).size !== 1)
    throw new Error(
      "DB_TARGET_BINDING_MISMATCH: DB_CONTAINER does not publish the DATABASE_URL endpoint",
    );
  return {
    containerId: inspected.Id,
    containerPort: ports[0],
    inspection: inspected,
  };
}

export function targetEnvironment(target, env = process.env) {
  return {
    ...env,
    DATABASE_URL: target.url,
    BACKUP_TARGET_URL: target.url,
    DB_TARGET_EXPECTED_UUID: target.serverUuid,
    MYSQL_PWD: target.password,
    ...(target.adapter === "docker"
      ? { DB_CONTAINER: target.containerId }
      : { DB_NATIVE: "1" }),
  };
}

export function mysqlCommand(target, binary, extra = []) {
  const native = target.adapter === "native";
  const args = [
    "--protocol=TCP",
    "-h",
    native ? target.host : "127.0.0.1",
    "-P",
    native ? target.port : target.containerPort,
    `-u${target.user}`,
    ...extra,
  ];
  if (binary === "mysqldump") {
    if (!/^[A-Za-z0-9-]+$/.test(target.serverUuid))
      throw new Error("DB_TARGET_UUID_INVALID");
    // MySQL executes this on the dump connection and on every reconnect. A
    // different UUID produces an invalid sql_mode error before any table dump.
    // The bounded stock-Docker 8.0 path uses a separate continuity guard and
    // constructs its matching older client's arguments without this option.
    args.push(
      `--init-command=SET SESSION sql_mode = IF(@@server_uuid = '${target.serverUuid}', @@sql_mode, 'DB_TARGET_IDENTITY_MISMATCH')`,
    );
  }
  return native
    ? { command: binary, args }
    : {
        command: "docker",
        args: [
          "exec",
          ...(binary === "mysql" ? ["-i"] : []),
          "-e",
          "MYSQL_PWD",
          target.containerId,
          binary,
          ...args,
        ],
      };
}

function sameIdentity(actual, expected) {
  if (
    !actual?.serverUuid ||
    actual.serverUuid !== expected.serverUuid ||
    (actual.db !== expected.db &&
      !(expected.allowMissingDatabase && actual.db === null))
  ) {
    throw new Error(
      "DB_TARGET_IDENTITY_MISMATCH: server UUID or database changed",
    );
  }
}

/** Restore children must check their own connection before doing any work. */
export async function assertConnectionTarget(connection, rawUrl, expectedUuid) {
  if (!expectedUuid) return;
  const target = parseDbTarget(rawUrl);
  const [rows] = await connection.query(
    "SELECT @@server_uuid AS serverUuid, DATABASE() AS db",
  );
  sameIdentity(rows[0], { serverUuid: expectedUuid, db: target.db });
}

export async function assertDbTarget(
  target,
  {
    execFileSync = runFile,
    queryIdentity = readIdentity,
    requireDatabase = !target.allowMissingDatabase,
  } = {},
) {
  if (target.adapter === "docker") {
    const binding = dockerBinding(target, target.containerId, execFileSync);
    if (
      binding.containerId !== target.containerId ||
      binding.containerPort !== target.containerPort
    )
      throw new Error("DB_TARGET_BINDING_MISMATCH");
  }
  const expected = { ...target, allowMissingDatabase: !requireDatabase };
  sameIdentity(await queryIdentity(target), expected);
  if (target.adapter === "docker") {
    const probe = mysqlCommand(target, "mysql", [
      "--batch",
      "--skip-column-names",
      "-e",
      identitySql(target),
      ...(target.allowMissingDatabase ? [] : [target.db]),
    ]);
    let values;
    try {
      values = execFileSync(probe.command, probe.args, {
        encoding: "utf8",
        env: targetEnvironment(target),
        stdio: ["ignore", "pipe", "pipe"],
      })
        .trim()
        .split("\t");
    } catch {
      throw new Error("DB_TARGET_ADAPTER_IDENTITY_UNAVAILABLE");
    }
    sameIdentity({ serverUuid: values[0], db: values[1] || null }, expected);
  }
  return target;
}

export async function resolveDbTarget(
  rawUrl,
  {
    adapter = "docker",
    container = process.env.DB_CONTAINER ?? "erp-mysql",
    expectedUuid = process.env.DB_TARGET_EXPECTED_UUID,
    execFileSync = runFile,
    queryIdentity = readIdentity,
    allowMissingDatabase = false,
  } = {},
) {
  const parsed = { ...parseDbTarget(rawUrl), allowMissingDatabase };
  const { inspection: _inspection, ...binding } =
    adapter === "docker" ? dockerBinding(parsed, container, execFileSync) : {};
  const actual = await queryIdentity(parsed);
  if (
    !actual?.serverUuid ||
    (actual.db !== parsed.db &&
      !(allowMissingDatabase && actual.db === null)) ||
    (expectedUuid && actual.serverUuid !== expectedUuid)
  )
    throw new Error("DB_TARGET_IDENTITY_MISMATCH");
  const target = Object.freeze({
    ...parsed,
    adapter,
    ...binding,
    serverUuid: actual.serverUuid,
    serverVersion: actual.serverVersion,
  });
  // Verify the adapter independently, not just the connection used by migrations.
  await assertDbTarget(target, {
    execFileSync,
    queryIdentity: async () => actual,
  });
  return target;
}

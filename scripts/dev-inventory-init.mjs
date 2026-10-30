import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";
import { parseDbTarget } from "./lib/db-target.mjs";
import {
  acquireInventoryGate,
  assertNoUnownedSessions,
} from "./lib/inventory-activation-fence.mjs";
import { withInventoryConnectionDeadline } from "./lib/inventory-activation-host.mjs";
import {
  activateInventoryProjection,
  assertInventoryTransitParity,
  deriveInventoryTransitProjection,
} from "./lib/inventory-projection-activation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const samePath = (a, b) => {
  const normalize = (value) =>
    process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  return normalize(a) === normalize(b);
};

/** Positive local development admission, completed before opening SQL. */
export function admitLocalInventoryTarget({
  rawUrl,
  container,
  serverUuid,
  confirmLocalDevelopment,
  projectRoot = ROOT,
  env = process.env,
  execute = execFileSync,
}) {
  if (
    !confirmLocalDevelopment ||
    env.NODE_ENV === "production" ||
    env.CONTROL_DATABASE_URL ||
    env.DOCKER_HOST ||
    !UUID.test(serverUuid ?? "") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container ?? "")
  )
    throw new Error("LOCAL_INVENTORY_EXPLICIT_DEVELOPMENT_TARGET_REQUIRED");
  const target = parseDbTarget(rawUrl);
  if (
    target.host !== "127.0.0.1" ||
    ["3306", "3307"].includes(target.port) ||
    Number(target.port) < 1024 ||
    new URL(target.url).search ||
    !/^erp_[a-z0-9_]+_dev$/.test(target.db) ||
    /prod|live|backup/i.test(target.db)
  )
    throw new Error("LOCAL_INVENTORY_UNSAFE_TARGET");
  const options = {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  };
  const endpoint = execute(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    options,
  ).trim();
  if (
    !/^(?:npipe:\/\/\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)|unix:\/\/\/var\/run\/docker\.sock)$/.test(
      endpoint,
    )
  )
    throw new Error("LOCAL_INVENTORY_LOCAL_DOCKER_REQUIRED");
  const inspected = JSON.parse(
    execute("docker", ["inspect", container], options),
  );
  const row = inspected?.length === 1 ? inspected[0] : null;
  const labels = row?.Config?.Labels ?? {};
  const bindings = row?.NetworkSettings?.Ports?.["3306/tcp"];
  const healthcheck = row?.Config?.Healthcheck?.Test;
  if (
    !/^[a-f0-9]{64}$/.test(row?.Id ?? "") ||
    row?.Name !== `/${container}` ||
    row?.State?.Running !== true ||
    labels["online.alarabiya.erp.environment"] !== "development" ||
    !labels["online.alarabiya.erp.project-root"] ||
    !samePath(labels["online.alarabiya.erp.project-root"], projectRoot) ||
    labels["online.alarabiya.erp.database"] !== target.db ||
    !row.Config.Env?.includes(`MYSQL_DATABASE=${target.db}`) ||
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0].HostIp !== "127.0.0.1" ||
    bindings[0].HostPort !== target.port ||
    (healthcheck?.length && healthcheck[0] !== "NONE")
  )
    throw new Error("LOCAL_INVENTORY_CONTAINER_IDENTITY_MISMATCH");
  return Object.freeze({ ...target, containerId: row.Id, serverUuid });
}

/** An explicit offline developer operation. Runtime readiness is never repaired. */
export async function initializeLocalInventory(options) {
  const target = admitLocalInventoryTarget(options);
  const commit =
    options.commit ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: options.projectRoot ?? ROOT,
      encoding: "utf8",
      timeout: 10000,
    }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("LOCAL_INVENTORY_EXACT_COMMIT_REQUIRED");
  const connect = options.connect ?? mysql.createConnection;
  const connections = [];
  try {
    const open = async () => {
      const connection = withInventoryConnectionDeadline(
        await connect({
          host: target.host,
          port: Number(target.port),
          database: target.db,
          user: target.user,
          password: target.password,
          connectTimeout: 10000,
          multipleStatements: false,
        }),
      );
      connections.push(connection);
      const [[identity]] = await connection.query(
        "SELECT CONNECTION_ID() AS id,DATABASE() AS db,@@server_uuid AS serverUuid",
      );
      if (
        identity.db !== target.db ||
        identity.serverUuid !== target.serverUuid
      )
        throw new Error("LOCAL_INVENTORY_DATABASE_IDENTITY_MISMATCH");
      await connection.query("SET SESSION innodb_lock_wait_timeout=5");
      return { connection, id: Number(identity.id) };
    };
    const a = await open(),
      b = await open();
    const allowed = new Set([a.id, b.id]);
    if (allowed.size !== 2)
      throw new Error("LOCAL_INVENTORY_CONNECTION_IDENTITY_MISMATCH");
    const assertQuiescent = async () => {
      if (admitLocalInventoryTarget(options).containerId !== target.containerId)
        throw new Error("LOCAL_INVENTORY_CONTAINER_CHANGED");
      const [grants] = await a.connection.query("SHOW GRANTS FOR CURRENT_USER");
      if (
        !grants.some((row) =>
          /GRANT (?:ALL PRIVILEGES|[^\n]*\bPROCESS\b[^\n]*) ON \*\.\*/.test(
            Object.values(row).join(" "),
          ),
        )
      )
        throw new Error("LOCAL_INVENTORY_SESSION_VISIBILITY_REQUIRED");
      const [[settings]] = await a.connection.query(
        "SELECT @@GLOBAL.event_scheduler AS scheduler",
      );
      if (
        String(settings.scheduler).toUpperCase() !== "OFF" &&
        String(settings.scheduler).toUpperCase() !== "DISABLED"
      )
        throw new Error("LOCAL_INVENTORY_EVENT_WRITER_UNSUPPORTED");
      const [replicas] = await a.connection.query(
        "SELECT CHANNEL_NAME FROM performance_schema.replication_connection_status WHERE SERVICE_STATE='ON'",
      );
      if (replicas.length)
        throw new Error("LOCAL_INVENTORY_REPLICATION_WRITER_UNSUPPORTED");
      await assertNoUnownedSessions(a.connection, allowed);
    };
    await assertQuiescent();
    // db:push creates tables only. Missing operational singletons start UNREADY.
    await a.connection.query(
      "INSERT INTO monthCloseSequence(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id",
    );
    await assertQuiescent();
    const gate = await acquireInventoryGate(a.connection, {
      database: target.db,
      serverUuid: target.serverUuid,
    });
    const fence = {
      async assertQuiescentAndLocked() {
        await gate.assertLocked();
        await assertQuiescent();
        await gate.assertLocked();
      },
    };
    await fence.assertQuiescentAndLocked();
    await b.connection.query(
      "INSERT INTO inventoryProjectionState(id,readyVersion) VALUES(1,0) ON DUPLICATE KEY UPDATE id=id",
    );
    const [states] = await b.connection.query(
      "SELECT id,readyVersion,activatedCommit,activatedAt FROM inventoryProjectionState",
    );
    if (
      states.length !== 1 ||
      Number(states[0].id) !== 1 ||
      ![0, 1].includes(Number(states[0].readyVersion))
    )
      throw new Error("LOCAL_INVENTORY_READY_STATE_UNSUPPORTED");
    let result;
    if (Number(states[0].readyVersion) === 0) {
      result = await activateInventoryProjection(b.connection, {
        expectedDatabase: target.db,
        expectedServerUuid: target.serverUuid,
        commit,
        fence,
      });
      result = { ...result, replayed: false };
    } else {
      if (
        !/^[a-f0-9]{40}$/.test(states[0].activatedCommit ?? "") ||
        !states[0].activatedAt
      )
        throw new Error("LOCAL_INVENTORY_ACTIVATION_PROVENANCE_MISSING");
      await b.connection.beginTransaction();
      try {
        await deriveInventoryTransitProjection(b.connection);
        result = {
          ...(await assertInventoryTransitParity(b.connection)),
          readyVersion: 1,
          replayed: true,
        };
        await fence.assertQuiescentAndLocked();
        await b.connection.commit();
      } catch (error) {
        await b.connection.rollback().catch(() => {});
        throw error;
      }
    }
    await fence.assertQuiescentAndLocked();
    await gate.release();
    return {
      ...result,
      database: target.db,
      serverUuid: target.serverUuid,
      containerId: target.containerId,
    };
  } finally {
    await Promise.all(
      connections.map((connection) => connection.end().catch(() => {})),
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const valid = new Set([
    "--container",
    "--server-uuid",
    "--confirm-local-development",
  ]);
  try {
    for (let i = 0; i < args.length; i++) {
      if (!valid.has(args[i]))
        throw new Error("LOCAL_INVENTORY_UNKNOWN_ARGUMENT");
      if (args[i] !== "--confirm-local-development") i++;
    }
    const result = await initializeLocalInventory({
      rawUrl: process.env.DATABASE_URL,
      container: value("--container"),
      serverUuid: value("--server-uuid"),
      confirmLocalDevelopment: args.includes("--confirm-local-development"),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      error?.code ?? error?.message ?? "LOCAL_INVENTORY_INITIALIZATION_FAILED",
    );
    process.exitCode = 1;
  }
}

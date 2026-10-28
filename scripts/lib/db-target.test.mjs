import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveBackupClient, backupDumpCommand } from "./backup-client.mjs";
import { dockerBinding, parseDbTarget } from "./db-target.mjs";

test(
  "Docker inspection has a bounded timeout and never exposes subprocess details",
  { timeout: 200 },
  () => {
    let inspectedOptions;
    assert.throws(
      () =>
        dockerBinding(
          parseDbTarget("mysql://root@127.0.0.1:33330/erp"),
          "explicit-container",
          (_command, _args, options) => {
            inspectedOptions = options;
            throw Object.assign(
              new Error("synthetic-secret-subprocess-details"),
              { code: "ETIMEDOUT" },
            );
          },
        ),
      (error) => error.message === "DB_TARGET_CONTAINER_UNAVAILABLE",
    );
    assert.equal(inspectedOptions.timeout, 30000);
  },
);

// Run the real selection branch with subprocesses/identity reads replaced at the I/O edge.
// No dump, restore or database write is ever executed by this harness.
async function backupSelection({
  host = "127.0.0.1",
  urlPort = "3310",
  publishedPort = "3306",
  uuid = "server-b",
  adapterUuid = uuid,
  native = false,
} = {}) {
  const source = readFileSync(
    new URL("../backup.mjs", import.meta.url),
    "utf8",
  );
  const calls = [];
  const execFileSync = (command, args) => {
    calls.push([command, args]);
    if (command === "mysqldump") {
      if (!native) throw new Error("missing native tool");
      return "mysqldump Ver 8.4.9\n --init-command=name SQL on connect";
    }
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: "container-a",
          State: { Running: true },
          NetworkSettings: {
            Ports: {
              "3306/tcp": [{ HostIp: "0.0.0.0", HostPort: publishedPort }],
            },
          },
        },
      ]);
    if (args[0] === "exec")
      return args.includes("mysqldump")
        ? "mysqldump Ver 8.4.9\n --init-command=name SQL on connect"
        : `${adapterUuid}\terp\n`;
    throw new Error(`unexpected command ${command}`);
  };
  let helpers = {};
  if (existsSync(new URL("./db-target.mjs", import.meta.url))) {
    const actual = await import("./db-target.mjs");
    const dependencies = {
      execFileSync,
      queryIdentity: async () => ({
        serverUuid: uuid,
        db: "erp",
        serverVersion: "8.4.9",
      }),
    };
    helpers = {
      resolveDbTarget: (url, options) =>
        actual.resolveDbTarget(url, { ...options, ...dependencies }),
      assertDbTarget: (target) => actual.assertDbTarget(target, dependencies),
      mysqlCommand: actual.mysqlCommand,
      targetEnvironment: actual.targetEnvironment,
      resolveBackupClient: (url, options) =>
        resolveBackupClient(url, {
          ...options,
          execFileSync,
          resolveTarget: (value, config) =>
            actual.resolveDbTarget(value, { ...config, ...dependencies }),
        }),
      backupDumpCommand,
    };
  }
  const context = vm.createContext({
    ...helpers,
    execFileSync,
    console: { error() {}, log() {} },
    process: {
      argv: [],
      env: {
        BACKUP_TARGET_URL: `mysql://root:pw@${host}:${urlPort}/erp`,
        DB_CONTAINER: "container-a",
      },
      exit: (code) => {
        throw new Error(`EXIT:${code}`);
      },
    },
  });
  const selection = source.slice(
    source.indexOf("const container ="),
    source.indexOf("const ts ="),
  );
  return {
    result: await vm.runInContext(
      `(async () => { ${selection}\n return { db, dumpCmd, dumpArgs }; })()`,
      context,
    ),
    calls,
  };
}

test("backup refuses Docker fallback whose published port differs from the URL", async () => {
  await assert.rejects(backupSelection(), /DB_TARGET_BINDING_MISMATCH|EXIT:1/);
});
test("backup refuses remote Docker fallback", async () => {
  await assert.rejects(
    backupSelection({ host: "db.remote.invalid" }),
    /DB_TARGET_DOCKER_REMOTE|EXIT:1/,
  );
});
test("backup refuses matching Docker port with a different server identity", async () => {
  await assert.rejects(
    backupSelection({ publishedPort: "3310", adapterUuid: "server-a" }),
    /DB_TARGET_IDENTITY_MISMATCH|EXIT:1/,
  );
});
test("backup selects the verified Docker container with explicit internal TCP coordinates", async () => {
  const { result } = await backupSelection({ publishedPort: "3310" });
  assert.equal(result.dumpCmd, "docker");
  assert.ok(result.dumpArgs.includes("container-a"));
  assert.ok(result.dumpArgs.includes("--protocol=TCP"));
  assert.ok(result.dumpArgs.includes("127.0.0.1"));
});
test("backup native command preserves the requested host and port", async () => {
  const { result } = await backupSelection({ native: true });
  assert.equal(result.dumpCmd, "mysqldump");
  assert.ok(result.dumpArgs.includes("3310"));
});
test("backup pins the actual native dump connection and every reconnect", async () => {
  const { result } = await backupSelection({ native: true });
  const pin = result.dumpArgs.find((arg) => arg.startsWith("--init-command="));
  assert.ok(pin, "mysqldump must validate UUID on its own connection");
  assert.match(pin, /@@server_uuid\s*=\s*'server-b'/);
  assert.match(pin, /@@sql_mode/);
  assert.match(pin, /DB_TARGET_IDENTITY_MISMATCH/);
  assert.ok(!result.dumpArgs.includes("--force"));
});
test("an older dump client rejecting the pin option aborts the streaming backup", async () => {
  const source = readFileSync(
    new URL("../backup.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function dumpToFile(");
  const body = source.slice(start, source.indexOf("\ntry {", start));
  const sink = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const context = vm.createContext({
    partial: "not-created.partial",
    db: "erp",
    dumpCmd: "mysqldump",
    dumpArgs: ["--init-command=guard"],
    resolvedTarget: {},
    targetEnvironment: () => ({}),
    createWriteStream: () => sink,
    dumpCleanup() {},
    setTimeout,
    clearTimeout,
    spawn: (command, args) => {
      assert.ok(args.some((arg) => arg.startsWith("--init-command=")));
      queueMicrotask(() => {
        child.stderr.write("unknown variable 'init-command=guard'");
        child.stdout.end("-- incomplete dump");
        child.emit("close", 2);
      });
      return child;
    },
  });
  await assert.rejects(
    vm.runInContext(
      `(async () => { ${body}; await dumpToFile(); })()`,
      context,
    ),
    /unknown variable.*init-command/,
  );
});

async function restoreExecution({
  publishedPort = "3306",
  uuid = "server-b",
  expectedUuid,
  driftAtRead = Infinity,
  streamUuid = uuid,
  missingDatabase = false,
  noBackup = false,
} = {}) {
  const source = readFileSync(
    new URL("../restore.mjs", import.meta.url),
    "utf8",
  );
  const calls = [];
  let identityReads = 0;
  let databaseCreated = !missingDatabase;
  const execFileSync = (command, args, options) => {
    calls.push({ command, args: Array.from(args), env: options?.env });
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: "container-a",
          State: { Running: true },
          NetworkSettings: {
            Ports: {
              "3306/tcp": [{ HostIp: "0.0.0.0", HostPort: publishedPort }],
            },
          },
        },
      ]);
    if (args[0] === "exec") return `${uuid}\t${databaseCreated ? "erp" : ""}\n`;
    return "";
  };
  let helpers = {};
  if (existsSync(new URL("./db-target.mjs", import.meta.url))) {
    const actual = await import("./db-target.mjs");
    const dependencies = {
      execFileSync,
      queryIdentity: async (target) => {
        if (!databaseCreated && !target.allowMissingDatabase)
          throw new Error("ER_BAD_DB_ERROR");
        return {
          serverUuid: ++identityReads >= driftAtRead ? "rebound-server" : uuid,
          db: databaseCreated ? "erp" : null,
        };
      },
    };
    helpers = {
      resolveDbTarget: (url, options) =>
        actual.resolveDbTarget(url, { ...options, ...dependencies }),
      assertDbTarget: (target, options) =>
        actual.assertDbTarget(target, { ...dependencies, ...options }),
      mysqlCommand: actual.mysqlCommand,
      targetEnvironment: actual.targetEnvironment,
    };
  }
  const context = vm.createContext({
    ...helpers,
    execFileSync,
    Buffer,
    pipeline,
    setTimeout,
    clearTimeout,
    join: (...parts) => parts.join("/"),
    acquireMaintenanceLock: () => () => {},
    flag: (name) => name === "--no-backup" && noBackup,
    file: "synthetic.sql",
    size: 600,
    url: "mysql://root:pw@127.0.0.1:3310/erp",
    dbName: "erp",
    targetDb: "erp",
    fail: (message) => {
      throw new Error(message);
    },
    console: { log() {}, error() {} },
    createReadStream: () => Readable.from(["-- MySQL dump synthetic\n"]),
    spawn: (command, args, options) => {
      calls.push({
        command,
        args: Array.from(args),
        env: options.env,
        destructive: true,
      });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => {
        child.stdin.destroy();
        queueMicrotask(() => child.emit("exit", 1));
      };
      child.stdin = new Writable({
        write(chunk, encoding, callback) {
          if (chunk.toString().includes("DROP DATABASE")) {
            calls.push({ drop: true });
            databaseCreated = true;
          }
          if (chunk.toString().includes("ALROYA_TARGET_IDENTITY:"))
            queueMicrotask(() =>
              child.stdout.write(
                `ALROYA_TARGET_IDENTITY:${streamUuid}:${databaseCreated ? "erp" : ""}\n`,
              ),
            );
          callback();
        },
      });
      child.stdin.on("finish", () =>
        queueMicrotask(() => child.emit("exit", 0)),
      );
      return child;
    },
    process: {
      platform: "win32",
      execPath: "node",
      env: {
        DATABASE_URL: "mysql://root:pw@127.0.0.1:3310/erp",
        DB_CONTAINER: "container-a",
        ...(expectedUuid ? { DB_TARGET_EXPECTED_UUID: expectedUuid } : {}),
      },
      once() {},
    },
  });
  const execution = source.slice(source.indexOf("let releaseMaintenanceLock;"));
  try {
    await vm.runInContext(`(async () => { ${execution}\n })()`, context);
  } catch (error) {
    error.calls = calls;
    throw error;
  }
  return calls;
}

test("restore refuses a wrong binding before safety backup or DROP", async () => {
  await assert.rejects(restoreExecution(), (error) => {
    assert.match(error.message, /DB_TARGET_BINDING_MISMATCH/);
    assert.ok(
      error.calls.every((call) => !call.destructive && call.command !== "node"),
    );
    return true;
  });
});
test("restore pins UUID and URL across prebackup, destructive adapter and migration verification", async () => {
  const calls = await restoreExecution({ publishedPort: "3310" });
  const backup = calls.find((call) => call.command === "node");
  assert.equal(backup.env.DB_TARGET_EXPECTED_UUID, "server-b");
  const restore = calls.find((call) => call.destructive);
  assert.ok(restore.args.includes("--protocol=TCP"));
  for (const call of calls.filter((call) => call.command === "pnpm")) {
    assert.equal(call.env.DATABASE_URL, backup.env.BACKUP_TARGET_URL);
    assert.equal(call.env.DB_TARGET_EXPECTED_UUID, "server-b");
  }
});
test("restore detects changed server identity after prebackup before DROP", async () => {
  await assert.rejects(
    restoreExecution({ publishedPort: "3310", driftAtRead: 2 }),
    (error) => {
      assert.match(error.message, /DB_TARGET_IDENTITY_MISMATCH/);
      assert.ok(error.calls.every((call) => !call.destructive));
      return true;
    },
  );
});
test("restore validates the exact destructive connection before sending DROP", async () => {
  await assert.rejects(
    restoreExecution({
      publishedPort: "3310",
      streamUuid: "reconnected-server",
    }),
    (error) => {
      assert.match(error.message, /DB_TARGET_IDENTITY_MISMATCH/);
      assert.ok(error.calls.every((call) => !call.drop));
      return true;
    },
  );
});
test("explicit no-backup recovery creates a missing database only after exact-connection identity", async () => {
  const calls = await restoreExecution({
    publishedPort: "3310",
    missingDatabase: true,
    noBackup: true,
  });
  assert.equal(
    calls.some((call) => call.command === "node"),
    false,
  );
  assert.equal(calls.filter((call) => call.drop).length, 1);
  assert.equal(calls.filter((call) => call.command === "pnpm").length, 2);
  const restore = calls.find((call) => call.destructive);
  assert.equal(
    restore.args.includes("erp"),
    false,
    "client must not select a database before CREATE",
  );
});
test("missing database still refuses ordinary restore before backup or destructive SQL", async () => {
  await assert.rejects(
    restoreExecution({ publishedPort: "3310", missingDatabase: true }),
    (error) => {
      assert.ok(
        error.calls.every((call) => !call.drop && call.command !== "node"),
      );
      return true;
    },
  );
});
test("target parsing refuses port zero instead of allowing driver default-port substitution", async () => {
  const { parseDbTarget } = await import("./db-target.mjs");
  assert.throws(
    () => parseDbTarget("mysql://root:pw@127.0.0.1:0/erp"),
    /DB_TARGET_URL_INVALID/,
  );
});
test("target parsing decodes credentials and schema and retains an explicit empty password", async () => {
  const { parseDbTarget, targetEnvironment } = await import("./db-target.mjs");
  const target = parseDbTarget(
    "mysql://test%40user:p%40ss%3Aword@127.0.0.1:3310/%65rp",
  );
  assert.equal(target.user, "test@user");
  assert.equal(target.password, "p@ss:word");
  assert.equal(target.db, "erp");
  assert.equal(new URL(target.url).pathname, "/erp");
  const empty = parseDbTarget("mysql://root:@127.0.0.1/erp");
  assert.equal(empty.port, "3306");
  assert.equal(
    targetEnvironment(empty, { MYSQL_PWD: "unrelated" }).MYSQL_PWD,
    "",
  );
  assert.throws(
    () =>
      parseDbTarget("mysql://root:pw@127.0.0.1/erp?socketPath=another-server"),
    /DB_TARGET_URL_INVALID/,
  );
});

async function childDatabasePhase(
  phase,
  { actualUuid = "server-b", expectedUuid = "server-b" } = {},
) {
  const helpers = await import("./db-target.mjs");
  const source = readFileSync(
    new URL(
      phase === "migrate"
        ? "../db-migrate-apply.mjs"
        : "../db-verify-schema.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const calls = { migrated: false, identityReads: 0, ended: false };
  const connection = {
    query: async () => {
      calls.identityReads++;
      return [[{ serverUuid: actualUuid, db: "erp" }]];
    },
    end: async () => {
      calls.ended = true;
    },
  };
  const context = vm.createContext({
    URL,
    assertConnectionTarget: helpers.assertConnectionTarget,
    createConnection: async () => connection,
    drizzle: (value) => value,
    migrate: async () => {
      calls.migrated = true;
    },
    console: { log() {}, error() {} },
    process: {
      env: {
        DATABASE_URL: "mysql://root:pw@127.0.0.1:3310/erp",
        ...(expectedUuid ? { DB_TARGET_EXPECTED_UUID: expectedUuid } : {}),
      },
      exit: (code) => {
        throw new Error(`EXIT:${code}`);
      },
    },
  });
  let execution = source.slice(
    source.indexOf("const url = process.env.DATABASE_URL;"),
  );
  if (phase === "verify")
    execution =
      execution.slice(
        0,
        execution.indexOf("  const [rows] = await conn.query("),
      ) + "return; } finally { await conn.end(); }";
  try {
    await vm.runInContext(`(async () => { ${execution} })()`, context);
  } catch (error) {
    error.calls = calls;
    throw error;
  }
  return calls;
}

for (const phase of ["migrate", "verify"]) {
  test(`${phase} refuses a different UUID on its own actual connection before work`, async () => {
    await assert.rejects(
      childDatabasePhase(phase, { actualUuid: "server-a" }),
      (error) => {
        assert.match(error.message, /DB_TARGET_IDENTITY_MISMATCH|EXIT:1/);
        assert.equal(error.calls.migrated, false);
        assert.equal(error.calls.ended, true);
        return true;
      },
    );
  });
  test(`${phase} accepts the pinned server on the same connection`, async () => {
    const calls = await childDatabasePhase(phase);
    assert.equal(calls.identityReads, 1);
    assert.equal(calls.migrated, phase === "migrate");
    assert.equal(calls.ended, true);
  });
  test(`${phase} preserves ordinary execution when no UUID pin was supplied`, async () => {
    const calls = await childDatabasePhase(phase, { expectedUuid: null });
    assert.equal(calls.migrated, phase === "migrate");
    assert.equal(calls.identityReads, 0);
  });
}

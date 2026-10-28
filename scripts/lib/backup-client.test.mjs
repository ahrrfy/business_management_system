import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import * as identity from "./db-target.mjs";

const IMAGE =
  "mysql@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084";
const IMAGE_ID = "sha256:" + "a".repeat(64);
const modernHelp =
  "mysqldump Ver 8.4.9 for Linux (MySQL Community Server)\n  --init-command=name SQL after connect/reconnect";
const oldHelp =
  "mysqldump Ver 8.0.46 for Linux (MySQL Community Server)\n  --single-transaction --host --port --source-data[=#]";
const clientModule = existsSync(new URL("./backup-client.mjs", import.meta.url))
  ? await import("./backup-client.mjs")
  : undefined;

function fixture({
  native = "missing",
  server = "8.0",
  imageCached = true,
  imageValid = true,
  containerAvailable = true,
  artifactHelp = modernHelp,
} = {}) {
  const calls = [];
  const state = {
    cached: imageCached,
    cleanupLabel: undefined,
    removed: false,
  };
  const execute = (command, args, options) => {
    calls.push({ command, args: Array.from(args), options });
    if (command === "mysqldump") {
      if (native === "missing") throw new Error("ENOENT");
      return args.includes("--version")
        ? `mysqldump Ver ${native}`
        : native.startsWith("8.0")
          ? oldHelp
          : modernHelp;
    }
    assert.equal(command, "docker");
    if (args[0] === "pull") {
      state.cached = true;
      return "prepared";
    }
    if (args[0] === "image" && args[1] === "inspect") {
      if (!state.cached) throw new Error("image absent");
      return JSON.stringify([
        {
          Id: IMAGE_ID,
          RepoDigests: [imageValid ? IMAGE : "mysql@sha256:" + "b".repeat(64)],
        },
      ]);
    }
    if (args[0] === "inspect") {
      if (String(args[1]).startsWith("erp-backup-client-")) {
        return JSON.stringify([
          {
            Id: "owned-client-id",
            Image: IMAGE_ID,
            Config: {
              Labels: { "alroya.backup-client.run": state.cleanupLabel },
            },
          },
        ]);
      }
      if (!containerAvailable) throw new Error("container absent");
      return JSON.stringify([
        {
          Id: "db80-id",
          State: { Running: true },
          NetworkSettings: {
            Ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "3310" }] },
          },
        },
      ]);
    }
    if (args[0] === "exec") {
      if (args.includes("mysqldump"))
        return server === "8.0" ? oldHelp : modernHelp;
      return "server-b\terp\n";
    }
    if (args[0] === "run" && args.includes("--help")) return artifactHelp;
    if (args[0] === "rm") {
      state.removed = true;
      return "removed";
    }
    throw new Error("Unexpected mocked process command");
  };
  const resolveTarget = (url, options) =>
    identity.resolveDbTarget(url, {
      ...options,
      execFileSync: execute,
      queryIdentity: async () => ({
        serverUuid: "server-b",
        db: "erp",
        serverVersion: "8.4.9",
      }),
    });
  return { calls, state, execute, resolveTarget };
}

async function selectThroughBackup(options) {
  const f = fixture(options);
  const source = readFileSync(
    new URL("../backup.mjs", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({
    execFileSync: f.execute,
    console: { error() {} },
    process: {
      argv: [],
      env: {
        BACKUP_TARGET_URL: "mysql://root:synthetic@127.0.0.1:3310/erp",
        DB_CONTAINER: "erp-mysql",
      },
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
    },
    resolveDbTarget: f.resolveTarget,
    mysqlCommand: identity.mysqlCommand,
    targetEnvironment: identity.targetEnvironment,
    resolveBackupClient:
      clientModule &&
      ((url, config) =>
        clientModule.resolveBackupClient(url, {
          ...config,
          execFileSync: f.execute,
          resolveTarget: f.resolveTarget,
        })),
    backupDumpCommand:
      clientModule &&
      ((selection, flags) =>
        clientModule.backupDumpCommand(selection, flags, {
          execFileSync: f.execute,
          runId: "test-client-run",
        })),
  });
  const selection = source.slice(
    source.indexOf("const container ="),
    source.indexOf("const ts ="),
  );
  const command = await vm.runInContext(
    `(async()=>{${selection};return {command:dumpCmd,args:dumpArgs};})()`,
    context,
  );
  return { ...f, command };
}

test("a modern server with an older bundled client selects a prepared capable client without runtime pulls", async () => {
  const { command, calls } = await selectThroughBackup();
  assert.equal(command.command, "docker");
  assert.equal(command.args[0], "run");
  assert.ok(command.args.includes("--pull=never"));
  assert.ok(command.args.includes("container:db80-id"));
  assert.ok(command.args.includes(IMAGE));
  assert.ok(
    command.args.some(
      (arg) => arg.startsWith("--init-command=") && arg.includes("server-b"),
    ),
  );
  assert.ok(command.args.includes("65534:65534"));
  assert.ok(
    !command.args.some((arg) =>
      /^(--volume|-v|--publish|-p|--privileged|--mount)$/.test(arg),
    ),
  );
  assert.ok(!command.args.some((arg) => arg.includes("synthetic")));
  assert.equal(
    calls.some((call) => call.args[0] === "pull"),
    false,
  );
});

test("an old native client falls back to verified Docker rather than executing unsupported pin flags", async () => {
  const { command } = await selectThroughBackup({ native: "8.0.45" });
  assert.equal(command.command, "docker");
  assert.equal(command.args[0], "run");
});
test("an old native client without a matching DB container reports a configuration error", async () => {
  await assert.rejects(
    selectThroughBackup({ native: "8.0.45", containerAvailable: false }),
    /BACKUP_CLIENT_CONFIG|EXIT:1/,
  );
});
test("a capable native client retains the native host/port path", async () => {
  const { command } = await selectThroughBackup({ native: "8.4.9" });
  assert.equal(command.command, "mysqldump");
  assert.ok(command.args.includes("3310"));
});
test("a capable existing DB-container client remains usable without another image", async () => {
  const { command, calls } = await selectThroughBackup({
    server: "8.4",
    imageCached: false,
  });
  assert.equal(command.args[0], "exec");
  assert.equal(
    calls.some((call) => call.args[0] === "image"),
    false,
  );
});
test("missing prepared artifact fails before the stream without an implicit pull", async () => {
  await assert.rejects(
    selectThroughBackup({ imageCached: false }),
    /BACKUP_CLIENT_NOT_PREPARED|EXIT:1/,
  );
});
test("a wrong cached artifact digest is refused", async () => {
  await assert.rejects(
    selectThroughBackup({ imageValid: false }),
    /BACKUP_CLIENT_IMAGE_MISMATCH|EXIT:1/,
  );
});
for (const artifactHelp of [oldHelp, modernHelp.replace("8.4.9", "8.4.10")])
  test("a cached artifact with wrong version/capabilities is refused without pulling", async () => {
    const f = fixture({ artifactHelp });
    await assert.rejects(
      () =>
        clientModule.provisionBackupClient({
          pull: true,
          forceIsolated: true,
          execFileSync: f.execute,
        }),
      /BACKUP_CLIENT_CAPABILITY_MISMATCH/,
    );
    assert.equal(
      f.calls.some((call) => call.args[0] === "pull"),
      false,
    );
  });

test("explicit preparation is idempotent offline when the pinned client is cached", async () => {
  assert.equal(
    typeof clientModule?.provisionBackupClient,
    "function",
    "explicit preparation must exist",
  );
  const f = fixture();
  await clientModule.provisionBackupClient({
    pull: true,
    execFileSync: f.execute,
  });
  assert.equal(
    f.calls.some((call) => call.args[0] === "pull"),
    false,
  );
});
test("preparation downloads only when explicitly allowed and then validates capabilities", async () => {
  assert.equal(typeof clientModule?.provisionBackupClient, "function");
  const offline = fixture({ imageCached: false });
  await assert.rejects(
    () => clientModule.provisionBackupClient({ execFileSync: offline.execute }),
    /BACKUP_CLIENT_NOT_PREPARED/,
  );
  assert.equal(
    offline.calls.some((call) => call.args[0] === "pull"),
    false,
  );
  const online = fixture({ imageCached: false });
  await clientModule.provisionBackupClient({
    pull: true,
    execFileSync: online.execute,
  });
  assert.equal(
    online.calls.filter((call) => call.args[0] === "pull").length,
    1,
  );
  assert.ok(
    online.calls.some(
      (call) => call.args[0] === "run" && call.args.includes("--help"),
    ),
  );
});
test("native capable preparation does not require Docker", async () => {
  assert.equal(typeof clientModule?.provisionBackupClient, "function");
  const f = fixture({ native: "8.4.9", imageCached: false });
  await clientModule.provisionBackupClient({
    pull: true,
    execFileSync: f.execute,
  });
  assert.equal(
    f.calls.some((call) => call.command === "docker"),
    false,
  );
});
test("CI can explicitly prepare the isolated artifact even with a capable native client", async () => {
  assert.equal(typeof clientModule?.provisionBackupClient, "function");
  const f = fixture({ native: "8.4.9" });
  const result = await clientModule.provisionBackupClient({
    forceIsolated: true,
    execFileSync: f.execute,
  });
  assert.equal(result.kind, "isolated");
  assert.ok(f.calls.some((call) => call.args[0] === "image"));
});

test("isolated dump cleanup removes only its labelled owned client", async () => {
  assert.equal(typeof clientModule?.resolveBackupClient, "function");
  const f = fixture();
  const selection = await clientModule.resolveBackupClient(
    "mysql://root:synthetic@127.0.0.1:3310/erp",
    { execFileSync: f.execute, resolveTarget: f.resolveTarget },
  );
  const command = clientModule.backupDumpCommand(selection, ["erp"], {
    execFileSync: f.execute,
    runId: "test-client-run",
  });
  assert.equal(typeof command.cleanup, "function");
  f.state.cleanupLabel = "unrelated";
  command.cleanup();
  assert.equal(f.state.removed, false);
  f.state.cleanupLabel = "test-client-run";
  command.cleanup();
  assert.equal(f.state.removed, true);
});

test("deployment prepares the client before its safety backup", () => {
  const source = readFileSync(
    new URL("../deploy.mjs", import.meta.url),
    "utf8",
  );
  const preparation = source.indexOf("scripts/provision-backup-client.mjs");
  const backup = source.indexOf('["db:backup"]');
  assert.ok(
    preparation >= 0 && preparation < backup,
    "prepare must precede deployment's backup",
  );
});

function legacyGuardFixture() {
  const containerId = "c".repeat(64);
  const inspected = {
    Id: containerId,
    Image: IMAGE_ID,
    RestartCount: 0,
    Config: {
      Image: "mysql:8.0.46",
      Entrypoint: ["docker-entrypoint.sh"],
      Cmd: ["--default-authentication-plugin=mysql_native_password"],
    },
    State: {
      Running: true,
      Restarting: false,
      Pid: 123,
      StartedAt: "2026-10-28T00:00:00Z",
    },
    HostConfig: { NetworkMode: "bridge", PidMode: "" },
    NetworkSettings: {
      Ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "33330" }] },
    },
  };
  const tuple = {
    serverUuid: "server-b",
    connectionId: 17,
    db: "erp",
    port: 3306,
    pidFile: "/var/lib/mysql/server.pid",
    serverVersion: "8.0.46",
  };
  const connection = new EventEmitter();
  connection.query = async () => [[{ ...tuple }]];
  connection.end = async () => {};
  connection.destroy = () => {};
  const execute = (command, args) => {
    if (command === "mysqldump") return modernHelp;
    assert.equal(command, "docker");
    if (args[0] === "image")
      return JSON.stringify([
        {
          Id: IMAGE_ID,
          RepoDigests: ["mysql@sha256:" + "d".repeat(64)],
          Config: { ...inspected.Config, Cmd: ["mysqld"] },
        },
      ]);
    if (args[0] === "inspect") return JSON.stringify([inspected]);
    if (args[0] === "run" || args.includes("mysqldump")) return oldHelp;
    if (args[0] === "exec" && args.includes("/proc/1/comm")) return "mysqld\n";
    if (args[0] === "exec" && args.includes("/proc/1/stat"))
      return (
        "1 (mysqld) " +
        Array.from({ length: 20 }, (_, i) => (i === 19 ? "123456" : "0")).join(
          " ",
        )
      );
    if (
      args[0] === "exec" &&
      (args.includes(tuple.pidFile) ||
        args.includes("/var/lib/mysql/server.pid"))
    )
      return "1\n";
    throw new Error("Unexpected legacy guard command: " + args.join(" "));
  };
  const selection = {
    kind: "legacy-container",
    imageId: IMAGE_ID,
    target: {
      ...identity.parseDbTarget("mysql://root@127.0.0.1:33330/erp"),
      adapter: "docker",
      containerId,
      containerPort: "3306",
      serverUuid: "server-b",
      serverVersion: "8.0.46",
    },
  };
  const options = {
    execFileSync: execute,
    createConnection: async () => connection,
    heartbeatMs: 10000,
    queryTimeoutMs: 100,
  };
  return { selection, options, inspected, tuple, connection };
}

test("8.0 server generation chooses its exact matching image even with a modern native client", async () => {
  const f = legacyGuardFixture();
  const selected = await clientModule.resolveBackupClient(
    f.selection.target.url,
    {
      execFileSync: f.options.execFileSync,
      resolveTarget: async (_url, options) => ({
        ...f.selection.target,
        adapter: options.adapter,
      }),
    },
  );
  assert.equal(selected.kind, "legacy-container");
  const command = clientModule.backupDumpCommand(
    selected,
    ["--source-data=2", "erp"],
    { execFileSync: f.options.execFileSync, runId: "test-client-run" },
  );
  assert.ok(command.args.includes(IMAGE_ID));
  assert.ok(command.args.includes("--source-data=2"));
  assert.ok(!command.args.some((x) => x.startsWith("--init-command=")));
  assert.ok(!command.args.includes("--no-login-paths"));
});

test("8.0 preparation validates its cached direct-server artifact without pulling 8.4", async () => {
  const f = legacyGuardFixture();
  let pulled = false;
  const prepared = await clientModule.provisionBackupClient({
    rawUrl: f.selection.target.url,
    forceIsolated: true,
    pull: true,
    execFileSync: (command, args, opts) => {
      if (args[0] === "pull") pulled = true;
      return f.options.execFileSync(command, args, opts);
    },
    resolveTarget: async (_url, options) => ({
      ...f.selection.target,
      adapter: options.adapter,
    }),
  });
  assert.equal(prepared.kind, "legacy-container");
  assert.equal(pulled, false);
});

test("legacy continuity verifies the same stock mysqld session and publishes only after completion", async () => {
  assert.equal(typeof clientModule.completeBackupDump, "function");
  const f = legacyGuardFixture();
  const events = [];
  await clientModule.completeBackupDump(
    f.selection,
    {
      dump: async () => {
        events.push("child-and-sink-closed");
      },
      publish: () => events.push("published"),
      discard: () => events.push("discarded"),
    },
    f.options,
  );
  assert.deepEqual(events, ["child-and-sink-closed", "published"]);
});

for (const event of ["error", "end", "close"])
  test(`legacy ${event} latches failure and never publishes`, async () => {
    assert.equal(typeof clientModule.completeBackupDump, "function");
    const f = legacyGuardFixture();
    let killed = false,
      published = false,
      discarded = false;
    await assert.rejects(
      clientModule.completeBackupDump(
        f.selection,
        {
          dump: async (guard) => {
            guard.onFailure(() => {
              killed = true;
            });
            f.connection.emit(event, new Error("sentinel disconnected"));
          },
          publish: () => {
            published = true;
          },
          discard: () => {
            discarded = true;
          },
        },
        f.options,
      ),
      /BACKUP_TARGET_CONTINUITY/,
    );
    assert.equal(killed, true);
    assert.equal(published, false);
    assert.equal(discarded, true);
  });

for (const changed of [
  "uuid",
  "connection",
  "port",
  "pidfile",
  "epoch",
  "image",
  "binding",
])
  test(`legacy ${changed} change discards the completed dump`, async () => {
    assert.equal(typeof clientModule.completeBackupDump, "function");
    const f = legacyGuardFixture();
    let published = false,
      discarded = false;
    await assert.rejects(
      clientModule.completeBackupDump(
        f.selection,
        {
          dump: async () => {
            if (changed === "uuid") f.tuple.serverUuid = "server-c";
            if (changed === "connection") f.tuple.connectionId++;
            if (changed === "port") f.tuple.port++;
            if (changed === "pidfile")
              f.tuple.pidFile = "/var/lib/mysql/other.pid";
            if (changed === "epoch") f.inspected.RestartCount++;
            if (changed === "image")
              f.inspected.Image = "sha256:" + "b".repeat(64);
            if (changed === "binding")
              f.inspected.NetworkSettings.Ports["3306/tcp"][0].HostPort =
                "33331";
          },
          publish: () => {
            published = true;
          },
          discard: () => {
            discarded = true;
          },
        },
        f.options,
      ),
      /BACKUP_TARGET_CONTINUITY|DB_TARGET_/,
    );
    assert.equal(published, false);
    assert.equal(discarded, true);
  });

test("legacy wrong UUID is rejected before invoking the dump", async () => {
  assert.equal(typeof clientModule.completeBackupDump, "function");
  const f = legacyGuardFixture();
  f.tuple.serverUuid = "wrong-uuid";
  let started = false;
  await assert.rejects(
    clientModule.completeBackupDump(
      f.selection,
      {
        dump: () => {
          started = true;
        },
        publish() {},
        discard() {},
      },
      f.options,
    ),
    /IDENTITY_MISMATCH/,
  );
  assert.equal(started, false);
});

for (const topology of ["host", "shared", "proxy", "pidfile", "pidpath"])
  test(`legacy rejects ${topology} topology before dumping`, async () => {
    assert.equal(typeof clientModule.completeBackupDump, "function");
    const f = legacyGuardFixture();
    let started = false;
    if (topology === "host") f.inspected.HostConfig.NetworkMode = "host";
    if (topology === "shared")
      f.inspected.HostConfig.NetworkMode = "container:another";
    if (topology === "proxy") f.inspected.Config.Entrypoint = ["proxy.sh"];
    if (topology === "pidfile") f.tuple.pidFile = "/tmp/not-mysqld.pid";
    if (topology === "pidpath")
      f.tuple.pidFile = "/var/lib/mysql/../../etc/passwd";
    const options =
      topology === "pidfile"
        ? {
            ...f.options,
            execFileSync: (command, args) =>
              args.includes(f.tuple.pidFile)
                ? "2\n"
                : f.options.execFileSync(command, args),
          }
        : f.options;
    await assert.rejects(
      clientModule.completeBackupDump(
        f.selection,
        {
          dump: () => {
            started = true;
          },
          publish() {},
          discard() {},
        },
        options,
      ),
      /BACKUP_TARGET_CONTINUITY/,
    );
    assert.equal(started, false);
  });

test("legacy heartbeat timeout is terminal and does not open another session", async () => {
  assert.equal(typeof clientModule.completeBackupDump, "function");
  const f = legacyGuardFixture();
  let queries = 0,
    connections = 0,
    aborted = false,
    published = false;
  f.connection.query = async () =>
    ++queries === 1 ? [[{ ...f.tuple }]] : new Promise(() => {});
  await assert.rejects(
    clientModule.completeBackupDump(
      f.selection,
      {
        dump: async (guard) =>
          new Promise((resolve) =>
            guard.onFailure(() => {
              aborted = true;
              resolve();
            }),
          ),
        publish: () => {
          published = true;
        },
        discard() {},
      },
      {
        ...f.options,
        heartbeatMs: 2,
        queryTimeoutMs: 10,
        createConnection: async () => {
          connections++;
          return f.connection;
        },
      },
    ),
    /BACKUP_TARGET_CONTINUITY/,
  );
  assert.equal(connections, 1);
  assert.equal(aborted, true);
  assert.equal(published, false);
});

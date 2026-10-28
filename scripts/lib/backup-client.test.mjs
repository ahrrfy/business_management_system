import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import * as identity from "./db-target.mjs";

const IMAGE =
  "mysql@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084";
const IMAGE_ID = "sha256:" + "a".repeat(64);
const modernHelp =
  "mysqldump Ver 8.4.9 for Linux (MySQL Community Server)\n  --init-command=name SQL after connect/reconnect";
const oldHelp =
  "mysqldump Ver 8.0.45 for Linux (MySQL Community Server)\n  --single-transaction --host --port";
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
      queryIdentity: async () => ({ serverUuid: "server-b", db: "erp" }),
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

test("configured MySQL 8.0 selects an isolated capable client without runtime pulls", async () => {
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
  test("a cached artifact with wrong version/capabilities is refused without pulling", () => {
    const f = fixture({ artifactHelp });
    assert.throws(
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

test("explicit preparation is idempotent offline when the pinned client is cached", () => {
  assert.equal(
    typeof clientModule?.provisionBackupClient,
    "function",
    "explicit preparation must exist",
  );
  const f = fixture();
  clientModule.provisionBackupClient({ pull: true, execFileSync: f.execute });
  assert.equal(
    f.calls.some((call) => call.args[0] === "pull"),
    false,
  );
});
test("preparation downloads only when explicitly allowed and then validates capabilities", () => {
  assert.equal(typeof clientModule?.provisionBackupClient, "function");
  const offline = fixture({ imageCached: false });
  assert.throws(
    () => clientModule.provisionBackupClient({ execFileSync: offline.execute }),
    /BACKUP_CLIENT_NOT_PREPARED/,
  );
  assert.equal(
    offline.calls.some((call) => call.args[0] === "pull"),
    false,
  );
  const online = fixture({ imageCached: false });
  clientModule.provisionBackupClient({
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
test("native capable preparation does not require Docker", () => {
  assert.equal(typeof clientModule?.provisionBackupClient, "function");
  const f = fixture({ native: "8.4.9", imageCached: false });
  clientModule.provisionBackupClient({ pull: true, execFileSync: f.execute });
  assert.equal(
    f.calls.some((call) => call.command === "docker"),
    false,
  );
});
test("CI can explicitly prepare the isolated artifact even with a capable native client", () => {
  assert.equal(typeof clientModule?.provisionBackupClient, "function");
  const f = fixture({ native: "8.4.9" });
  const result = clientModule.provisionBackupClient({
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

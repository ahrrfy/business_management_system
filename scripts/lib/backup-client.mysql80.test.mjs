// Opt-in integration smoke. It never pulls images and refuses existing schemas,
// normal DB ports, missing ownership labels, or any server except MySQL 8.0.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  backupDumpCommand,
  resolveBackupClient,
  BACKUP_CLIENT_VERSION,
} from "./backup-client.mjs";
import {
  mysqlCommand,
  parseDbTarget,
  resolveDbTarget,
  targetEnvironment,
} from "./db-target.mjs";

const LABEL = "alroya.backup-client.mysql80-smoke";
const PROTECTED_PORTS = new Set(["3306", "3307", "3310", "33318", "33320"]);

function assertSmokeConfiguration(
  rawUrl,
  container,
  inspected,
  { ci = false } = {},
) {
  const target = parseDbTarget(rawUrl);
  assert.ok(
    container,
    "BACKUP_SMOKE_CONTAINER must explicitly name the isolated MySQL 8.0 container",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(target.host),
    "smoke database must be loopback",
  );
  assert.ok(
    !PROTECTED_PORTS.has(target.port) || (ci && target.port === "3306"),
    "smoke refuses production/default/other-task DB ports outside labelled CI",
  );
  assert.match(
    target.db,
    /^erp_backup_client_80_[a-z0-9_]*test$/i,
    "smoke requires its dedicated schema prefix",
  );
  assert.match(
    inspected?.Config?.Image ?? "",
    /^mysql:8\.0(?:[.@]|$)/,
    "smoke requires an explicit mysql:8.0 server image",
  );
  assert.equal(
    inspected.Config.Labels?.[LABEL],
    "1",
    "isolated container ownership label is required",
  );
  return target;
}

test("MySQL 8.0 smoke configuration rejects live/default targets before SQL", () => {
  const owned = { Config: { Image: "mysql:8.0", Labels: { [LABEL]: "1" } } };
  const url = "mysql://fixture@127.0.0.1:33330/erp_backup_client_80_smoke_test";
  assert.equal(
    assertSmokeConfiguration(url, "explicit-fixture", owned).port,
    "33330",
  );
  assert.equal(
    assertSmokeConfiguration(
      url.replace(":33330/", ":3306/"),
      "explicit-fixture",
      owned,
      { ci: true },
    ).port,
    "3306",
  );
  for (const port of PROTECTED_PORTS)
    assert.throws(() =>
      assertSmokeConfiguration(
        url.replace(":33330/", `:${port}/`),
        "explicit-fixture",
        owned,
      ),
    );
  assert.throws(() =>
    assertSmokeConfiguration(
      url.replace("127.0.0.1", "remote.invalid"),
      "explicit-fixture",
      owned,
    ),
  );
  assert.throws(() =>
    assertSmokeConfiguration(
      url.replace("erp_backup_client_80_smoke_test", "erp"),
      "explicit-fixture",
      owned,
    ),
  );
  assert.throws(() =>
    assertSmokeConfiguration(url, "explicit-fixture", {
      Config: { Image: "mysql:8.4", Labels: { [LABEL]: "1" } },
    }),
  );
  assert.throws(() =>
    assertSmokeConfiguration(url, "explicit-fixture", {
      Config: { Image: "mysql:8.0" },
    }),
  );
});

test(
  "pinned MySQL 8.4 client dumps and roundtrips a fresh isolated MySQL 8.0 snapshot",
  {
    skip: process.env.RUN_BACKUP_MYSQL80_SMOKE !== "1",
    timeout: 120000,
  },
  async () => {
    assert.ok(
      process.env.CI === "true" ||
        process.env.ALLOW_LOCAL_BACKUP_MYSQL80_SMOKE === "1",
      "smoke requires CI or a second explicit synthetic-local acknowledgement",
    );
    const rawUrl = process.env.BACKUP_SMOKE_DATABASE_URL;
    const container = process.env.BACKUP_SMOKE_CONTAINER;
    assert.ok(
      rawUrl && container,
      "BACKUP_SMOKE_DATABASE_URL and BACKUP_SMOKE_CONTAINER are required",
    );
    const inspected = JSON.parse(
      execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
    )[0];
    const config = assertSmokeConfiguration(rawUrl, container, inspected, {
      ci: process.env.CI === "true",
    });
    const initial = await resolveDbTarget(rawUrl, {
      container,
      allowMissingDatabase: true,
    });
    const destination = `${config.db}_roundtrip_test`;
    const serverUrl = new URL(rawUrl);
    serverUrl.pathname = "/";
    const mysql = await import("mysql2/promise");
    const connection = await mysql.createConnection(serverUrl.toString());
    const created = new Set();
    const commands = [];
    try {
      const [[server]] = await connection.query(
        "SELECT @@version AS version, @@server_uuid AS uuid, @@log_bin AS binlog",
      );
      assert.match(server.version, /^8\.0\./);
      assert.equal(server.uuid, initial.serverUuid);
      assert.equal(
        Number(server.binlog),
        1,
        "smoke server must enable binlog for the production --source-data path",
      );
      const [existing] = await connection.query(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)",
        [config.db, destination],
      );
      assert.equal(
        existing.length,
        0,
        "smoke refuses to overwrite any existing source/roundtrip schema",
      );
      for (const name of [config.db, destination]) {
        await connection.query(
          `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        );
        created.add(name);
      }
      await connection.query(
        `CREATE TABLE \`${config.db}\`.snapshot (id INT PRIMARY KEY, label VARCHAR(128), amount DECIMAL(15,2), payload VARBINARY(20)) ENGINE=InnoDB`,
      );
      await connection.query(
        `INSERT INTO \`${config.db}\`.snapshot VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
        [
          1,
          "عينة ' وسطر\nثانٍ",
          "100.50",
          null,
          2,
          "second",
          "-12.25",
          Buffer.from([0, 1, 2, 255]),
        ],
      );
      const [expected] = await connection.query(
        `SELECT id, label, amount, HEX(payload) AS payload FROM \`${config.db}\`.snapshot ORDER BY id`,
      );

      // Force this smoke to exercise the isolated artifact even when CI happens
      // to have a modern native client. All Docker/DB operations remain real.
      const withoutNative = (command, args, options) => {
        if (command === "mysqldump")
          throw new Error("native disabled in isolated-client smoke");
        return execFileSync(command, args, options);
      };
      const selected = await resolveBackupClient(rawUrl, {
        container,
        execFileSync: withoutNative,
        resolveTarget: (url, options) =>
          resolveDbTarget(url, {
            ...options,
            expectedUuid: initial.serverUuid,
          }),
      });
      assert.equal(selected.kind, "isolated");
      const flags = [
        "--single-transaction",
        "--routines",
        "--events",
        "--no-tablespaces",
        "--source-data=2",
        "--set-gtid-purged=OFF",
        config.db,
      ];
      const goodCommand = backupDumpCommand(selected, flags);
      commands.push(goodCommand);
      const dump = spawnSync(goodCommand.command, goodCommand.args, {
        env: targetEnvironment(selected.target),
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(dump.status, 0, dump.stderr?.toString());
      assert.match(dump.stdout.toString(), /CREATE TABLE `snapshot`/);
      goodCommand.cleanup?.();

      const wrongCommand = backupDumpCommand(
        {
          ...selected,
          target: {
            ...selected.target,
            serverUuid: "00000000-0000-0000-0000-000000000000",
          },
        },
        flags,
      );
      commands.push(wrongCommand);
      const wrong = spawnSync(wrongCommand.command, wrongCommand.args, {
        env: targetEnvironment(selected.target),
        maxBuffer: 1024 * 1024,
      });
      assert.notEqual(wrong.status, 0);
      assert.match(wrong.stderr.toString(), /DB_TARGET_IDENTITY_MISMATCH/);
      assert.doesNotMatch(wrong.stdout.toString(), /CREATE TABLE `snapshot`/);
      wrongCommand.cleanup?.();

      const destinationUrl = new URL(rawUrl);
      destinationUrl.pathname = `/${destination}`;
      const restoreTarget = await resolveDbTarget(destinationUrl.toString(), {
        container,
        expectedUuid: initial.serverUuid,
      });
      // mysql 8.0 already supports --init-command. Reuse the exact dump UUID guard
      // on this actual restore connection and disable reconnects.
      const pin = goodCommand.args.find((arg) =>
        arg.startsWith("--init-command="),
      );
      assert.ok(pin);
      const restore = mysqlCommand(restoreTarget, "mysql", [
        pin,
        "--skip-reconnect",
        "--binary-mode=1",
        "--default-character-set=utf8mb4",
        destination,
      ]);
      const replay = spawnSync(restore.command, restore.args, {
        env: targetEnvironment(restoreTarget),
        input: dump.stdout,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(replay.status, 0, replay.stderr?.toString());
      const [actual] = await connection.query(
        `SELECT id, label, amount, HEX(payload) AS payload FROM \`${destination}\`.snapshot ORDER BY id`,
      );
      assert.deepEqual(actual, expected);
      console.log(
        JSON.stringify({
          clientVersion: BACKUP_CLIENT_VERSION,
          serverVersion: server.version,
          sourceRows: expected.length,
          roundtripRows: actual.length,
          wrongUuidRejected: true,
        }),
      );
    } finally {
      for (const command of commands) command.cleanup?.();
      // Use the same non-reconnecting connection; never delete a pre-existing DB.
      try {
        const [[server]] = await connection.query(
          "SELECT @@server_uuid AS uuid",
        );
        if (server.uuid === initial.serverUuid)
          for (const name of created)
            await connection.query(`DROP DATABASE \`${name}\``);
      } finally {
        await connection.end();
      }
    }
  },
);

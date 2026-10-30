import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  admitLocalInventoryTarget,
  initializeLocalInventory,
} from "./dev-inventory-init.mjs";

const projectRoot = path.resolve(".");
const uuid = "45b7a9ab-d4a2-11f1-bf42-028bd55d50bb";
const rawUrl = "mysql://root:synthetic@127.0.0.1:33324/erp_inventory_dev";
const container = "erp-inventory-local-dev";
const inspection = () => [
  {
    Id: "a".repeat(64),
    Name: `/${container}`,
    State: { Running: true },
    Config: {
      Labels: {
        "online.alarabiya.erp.environment": "development",
        "online.alarabiya.erp.project-root": projectRoot,
        "online.alarabiya.erp.database": "erp_inventory_dev",
      },
      Env: ["MYSQL_DATABASE=erp_inventory_dev"],
      Healthcheck: { Test: ["NONE"] },
    },
    NetworkSettings: {
      Ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "33324" }] },
    },
  },
];
const options = (overrides = {}) => ({
  rawUrl,
  projectRoot,
  container,
  serverUuid: uuid,
  confirmLocalDevelopment: true,
  env: {},
  execute: (_command, args) =>
    args[0] === "context"
      ? "npipe:////./pipe/dockerDesktopLinuxEngine\n"
      : JSON.stringify(inspection()),
  ...overrides,
});

test("positively admits only the explicitly confirmed project-local development Docker target", () => {
  const target = admitLocalInventoryTarget(options());
  assert.equal(target.db, "erp_inventory_dev");
  assert.equal(target.port, "33324");
  assert.equal(target.serverUuid, uuid);
  assert.equal(target.containerId, "a".repeat(64));
});

for (const [label, overrides] of [
  ["confirmation missing", { confirmLocalDevelopment: false }],
  ["production environment", { env: { NODE_ENV: "production" } }],
  [
    "tenant control database",
    { env: { CONTROL_DATABASE_URL: "mysql://unsafe" } },
  ],
  ["Docker host override", { env: { DOCKER_HOST: "tcp://remote:2375" } }],
  ["invalid UUID", { serverUuid: "anything" }],
  ["missing container", { container: "" }],
  ...[
    "mysql://root:x@127.0.0.1:3306/erp_inventory_dev",
    "mysql://root:x@127.0.0.1:3307/erp_inventory_dev",
    "mysql://root:x@localhost:33324/erp_inventory_dev",
    "mysql://root:x@remote:33324/erp_inventory_dev",
    "mysql://root:x@127.0.0.1:33324/erp",
    "mysql://root:x@127.0.0.1:33324/erp_production_dev",
    "mysql://root:x@127.0.0.1:33324/erp_live_dev",
    "mysql://root:x@127.0.0.1:33324/erp_inventory_test",
    "mysql://root:x@127.0.0.1:33324/erp_inventory_dev?socketPath=/tmp/mysql.sock",
    "mysql://root:x@127.0.0.1:33324/erp_inventory_dev?port=3306",
    "https://127.0.0.1:33324/erp_inventory_dev",
  ].map((url) => [url, { rawUrl: url }]),
])
  test(`rejects ${label} before Docker access or SQL connection`, async () => {
    let connections = 0,
      executions = 0;
    await assert.rejects(
      initializeLocalInventory(
        options({
          ...overrides,
          execute: () => {
            executions++;
            throw new Error("must not execute");
          },
          connect: async () => {
            connections++;
            throw new Error("must not connect");
          },
        }),
      ),
    );
    assert.equal(connections, 0);
    assert.equal(executions, 0);
  });

for (const [label, change] of [
  [
    "wrong development label",
    (i) => {
      i.Config.Labels["online.alarabiya.erp.environment"] = "production";
    },
  ],
  [
    "another worktree",
    (i) => {
      i.Config.Labels["online.alarabiya.erp.project-root"] =
        path.resolve("../other");
    },
  ],
  [
    "another database label",
    (i) => {
      i.Config.Labels["online.alarabiya.erp.database"] = "erp_other_dev";
    },
  ],
  [
    "another configured database",
    (i) => {
      i.Config.Env = ["MYSQL_DATABASE=erp_other_dev"];
    },
  ],
  [
    "stopped container",
    (i) => {
      i.State.Running = false;
    },
  ],
  [
    "wildcard bind",
    (i) => {
      i.NetworkSettings.Ports["3306/tcp"][0].HostIp = "0.0.0.0";
    },
  ],
  [
    "wrong mapped port",
    (i) => {
      i.NetworkSettings.Ports["3306/tcp"][0].HostPort = "3306";
    },
  ],
  [
    "ambiguous bind",
    (i) => {
      i.NetworkSettings.Ports["3306/tcp"].push({
        HostIp: "0.0.0.0",
        HostPort: "33324",
      });
    },
  ],
  [
    "active healthcheck",
    (i) => {
      i.Config.Healthcheck = { Test: ["CMD", "mysqladmin", "ping"] };
    },
  ],
])
  test(`rejects ${label} before SQL connection`, async () => {
    const rows = inspection();
    change(rows[0]);
    let connections = 0;
    await assert.rejects(
      initializeLocalInventory(
        options({
          execute: (_command, args) =>
            args[0] === "context"
              ? "npipe:////./pipe/dockerDesktopLinuxEngine"
              : JSON.stringify(rows),
          connect: async () => {
            connections++;
            throw new Error("must not connect");
          },
        }),
      ),
    );
    assert.equal(connections, 0);
  });

test("rejects a remote Docker context before inspection or connection", async () => {
  let executions = 0,
    connections = 0;
  await assert.rejects(
    initializeLocalInventory(
      options({
        execute: () => {
          executions++;
          return "tcp://remote:2376";
        },
        connect: async () => {
          connections++;
          throw new Error("must not connect");
        },
      }),
    ),
  );
  assert.equal(executions, 1);
  assert.equal(connections, 0);
});

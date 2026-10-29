import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateInventoryProjection,
  invalidateInventoryProjection,
} from "./inventory-projection-activation.mjs";
function connection({ missing = false, commitError = false } = {}) {
  const calls = [];
  return {
    calls,
    async beginTransaction() {
      calls.push("begin");
    },
    async rollback() {
      calls.push("rollback");
    },
    async commit() {
      calls.push("commit");
      if (commitError) throw new Error("reply lost");
    },
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith("SELECT DATABASE"))
        return [[{ db: "isolated_test", serverUuid: "uuid" }]];
      if (sql.includes("FROM inventoryProjectionState"))
        return [missing ? [] : [{ id: 1, readyVersion: 0 }]];
      if (sql.startsWith("SELECT COUNT")) return [[{ n: 0 }]];
      return [[]];
    },
  };
}
const options = () => ({
  expectedDatabase: "isolated_test",
  expectedServerUuid: "uuid",
  commit: "a".repeat(40),
  fence: { async assertQuiescentAndLocked() {} },
});
test("requires actual caller fence and exact immutable DB/source identity", async () => {
  const c = connection();
  await assert.rejects(
    activateInventoryProjection(c, { ...options(), fence: undefined }),
    /fence required/,
  );
  await assert.rejects(
    activateInventoryProjection(c, {
      ...options(),
      expectedServerUuid: "wrong",
    }),
    /identity mismatch/,
  );
  assert.ok(!c.calls.includes("begin"));
});
test("missing marker refuses before any backfill and rolls back", async () => {
  const c = connection({ missing: true });
  await assert.rejects(activateInventoryProjection(c, options()), /UNREADY/);
  assert.ok(c.calls.includes("rollback"));
  assert.ok(!c.calls.some((x) => x.startsWith("UPDATE productVariants")));
});
test("rechecks fence immediately before commit and aborts atomically on loss", async () => {
  const c = connection();
  let checks = 0;
  const o = options();
  o.fence.assertQuiescentAndLocked = async () => {
    if (++checks === 2) throw new Error("A lost");
  };
  await assert.rejects(activateInventoryProjection(c, o), /A lost/);
  assert.equal(checks, 2);
  assert.ok(c.calls.includes("rollback"));
  assert.ok(!c.calls.includes("commit"));
});
test("lost activation commit reply is explicitly uncertain, never retried", async () => {
  const c = connection({ commitError: true });
  await assert.rejects(
    activateInventoryProjection(c, options()),
    /INVENTORY_ACTIVATION_COMMIT_UNCERTAIN/,
  );
  assert.equal(c.calls.filter((x) => x === "commit").length, 1);
});
test("invalidation also distinguishes uncertain commit", async () => {
  const c = connection({ commitError: true });
  await assert.rejects(
    invalidateInventoryProjection(c, options()),
    /INVENTORY_INVALIDATION_COMMIT_UNCERTAIN/,
  );
});

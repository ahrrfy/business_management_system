import test from "node:test";
import assert from "node:assert/strict";
import { CreditPipelineQueue } from "./pipeline.ts";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));
test("one ticket reads after proven primary while previous ACK remains held, then writes only after exact ACK", async () => {
  const q = new CreditPipelineQueue(),
    commit = deferred(),
    ack = deferred(),
    events = [];
  const a = q.run(
    async (h) => {
      await commit.promise;
      events.push("A-primary");
      h.committed(2);
      await ack.promise;
      events.push("A-ack");
      h.acknowledged(2);
      return new Response("A");
    },
    async () => ({ epoch: 1 }),
  );
  const b = q.run(
    async (h) => {
      events.push("B-write");
      assert.equal(h.prefetched.epoch, 2);
      h.committed(3);
      h.acknowledged(3);
      return new Response("B");
    },
    async (epoch) => {
      events.push("B-read");
      assert.equal(epoch, 2);
      return { epoch };
    },
  );
  const c = q.run(
    async (h) => {
      events.push("C-write");
      h.committed(4);
      h.acknowledged(4);
      return new Response("C");
    },
    async (epoch) => {
      events.push("C-read");
      assert.equal(epoch, 3);
      return { epoch };
    },
  );
  await tick();
  assert.deepEqual(events, []);
  commit.resolve();
  await tick();
  assert.deepEqual(events, ["A-primary", "B-read"]);
  ack.resolve();
  await Promise.all([a, b, c]);
  assert.deepEqual(events, [
    "A-primary",
    "B-read",
    "A-ack",
    "B-write",
    "C-read",
    "C-write",
  ]);
  assert.equal(q.stats().maxActive, 1);
});
test("a failed/uncertain predecessor invalidates already-read ticket and never executes it", async () => {
  const q = new CreditPipelineQueue(),
    gate = deferred();
  let reads = 0,
    writes = 0;
  const a = q.run(
    async (h) => {
      h.committed(2);
      await gate.promise;
      return new Response("unknown", { status: 503 });
    },
    async () => ({ epoch: 1 }),
  );
  const b = q.run(
    async () => {
      writes++;
      return new Response("unsafe");
    },
    async (epoch) => {
      reads++;
      return { epoch };
    },
  );
  await tick();
  assert.equal(reads, 1);
  gate.resolve();
  await a;
  await assert.rejects(b, /LOOKAHEAD_PREDECESSOR_UNCONFIRMED/);
  assert.equal(writes, 0);
  const retry = await q.run(
    async (h) => {
      assert.equal(h.prefetched, null);
      return new Response("bounded full protocol");
    },
    async () => {
      throw Error("must not read speculatively after failed idle tail");
    },
  );
  assert.equal(retry.value.status, 200);
});
test("lookahead with another epoch is rejected and admission remains bounded", async () => {
  const q = new CreditPipelineQueue(2),
    ack = deferred();
  const a = q.run(
    async (h) => {
      h.committed(2);
      await ack.promise;
      h.acknowledged(2);
      return new Response("ok");
    },
    async () => ({ epoch: 1 }),
  );
  const b = q.run(
    async () => {
      throw Error("must not execute stale ticket");
    },
    async () => ({ epoch: 3 }),
  );
  await assert.rejects(
    q.run(async () => new Response("overflow")),
    /CASH_WRITER_QUEUE_FULL/,
  );
  ack.resolve();
  await a;
  await assert.rejects(b, /LOOKAHEAD_SNAPSHOT_CHANGED/);
  assert.equal(q.stats().pending, 0);
});

import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appNotificationOutbox, appNotifications, branches, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { enqueueAppNotificationOutbox } from "../appNotificationOutboxService";
import {
  createAppNotificationOutboxWorkerRuntime,
  runAppNotificationOutboxBatch,
} from "../appNotificationOutboxWorker";
import { withTx } from "../tx";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await db().execute(sql`TRUNCATE TABLE appNotificationOutbox`);
  await db().execute(sql`TRUNCATE TABLE appNotifications`);
  await db().execute(sql`TRUNCATE TABLE users`);
  await db().execute(sql`TRUNCATE TABLE branches`);
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(users).values({ id: 81, openId: "outbox-worker-user", name: "مدير", role: "manager", branchId: 1 });
});

describe("appNotificationOutboxWorker", () => {
  it("ينتظر stop الدفعة الجارية قبل إغلاق قاعدة البيانات", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAppNotificationOutboxWorkerRuntime({
      intervalMs: 60_000,
      runBatch: async () => gate,
      onError: vi.fn(),
    });

    expect(runtime.start()).toBe(true);
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("يصالح النوايا العامة دورياً ولا يعتمد على عامل استوديو المنتجات", async () => {
    await withTx((tx) => enqueueAppNotificationOutbox(tx, [{
      branchId: 1,
      streamKey: "task:91:user:81",
      occurrenceId: "task-event:901",
      notification: {
        userId: 81,
        kind: "TASK_ASSIGNED",
        family: "ADMIN",
        title: "اكتملت المهمة",
        body: "TSK-91 · مراجعة الطلب",
        route: "/tasks?task=91",
        eventKey: "task:91:event:901:RESOLVED:81",
        entityType: "task",
        entityId: 91,
      },
    }]));

    const result = await runAppNotificationOutboxBatch();

    expect(result).toMatchObject({ claimedCount: 1, createdCount: 1, failedCount: 0 });
    expect((await db().select().from(appNotifications)).map((row) => row.family)).toEqual(["ADMIN"]);
    expect((await db().select().from(appNotificationOutbox).where(eq(appNotificationOutbox.eventKey, "task:91:event:901:RESOLVED:81")))[0])
      .toMatchObject({ status: "DELIVERED" });
  });
});

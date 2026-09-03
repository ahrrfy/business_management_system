import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativePushOutbox, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizeNativePushPayload } from "../nativePushService";
import {
  computeNativePushBackoffMs,
  runNativePushOutboxBatch,
} from "../nativePushOutboxWorker";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function payload(id: string, family: "OPERATIONS" | "ADMIN" = "OPERATIONS") {
  return normalizeNativePushPayload({
    notificationId: id,
    kind: "TASK_ASSIGNED",
    title: "مهمة جديدة",
    body: "راجع مساحة المهام.",
    destination: "alrueya://app/tasks",
    urgency: "action",
    sensitive: false,
    family,
  });
}

beforeEach(async () => {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await database.execute(sql`TRUNCATE TABLE nativePushOutbox`);
  await database.execute(sql`TRUNCATE TABLE users`);
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await database.insert(users).values({
    id: 52,
    openId: "native-outbox-user",
    name: "مستخدم",
    role: "cashier",
  });
});

describe("nativePushOutboxWorker", () => {
  it("يطالب الصف مرة واحدة ويعلّمه مرسلاً بعد نجاح التسليم", async () => {
    await db()
      .insert(nativePushOutbox)
      .values({
        userId: 52,
        eventKey: "native:success:1",
        payload: payload("native_success_1", "ADMIN"),
        environment: "dev",
      });
    const deliver = vi.fn(async () => ({ sent: 1, goneRevoked: 0, failed: 0 }));

    const first = await runNativePushOutboxBatch(10, {
      configured: () => true,
      deliver,
    });
    const second = await runNativePushOutboxBatch(10, {
      configured: () => true,
      deliver,
    });

    expect(first).toMatchObject({ claimed: 1, sent: 1, retried: 0, dead: 0 });
    expect(second.claimed).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ family: "ADMIN" });
    const [row] = await db().select().from(nativePushOutbox);
    expect(row.status).toBe("SENT");
    expect(row.attemptCount).toBe(1);
    expect(row.completedAt).toBeTruthy();
  });

  it("يعيد المحاولة بتراجع محدود ثم ينقل الصف المستنفد إلى DEAD", async () => {
    await db()
      .insert(nativePushOutbox)
      .values([
        {
          userId: 52,
          eventKey: "native:retry:1",
          payload: payload("native_retry_1"),
          environment: "dev",
        },
        {
          userId: 52,
          eventKey: "native:dead:1",
          payload: payload("native_dead_1"),
          environment: "dev",
          attemptCount: 7,
        },
      ]);
    const before = Date.now();
    const result = await runNativePushOutboxBatch(10, {
      configured: () => true,
      deliver: async () => ({ sent: 0, goneRevoked: 0, failed: 1 }),
    });

    expect(result).toMatchObject({ claimed: 2, sent: 0, retried: 1, dead: 1 });
    const rows = await db().select().from(nativePushOutbox);
    const retry = rows.find((row) => row.eventKey === "native:retry:1");
    const dead = rows.find((row) => row.eventKey === "native:dead:1");
    expect(retry?.status).toBe("RETRY");
    expect(retry?.attemptCount).toBe(1);
    expect(retry?.availableAt.getTime()).toBeGreaterThanOrEqual(
      before + computeNativePushBackoffMs(1) - 1_000,
    );
    expect(dead?.status).toBe("DEAD");
    expect(dead?.attemptCount).toBe(8);
    expect(dead?.completedAt).toBeTruthy();
  });

  it("لا يطالب أي صف عند غياب تهيئة FCM ولا يسجل نجاحاً كاذباً", async () => {
    await db()
      .insert(nativePushOutbox)
      .values({
        userId: 52,
        eventKey: "native:disabled:1",
        payload: payload("native_disabled_1"),
        environment: "dev",
      });
    const deliver = vi.fn();
    expect(
      await runNativePushOutboxBatch(10, { configured: () => false, deliver }),
    ).toEqual({
      configured: false,
      claimed: 0,
      sent: 0,
      retried: 0,
      dead: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
    const [row] = await db().select().from(nativePushOutbox);
    expect(row.status).toBe("PENDING");
    expect(row.attemptCount).toBe(0);
  });
});

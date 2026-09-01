import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { users, webPushOutbox } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  computeWebPushBackoffMs,
  runWebPushOutboxBatch,
} from "../webPushOutboxWorker";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function payload(kind = "TASK_ASSIGNED") {
  return {
    kind,
    title: "مهمة جديدة",
    body: "راجع مساحة العمل.",
    url: "/my-work",
  };
}

beforeEach(async () => {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await database.execute(sql`TRUNCATE TABLE webPushOutbox`);
  await database.execute(sql`TRUNCATE TABLE users`);
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await database.insert(users).values({
    id: 53,
    openId: "web-outbox-user",
    name: "مستخدم",
    role: "cashier",
  });
});

describe("webPushOutboxWorker", () => {
  it("يسلّم الصف مرة واحدة ويختمه SENT", async () => {
    await db().insert(webPushOutbox).values({
      userId: 53,
      eventKey: "web:success:1",
      payload: payload(),
    });
    const deliver = vi.fn(async () => ({ sent: 1, goneRevoked: 0, failed: 0 }));

    expect(await runWebPushOutboxBatch(10, { configured: () => true, deliver })).toMatchObject({
      claimed: 1,
      sent: 1,
      retried: 0,
      dead: 0,
    });
    expect((await runWebPushOutboxBatch(10, { configured: () => true, deliver })).claimed).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [row] = await db().select().from(webPushOutbox);
    expect(row).toMatchObject({ status: "SENT", attemptCount: 1 });
    expect(row.completedAt).toBeTruthy();
  });

  it("يعيد العطل العابر ويقتل الحمولة الفاسدة بلا إرسال", async () => {
    await db().insert(webPushOutbox).values([
      { userId: 53, eventKey: "web:retry:1", payload: payload() },
      { userId: 53, eventKey: "web:invalid:1", payload: { ...payload(), url: "https://evil.test" } },
    ]);
    const before = Date.now();
    const deliver = vi.fn(async () => ({ sent: 0, goneRevoked: 0, failed: 1 }));
    const result = await runWebPushOutboxBatch(10, { configured: () => true, deliver });

    expect(result).toMatchObject({ claimed: 2, retried: 1, dead: 1 });
    const rows = await db().select().from(webPushOutbox);
    const retry = rows.find((row) => row.eventKey === "web:retry:1");
    const invalid = rows.find((row) => row.eventKey === "web:invalid:1");
    expect(retry?.status).toBe("RETRY");
    expect(retry?.availableAt.getTime()).toBeGreaterThanOrEqual(before + computeWebPushBackoffMs(1) - 1_000);
    expect(invalid?.status).toBe("DEAD");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("يترك الصف PENDING عند غياب VAPID", async () => {
    await db().insert(webPushOutbox).values({
      userId: 53,
      eventKey: "web:disabled:1",
      payload: payload("SYSTEM"),
    });
    const deliver = vi.fn();
    expect(await runWebPushOutboxBatch(10, { configured: () => false, deliver })).toEqual({
      configured: false,
      claimed: 0,
      sent: 0,
      retried: 0,
      dead: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
    expect((await db().select().from(webPushOutbox))[0]).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });
});

// اختبارات الإنشاء التلقائي للمهمة من رسالة واتساب واردة (maybeCreateTaskForInbound):
//  8) AUTO_ALL: رسالة IN جديدة ⇒ مهمة INQUIRY مربوطة بالمحادثة؛ رسالة ثانية (والأولى مفتوحة) ⇒ لا مهمة ثانية.
//  9) قاعدة كلمة مفتاحية «شكوى» ⇒ kind SUPPORT + serviceTypeId المطابق.
//  10) KEYWORD_ONLY بلا مطابقة ⇒ لا مهمة؛ MANUAL ⇒ لا مهمة؛ autoTaskEnabled=false ⇒ لا مهمة.
//  11) محادثة أُغلقت مهمتها (RESOLVED) ثم رسالة جديدة ⇒ مهمة جديدة تُنشأ.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { maybeCreateTaskForInbound } from "../tasks/autoCreate";
import { withTx } from "../tx";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = ["taskEvents", "tasks", "waKeywordRules", "waHubSettings", "serviceTypes", "conversations", "customers", "branches"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.conversations).values({ id: 1, branchId: 1, channel: "WHATSAPP", channelHandle: "9647700000001" });
  await d.insert(s.serviceTypes).values({ id: 1, name: "دعم فني", defaultKind: "SUPPORT", defaultPriority: "HIGH", slaHours: 4 });
}

/** يستبدل صفّ الإعدادات singleton (id=1) — حذف ثم إدراج (لا سباق: كل اختبار متسلسل). */
async function setSettings(partial: Partial<typeof s.waHubSettings.$inferInsert>) {
  const d = db();
  await d.delete(s.waHubSettings);
  await d.insert(s.waHubSettings).values({ id: 1, triageMode: "AUTO_ALL", autoTaskEnabled: true, ...partial });
}

function inbound(overrides: Partial<{ conversationId: number; branchId: number; customerId: number | null; messageBody: string }> = {}) {
  return withTx((tx) =>
    maybeCreateTaskForInbound(tx, {
      conversationId: 1,
      branchId: 1,
      customerId: null,
      messageBody: "رسالة اختبار",
      sourceChannel: "WHATSAPP",
      ...overrides,
    }),
  );
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("tasks — الإنشاء التلقائي من وارد واتساب", () => {
  it("8) AUTO_ALL: أول رسالة ⇒ مهمة INQUIRY مربوطة بالمحادثة؛ الثانية (والأولى مفتوحة) ⇒ لا مهمة ثانية", async () => {
    await setSettings({ triageMode: "AUTO_ALL", autoTaskEnabled: true });

    const r1 = await inbound({ messageBody: "مرحباً، عندي استفسار عن سعر الطباعة" });
    expect(r1.created).toBe(true);
    const task1 = (await db().select().from(s.tasks).where(eq(s.tasks.id, r1.taskId!)))[0];
    expect(task1.taskKind).toBe("INQUIRY");
    expect(task1.taskStatus).toBe("NEW");
    expect(Number(task1.conversationId)).toBe(1);

    const r2 = await inbound({ messageBody: "رسالة ثانية من نفس المحادثة" });
    expect(r2.created).toBe(false);
    expect(r2.taskId).toBeUndefined();

    const rows = await db().select().from(s.tasks).where(eq(s.tasks.conversationId, 1));
    expect(rows).toHaveLength(1);
  });

  it("9) قاعدة كلمة مفتاحية «شكوى» ⇒ kind SUPPORT + serviceTypeId المطابق", async () => {
    await setSettings({ triageMode: "AUTO_ALL", autoTaskEnabled: true });
    await db().insert(s.waKeywordRules).values({ pattern: "شكوى", matchKind: "SUPPORT", serviceTypeId: 1, priority: 0, isActive: true });

    const r = await inbound({ messageBody: "عندي شكوى بخصوص الطلب الأخير" });
    expect(r.created).toBe(true);
    const task = (await db().select().from(s.tasks).where(eq(s.tasks.id, r.taskId!)))[0];
    expect(task.taskKind).toBe("SUPPORT");
    expect(Number(task.serviceTypeId)).toBe(1);
  });

  it("10) KEYWORD_ONLY بلا مطابقة ⇒ لا مهمة؛ MANUAL ⇒ لا مهمة؛ autoTaskEnabled=false ⇒ لا مهمة", async () => {
    await setSettings({ triageMode: "KEYWORD_ONLY", autoTaskEnabled: true });
    const r1 = await inbound({ messageBody: "رسالة عادية بلا أي كلمة مفتاحية مسجَّلة" });
    expect(r1.created).toBe(false);

    await setSettings({ triageMode: "MANUAL", autoTaskEnabled: true });
    const r2 = await inbound({ messageBody: "أي رسالة أخرى" });
    expect(r2.created).toBe(false);

    await setSettings({ triageMode: "AUTO_ALL", autoTaskEnabled: false });
    const r3 = await inbound({ messageBody: "رسالة ثالثة مختلفة" });
    expect(r3.created).toBe(false);

    const rows = await db().select().from(s.tasks);
    expect(rows).toHaveLength(0);
  });

  it("11) محادثة أُغلقت مهمتها (RESOLVED) ثم رسالة جديدة ⇒ مهمة جديدة تُنشأ", async () => {
    await setSettings({ triageMode: "AUTO_ALL", autoTaskEnabled: true });

    const r1 = await inbound({ messageBody: "استفسار أول" });
    expect(r1.created).toBe(true);
    await db().update(s.tasks).set({ taskStatus: "RESOLVED" }).where(eq(s.tasks.id, r1.taskId!));

    const r2 = await inbound({ messageBody: "استفسار جديد بعد إغلاق المهمة الأولى" });
    expect(r2.created).toBe(true);
    expect(r2.taskId).not.toBe(r1.taskId);

    const rows = await db().select().from(s.tasks).where(eq(s.tasks.conversationId, 1));
    expect(rows).toHaveLength(2);
  });
});

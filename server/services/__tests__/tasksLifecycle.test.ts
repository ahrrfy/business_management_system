// اختبارات نظام المهام — آلة الحالات (FSM) عبر appRouter.createCaller (نمط rbacTightening.test.ts):
//  1) createTask يولّد TSK-{فرع}-{YYYYMMDD}-{تسلسل} تصاعدياً + حدث SYSTEM.
//  2) claim على NEW يسند ويحوّل IN_PROGRESS + firstResponseAt؛ claim على مهمة مسنَدة لغيرك ⇒ CONFLICT.
//  3) انتقال ممنوع (resolve مباشرة من NEW) ⇒ BAD_REQUEST.
//  4) resolve مهمة SUPPORT بلا resolutionNote ⇒ BAD_REQUEST؛ معها ⇒ RESOLVED + resolvedAt.
//  5) setWaiting ثم resume يراكم waitingAccumMs (>٠)؛ effectiveDueAt يزيد بمقدار الانتظار.
//  6) reopen خلال ٧ أيام ⇒ IN_PROGRESS + reopenCount=1؛ بعد ٨ أيام ⇒ BAD_REQUEST.
//  7) عزل الكتابة صارم حتى مع رؤية الطابور: زميل يرى مهمة NEW غير مسندة لكن لا يعلّق عليها؛
//     مهمة مُسنَدة صراحةً لغيره تبقى محجوبة رؤيةً وكتابةً.
//  8) إصلاح S2 حاصر — الطابور الوارد غير المسند: أيّ منفّذ في الفرع يراه ويسحبه (claim)؛ بعد
//     السحب يختفي عن الزميل الآخر؛ ومهمة مُسنَدة لغير الفاعل لا يراها إطلاقاً.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = ["taskEvents", "tasks", "waKeywordRules", "serviceTypes", "users", "branches"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير العام", email: "admin@t22.test", passwordHash: hashPassword("Admin@12345"), role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_mgr", name: "مدير الفرع", email: "mgr@t22.test", passwordHash: hashPassword("Admin@12345"), role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_cash_a", name: "كاشير أ", email: "ca@t22.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "local_cash_b", name: "كاشير ب", email: "cb@t22.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "local_print", name: "فني مطبعة", email: "po@t22.test", role: "print_operator", loginMethod: "local", branchId: 1 },
  ]);
}

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}
async function callerFor(id: number) {
  return appRouter.createCaller(makeCtx(await userById(id)));
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("tasks — آلة الحالات (FSM)", () => {
  it("1) createTask يولّد رقماً تسلسلياً + حدث SYSTEM واحد", async () => {
    const cashierA = await callerFor(3);
    const t1 = await cashierA.tasks.create({ branchId: 1, title: "طلب أول" });
    expect(t1.taskNumber).toMatch(/^TSK-1-\d{8}-00001$/);
    const t2 = await cashierA.tasks.create({ branchId: 1, title: "طلب ثانٍ" });
    expect(t2.taskNumber).toMatch(/^TSK-1-\d{8}-00002$/);

    const events = await db().select().from(s.taskEvents).where(eq(s.taskEvents.taskId, t1.taskId));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("SYSTEM");
    expect(events[0].note).toBe("أُنشئت المهمة");

    const row = (await db().select().from(s.tasks).where(eq(s.tasks.id, t1.taskId)))[0];
    expect(row.taskStatus).toBe("NEW");
  });

  it("2) claim على NEW يسند ويحوّل IN_PROGRESS + firstResponseAt؛ claim على مهمة مسنَدة لغيرك ⇒ CONFLICT", async () => {
    const cashierA = await callerFor(3);
    const cashierB = await callerFor(4);
    const created = await cashierA.tasks.create({ branchId: 1, title: "بحاجة متابعة" });

    const res = await cashierB.tasks.claim({ taskId: created.taskId });
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.assignedTo).toBe(4);
    const row = (await db().select().from(s.tasks).where(eq(s.tasks.id, created.taskId)))[0];
    expect(row.firstResponseAt).not.toBeNull();

    // claim ثانٍ (idempotent — نفس الفاعل) لا يرمي رغم أن الحالة صارت IN_PROGRESS ⇒ BAD_REQUEST
    // (claim مقصور على NEW فقط — التوثيق: «لا يمكن سحب المهمة إلا وهي جديدة»).
    await expect(cashierB.tasks.claim({ taskId: created.taskId })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // مهمة أخرى مُسنَدة لكاشير آخر عند الإنشاء — سحبها من غيره ⇒ CONFLICT (لا سرقة).
    const created2 = await cashierA.tasks.create({ branchId: 1, title: "أخرى", assignedTo: 4 });
    await expect(cashierA.tasks.claim({ taskId: created2.taskId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("3) انتقال ممنوع: resolve مباشرة من NEW ⇒ BAD_REQUEST", async () => {
    const cashierA = await callerFor(3);
    const manager = await callerFor(2);
    const created = await cashierA.tasks.create({ branchId: 1, title: "طلب" });
    await expect(manager.tasks.resolve({ taskId: created.taskId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("4) resolve مهمة SUPPORT بلا resolutionNote ⇒ BAD_REQUEST؛ معها ⇒ RESOLVED + resolvedAt", async () => {
    const cashierA = await callerFor(3);
    const created = await cashierA.tasks.create({ branchId: 1, title: "شكوى عميل", kind: "SUPPORT" });
    await cashierA.tasks.claim({ taskId: created.taskId });

    await expect(cashierA.tasks.resolve({ taskId: created.taskId })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const res = await cashierA.tasks.resolve({ taskId: created.taskId, resolutionNote: "تمّ الحلّ مع العميل" });
    expect(res.status).toBe("RESOLVED");
    const row = (await db().select().from(s.tasks).where(eq(s.tasks.id, created.taskId)))[0];
    expect(row.resolvedAt).not.toBeNull();
    expect(row.resolutionNote).toBe("تمّ الحلّ مع العميل");
  });

  it("5) setWaiting ثم resume يراكم waitingAccumMs (>٠)؛ effectiveDueAt يزيد بمقدار الانتظار", async () => {
    const cashierA = await callerFor(3);
    const dueAtIso = new Date(Date.now() + 3600_000).toISOString();
    const created = await cashierA.tasks.create({ branchId: 1, title: "طلب موقوت", dueAt: dueAtIso });
    await cashierA.tasks.claim({ taskId: created.taskId });
    await cashierA.tasks.setWaiting({ taskId: created.taskId });

    // نُبعد waitingSince ساعة للماضي ذرّياً عبر SQL — تراكمٌ محدَّد بلا اعتماد على توقيت التشغيل الفعلي.
    await db()
      .update(s.tasks)
      .set({ waitingSince: sql`DATE_SUB(NOW(), INTERVAL 1 HOUR)` })
      .where(eq(s.tasks.id, created.taskId));

    const before = (await db().select({ dueAt: s.tasks.dueAt }).from(s.tasks).where(eq(s.tasks.id, created.taskId)))[0];

    const res = await cashierA.tasks.resume({ taskId: created.taskId });
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.waitingAccumMs).toBeGreaterThan(0);

    const got = await cashierA.tasks.get({ taskId: created.taskId });
    expect(got.effectiveDueAt).not.toBeNull();
    expect(new Date(got.effectiveDueAt as unknown as string).getTime()).toBeGreaterThan(
      new Date(before.dueAt as unknown as string).getTime(),
    );
  });

  it("6) reopen خلال ٧ أيام ⇒ IN_PROGRESS + reopenCount=1؛ بعد ٨ أيام ⇒ BAD_REQUEST", async () => {
    const cashierA = await callerFor(3);
    const manager = await callerFor(2);

    const created = await cashierA.tasks.create({ branchId: 1, title: "طلب" });
    await cashierA.tasks.claim({ taskId: created.taskId });
    await cashierA.tasks.resolve({ taskId: created.taskId });
    const res = await manager.tasks.reopen({ taskId: created.taskId });
    expect(res.status).toBe("IN_PROGRESS");
    const row = (await db().select().from(s.tasks).where(eq(s.tasks.id, created.taskId)))[0];
    expect(row.reopenCount).toBe(1);

    const created2 = await cashierA.tasks.create({ branchId: 1, title: "طلب٢" });
    await cashierA.tasks.claim({ taskId: created2.taskId });
    await cashierA.tasks.resolve({ taskId: created2.taskId });
    await db()
      .update(s.tasks)
      .set({ resolvedAt: sql`DATE_SUB(NOW(), INTERVAL 8 DAY)` })
      .where(eq(s.tasks.id, created2.taskId));
    await expect(manager.tasks.reopen({ taskId: created2.taskId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("7) عزل الكتابة صارم حتى مع رؤية الطابور؛ مهمة مُسنَدة لغيره محجوبة رؤيةً وكتابةً", async () => {
    const cashierA = await callerFor(3);
    const cashierB = await callerFor(4);
    const created = await cashierA.tasks.create({ branchId: 1, title: "مهمة خاصة بكاشير أ" });

    // هذه المهمة NEW بلا assignedTo ⇒ طابور وارد مرئيّ للجميع في الفرع (إصلاح S2 حاصر) — كاشير ب
    // يراها في list/get رغم أنها ليست له، لكنه لا يستطيع الكتابة عليها (addComment يبقى بنطاق
    // الملكية الفعلية فقط — لا يُفتَح للطابور).
    const list = await cashierB.tasks.list({});
    expect(list.rows.find((r) => Number(r.id) === created.taskId)).toBeDefined();
    await expect(cashierB.tasks.get({ taskId: created.taskId })).resolves.toBeDefined();
    await expect(cashierB.tasks.addComment({ taskId: created.taskId, note: "تعليق" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // بالمقابل صاحب المهمة (المُنشئ) يستطيع التعليق عليها رغم عدم كونه المُسنَد إليه بعد.
    const commentRes = await cashierA.tasks.addComment({ taskId: created.taskId, note: "متابعة" });
    expect(commentRes.ok).toBe(true);

    // مهمة أخرى مُسنَدة صراحةً لكاشير أ عند الإنشاء (ليست NEW-غير-مسندة) — محجوبة تماماً عن كاشير ب
    // رؤيةً وكتابةً؛ عزل الملكية الحقيقي بلا تغيير.
    const createdAssigned = await cashierA.tasks.create({ branchId: 1, title: "مهمة مسنَدة صراحةً لكاشير أ", assignedTo: 3 });
    const list2 = await cashierB.tasks.list({});
    expect(list2.rows.find((r) => Number(r.id) === createdAssigned.taskId)).toBeUndefined();
    await expect(cashierB.tasks.get({ taskId: createdAssigned.taskId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("8) الطابور الوارد غير المسند: أيّ منفّذ يراه ويسحبه؛ بعد السحب يختفي عن الزميل؛ مهمة مُسنَدة لغيره لا تُرى", async () => {
    const admin = await callerFor(1);
    const cashierA = await callerFor(3);
    const cashierB = await callerFor(4);
    const printOp = await callerFor(5);

    // مهمة NEW بلا assignedTo/createdBy (تحاكي إنشاء واتساب التلقائي) — أنشأها admin فلا تتقاطع
    // مع عزل «أنشأها هو» لكاشير أ/ب، فتختبر طابور «غير المسند» بمعزلٍ عن الملكية.
    const created = await admin.tasks.create({ branchId: 1, title: "استفسار وارد تلقائياً" });
    const row = (await db().select().from(s.tasks).where(eq(s.tasks.id, created.taskId)))[0];
    expect(row.assignedTo).toBeNull();
    expect(row.createdBy).toBe(1);
    expect(row.taskStatus).toBe("NEW");

    // كل منفّذي الفرع (كاشير أ/ب وفنّي المطبعة) يرونها في list ويستطيعون فتحها.
    for (const caller of [cashierA, cashierB, printOp]) {
      const list = await caller.tasks.list({});
      expect(list.rows.find((r) => Number(r.id) === created.taskId)).toBeDefined();
      await expect(caller.tasks.get({ taskId: created.taskId })).resolves.toBeDefined();
    }

    // كاشير أ يسحبها (claim) — لا حارس ملكية سابق يمنع فتح غير المسند، فقط عزل الفرع + حالة NEW.
    const claimRes = await cashierA.tasks.claim({ taskId: created.taskId });
    expect(claimRes.status).toBe("IN_PROGRESS");
    expect(claimRes.assignedTo).toBe(3);

    // بعد السحب: كاشير ب (لا مُسنَد ولا مُنشئ، والمهمة لم تعُد NEW) لا يراها في list ولا get.
    const listBAfter = await cashierB.tasks.list({});
    expect(listBAfter.rows.find((r) => Number(r.id) === created.taskId)).toBeUndefined();
    await expect(cashierB.tasks.get({ taskId: created.taskId })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // كاشير أ (المُسنَد إليه الآن فعلاً) ما زال يراها بعد السحب.
    const listAAfter = await cashierA.tasks.list({});
    expect(listAAfter.rows.find((r) => Number(r.id) === created.taskId)).toBeDefined();
  });
});

/**
 * اختبارات cashHandoverService.createHandover (تسليم نقد كاشير ⇒ خزينة، treasury-stage2).
 * فجوة كانت موثَّقة: closeShift.handover مسار حقيقي في الإنتاج بصفر تغطية — لا اختبار existing
 * يمرّر كائن handover إطلاقاً (auditLogGaps.test.ts يستدعي shifts.close بلا handover).
 * يغطّي: المسار السعيد (رقم متسلسل + إيصالان + قيد CASH_HANDOVER)، حراسة المستلِم
 * (دور/نشاط/وجود)، حراسة المبلغ (> المعدود / صفر / سالب)، وحراسة الملكية/الفرع
 * الدفاعية داخل createHandover نفسها (غير قابلة للوصول عبر closeShift الذي يفحص
 * الملكية أولاً — لكنها كود إنتاج حقيقي يستحق تغطية مستقلة).
 */
import { desc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createHandover } from "../cashHandoverService";
import { closeShift, openShift } from "../shiftService";
import { withTx } from "../tx";
import { appRouter } from "../../routers";

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

const TABLES = [
  "accountingEntries",
  "receipts",
  "shifts",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

// معرّفات ثابتة لتسهيل القراءة.
const ADMIN = 1;
const MANAGER1 = 2; // فرع ١
const CASHIER1 = 3; // فرع ١ — صاحب الوردية في أغلب الاختبارات
const CASHIER2 = 4; // فرع ١ — كاشير آخر
const MANAGER2 = 5; // فرع ٢ — لاختبار عبور الفروع
const DISABLED_MANAGER = 6; // فرع ١، isActive=false

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: ADMIN, openId: "local_admin", name: "المدير العام", role: "admin", loginMethod: "local" },
    { id: MANAGER1, openId: "local_mgr1", name: "مدير الفرع١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CASHIER1, openId: "local_c1", name: "كاشير١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: CASHIER2, openId: "local_c2", name: "كاشير٢", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER2, openId: "local_mgr2", name: "مدير الفرع٢", role: "manager", loginMethod: "local", branchId: 2 },
    {
      id: DISABLED_MANAGER,
      openId: "local_mgr_off",
      name: "مدير معطَّل",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isActive: false,
    },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

async function receiptsByRef(ref: string) {
  return db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, ref));
}

async function shiftStatus(shiftId: number) {
  const rows = await db().select({ status: s.shifts.status }).from(s.shifts).where(eq(s.shifts.id, shiftId)).limit(1);
  return rows[0]?.status;
}

describe("cashHandoverService — عبر closeShift (المسار الحقيقي في الإنتاج)", () => {
  it("مسار سعيد: سند بِرقم مُسلسَل + إيصالان (OUT درج / IN خزينة) + قيد CASH_HANDOVER + الوردية تُغلَق", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "500" }, { userId: CASHIER1, branchId: 1 });

    const res = await closeShift(
      { shiftId, countedCash: "500", handover: { amount: "200", handoverTo: MANAGER1 } },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );

    expect(res.variance).toBe("0.00");
    expect(res.handover).toBeTruthy();
    const handoverNumber = res.handover!.handoverNumber;
    expect(handoverNumber).toMatch(/^CH-1-\d{8}-0001$/);

    const rows = await receiptsByRef(handoverNumber);
    expect(rows).toHaveLength(2);

    const out = rows.find((r) => r.direction === "OUT")!;
    expect(out).toBeTruthy();
    expect(out.branchId).toBe(1);
    expect(out.shiftId).toBe(shiftId);
    expect(out.cashBucket).toBe("DRAWER");
    expect(out.amount).toBe("200.00");
    expect(out.createdBy).toBe(CASHIER1);

    const inn = rows.find((r) => r.direction === "IN")!;
    expect(inn).toBeTruthy();
    expect(inn.branchId).toBe(1);
    expect(inn.shiftId).toBeNull();
    expect(inn.cashBucket).toBe("TREASURY");
    expect(inn.amount).toBe("200.00");
    expect(inn.createdBy).toBe(MANAGER1);

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "CASH_HANDOVER" as any));
    expect(entries).toHaveLength(1);
    expect(entries[0].dedupeKey).toBe(`CASH_HANDOVER:${handoverNumber}`);
    expect(entries[0].amount).toBe("200.00");
    expect(entries[0].branchId).toBe(1);
    expect(entries[0].receiptId).toBe(out.id);

    expect(await shiftStatus(shiftId)).toBe("CLOSED");
  });

  it("تسلسل الأرقام: تسليمان في نفس الفرع/اليوم ⇒ 0001 ثم 0002", async () => {
    const s1 = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });
    const r1 = await closeShift(
      { shiftId: s1.shiftId, countedCash: "100", handover: { amount: "50", handoverTo: MANAGER1 } },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );
    expect(r1.handover!.handoverNumber).toMatch(/-0001$/);

    const s2 = await openShift({ branchId: 1, openingBalance: "80" }, { userId: CASHIER2, branchId: 1 });
    const r2 = await closeShift(
      { shiftId: s2.shiftId, countedCash: "80", handover: { amount: "30", handoverTo: MANAGER1 } },
      { userId: CASHIER2, branchId: 1, role: "cashier" },
    );
    expect(r2.handover!.handoverNumber).toMatch(/-0002$/);
  });

  it("رفض: مبلغ التسليم أكبر من المعدود ⇒ BAD_REQUEST، ولا إيصال يُنشأ، والوردية تبقى مفتوحة", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      closeShift(
        { shiftId, countedCash: "100", handover: { amount: "200", handoverTo: MANAGER1 } },
        { userId: CASHIER1, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/لا يمكن تسليم أكثر من المعدود/);

    expect(await shiftStatus(shiftId)).toBe("OPEN");
    const all = await db().select().from(s.receipts);
    expect(all).toHaveLength(0);
  });

  it("رفض: المستلِم كاشير لا مديراً/إداريّاً ⇒ BAD_REQUEST، والوردية تبقى مفتوحة (rollback كامل)", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      closeShift(
        { shiftId, countedCash: "100", handover: { amount: "50", handoverTo: CASHIER2 } },
        { userId: CASHIER1, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/مديراً أو إدارياً/);

    expect(await shiftStatus(shiftId)).toBe("OPEN");
  });

  it("رفض: المستلِم معطَّل (isActive=false) ⇒ BAD_REQUEST", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      closeShift(
        { shiftId, countedCash: "100", handover: { amount: "50", handoverTo: DISABLED_MANAGER } },
        { userId: CASHIER1, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/غير موجود أو معطّل/);
  });

  it("رفض: المستلِم غير موجود أصلاً ⇒ BAD_REQUEST", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      closeShift(
        { shiftId, countedCash: "100", handover: { amount: "50", handoverTo: 999999 } },
        { userId: CASHIER1, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/غير موجود أو معطّل/);
  });

  it("رفض: مبلغ صفري ⇒ BAD_REQUEST (المبلغ يجب أن يكون موجباً)", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      closeShift(
        { shiftId, countedCash: "100", handover: { amount: "0.00", handoverTo: MANAGER1 } },
        { userId: CASHIER1, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/المبلغ يَجب أن يَكون موجباً/);
  });

  it("رفض: مبلغ سالب (يتجاوز تحقّق الراوتر نظرياً لو استُدعيت الخدمة مباشرة) ⇒ BAD_REQUEST", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      closeShift(
        { shiftId, countedCash: "100", handover: { amount: "-50", handoverTo: MANAGER1 } },
        { userId: CASHIER1, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/المبلغ يَجب أن يَكون موجباً/);
  });
});

describe("cashHandoverService.createHandover — استدعاء مباشر (حراسة دفاع-في-العمق)", () => {
  // ملاحظة: closeShift نفسها تفحص الملكية/الفرع (سياسة #14) قبل الوصول لـcreateHandover،
  // فهذه الحراسات داخل createHandover غير قابلة للوصول فعلياً عبر closeShift اليوم —
  // لكنها كود إنتاج حقيقي (أيّ مستدعٍ مستقبلي لـcreateHandover مباشرة) يستحق تغطية مستقلّة.

  it("مدير من فرع آخر يحاول تسليم نقد من وردية فرع مختلف مباشرة ⇒ FORBIDDEN", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      withTx((tx) =>
        createHandover(tx, { shiftId, amount: "50", handoverTo: MANAGER1 }, { userId: MANAGER2, branchId: 2, role: "manager" }),
      ),
    ).rejects.toThrow(/لا يمكنك تسليم نقد من وردية فرع آخر/);

    expect(await shiftStatus(shiftId)).toBe("OPEN");
  });

  it("كاشير آخر يحاول تسليم نقد من وردية زميله مباشرة ⇒ FORBIDDEN", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    await expect(
      withTx((tx) =>
        createHandover(tx, { shiftId, amount: "50", handoverTo: MANAGER1 }, { userId: CASHIER2, branchId: 1, role: "cashier" }),
      ),
    ).rejects.toThrow(/لا يمكنك تسليم نقد من وردية موظّف آخر/);
  });

  it("admin يتجاوز فحص الملكية/الفرع تماماً (مرور حرّ)", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });

    const result = await withTx((tx) =>
      createHandover(tx, { shiftId, amount: "50", handoverTo: MANAGER1 }, { userId: ADMIN, branchId: 2, role: "admin" }),
    );
    expect(result.handoverNumber).toMatch(/^CH-1-\d{8}-0001$/);
  });

  it("رفض: الوردية غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(
      withTx((tx) =>
        createHandover(tx, { shiftId: 999999, amount: "50", handoverTo: MANAGER1 }, { userId: ADMIN, branchId: 1, role: "admin" }),
      ),
    ).rejects.toThrow(/الوردية غير موجودة/);
  });

  it("رفض: الوردية مغلقة بالفعل ⇒ BAD_REQUEST", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100" }, { userId: CASHIER1, branchId: 1 });
    await closeShift({ shiftId, countedCash: "100" }, { userId: CASHIER1, branchId: 1, role: "cashier" });

    await expect(
      withTx((tx) =>
        createHandover(tx, { shiftId, amount: "50", handoverTo: MANAGER1 }, { userId: ADMIN, branchId: 1, role: "admin" }),
      ),
    ).rejects.toThrow(/الوردية مغلقة بالفعل/);
  });
});

describe("shifts.handoverRecipients — منتقي المستلِمين (الواجهة)", () => {
  it("الكاشير يرى المديرين/الإداريين النشطين فقط (لا كاشير، لا معطَّل)، مرتّبين بالاسم", async () => {
    const caller = appRouter.createCaller(
      makeCtx({ id: CASHIER1, role: "cashier", branchId: 1, name: "كاشير١" }),
    );
    const rows = await caller.shifts.handoverRecipients();

    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    // ADMIN + MANAGER1 + MANAGER2 فقط — لا كاشيرين ولا المدير المعطَّل.
    expect(ids).toEqual([ADMIN, MANAGER1, MANAGER2]);
    expect(rows.some((r) => r.id === CASHIER1 || r.id === CASHIER2)).toBe(false);
    expect(rows.some((r) => r.id === DISABLED_MANAGER)).toBe(false);
    // كل صفّ يحمل اسماً غير فارغ (المنتقي يعرضه).
    expect(rows.every((r) => typeof r.name === "string" && r.name.length > 0)).toBe(true);
  });

  it("متاحٌ للمدير أيضاً (نفس بوّابة الإغلاق)", async () => {
    const caller = appRouter.createCaller(
      makeCtx({ id: MANAGER1, role: "manager", branchId: 1, name: "مدير الفرع١" }),
    );
    const rows = await caller.shifts.handoverRecipients();
    expect(rows.length).toBe(3);
  });
});

/**
 * ①ج استمرارية نقد الورديات — مطابقة الرصيد الافتتاحيّ للوردية بالمتبقّي فعلياً في الدرج بعد إغلاق
 * آخر وردية مغلقة لنفس (الفرع×النوع): المتبقّي = المعدود − المُسلَّم للخزينة عند الإغلاق. عند اختلاف
 * المُدخَل عن المتوقَّع ⇒ سببٌ إلزاميّ يُسجَّل تدقيقياً (تحذيرٌ لا حظر). أوّل وردية ⇒ لا مطابقة.
 *
 * يغطّي (حسب مطالب الشريحة): (أ) نفس المتبقّي ⇒ لا تحذير/سبب · (ب) مبلغٌ مختلف ⇒ سبب إلزاميّ
 * ومُسجَّل · (ج) أوّل وردية ⇒ لا مطابقة · (د) صفر انحدار: closeShift يخزّن المتبقّي بلا كسر السلوك.
 * + عزل الفرع/النوع + اختيار آخر مغلقة + قراءة expectedOpening (خدمة + راوتر).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, getExpectedOpening, openShift } from "../shiftService";
import { appRouter } from "../../routers";

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

const TABLES = ["auditLogs", "accountingEntries", "receipts", "shifts", "users", "branches"];

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

const ADMIN = 1;
const MANAGER1 = 2; // فرع ١ — مستلِم التسليم
const CASHIER1 = 3; // فرع ١
const CASHIER2 = 4; // فرع ١ — الكاشير التالي على نفس الدرج
const MANAGER2 = 5; // فرع ٢

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
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

async function shiftRow(id: number) {
  return (await db().select().from(s.shifts).where(eq(s.shifts.id, id)).limit(1))[0];
}

/** يفتح ثم يُغلق وردية ويُرجِع معرّفها (المتبقّي المخزَّن = counted − handover). */
async function closeWith(opts: {
  user: number;
  opening: string;
  counted: string;
  handover?: string;
  branchId?: number;
  shiftType?: "RETAIL" | "RECEPTION";
}) {
  const branchId = opts.branchId ?? 1;
  const shiftType = opts.shiftType ?? "RETAIL";
  // سببٌ ثابت للتهيئة: يُتجاهَل حين لا اختلاف، ويُمرَّر حين يُهيّئ الاختبار وردية تالية على درجٍ له
  // متبقٍّ سابق (لئلّا تُرفَض التهيئة بحارس الاستمرارية نفسه الذي نختبره).
  const { shiftId } = await openShift(
    { branchId, openingBalance: opts.opening, shiftType, openingDiscrepancyReason: "تهيئة اختبار" },
    { userId: opts.user, branchId },
  );
  await closeShift(
    {
      shiftId,
      countedCash: opts.counted,
      handover: opts.handover ? { amount: opts.handover, handoverTo: MANAGER1 } : null,
    },
    { userId: opts.user, branchId, role: "cashier" },
  );
  return shiftId;
}

describe("①ج استمرارية نقد الورديات — الخدمة", () => {
  it("(أ) فتح وردية تالية بنفس المتبقّي ⇒ لا تحذير ولا سبب مطلوب", async () => {
    const s1 = await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300
    expect((await shiftRow(s1)).closingDrawerCash).toBe("300.00");

    const res = await openShift(
      { branchId: 1, openingBalance: "300", shiftType: "RETAIL" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(res.hasDiscrepancy).toBe(false);
    expect(res.expectedOpening).toBe("300.00");
    expect(res.discrepancyReason).toBeNull();

    const row2 = await shiftRow(res.shiftId);
    expect(row2.openingExpectedCash).toBe("300.00");
    expect(row2.openingDiscrepancyReason).toBeNull();
  });

  it("المتبقّي بلا تسليم = المعدود كاملاً ⇒ يُطابَق بلا تحذير", async () => {
    const s1 = await closeWith({ user: CASHIER1, opening: "0", counted: "750" }); // بلا تسليم
    expect((await shiftRow(s1)).closingDrawerCash).toBe("750.00");

    const res = await openShift(
      { branchId: 1, openingBalance: "750", shiftType: "RETAIL" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(res.hasDiscrepancy).toBe(false);
    expect(res.expectedOpening).toBe("750.00");
  });

  it("(ب) فتح بمبلغ مختلف بلا سبب ⇒ يُرفَض (سبب مطلوب) ولا وردية تُنشأ", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300

    await expect(
      openShift({ branchId: 1, openingBalance: "500", shiftType: "RETAIL" }, { userId: CASHIER2, branchId: 1 }),
    ).rejects.toThrow(/سبب الاختلاف/);

    const stillOpen = await db()
      .select()
      .from(s.shifts)
      .where(and(eq(s.shifts.userId, CASHIER2), eq(s.shifts.status, "OPEN")));
    expect(stillOpen).toHaveLength(0);
  });

  it("(ب) فتح بمبلغ مختلف مع سبب ⇒ ينجح ويُخزَّن السبب + المتوقَّع + الفرق", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300

    const res = await openShift(
      { branchId: 1, openingBalance: "500", shiftType: "RETAIL", openingDiscrepancyReason: "إيداع فكّة من الخزينة" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(res.hasDiscrepancy).toBe(true);
    expect(res.expectedOpening).toBe("300.00");
    expect(res.difference).toBe("200.00");

    const row = await shiftRow(res.shiftId);
    expect(row.openingExpectedCash).toBe("300.00");
    expect(row.openingDiscrepancyReason).toBe("إيداع فكّة من الخزينة");
  });

  it("عتبة صغيرة: فرقٌ ≥ 0.01 يُعدّ اختلافاً (0.01 يستوجب سبباً)", async () => {
    await closeWith({ user: CASHIER1, opening: "0", counted: "300" }); // متبقٍّ 300.00

    await expect(
      openShift({ branchId: 1, openingBalance: "300.01", shiftType: "RETAIL" }, { userId: CASHIER2, branchId: 1 }),
    ).rejects.toThrow(/سبب الاختلاف/);
  });

  it("المطابقة بلا اختلاف لا تُخزّن سبباً حتى لو مُرِّر عبثاً", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300

    const res = await openShift(
      { branchId: 1, openingBalance: "300", shiftType: "RETAIL", openingDiscrepancyReason: "سبب لا داعي له" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(res.hasDiscrepancy).toBe(false);
    expect((await shiftRow(res.shiftId)).openingDiscrepancyReason).toBeNull();
  });

  it("(ج) أوّل وردية للفرع (لا سابقة مغلقة) ⇒ لا مطابقة، أيّ مبلغ يُقبَل بلا سبب", async () => {
    const res = await openShift(
      { branchId: 1, openingBalance: "123456", shiftType: "RETAIL" },
      { userId: CASHIER1, branchId: 1 },
    );
    expect(res.hasDiscrepancy).toBe(false);
    expect(res.expectedOpening).toBeNull();

    const row = await shiftRow(res.shiftId);
    expect(row.openingExpectedCash).toBeNull();
    expect(row.openingDiscrepancyReason).toBeNull();
  });

  it("(ج) وردية مفتوحة (غير مغلقة) لا تُعدّ سابقة ⇒ لا مطابقة", async () => {
    await openShift({ branchId: 1, openingBalance: "500", shiftType: "RETAIL" }, { userId: CASHIER1, branchId: 1 }); // تبقى OPEN
    const res = await openShift(
      { branchId: 1, openingBalance: "999", shiftType: "RETAIL" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(res.expectedOpening).toBeNull();
    expect(res.hasDiscrepancy).toBe(false);
  });

  it("عزل النوع: متبقّي RETAIL لا يُطابَق بوردية RECEPTION (درجان مستقلّان)", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "300" }); // RETAIL متبقٍّ 300
    const res = await openShift(
      { branchId: 1, openingBalance: "999", shiftType: "RECEPTION" },
      { userId: CASHIER1, branchId: 1 },
    );
    expect(res.expectedOpening).toBeNull();
    expect(res.hasDiscrepancy).toBe(false);
  });

  it("عزل الفرع: متبقّي فرع١ لا يُطابَق بوردية فرع٢", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "300" }); // فرع١ متبقٍّ 300
    const res = await openShift(
      { branchId: 2, openingBalance: "999", shiftType: "RETAIL" },
      { userId: MANAGER2, branchId: 2 },
    );
    expect(res.expectedOpening).toBeNull();
  });

  it("(د) صفر انحدار: الإغلاق يخزّن المتبقّي = المعدود − المُسلَّم (من المعدود لا المتوقَّع)", async () => {
    // opening 1000، counted 800 (عجز 200 عن المتوقَّع)، تسليم 300 ⇒ المتبقّي = 800 − 300 = 500.
    const s1 = await closeWith({ user: CASHIER1, opening: "1000", counted: "800", handover: "300" });
    const row = await shiftRow(s1);
    expect(row.closingDrawerCash).toBe("500.00");
    expect(row.variance).toBe("-200.00"); // السلوك القائم لم يُكسَر
    expect(row.countedCash).toBe("800.00");
  });

  it("تختار آخر وردية مغلقة (الأحدث إغلاقاً)", async () => {
    await closeWith({ user: CASHIER1, opening: "0", counted: "300" }); // الأقدم — متبقٍّ 300
    await closeWith({ user: CASHIER2, opening: "0", counted: "450" }); // الأحدث — متبقٍّ 450

    const res = await openShift(
      { branchId: 1, openingBalance: "450", shiftType: "RETAIL" },
      { userId: CASHIER1, branchId: 1 },
    );
    expect(res.expectedOpening).toBe("450.00");
    expect(res.hasDiscrepancy).toBe(false);
  });

  it("تعدّد الكاشير: وردية ثالثة لا تُطابَق بمتبقٍّ استهلكته وردية مفتوحة سابقة (Codex P2)", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // A: متبقٍّ 300
    // B تفتح على نفس الدرج بـ300 (تُطابِق وتستهلك المتبقّي) وتبقى مفتوحة
    const b = await openShift(
      { branchId: 1, openingBalance: "300", shiftType: "RETAIL" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(b.hasDiscrepancy).toBe(false);
    // C (وردية ثالثة متزامنة) ⇒ لا مطابقة (المتبقّي استُهلك) ⇒ أيّ مبلغ بلا سبب، بلا فجوة زائفة
    const c = await openShift(
      { branchId: 1, openingBalance: "0", shiftType: "RETAIL" },
      { userId: ADMIN, branchId: 1 },
    );
    expect(c.expectedOpening).toBeNull();
    expect(c.hasDiscrepancy).toBe(false);
    // القراءة تعكس ذلك (لا تعرض متبقّياً مُستهلَكاً)
    expect((await getExpectedOpening(1, "RETAIL")).expected).toBeNull();
  });

  it("getExpectedOpening (خدمة): يعيد المتبقّي، وnull للنوع/الفرع المختلف وحين لا سابقة", async () => {
    expect((await getExpectedOpening(1, "RETAIL")).expected).toBeNull();
    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300
    expect((await getExpectedOpening(1, "RETAIL")).expected).toBe("300.00");
    expect((await getExpectedOpening(1, "RECEPTION")).expected).toBeNull();
    expect((await getExpectedOpening(2, "RETAIL")).expected).toBeNull();
  });

  it("انحدار #320: كشف «الاستهلاك» بالمعرّف الرتيب لا بالساعة — انزياح openedAt للماضي لا يُعيد المطابقة", async () => {
    // A تُغلق بمتبقٍّ 300، ثم B تفتح على نفس الدرج وتستهلكه وتبقى مفتوحة.
    const aId = await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" });
    const b = await openShift(
      { branchId: 1, openingBalance: "300", shiftType: "RETAIL" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(b.hasDiscrepancy).toBe(false);

    // نحاكي تخلُّف ساعة القاعدة: openedAt للوردية B (defaultNow — ساعة القاعدة) يُقتطَع لثانيةٍ أسبق من
    // closedAt للوردية A (new Date — ساعة التطبيق). الكشف السليم يجب ألّا يعتمد على هذا التباين: الشيفرة
    // القديمة (gte openedAt≥closedAt) كانت تُخطئ B فتُعيد مطابقة المتبقّي المُستهلَك لوردية ثالثة (فجوة
    // استمرارية زائفة متقطّعة على #320). الكشف بالمعرّف الرتيب يُبطِل التباين حتماً — هذا الاختبار يفشل
    // على الشيفرة القديمة (openShift لِـC يرمي «سبب الاختلاف») ويمرّ على الجديدة.
    const aRow = await shiftRow(aId);
    await db()
      .update(s.shifts)
      .set({ openedAt: new Date(new Date(aRow.closedAt!).getTime() - 5000) }) // B.openedAt = A.closedAt − 5s
      .where(eq(s.shifts.id, b.shiftId));

    // C (ثالثة) ⇒ لا مطابقة رغم أنّ openedAt(B) < closedAt(A). المطابقة بالمعرّف لا بالساعة.
    const c = await openShift(
      { branchId: 1, openingBalance: "0", shiftType: "RETAIL" },
      { userId: ADMIN, branchId: 1 },
    );
    expect(c.expectedOpening).toBeNull();
    expect(c.hasDiscrepancy).toBe(false);
    expect((await getExpectedOpening(1, "RETAIL")).expected).toBeNull();
  });
});

describe("①ج استمرارية نقد الورديات — الراوتر (open + expectedOpening + التدقيق)", () => {
  it("expectedOpening (راوتر) يعيد المتبقّي للكاشير على فرعه", async () => {
    const caller = appRouter.createCaller(makeCtx({ id: CASHIER1, role: "cashier", branchId: 1, name: "كاشير١" }));
    expect((await caller.shifts.expectedOpening({ branchId: 1, shiftType: "RETAIL" })).expected).toBeNull();

    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300
    expect((await caller.shifts.expectedOpening({ branchId: 1, shiftType: "RETAIL" })).expected).toBe("300.00");
  });

  it("open (راوتر) بفرقٍ + سبب ⇒ ينجح ويُسجَّل تدقيقياً (hasDiscrepancy + المتوقَّع + السبب + entityId)", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300
    const caller = appRouter.createCaller(makeCtx({ id: CASHIER2, role: "cashier", branchId: 1, name: "كاشير٢" }));

    const res = await caller.shifts.open({
      branchId: 1,
      openingBalance: "500",
      shiftType: "RETAIL",
      openingDiscrepancyReason: "بدء برصيد جديد من الخزينة",
    });
    expect(res.hasDiscrepancy).toBe(true);

    const logs = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "shift.open"))
      .orderBy(desc(s.auditLogs.id))
      .limit(1);
    expect(logs).toHaveLength(1);
    const nv = logs[0].newValue as any;
    expect(nv.hasDiscrepancy).toBe(true);
    expect(nv.expectedOpening).toBe("300.00");
    expect(nv.difference).toBe("200.00");
    expect(nv.discrepancyReason).toBe("بدء برصيد جديد من الخزينة");
    // entityId كان undefined (openShift يُرجِع shiftId لا id) — أُصلح ليشير للوردية.
    expect(String(logs[0].entityId)).toBe(String(res.shiftId));
  });

  it("open (راوتر) بفرقٍ بلا سبب ⇒ يُرفَض", async () => {
    await closeWith({ user: CASHIER1, opening: "500", counted: "500", handover: "200" }); // متبقٍّ 300
    const caller = appRouter.createCaller(makeCtx({ id: CASHIER2, role: "cashier", branchId: 1, name: "كاشير٢" }));

    await expect(
      caller.shifts.open({ branchId: 1, openingBalance: "500", shiftType: "RETAIL" }),
    ).rejects.toThrow(/سبب الاختلاف/);
  });
});

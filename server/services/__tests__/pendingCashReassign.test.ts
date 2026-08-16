import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

/**
 * المسار أ من ورقة الإصلاحات (١٦/٨): «نقدٌ يعلق بلا مالك».
 *
 * قبل هذه الشريحة: إيصال الخزينة IN يُنشأ PENDING مقفولاً على المستلم عبر `createdBy`،
 * ولا يملك أحدٌ — ولا المدير — إعادة إسناده. إن عُطّل المستلم أو غادر، فالنقد يبقى
 * خارج رصيد الخزينة أبداً بلا مسار تسوية ولا ظهورٍ في أيّ تقرير.
 * الدليل الحيّ (١٦/٨): سندٌ واحد بـ٥٠٬٠٠٠ د.ع معلّق منذ ١٢/٨ على الإنتاج.
 */

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

const HOLDER = 31;      // المستلم الأصليّ (يُعطَّل لاحقاً)
const NEW_HOLDER = 32;  // المستلم البديل
const MANAGER = 33;     // المدير الذي يُعيد الإسناد
const CASHIER = 34;     // لا يملك إعادة الإسناد
const OTHER_BRANCH = 35;

async function user(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

async function pendingContract(
  createdBy = HOLDER,
  referenceNumber = "CD-1-20260816-0001",
  stageSource = true,
  sourceCreatedBy = CASHIER,
) {
  if (stageSource) {
    const sourceResult = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "50000",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      referenceNumber,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      createdBy: sourceCreatedBy,
    });
    const sourceReceiptId = Number(
      (sourceResult as any)[0]?.insertId ?? (sourceResult as any).insertId,
    );
    await db().insert(s.accountingEntries).values({
      entryType: "CASH_TRANSFER_OUT",
      branchId: 1,
      receiptId: sourceReceiptId,
      amount: "50000",
      entryDate: sql`CURDATE()` as unknown as string,
      dedupeKey: `TEST:CASH_DROP:${referenceNumber}`,
    });
  }
  const result = await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "50000",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber,
    status: "PENDING",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    description: "عهدة نقد معلّقة",
    createdBy,
  });
  return Number((result as any)[0]?.insertId ?? (result as any).insertId);
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["auditLogs", "accountingEntries", "receipts", "shifts", "users", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Sales", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: HOLDER, openId: "pc-holder", name: "المستلم الأصلي", role: "manager", loginMethod: "local", branchId: 1 },
    { id: NEW_HOLDER, openId: "pc-new", name: "المستلم البديل", role: "manager", loginMethod: "local", branchId: 1 },
    { id: MANAGER, openId: "pc-manager", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CASHIER, openId: "pc-cashier", name: "الكاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: OTHER_BRANCH, openId: "pc-other", name: "مدير فرع آخر", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
});

describe("المسار أ — حوكمة النقد المعلَّق", () => {
  it("القاعدة تمنع رقمَي سحبٍ متطابقين لنفس الاتجاه، وتسمح بزوج OUT/IN بالتصميم", async () => {
    await pendingContract(HOLDER, "CD-1-20260816-0009", false);
    // نفس الرقم باتجاه OUT = التصميم السليم (سند الدرج المقابل) ⇒ يُقبَل.
    await db().insert(s.receipts).values({
      branchId: 1, direction: "OUT", amount: "50000", paymentMethod: "CASH", cashBucket: "DRAWER",
      referenceNumber: "CD-1-20260816-0009", status: "COMPLETED", partyType: "OTHER", createdBy: CASHIER,
    });
    // تكرار نفس (الرقم، الاتجاه) ⇒ يجب أن ترفضه القاعدة نفسها لا التطبيق.
    await expect(pendingContract(NEW_HOLDER, "CD-1-20260816-0009")).rejects.toThrow();
  });

  it("طابور المدير يُظهر العهد المعلّقة كلّها بعمرها — لا المسندة إليه وحده", async () => {
    await pendingContract(HOLDER, "CD-1-20260816-0001");
    await pendingContract(NEW_HOLDER, "CD-1-20260816-0002");
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));

    // الطابور الشخصيّ القائم يرى صفراً (لا شيء مسندٌ للمدير) — وهذا بالضبط أصل العمى.
    expect(await manager.treasury.pendingHandoverReceipts()).toEqual([]);

    const queue = await manager.treasury.pendingHandoverQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({ amount: "50000.00", assignedToName: "المستلم الأصلي" });
    expect(queue[0].ageDays).toBeGreaterThanOrEqual(0);
  });

  it("المدير يُعيد إسناد عهدة مستلمٍ معطَّل فتخرج من العدم", async () => {
    const receiptId = await pendingContract(HOLDER);
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, HOLDER));

    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    await manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: NEW_HOLDER });

    const newHolder = appRouter.createCaller(makeCtx(await user(NEW_HOLDER)));
    const queue = await newHolder.treasury.pendingHandoverReceipts();
    expect(queue.map((r: any) => r.id)).toContain(receiptId);

    // وتصبح قابلةً للقبول فعلياً — لا مجرّد ظهور.
    await newHolder.treasury.acceptHandoverReceipt({ receiptId });
    const row = (await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId)))[0];
    expect(row.status).toBe("COMPLETED");
  });

  it("إعادة الإسناد تكتب أثراً يحمل المستلمَين معاً", async () => {
    const receiptId = await pendingContract(HOLDER);
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    await manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: NEW_HOLDER });

    const logs = await db().select().from(s.auditLogs).where(eq(s.auditLogs.entityId, receiptId));
    const entry = logs.find((l) => l.action === "treasury.handover.reassign");
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry!.oldValue)).toContain(String(HOLDER));
    expect(JSON.stringify(entry!.newValue)).toContain(String(NEW_HOLDER));
  });

  it("الكاشير لا يُعيد الإسناد", async () => {
    const receiptId = await pendingContract(HOLDER);
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(
      cashier.treasury.reassignHandoverReceipt({ receiptId, toUserId: NEW_HOLDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("المستلم البديل يجب أن يكون مديراً نشطاً من فرع العهدة", async () => {
    const receiptId = await pendingContract(HOLDER);
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));

    await expect(
      manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: CASHIER }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: OTHER_BRANCH }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, NEW_HOLDER));
    await expect(
      manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: NEW_HOLDER }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("لا تُسنَد العهدة إلى مُسلِّم النقد نفسه — لا يُطوى الشاهدان بشخصٍ واحد", async () => {
    // سند الدرج المقابل أنشأه MANAGER (أي أنّه المُسلِّم). إسناد عهدته إليه = قبولٌ ذاتيّ
    // يلتفّ على شرط createCashDrop («المُسلِّم ليس المستلم»).
    const receiptId = await pendingContract(
      HOLDER,
      "CD-1-20260816-0007",
      true,
      MANAGER,
    );
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    await expect(
      manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: MANAGER }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // وتبقى إعادة الإسناد لطرفٍ ثالث ممكنة.
    await manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: NEW_HOLDER });
    const row = (await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId)))[0];
    expect(Number(row.createdBy)).toBe(NEW_HOLDER);
  });

  it("مرجعٌ حرٌّ يبدأ بـCD- (سند بنكيّ) لا يحجزه قيد التفرّد", async () => {
    // `referenceNumber` حقلٌ حرّ؛ حجزُ كل ما يبدأ بـ«CD-» كان يمنع سندين بنكيَّين بنفس المرجع.
    const mk = (ref: string) =>
      db().insert(s.receipts).values({
        branchId: 1, direction: "IN", amount: "1000", paymentMethod: "TRANSFER",
        referenceNumber: ref, status: "COMPLETED", partyType: "OTHER", createdBy: MANAGER,
      });
    await mk("CD-BANK-991");
    await expect(mk("CD-BANK-991")).resolves.toBeTruthy();
  });

  it("عهدة مقبولة لا تُعاد إسناداً", async () => {
    const receiptId = await pendingContract(HOLDER);
    const holder = appRouter.createCaller(makeCtx(await user(HOLDER)));
    await holder.treasury.acceptHandoverReceipt({ receiptId });

    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    await expect(
      manager.treasury.reassignHandoverReceipt({ receiptId, toUserId: NEW_HOLDER }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

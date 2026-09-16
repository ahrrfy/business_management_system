/**
 * **خدمةُ منتقي روافد الردّ الموحَّدة** — تختبرها بحالاتٍ حقيقيّة يُتوقّع فيها الرفض:
 *  ① مستندٌ غير موجود ⇒ `NOT_FOUND` مقروء بمصطلحه العربيّ.
 *  ② فرعٌ آخر لغير مَن يعبُر الفروع ⇒ `FORBIDDEN` مقروء.
 *  ③ عزلُ الفرع لا يُطبَّق على مَن يعبُر الفروع (admin).
 *  ④ حجبُ رصيد الخزينة/الأدراج عن مَن لا يملك `treasury:READ`.
 *  ⑤ التوزيع الصحيح لأنواع المستندات الأربعة (WORKORDER_CANCEL/REVERSE_DELIVERY/CONSIGNMENT_RETURN/SALE_RETURN).
 *  ⑥ خريطةُ الروافد `rails` (م٢ ذيل): ما لا يقبله فعلُ التنفيذ يُعلَن بسببه ولا يُخفى.
 *
 * ⚠️ الاختبارُ لا يعيد اختبارَ منطقِ الحساب — ذلك مغطّى في `refundPreflightAppliedGap.test.ts`
 * وفي `deliveryFlow.test.ts` وأخواتها. هنا نختبر **البوّابة والتوزيع** لا الحسبة.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";
import { refundRailPreflight, type RefundRailActor } from "../refundRailService";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
  "orderPayments",
  "receptionDrafts",
  "deliveryConsignments",
  "workOrders",
  "shifts",
  "customers",
  "branches",
  "users",
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

async function seedBase() {
  const d = db();
  await d
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "SALES", code: "SALES", type: "SALES" },
    ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "reception", name: "استقبال ١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "reception2", name: "استقبال ٢", role: "cashier", loginMethod: "local", branchId: 2 },
    { id: 4, openId: "manager", name: "مديرة", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d
    .insert(s.customers)
    .values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
}

async function openReceptionShiftWithCash(branchId: number, userId: number, cash: string): Promise<number> {
  const shiftId = extractInsertId(
    await db()
      .insert(s.shifts)
      .values({
        branchId,
        userId,
        openingBalance: "0",
        shiftStatus: "OPEN",
        shiftType: "RECEPTION",
        openGuard: `g-${randomUUID().slice(0, 8)}`,
      }),
  );
  await db().insert(s.receipts).values({
    branchId,
    shiftId,
    direction: "IN",
    amount: cash,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    createdBy: userId,
  });
  return shiftId;
}

async function workOrderWithDeposit(branchId: number, shiftId: number, deposit: string): Promise<number> {
  const workOrderId = extractInsertId(
    await db()
      .insert(s.workOrders)
      .values({
        orderNumber: `WO-${randomUUID().slice(0, 6)}`,
        branchId,
        customerId: 1,
        title: "أمرٌ بعربونٍ مباشر",
        quantity: 1,
        materialsCost: "0.00",
        laborCost: "0.00",
        salePrice: "10000.00",
        status: "RECEIVED",
        deposit,
        paymentMethod: "CASH",
        createdBy: 2,
      }),
  );
  await db().insert(s.receipts).values({
    branchId,
    shiftId,
    workOrderId,
    direction: "IN",
    amount: deposit,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "CUSTOMER",
    partyId: 1,
    createdBy: 2,
  });
  return workOrderId;
}

// قالب `cashier` صار يمنح `treasury: "READ"` (٢/٩/٢٦ سياسة الاستقبال الهجين)، فلا يعود
// كاشيراً «بلا treasury» تلقائياً. نُلغي بـ`permissionsOverride` لنُبقي قصدَ الاختبار:
// «موظّفٌ عنده workorders لكن بلا treasury:READ» — نموذجٌ حيّ (مدير مبيعات، مثلاً).
const RECEPTION_STAFF: RefundRailActor = {
  userId: 2,
  branchId: 1,
  role: "cashier",
  permissionsOverride: { treasury: "NONE" } as unknown as RefundRailActor["permissionsOverride"],
};
const OTHER_BRANCH_STAFF: RefundRailActor = { userId: 3, branchId: 2, role: "cashier" };
const ADMIN: RefundRailActor = { userId: 1, branchId: 1, role: "admin", isOwner: true };
const MANAGER_B1: RefundRailActor = { userId: 4, branchId: 1, role: "manager" };

describe("خدمةُ روافد الردّ الموحَّدة — العزلُ والتوزيع", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("⭐ ①  مستندٌ غير موجود ⇒ NOT_FOUND برسالةٍ عربيةٍ بمصطلحه", async () => {
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "WORKORDER_CANCEL", sourceDocId: 999999 },
          RECEPTION_STAFF,
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toMatch(/إلغاء طلب خدمة/);
    expect((caught as TRPCError).message).toMatch(/999999/);
  });

  it("⭐ ②  فرعٌ آخر لكاشير الفرع ⇒ FORBIDDEN بلا كشفِ رصيدٍ ولا أدراج", async () => {
    const shiftB2 = await openReceptionShiftWithCash(2, 3, "50000.00");
    const woB2 = await workOrderWithDeposit(2, shiftB2, "3000.00");
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "WORKORDER_CANCEL", sourceDocId: woB2 },
          RECEPTION_STAFF, // فرع ١
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
    expect((caught as TRPCError).message).toMatch(/لا يخصّ فرعك/);
  });

  it("⭐ ③  admin/isOwner يعبُر الفروع — يقرأ تمهيدَ فرعٍ آخرَ بلا FORBIDDEN", async () => {
    const shiftB2 = await openReceptionShiftWithCash(2, 3, "50000.00");
    const woB2 = await workOrderWithDeposit(2, shiftB2, "3000.00");
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_CANCEL", sourceDocId: woB2 },
        ADMIN,
      ),
    );
    expect(res.needsCashDrawer).toBe(true);
    expect(res.branchId).toBe(2);
    expect(res.estimatedCashOut).toBe("3000.00");
  });

  it("⭐ ④  حجبُ رصيد الخزينة عن مَن لا يملك `treasury:READ` — علَمُ الكفاية باقٍ", async () => {
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const wo = await workOrderWithDeposit(1, shift, "3000.00");
    // كاشير الاستقبال في الفرع ١ — بلا `treasury:READ` (قالب دور cashier لا يمنحه).
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_CANCEL", sourceDocId: wo },
        RECEPTION_STAFF,
      ),
    );
    expect(res.needsCashDrawer).toBe(true);
    // الرقم محجوب، والعلَم يكفي للقرار.
    expect(res.treasuryCash).toBeNull();
    expect(res.drawers[0]!.expectedCash).toBeUndefined();
    expect(res.drawers[0]!.sufficient).toBe(true);
  });

  it("⑤  admin يرى الأرقام (`exposeCash=true`) على نفس المستند", async () => {
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const wo = await workOrderWithDeposit(1, shift, "3000.00");
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_CANCEL", sourceDocId: wo },
        ADMIN,
      ),
    );
    expect(res.drawers[0]!.expectedCash).toBe("53000.00");
    // الخزينةُ خاويةٌ للفرع، فرقمُها 0.00 لا null.
    expect(res.treasuryCash).toBe("0.00");
  });

  it("⑥  مدير الفرع يرى الأرقام (يملك treasury:READ بقالبه) لكن على فرعه فقط", async () => {
    const shiftB2 = await openReceptionShiftWithCash(2, 3, "50000.00");
    const woB2 = await workOrderWithDeposit(2, shiftB2, "3000.00");
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "WORKORDER_CANCEL", sourceDocId: woB2 },
          MANAGER_B1, // مدير الفرع ١ — لا يعبُر الفروع
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
  });

  it("⑦  التوزيع: REVERSE_DELIVERY يستعمل نفس التمهيد ونتيجتُه لعمليةٍ مختلفة", async () => {
    // مستندٌ فيه شرطُ الإلغاء لكن ليس شرطَ عكسِ التسليم (لا فاتورة) ⇒ needsCashDrawer=false.
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const wo = await workOrderWithDeposit(1, shift, "3000.00");
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_REVERSE_DELIVERY", sourceDocId: wo },
        ADMIN,
      ),
    );
    expect(res.branchId).toBe(1);
    // م٢ ق١٠ (المفتاح الناقص): مع وردية استقبالٍ مفتوحة يخرج ردُّ عكس التسليم من درجها — الخزينةُ ليست
    // بديلاً يُختار بجانب الدرج (مرآةُ `resolveLockedReceptionCashSource`)، فتُحجب بسببها المعلَن لا صامتةً.
    expect(res.treasuryCash).toBeNull();
    expect(res.treasurySufficient).toBe(false);
    expect(res.rails.TREASURY.available).toBe(false);
    expect(res.rails.TREASURY.reason).toMatch(/توجد وردية استقبال مفتوحة/);
    expect(res.rails.DRAWER.available).toBe(true);
    expect(res.rails.CARD.available).toBe(false);
  });

  it("⑦ب REVERSE_DELIVERY بلا وردية استقبال مفتوحة: الخزينةُ رافدٌ معلَن (يُصرَف عند الاعتماد) لا باباً مسدوداً", async () => {
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const wo = await workOrderWithDeposit(1, shift, "3000.00");
    // تُقفَل الوردية بعد القبض ⇒ لا درجَ استقبالٍ مفتوحاً وقت الطلب.
    await db().update(s.shifts).set({ status: "CLOSED" }).where(eq(s.shifts.id, shift));
    const res = await withTx((tx) =>
      refundRailPreflight(tx, { sourceDocType: "WORKORDER_REVERSE_DELIVERY", sourceDocId: wo }, ADMIN),
    );
    expect(res.drawers).toHaveLength(0);
    expect(res.rails.DRAWER.available).toBe(false);
    expect(res.rails.TREASURY.available).toBe(true);
    expect(res.rails.CARD.available).toBe(false);
  });

  it("⑨  SALE_RETURN: الوعاءُ من سقوف الردّ، الأدراجُ أيُّ وردية مفتوحة، والبطاقةُ لعميلٍ مسجَّل", async () => {
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const invoiceId = extractInsertId(
      await db().insert(s.invoices).values({
        invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
        branchId: 1,
        customerId: 1,
        subtotal: "3000.00",
        total: "3000.00",
        paidAmount: "3000.00",
        status: "PAID",
        sourceType: "POS",
        createdBy: 2,
      } as never),
    );
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: shift, invoiceId, direction: "IN", amount: "3000.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      partyType: "CUSTOMER", partyId: 1, createdBy: 2,
    });
    const full = await withTx((tx) =>
      refundRailPreflight(tx, { sourceDocType: "SALE_RETURN", sourceDocId: invoiceId }, ADMIN),
    );
    expect(full.needsCashDrawer).toBe(true);
    expect(full.estimatedCashOut).toBe("3000.00"); // الوعاءُ كلُّه بلا مبلغ
    expect(full.drawers.map((d) => d.shiftId)).toContain(shift);
    expect(full.rails.DRAWER.available).toBe(true);
    // وردية مفتوحة ⇒ الخزينة ليست بديلاً يُختار بجانب الدرج (مرآة shiftIdForCashTx).
    expect(full.rails.TREASURY.available).toBe(false);
    expect(full.cardRefundAllowed).toBe(true); // عميلٌ مسجَّل والنقدُ رافدُ ردٍّ يستوعب الوعاء
    expect(full.rails.CARD.available).toBe(true);

    // مبلغٌ جزئيّ: الكفاية تُقاس به لا بالوعاء كلّه.
    const partial = await withTx((tx) =>
      refundRailPreflight(tx, { sourceDocType: "SALE_RETURN", sourceDocId: invoiceId, amount: "1000.00" }, ADMIN),
    );
    expect(partial.estimatedCashOut).toBe("1000.00");
    // مبلغٌ فوق الوعاء يُقصّ به — الخادم لا يثق بالشاشة.
    const capped = await withTx((tx) =>
      refundRailPreflight(tx, { sourceDocType: "SALE_RETURN", sourceDocId: invoiceId, amount: "9999.00" }, ADMIN),
    );
    expect(capped.estimatedCashOut).toBe("3000.00");
  });

  it("⑩  SALE_RETURN بلا وردية مفتوحة: الخزينةُ مخرجُ الإداريّ وحده، والكاشير يرى السببَ لا رقاقةً ميتة", async () => {
    const invoiceId = extractInsertId(
      await db().insert(s.invoices).values({
        invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
        branchId: 1,
        customerId: null,
        subtotal: "2000.00",
        total: "2000.00",
        paidAmount: "2000.00",
        status: "PAID",
        sourceType: "POS",
        createdBy: 2,
      } as never),
    );
    await db().insert(s.receipts).values({
      branchId: 1, invoiceId, direction: "IN", amount: "2000.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      partyType: "OTHER", createdBy: 2,
    });
    const manager = await withTx((tx) =>
      refundRailPreflight(tx, { sourceDocType: "SALE_RETURN", sourceDocId: invoiceId }, MANAGER_B1),
    );
    expect(manager.drawers).toHaveLength(0);
    expect(manager.rails.DRAWER.available).toBe(false);
    expect(manager.rails.TREASURY.available).toBe(true);
    // زبونٌ عابر ⇒ لا بطاقة (عقد الخدمة: نقدٌ كامل فقط).
    expect(manager.rails.CARD.available).toBe(false);
    const staff = await withTx((tx) =>
      refundRailPreflight(tx, { sourceDocType: "SALE_RETURN", sourceDocId: invoiceId }, { ...RECEPTION_STAFF, permissionsOverride: { sales: "READ", treasury: "NONE" } as unknown as RefundRailActor["permissionsOverride"] }),
    );
    expect(staff.rails.TREASURY.available).toBe(false);
    expect(staff.rails.TREASURY.reason).toMatch(/صلاحيةُ المدير أو الأدمن/);
  });

  it("⑧  التوزيع: CONSIGNMENT_RETURN لإرساليةٍ غير موجودة ⇒ NOT_FOUND بمصطلحها", async () => {
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "CONSIGNMENT_RETURN", sourceDocId: 12345 },
          ADMIN,
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toMatch(/إرجاعُ إرسالية توصيل/);
  });
});

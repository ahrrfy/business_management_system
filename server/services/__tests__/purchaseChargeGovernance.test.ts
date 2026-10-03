import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder } from "../purchaseService";
import {
  createPurchaseCharge,
  decidePurchaseChargeControl,
  requestPurchaseChargeControl,
} from "../purchase/purchaseCharges";
import type { Actor } from "../tx";
import { getDayCloseReconciliation } from "../reportsDayCloseService";

/**
 * مصروفُ الشراء (شحن/كمرك/…) خروجُ مالٍ حقيقيّ خلف بوّابة فصل مهامٍ
 * (decidePurchaseChargeControl) لم يستدعِها أيّ اختبارٍ قاعديّ قطّ — purchaseChargesS6.test.ts
 * وpurchaseChargePayableFailClosedP0.test.ts يفحصان دوالّ نقيّةً معزولة بلا معاملة ولا إيصال ولا
 * قيد. هذا الملفّ يسدّ الفجوة، ويثبت أيضاً أنّ تجاوز المالك (٣/٩، 3227ce5b) يعمل فعلياً على
 * جدول `purchaseChargeControlRequests` بعد إسقاط `chk_purchase_charge_control_maker_checker`
 * في الهجرة 0333 (PR #982) — قبلها كانت محاولة المالك اعتماد طلبه تسقط بخطأ DB خامّ
 * (ER_CHECK_CONSTRAINT_VIOLATED) رغم أنّ طبقة التطبيق تسمح له. راجع ذاكرة
 * [[owner-decision-no-second-approval-2026-09-03]].
 */

const maker = { userId: 7, branchId: 1, role: "purchasing" as const };
const reviewer = { userId: 8, branchId: 1, role: "accountant" as const };
const owner = { userId: 9, branchId: 1, role: "manager" as const };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "purchaseChargeAllocations",
    "purchaseCharges",
    "purchaseChargeControlRequests",
    "receipts",
    "accountingEntries",
    "shifts",
    "purchaseOrderItems",
    "purchaseOrders",
    "productUnits",
    "productVariants",
    "products",
    "accounts",
    "suppliers",
    "branches",
    "users",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db().insert(schema.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(schema.users)
    .values([
      { id: 7, openId: "pc-gov-maker", name: "طالب", role: "purchasing", loginMethod: "local", branchId: 1 },
      { id: 8, openId: "pc-gov-reviewer", name: "مراجع", role: "accountant", loginMethod: "local", branchId: 1 },
      { id: 9, openId: "pc-gov-owner", name: "المالك", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
    ]);
  await db().insert(schema.suppliers).values({ id: 1, name: "مورد اختبار المصروف", currentBalance: "0" });
  await db().insert(schema.accounts).values({
    id: 1,
    code: "5901-PC-GOV",
    name: "مصروف شحن الاختبار",
    type: "EXPENSE",
    systemRole: "DELIVERY_EXPENSE",
    isActive: true,
  });
  await db().insert(schema.products).values({ id: 1, name: "صنفٌ لاختبار مصروف الشراء" });
  await db().insert(schema.productVariants).values({ id: 1, productId: 1, sku: "PC-GOV-1", costPrice: "0.00" });
  await db().insert(schema.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
}

beforeEach(async () => {
  await reset();
  await seed();
});

/** أمرُ شراءٍ بمسوَّدة — يكفي مصدرَ توزيعٍ لمصروف الشراء بلا حاجة لاعتماده أو استلامه. */
async function makePurchaseOrderId(): Promise<number> {
  const created = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "5000.00" }],
    },
    maker,
  );
  return Number(created.purchaseOrderId);
}

/** ينشئ مصروف شراءٍ PAID/TRANSFER مسوَّدةً، ثم يطلب ترحيله بهويّة `requester`. */
async function createChargeAndRequestPost(
  requester: Actor,
  paymentMethod: "CASH" | "TRANSFER" = "TRANSFER",
) {
  const purchaseOrderId = await makePurchaseOrderId();
  const created = await createPurchaseCharge(
    {
      branchId: 1,
      clientRequestId: `pc-gov-charge:${randomUUID()}`,
      payeeSupplierId: 1,
      expenseAccountId: 1,
      chargeType: "SHIPPING",
      settlement: "PAID",
      paymentMethod,
      amount: "5000.00",
      expenseDate: "2026-01-01",
      externalReference: `${paymentMethod}-${randomUUID()}`,
      evidenceType: paymentMethod === "CASH" ? "CARRIER_INVOICE" : "BANK_ADVICE",
      evidenceReference: `ev-${randomUUID()}`,
      allocations: [{ purchaseOrderId, allocatedAmount: "5000.00" }],
    },
    requester,
  );
  const requested = await requestPurchaseChargeControl(
    {
      purchaseChargeId: created.purchaseChargeId,
      expectedChargeVersion: 1,
      requestKey: `pc-gov-request:${randomUUID()}`,
      kind: "POST",
      evidenceReference: `control-ev-${randomUUID()}`,
      reason: "ترحيل مصروف شحنٍ حقيقيّ",
    },
    requester,
  );
  return { purchaseChargeId: created.purchaseChargeId, requestId: requested.requestId };
}

describe("حوكمة مصروف الشراء — فصل المهام على قاعدةٍ حقيقية", () => {
  it("يرفض اعتماد طالب الترحيل لطلبه ذاته", async () => {
    const { requestId } = await createChargeAndRequestPost(maker);

    await expect(
      decidePurchaseChargeControl(
        { requestId, decisionKey: randomUUID(), action: "APPROVE", reviewReason: "محاولة اعتماد ذاتي" },
        maker,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(schema.receipts)).toHaveLength(0);
    expect(
      await db().select().from(schema.accountingEntries).where(eq(schema.accountingEntries.entryType, "PAYMENT_OUT")),
    ).toHaveLength(0);
    const [charge] = await db().select().from(schema.purchaseCharges);
    expect(charge.status).toBe("DRAFT");
  });

  it("يعتمد مراجعٌ مستقلّ الطلب فيُرحَّل المصروف فعلياً بإيصالٍ وقيد", async () => {
    const { requestId, purchaseChargeId } = await createChargeAndRequestPost(maker);

    const decided = await decidePurchaseChargeControl(
      { requestId, decisionKey: randomUUID(), action: "APPROVE", reviewReason: "راجعت مستند الشحن واعتمدت الترحيل" },
      reviewer,
    );
    expect(decided.status).toBe("APPROVED");

    const [charge] = await db().select().from(schema.purchaseCharges).where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(charge.status).toBe("POSTED");

    const receiptsRows = await db().select().from(schema.receipts);
    expect(receiptsRows).toHaveLength(1);
    expect(receiptsRows[0]).toMatchObject({
      direction: "OUT",
      partyType: "SUPPLIER",
      partyId: 1,
      createdBy: maker.userId,
      approvedBy: reviewer.userId,
      executedBy: maker.userId,
    });
    expect(receiptsRows[0].executedAt).not.toBeNull();

    const entries = await db().select().from(schema.accountingEntries).where(eq(schema.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].createdBy)).toBe(maker.userId);
  });

  it("مصروف الشحن النقدي يُخصم من وردية المنشئ ويظهر في المطابقة باسم المنفذ لا المراجع", async () => {
    await db().insert(schema.shifts).values([
      {
        id: 701,
        userId: maker.userId,
        branchId: 1,
        openingBalance: "0.00",
        status: "OPEN",
        shiftType: "RETAIL",
        openGuard: "7:1:RETAIL",
      },
      {
        id: 801,
        userId: reviewer.userId,
        branchId: 1,
        openingBalance: "0.00",
        status: "OPEN",
        shiftType: "RETAIL",
        openGuard: "8:1:RETAIL",
      },
    ]);
    await db().insert(schema.receipts).values({
      branchId: 1,
      shiftId: 701,
      cashBucket: "DRAWER",
      direction: "IN",
      amount: "10000.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      description: "تمويل اختباري لدرج منفذ الشحن",
      createdBy: maker.userId,
    });
    const { requestId, purchaseChargeId } = await createChargeAndRequestPost(maker, "CASH");
    const historicalCreatedAt = new Date("2025-01-01T08:00:00.000Z");
    await db()
      .update(schema.purchaseCharges)
      .set({ createdAt: historicalCreatedAt })
      .where(eq(schema.purchaseCharges.id, purchaseChargeId));
    const [backdatedCharge] = await db()
      .select({ version: schema.purchaseCharges.version })
      .from(schema.purchaseCharges)
      .where(eq(schema.purchaseCharges.id, purchaseChargeId));
    await db()
      .update(schema.purchaseChargeControlRequests)
      .set({ baseChargeVersion: Number(backdatedCharge.version) })
      .where(eq(schema.purchaseChargeControlRequests.id, requestId));

    await decidePurchaseChargeControl(
      {
        requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "اعتماد مستند الشحن النقدي",
      },
      reviewer,
    );

    const [receipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.direction, "OUT"));
    expect(receipt).toMatchObject({
      shiftId: 701,
      cashBucket: "DRAWER",
      createdBy: maker.userId,
      approvedBy: reviewer.userId,
      executedBy: maker.userId,
    });
    expect(receipt.executedAt).not.toBeNull();
    expect(receipt.executedAt!.getTime()).toBeGreaterThan(historicalCreatedAt.getTime());
    expect(receipt.approvedAt?.getTime()).toBe(receipt.executedAt!.getTime());
    const [entry] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(eq(schema.accountingEntries.receiptId, Number(receipt.id)));
    expect(Number(entry.createdBy)).toBe(maker.userId);

    const report = await getDayCloseReconciliation({
      date: new Date().toISOString().slice(0, 10),
      branchId: 1,
    });
    const makerShift = report.shifts.find((row) => row.shiftId === 701);
    const reviewerShift = report.shifts.find((row) => row.shiftId === 801);
    expect(makerShift?.expensesCash).toBe("5000.00");
    expect(makerShift?.operatingOut).toBe("5000.00");
    expect(makerShift?.movements[0]).toMatchObject({
      categoryType: "EXPENSE",
      categoryLabel: "مصروف شراء",
      classification: "SHIPPING",
      createdByName: "طالب",
    });
    expect(reviewerShift?.expensesCash).toBe("0.00");
  });

  it("عكس المصروف النقدي يُدخل النقد في وردية المراجع المنفّذ لا وردية منشئ المصروف", async () => {
    await db().insert(schema.shifts).values([
      {
        id: 701,
        userId: maker.userId,
        branchId: 1,
        openingBalance: "0.00",
        status: "OPEN",
        shiftType: "RETAIL",
        openGuard: "7:1:RETAIL",
      },
      {
        id: 801,
        userId: reviewer.userId,
        branchId: 1,
        openingBalance: "0.00",
        status: "OPEN",
        shiftType: "RETAIL",
        openGuard: "8:1:RETAIL",
      },
    ]);
    await db().insert(schema.receipts).values({
      branchId: 1,
      shiftId: 701,
      cashBucket: "DRAWER",
      direction: "IN",
      amount: "10000.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      description: "تمويل اختباري لدرج منفذ الشحن",
      createdBy: maker.userId,
    });
    const { requestId, purchaseChargeId } = await createChargeAndRequestPost(maker, "CASH");

    await decidePurchaseChargeControl(
      {
        requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "اعتماد دفع مصروف الشحن النقدي",
      },
      reviewer,
    );
    const reverseRequest = await requestPurchaseChargeControl(
      {
        purchaseChargeId,
        expectedChargeVersion: 2,
        requestKey: `pc-gov-reverse:${randomUUID()}`,
        kind: "REVERSE",
        evidenceReference: `reverse-ev-${randomUUID()}`,
        reason: "استرداد رسوم الشحن نقداً",
      },
      maker,
    );
    await decidePurchaseChargeControl(
      {
        requestId: reverseRequest.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "استلمت مبلغ الاسترداد نقداً",
      },
      reviewer,
    );

    const [reverseReceipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.direction, "IN"))
      .orderBy(sql`${schema.receipts.id} DESC`)
      .limit(1);
    expect(reverseReceipt).toMatchObject({
      shiftId: 801,
      cashBucket: "DRAWER",
      createdBy: reviewer.userId,
      approvedBy: reviewer.userId,
      executedBy: reviewer.userId,
    });
    expect(reverseReceipt.executedAt).not.toBeNull();
    const [reverseEntry] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(eq(schema.accountingEntries.receiptId, Number(reverseReceipt.id)));
    expect(Number(reverseEntry.createdBy)).toBe(reviewer.userId);
  });

  it("يعتمد المالكُ طلب ترحيلٍ أنشأه هو بنفسه فيُرحَّل المصروف فعلياً (لا خطأ DB خامّ بعد الهجرة 0333)", async () => {
    const { requestId, purchaseChargeId } = await createChargeAndRequestPost(owner);

    const [charge] = await db().select().from(schema.purchaseCharges).where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(charge.status).toBe("POSTED");

    const receiptsRows = await db().select().from(schema.receipts);
    expect(receiptsRows).toHaveLength(1);
    expect(receiptsRows[0]).toMatchObject({ direction: "OUT", partyType: "SUPPLIER", partyId: 1 });

    const [request] = await db().select().from(schema.purchaseChargeControlRequests).where(eq(schema.purchaseChargeControlRequests.id, requestId));
    expect(request).toMatchObject({ status: "APPROVED", requestedBy: owner.userId, reviewedBy: owner.userId });
  });
});

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPurchaseCharge,
  decidePurchaseChargeControl,
  requestPurchaseChargeControl,
} from "../purchase/purchaseCharges";
import { createPurchaseOrder } from "../purchaseService";

const creator = { userId: 1, branchId: 1, role: "manager" as const };
const independentApprover = { userId: 2, branchId: 1, role: "manager" as const };

// يفحص هذا الملفّ فصل المهام تحت سياسة الاعتماد **القديمة** (OFF) — ثبّته صراحةً بدل
// افتراض بيئة التشغيل، مطابقةً لنمط ownerGate.test.ts (مراجعة Codex).
const ROLLOUT_FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
let savedRolloutFlag: string | undefined;
beforeEach(() => {
  savedRolloutFlag = process.env[ROLLOUT_FLAG];
  delete process.env[ROLLOUT_FLAG];
});
afterEach(() => {
  if (savedRolloutFlag === undefined) delete process.env[ROLLOUT_FLAG];
  else process.env[ROLLOUT_FLAG] = savedRolloutFlag;
});

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "purchaseChargeAllocations",
    "purchaseChargeControlRequests",
    "purchaseCharges",
    "accountingEntries",
    "receipts",
    "accounts",
    "idempotencyKeys",
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
    "purchaseRequisitionControlRequests",
    "purchaseRequisitionItems",
    "purchaseRequisitions",
    "purchaseControlSettings",
    "purchaseOrderItems",
    "purchaseOrders",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "branches",
    "users",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db()
    .insert(schema.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(schema.users)
    .values([
      {
        id: 1,
        openId: "pcharge-creator",
        name: "المنشئ",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "pcharge-independent",
        name: "المعتمد المستقل",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db()
    .insert(schema.suppliers)
    .values({ id: 1, name: "مورد الاختبار", currentBalance: "0" });
  await db().insert(schema.products).values({ id: 1, name: "ورق" });
  await db()
    .insert(schema.productVariants)
    .values({ id: 1, productId: 1, sku: "PAPER", costPrice: "0" });
  await db().insert(schema.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(schema.accounts).values({
    id: 1,
    code: "TEST-EXP-1",
    name: "مصروفات الشحن (اختبار)",
    type: "EXPENSE",
    isActive: true,
    systemRole: "OPERATING_EXPENSE",
  });
}

async function createDraft(key: string) {
  return createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      clientRequestId: key,
      revisionReason: "إنشاء أمر شراء لاختبار مصروف الشراء",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
    },
    creator,
  );
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("purchaseCharges — إنشاء وترحيل وعكس مصروف شراء", () => {
  it("ينشئ مصروف الشراء بمسودة حين تُساوي التوزيعات المبلغ بالضبط، ويحفظ سطر التوزيع", async () => {
    const po = await createDraft("pcharge-po-1");
    const created = await createPurchaseCharge(
      {
        branchId: 1,
        clientRequestId: "pcharge-create-1",
        expenseAccountId: 1,
        chargeType: "SHIPPING",
        settlement: "PAID",
        paymentMethod: "CARD",
        amount: "50000.00",
        expenseDate: "2026-09-01",
        evidenceType: "CARRIER_INVOICE",
        evidenceReference: "CARRIER-INV-1001",
        allocations: [
          { purchaseOrderId: po.purchaseOrderId, allocatedAmount: "50000.00" },
        ],
      },
      creator,
    );
    expect(created).toMatchObject({ status: "DRAFT", idempotent: false });

    const allocations = await db()
      .select()
      .from(schema.purchaseChargeAllocations)
      .where(
        eq(
          schema.purchaseChargeAllocations.purchaseChargeId,
          created.purchaseChargeId,
        ),
      );
    expect(allocations).toHaveLength(1);
    expect(allocations[0].purchaseOrderId).toBe(po.purchaseOrderId);
    expect(allocations[0].allocatedAmount).toBe("50000.00");
  });

  it("يرفض إنشاء مصروف الشراء حين لا يساوي مجموع التوزيعات المبلغ، ولا يكتب أي صفّ", async () => {
    const po = await createDraft("pcharge-po-2");
    await expect(
      createPurchaseCharge(
        {
          branchId: 1,
          clientRequestId: "pcharge-create-2",
          expenseAccountId: 1,
          chargeType: "SHIPPING",
          settlement: "PAID",
          paymentMethod: "CARD",
          amount: "50000.00",
          expenseDate: "2026-09-01",
          evidenceType: "CARRIER_INVOICE",
          evidenceReference: "CARRIER-INV-1002",
          allocations: [
            { purchaseOrderId: po.purchaseOrderId, allocatedAmount: "49999.00" },
          ],
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await db().select().from(schema.purchaseCharges)).toHaveLength(0);
    expect(
      await db().select().from(schema.purchaseChargeAllocations),
    ).toHaveLength(0);
  });

  it("يفرض فصل المهام على قرار الترحيل ثم يرحّل المصروف ويعكسه بقيدين وإيصالين مستقلّين", async () => {
    const po = await createDraft("pcharge-po-3");
    const created = await createPurchaseCharge(
      {
        branchId: 1,
        clientRequestId: "pcharge-create-3",
        expenseAccountId: 1,
        chargeType: "SHIPPING",
        settlement: "PAID",
        paymentMethod: "CARD",
        amount: "75000.00",
        expenseDate: "2026-09-01",
        evidenceType: "CARRIER_INVOICE",
        evidenceReference: "CARRIER-INV-1003",
        allocations: [
          { purchaseOrderId: po.purchaseOrderId, allocatedAmount: "75000.00" },
        ],
      },
      creator,
    );
    const purchaseChargeId = created.purchaseChargeId;

    // طلب الترحيل — بلا أثرٍ ماديّ أو ماليّ بعد.
    const postRequest = await requestPurchaseChargeControl(
      {
        purchaseChargeId,
        expectedChargeVersion: 1,
        requestKey: "pcharge-post-request-3",
        kind: "POST",
        evidenceReference: "CARRIER-INV-1003",
        reason: "ترحيل مصروف شحن مؤكَّد بمستند الناقل",
      },
      creator,
    );
    expect(postRequest).toMatchObject({ status: "PENDING", idempotent: false });

    // فصل المهام: من طلب الترحيل لا يعتمده بنفسه.
    await expect(
      decidePurchaseChargeControl(
        {
          requestId: postRequest.requestId,
          decisionKey: "pcharge-post-self-decision",
          action: "APPROVE",
          reviewReason: "اعتماد ذاتي",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // معتمِد مستقل يرحّل المصروف فعلاً — قيد وإيصال حقيقيّان.
    const posted = await decidePurchaseChargeControl(
      {
        requestId: postRequest.requestId,
        decisionKey: "pcharge-post-independent-decision",
        action: "APPROVE",
        reviewReason: "راجعت مستند الناقل وطابقته بالمبلغ",
      },
      independentApprover,
    );
    expect(posted).toMatchObject({ status: "APPROVED", idempotent: false });

    const [chargeAfterPost] = await db()
      .select()
      .from(schema.purchaseCharges)
      .where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(chargeAfterPost.status).toBe("POSTED");
    expect(chargeAfterPost.postingEntryId).not.toBeNull();
    expect(chargeAfterPost.paymentReceiptId).not.toBeNull();
    expect(Number(chargeAfterPost.version)).toBe(2);

    const [postEntryRow] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(
        eq(
          schema.accountingEntries.dedupeKey,
          `PURCHASE_CHARGE_POST:${purchaseChargeId}`,
        ),
      );
    expect(postEntryRow).toBeTruthy();
    expect(postEntryRow.entryType).toBe("PAYMENT_OUT");
    expect(postEntryRow.amount).toBe("75000.00");

    const [postReceiptRow] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.id, Number(chargeAfterPost.paymentReceiptId)));
    expect(postReceiptRow.direction).toBe("OUT");
    expect(postReceiptRow.cashBucket).toBeNull();
    expect(postReceiptRow.paymentMethod).toBe("CARD");
    expect(postReceiptRow.amount).toBe("75000.00");

    // طلب العكس على المصروف المُرحَّل فعلاً.
    const reverseRequest = await requestPurchaseChargeControl(
      {
        purchaseChargeId,
        expectedChargeVersion: 2,
        requestKey: "pcharge-reverse-request-3",
        kind: "REVERSE",
        evidenceReference: "CARRIER-INV-1003-REV",
        reason: "المورّد ألغى رسوم الشحن بعد الترحيل",
      },
      creator,
    );
    expect(reverseRequest).toMatchObject({
      status: "PENDING",
      idempotent: false,
    });

    // معتمِد مستقل (غير طالب العكس) يعتمد العكس — قيد وإيصال مستقلّان.
    const reversed = await decidePurchaseChargeControl(
      {
        requestId: reverseRequest.requestId,
        decisionKey: "pcharge-reverse-independent-decision",
        action: "APPROVE",
        reviewReason: "تحقّقت من إلغاء رسوم الشحن مع الناقل",
      },
      independentApprover,
    );
    expect(reversed).toMatchObject({ status: "APPROVED", idempotent: false });

    const [chargeAfterReverse] = await db()
      .select()
      .from(schema.purchaseCharges)
      .where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(chargeAfterReverse.status).toBe("REVERSED");
    expect(chargeAfterReverse.reversalEntryId).not.toBeNull();
    expect(chargeAfterReverse.reversedBy).toBe(independentApprover.userId);
    expect(chargeAfterReverse.reversedAt).not.toBeNull();
    expect(chargeAfterReverse.reversalReason).toBe(
      "المورّد ألغى رسوم الشحن بعد الترحيل",
    );

    const [reverseEntryRow] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(
        eq(
          schema.accountingEntries.dedupeKey,
          `PURCHASE_CHARGE_REVERSAL:${purchaseChargeId}`,
        ),
      );
    expect(reverseEntryRow).toBeTruthy();
    expect(reverseEntryRow.entryType).toBe("PAYMENT_IN");
    expect(reverseEntryRow.amount).toBe("75000.00");

    const [reverseReceiptRow] = await db()
      .select()
      .from(schema.receipts)
      .where(
        eq(schema.receipts.id, Number(chargeAfterReverse.reversalReceiptId)),
      );
    expect(reverseReceiptRow.direction).toBe("IN");
    expect(reverseReceiptRow.cashBucket).toBeNull();
    expect(reverseReceiptRow.paymentMethod).toBe("CARD");
    expect(reverseReceiptRow.amount).toBe("75000.00");
  });
});

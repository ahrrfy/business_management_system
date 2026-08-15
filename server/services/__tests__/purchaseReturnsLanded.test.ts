// مرتجع الشراء بعد **قرار المالك ٥/٨/٢٦**: الشحن مصروفُ شركةٍ يقع لحظة الاستلام، خارج ذمّة
// المورّد وخارج تكلفة الصنف. لذا **لا منطق شحنٍ في المرتجع إطلاقاً**.
//
// نسخت هذه الاختبارات سياسةً سابقة (#311/#318/#321) كان فيها الشحن مُرسمَلاً ومُضافاً لذمّة
// المورّد، فاستوجب الإرجاعُ قيدَ «خسارة شحن» (ADJUST بمفتاح PURCHRET_LANDED) وإبقاءَ حصّة الشحن
// ديناً في AP. بعد القرار صار ذلك كلّه لاغياً، وأُعيدت كتابتها لتحرس النقيض:
//   (١) الإرجاع الكامل يُصفّر رصيد المورّد تماماً — لا بقايا شحنٍ عالقة في ذمّته.
//   (٢) لا قيد خسارة شحن (PURCHRET_LANDED) في أيّ مسار — إبقاؤه كان سيقيّد الخسارة مرّتين
//       (مرّةً مصروفَ نقلٍ عند الاستلام ومرّةً خسارةً عند الإرجاع).
//   (٣) مصروف النقل المُسجَّل عند الاستلام **لا يُعكَس** بالإرجاع: البضاعة شُحنت إلينا فعلاً والمال دُفع.
//   (٤) reconcileSupplierBalances يبقى خالياً (الدفتر والرصيد متطابقان).
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createPurchaseReturn } from "../purchaseReturnsService";
import { reconcileSupplierBalances } from "../reconcileService";
import { approveVoucher } from "../voucher/approval";

const actor = { userId: 1, branchId: 1, role: "admin" as const };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "idempotencyKeys", "accountingEntries", "expenses", "receipts", "inventoryMovements",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices",
  "productUnits", "productVariants", "products", "auditLogs", "suppliers", "branches", "users",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local", isOwner: false },
    { id: 2, openId: "owner", name: "owner", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-PURCHASE-RETURN-LANDED",
    createdBy: 2,
  });
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
  await d.insert(s.products).values([{ id: 1, name: "ورق" }, { id: 2, name: "حبر" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "P-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "P-2", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

async function supplierBalance(): Promise<string> {
  const r = (await db().select({ b: s.suppliers.currentBalance }).from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
  return String(r?.b);
}
async function entries() {
  return db().select().from(s.accountingEntries).orderBy(s.accountingEntries.id);
}
async function shippingLossEntries() {
  return (await entries()).filter((e) => String(e.dedupeKey ?? "").startsWith("PURCHRET_LANDED"));
}
async function transportExpenses() {
  return db().select().from(s.expenses).where(eq(s.expenses.category, "TRANSPORT"));
}

/** أمرٌ ببضاعة ٤٬٠٠٠ وشحن ٤٠٠، مُستلَمٌ بالكامل. `payNow` يسدّد للمورّد عند الاستلام (يلزم
 *  للاسترداد النقديّ: لا يُستردّ نقدٌ لم يُدفَع). يعيد معرّف الأمر. */
async function orderedAndReceived(payNow?: string): Promise<number> {
  const po = await createPurchaseOrder(
    {
      supplierId: 1, branchId: 1, taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
        { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },
      ],
      shippingCost: "300", customsCost: "100",
    },
    actor,
  );
  const items = await db().select().from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)).orderBy(s.purchaseOrderItems.id);
  const received = await receivePurchase(
    {
      purchaseOrderId: po.purchaseOrderId,
      lines: items.map((i) => ({ purchaseOrderItemId: Number(i.id), receivedBaseQuantity: i.baseQuantity })),
      ...(payNow ? { payment: { amount: payNow, method: "CASH" as const } } : {}),
    },
    actor,
  );
  if (received.supplierPaymentRequestReceiptId) {
    await approveVoucher(Number(received.supplierPaymentRequestReceiptId), {
      userId: 2,
      branchId: 1,
      role: "manager",
    });
  }
  return po.purchaseOrderId;
}

describe("مرتجع الشراء — لا منطق شحنٍ بعد نقل الشحن إلى المصروفات", () => {
  it("(١+٢) إرجاع كامل آجل ⇒ رصيد المورّد صفر تماماً، وبلا قيد خسارة شحن", async () => {
    const poId = await orderedAndReceived();
    expect(await supplierBalance()).toBe("4000.00"); // البضاعة وحدها ارتفعت في الذمّة

    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CREDIT",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },
        ],
      },
      actor,
    );

    // يُصفَّر تماماً — لا «٤٠٠ شحنٍ» عالقةٍ في ذمّته كما كانت السياسة الملغاة.
    expect(await supplierBalance()).toBe("0.00");
    expect(await shippingLossEntries()).toHaveLength(0);
  });

  it("(٣) مصروف النقل المُسجَّل عند الاستلام لا يُعكَس بالإرجاع", async () => {
    const poId = await orderedAndReceived();
    const before = await transportExpenses();
    expect(before).toHaveLength(1);
    expect(before[0].amount).toBe("400.00");

    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CREDIT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
      },
      actor,
    );

    const after = await transportExpenses();
    expect(after).toHaveLength(1);
    expect(after[0].amount).toBe("400.00"); // البضاعة شُحنت إلينا فعلاً والمال دُفع
    expect(after[0].status).toBe("ACTIVE");
  });

  it("إرجاع جزئيّ ⇒ عكسٌ متناسب للبضاعة وحدها، بلا أثر شحن", async () => {
    const poId = await orderedAndReceived();
    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CREDIT",
        items: [{ variantId: 2, productUnitId: 2, quantity: "2", unitPrice: "600.00" }], // 1,200
      },
      actor,
    );
    expect(await supplierBalance()).toBe("2800.00"); // 4,000 − 1,200
    expect(await shippingLossEntries()).toHaveLength(0);
  });

  it("(٤) إرجاع كامل نقديّ ⇒ AP محايد وبلا خسارة شحن، والمطابقة خالية", async () => {
    // سُدِّدت البضاعة نقداً عند الاستلام (٤٬٠٠٠) — شرطُ الاسترداد النقديّ. لاحظ أنّ المسدَّد قيمة
    // البضاعة وحدها: الشحن خرج نقداً في مصروفٍ مستقلٍّ لا يمرّ بالمورّد أصلاً.
    const poId = await orderedAndReceived("4000.00");
    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CASH",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },
        ],
      },
      actor,
    );
    expect(await shippingLossEntries()).toHaveLength(0);
    const drift = await reconcileSupplierBalances();
    expect(drift).toHaveLength(0); // الرصيد يطابق الدفتر
  });
});

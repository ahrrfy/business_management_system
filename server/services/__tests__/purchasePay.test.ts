/**
 * تسديد أمر شراءٍ بعد استلامه — الفجوة التي كانت تُبقي الشراء الآجل بلا مسار إقفال.
 *
 * البيع يملك `sales.pay`؛ الشراء لم يكن له نظير: بطاقة الدفع تختفي فور اكتمال الاستلام
 * وقائمة الإجراءات بلا «تسديد» ⇒ كلّ سدادٍ لاحق يخرج إلى سند صرفٍ عامّ يُنقص رصيد المورّد
 * ولا يمسّ `purchaseOrders.paidAmount` ⇒ «المتبقّي» يطالب بمبلغٍ مسدَّد، وخطرُه دفعٌ مكرَّر.
 *
 * التصميم المُختبَر هنا: إعادة استعمال آلية `PURCHASE_SUPPLIER` نفسها التي يستعملها الاستلام
 * ⇒ الأثر الماليّ عند **الاعتماد** لا الطلب، و`paidAmount` يتحرّك هناك تحت القفل.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { payPurchaseOrder } from "../purchase/pay";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const otherBranchMgr = { userId: 2, branchId: 2, role: "manager" as const };

const TABLES = [
  "auditLogs", "idempotencyKeys", "journalLines", "journalEntries", "accountingEntries", "receipts",
  "purchaseOrderItems", "purchaseOrders", "shifts", "suppliers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  await truncateTables(TABLES);
}
async function seed(opts: { paid?: string; currency?: "IQD" | "USD"; status?: "RECEIVED" | "CANCELLED" } = {}) {
  const d = db();
  const paid = opts.paid ?? "0.00";
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع", code: "BR2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "أدمن", role: "admin", loginMethod: "local" },
    { id: 2, openId: "local_mgr2", name: "مدير ٢", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "10000.00", isActive: true });
  await d.insert(s.shifts).values({ id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "100000.00" });
  await d.insert(s.purchaseOrders).values({
    id: 1, poNumber: "PO-1", supplierId: 1, branchId: 1,
    status: opts.status ?? "RECEIVED",
    agreedCurrency: opts.currency ?? "IQD",
    subtotal: "10000.00", total: "10000.00", paidAmount: paid,
    createdBy: 1,
  });
  await d.insert(s.accountingEntries).values({
    entryType: "PURCHASE",
    branchId: 1,
    purchaseOrderId: 1,
    supplierId: 1,
    amount: "10000.00",
    entryDate: new Date(),
  });
  if (money(paid).gt(0)) {
    await d.insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      branchId: 1,
      purchaseOrderId: 1,
      supplierId: 1,
      amount: paid,
      entryDate: new Date(),
    });
  }
}
async function po() {
  return (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, 1)))[0];
}

describe("purchases.pay — تسديد أمر شراءٍ بعد الاستلام", () => {
  beforeEach(async () => { await reset(); });

  it("يُنشئ طلباً معلّقاً بلا أثرٍ ماليّ قبل الاعتماد (قرار المالك: كل صرفٍ للمورّد باعتماد ثانٍ)", async () => {
    await seed();
    const res = await payPurchaseOrder(
      { purchaseOrderId: 1, amount: "4000.00", method: "CASH", clientRequestId: "pp-1" },
      admin,
    );
    expect(res.remainingBefore).toBe("10000.00");

    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, res.paymentRequestReceiptId)))[0];
    expect(receipt.approvalStatus).toBe("PENDING_APPROVAL");
    expect(receipt.status).toBe("PENDING");
    // لا أثر ماليّ قبل الاعتماد: لا `paidAmount` ولا رصيد مورّد ولا دلو نقديّ.
    expect(money((await po()).paidAmount ?? "0").toFixed(2)).toBe("0.00");
    expect(receipt.cashBucket).toBeNull();
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(money(sup.currentBalance ?? "0").toFixed(2)).toBe("10000.00");
  });

  it("يرفض ما يتجاوز المتبقّي (والمتبقّي يحترم المدفوع سلفاً)", async () => {
    await seed({ paid: "7000.00" });
    await expect(
      payPurchaseOrder({ purchaseOrderId: 1, amount: "4000.00", method: "CASH", clientRequestId: "pp-2" }, admin),
    ).rejects.toThrow(/تتجاوز المتبقّي/);
    // والمطابق للمتبقّي يمرّ.
    const ok = await payPurchaseOrder(
      { purchaseOrderId: 1, amount: "3000.00", method: "CASH", clientRequestId: "pp-3" }, admin,
    );
    expect(ok.remainingBefore).toBe("3000.00");
  });

  it("يرفض أمراً مسدَّداً بالكامل", async () => {
    await seed({ paid: "10000.00" });
    await expect(
      payPurchaseOrder({ purchaseOrderId: 1, amount: "100.00", method: "CASH", clientRequestId: "pp-4" }, admin),
    ).rejects.toThrow(/لا يوجد مبلغ مستحق/);
  });

  it("عزل الفرع: مدير فرعٍ لا يسدّد أمر فرعٍ آخر", async () => {
    await seed();
    await expect(
      payPurchaseOrder({ purchaseOrderId: 1, amount: "100.00", method: "CASH", clientRequestId: "pp-5" }, otherBranchMgr),
    ).rejects.toThrow(/فرع آخر/);
  });

  it("يرفض الأمر الملغى، ويحيل الدولاريّ إلى مساره الخاصّ", async () => {
    await seed({ status: "CANCELLED" });
    await expect(
      payPurchaseOrder({ purchaseOrderId: 1, amount: "100.00", method: "CASH", clientRequestId: "pp-6" }, admin),
    ).rejects.toThrow(/ملغى/);

    await reset();
    await seed({ currency: "USD" });
    await expect(
      payPurchaseOrder({ purchaseOrderId: 1, amount: "100.00", method: "CASH", clientRequestId: "pp-7" }, admin),
    ).rejects.toThrow(/الدولار/);
  });
});

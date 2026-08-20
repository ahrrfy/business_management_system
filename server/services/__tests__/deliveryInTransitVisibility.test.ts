/**
 * رؤية الطرود بالطريق (بلاغ المالك ١٨/٨: «الطلبات المُسنَدة للمندوب لا تظهر في شاشة التوصيل
 * ولا أيّ شاشة أخرى إدارية أو لموظف الاستقبال ولا حتى لفنّي المطبعة»).
 *
 * الثقب المُثبَت: بين الإسناد وإثبات التسليم، الطرد يعيش في حالاتٍ وسيطة لا تطابقها أيّ قائمة
 * تشغيلية — خرج من «جاهز للإرسال» (له إرسالية) وليس في «تسوية المناديب» (تشترط DELIVERED أو
 * صفر تحصيل). وثقبٌ ثانٍ: إلغاء الإسناد كان يُسقط الأمر من طابور الإرسال **إلى الأبد**.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { dispatchToDelivery } from "../delivery/dispatch";
import { listInTransitConsignments, listOpenConsignments, listReadyForDispatch } from "../delivery/queries";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

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
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب أحمد", partyKind: "INDIVIDUAL", currentBalance: "0.00", isActive: true },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

/** أمر شغلٍ بتوصيل، جاهزٌ للإرسال، بلا عربون (كامل قيمته COD على المندوب). */
async function readyDeliveryOrder(reqId: string) {
  const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  const r = await checkoutReception({
    branchId: 1, shiftId: shift.shiftId, customerId: 1,
    paidAmount: "0", clientRequestId: reqId,
    workOrders: [{
      title: "طلب توصيل", quantity: 1, salePrice: "20000.00", materials: [],
      hasDelivery: true, deliveryAddress: "بغداد — العامرية", deliveryPhone: "+9647701234567",
    }],
  }, CASHIER);
  const woId = r.workOrders[0].workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return { workOrderId: woId, shiftId: shift.shiftId };
}

const dispatch = (workOrderId: number, reqId: string) =>
  dispatchToDelivery({ workOrderId, partyId: 1, clientRequestId: reqId }, CASHIER);

beforeEach(async () => {
  await reset();
  await seed();
});

describe("قيد التوصيل — الطرد بالطريق لا يختفي", () => {
  it("الطرد المُسنَد يظهر في «قيد التوصيل» بتعرّضه وجهته وعمره", async () => {
    const { workOrderId } = await readyDeliveryOrder("t-1");
    await dispatch(workOrderId, "d-1");

    const rows = await listInTransitConsignments(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].parcelStatus).toBe("ASSIGNED");
    expect(Number(rows[0].codDue)).toBe(20000);
    expect(rows[0].partyName).toBe("مندوب أحمد");
    expect(rows[0].workOrderId).toBe(workOrderId);
  });

  it("⭐ الحالات الوسيطة — الطرد الذي قبله المندوب وخرج به يبقى ظاهراً (كان يختفي من كل قائمة)", async () => {
    const { workOrderId } = await readyDeliveryOrder("t-2");
    await dispatch(workOrderId, "d-2");

    for (const p of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
      await db().update(s.deliveryConsignments).set({ parcelStatus: p });
      const inTransit = await listInTransitConsignments(1);
      expect(inTransit, `parcelStatus=${p} يجب أن يبقى مرئياً`).toHaveLength(1);
      expect(inTransit[0].parcelStatus).toBe(p);

      // إثباتُ الثقب القديم: هاتان القائمتان لا تريانه — ولذلك وُجد التبويب الجديد.
      expect(await listReadyForDispatch(1)).toHaveLength(0);
      expect(await listOpenConsignments(1, 1)).toHaveLength(0);
    }
  });

  it("الطرد المتعثّر يظهر بسبب تعثّره (قرارٌ مطلوب لا صفٌّ صامت)", async () => {
    const { workOrderId } = await readyDeliveryOrder("t-3");
    await dispatch(workOrderId, "d-3");
    await db().update(s.deliveryConsignments)
      .set({ parcelStatus: "FAILED", failureReason: "العميل رفض الاستلام" });

    const rows = await listInTransitConsignments(1);
    expect(rows[0].parcelStatus).toBe("FAILED");
    expect(rows[0].failureReason).toBe("العميل رفض الاستلام");
  });

  it("عزل الفرع: لا يظهر طردُ فرعٍ آخر", async () => {
    const { workOrderId } = await readyDeliveryOrder("t-4");
    await dispatch(workOrderId, "d-4");
    expect(await listInTransitConsignments(2)).toHaveLength(0);
    expect(await listInTransitConsignments(null)).toHaveLength(1); // الأدمن يرى الكل
  });
});

describe("طابور «جاهز للإرسال» — إلغاء الإسناد لا يحبس الأمر للأبد", () => {
  it("⭐ بعد إلغاء الإسناد يعود الأمر قابلاً للإرسال (كان يسقط نهائياً)", async () => {
    const { workOrderId } = await readyDeliveryOrder("t-5");
    await dispatch(workOrderId, "d-5");
    expect(await listReadyForDispatch(1)).toHaveLength(0); // مُسنَد ⇒ خارج الطابور بحقّ

    const consignmentId = Number((await db().select().from(s.deliveryConsignments))[0].id);
    await cancelDeliveryAssignment(
      { consignmentId, reason: "تبديل المندوب", clientRequestId: "cancel-1" },
      MANAGER,
    );

    // القاعدة: الاستبعاد يخصّ الإرسالية **الحيّة** — الملغاة لا تحبس الأمر.
    const ready = await listReadyForDispatch(1);
    expect(ready.map((r) => Number(r.id))).toContain(workOrderId);
    // ولا يبقى شيءٌ في «قيد التوصيل» (لم يعد طرداً خارجاً).
    expect(await listInTransitConsignments(1)).toHaveLength(0);
  });
});

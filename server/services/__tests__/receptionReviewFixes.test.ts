/**
 * ش٣ — إثبات إصلاحات المراجعة العدائية (٥/٨) على منظومة محطة خدمة الزبائن.
 * docs/reception-cashier-system-design-2026-08-05.md — الملاحظات التسع المؤكَّدة.
 *
 * المُثبَت:
 *  F1 — فاتورة إرساليتها بالطريق (DISPATCHED) ⇒ collectOnReceptionInvoice يُرفض
 *       PRECONDITION_FAILED (التحصيل مساره توريد المندوب — لا ازدواج قبضٍ لبيعٍ واحد).
 *  F2 — حزام التوريد الثاني: توريدُ نقد إرسالية تاريخية بعد مرتجع جزئي لا يرفع paidAmount
 *       فوق متبقّي الفاتورة الحيّ، حتى لو كان codAmount الملتقَط أكبر.
 *  F3 — تثبيت مسوّدة ببند تخصيصٍ أجرتُه «مقبوضة في الاستقبال» (COUNTER) ⇒ BAD_REQUEST
 *       (createWorkOrderInTx كان سيكتب إيصال نقدٍ لم يُقبَض ⇒ عجزُ إغلاقٍ حتميّ).
 *  F4 — تسليم أمر شغلٍ والمنفّذ بلا وردية استقبال (RETAIL فقط) ⇒ فاتورة التسليم بلا shiftId
 *       (لا تتسلّل لطابور/Z وردية غير استقبالية) بينما إيصال الدفعة يهبط على درجه الفعليّ.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { createDeliveryParty } from "../deliveryService";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { collectOnReceptionInvoice, commitDraft, listReceptionInvoices, promoteDraft } from "../reception";

const TABLES = [
  "receptionDraftLines", "receptionDrafts",
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const CASHIER2 = { userId: 5, branchId: 1, role: "cashier" };

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
    { id: 2, openId: "rc1", name: "موظف خدمة", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "rc2", name: "موظف ثانٍ", email: "r2@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", phone: "+9647700000001", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

/** فاتورة آجلة على وردية استقبال — في نطاق الطابور وقابلة للإسناد/التسديد. */
async function creditInvoiceOnReception(shiftId: number, id: number, total = "10000.00") {
  await db().insert(s.invoices).values({
    id, invoiceNumber: `INV-RF-${id}`, sourceType: "POS", sourceId: `rf-${id}`,
    branchId: 1, customerId: 1, shiftId, priceTier: "RETAIL",
    subtotal: total, taxAmount: "0.00", discountAmount: "0.00",
    total, costTotal: "0.00", status: "PENDING", paidAmount: "0.00", createdBy: 2,
  });
  await db().update(s.customers).set({ currentBalance: total }).where(eq(s.customers.id, 1));
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("F1 — لا تسديد كاونتر لفاتورةٍ بالطريق مع المندوب", () => {
  it("collectOnReceptionInvoice على إرسالية DISPATCHED ⇒ PRECONDITION_FAILED باسم الإرسالية", async () => {
    const rec = await openReception();
    await creditInvoiceOnReception(rec.shiftId, 601);
    const { id: partyId } = await createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "0", branchId: 1 }, MANAGER,
    );
    const dispatched = await dispatchInvoiceToDelivery(
      { invoiceId: 601, partyId, deliveryFee: "0", clientRequestId: "rf-f1-d" }, CASHIER,
    );

    await expect(collectOnReceptionInvoice(
      { invoiceId: 601, amount: "10000.00", method: "CASH", clientRequestId: "rf-f1-c" }, CASHIER,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(collectOnReceptionInvoice(
      { invoiceId: 601, amount: "10000.00", method: "CASH", clientRequestId: "rf-f1-c2" }, CASHIER,
    )).rejects.toThrowError(new RegExp(dispatched.consignmentNumber));

    // لم يُكتب أي قبض — الفاتورة كما هي والذمّة قائمة (التحصيل مساره التوريد).
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, 601)))[0];
    expect(inv.paidAmount).toBe("0.00");
    expect((await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, 601))).length).toBe(0);
  });
});

describe("F2 — حزام التوريد: قيد الفاتورة مسقوف بمتبقّيها الحيّ", () => {
  it("إرسالية تاريخية سُلّمت ثم حدث مرتجع جزئي ⇒ توريد النقد الكامل لا يرفع الفاتورة فوق صافيها", async () => {
    const rec = await openReception(); // درج المستلم
    await creditInvoiceOnReception(rec.shiftId, 602);
    const { id: partyId } = await createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "0", branchId: 1 }, MANAGER,
    );
    const dispatched = await dispatchInvoiceToDelivery(
      { invoiceId: 602, partyId, deliveryFee: "0", clientRequestId: "rf-f2-d" }, CASHIER,
    );
    expect(dispatched.codAmount).toBe("10000.00");

    // لقطة تاريخية: التسليم سبق نموذج المرحلة الثانية، ولذلك بقيت الفاتورة غير مسددة
    // رغم أن COD صار في عهدة المندوب. ثم عولج مرتجع جزئي فصار حق الفاتورة الحي 5000 فقط.
    const deliveredAt = new Date("2026-08-05T12:00:00.000Z");
    await db().update(s.deliveryConsignments).set({
      parcelStatus: "DELIVERED",
      courierDeliveredAt: deliveredAt,
      custodyRecognizedAt: deliveredAt,
    }).where(eq(s.deliveryConsignments.id, dispatched.consignmentId));
    await db().update(s.deliveryParties).set({ currentBalance: "10000.00" }).where(eq(s.deliveryParties.id, partyId));
    await db().update(s.invoices).set({ returnedTotal: "5000.00" }).where(eq(s.invoices.id, 602));
    await db().update(s.customers).set({ currentBalance: "5000.00" }).where(eq(s.customers.id, 1));

    const ok = await recordDeliveryRemittance({
      branchId: 1, partyId,
      lines: [{ consignmentId: dispatched.consignmentId, collectedAmount: "10000.00" }],
      countedCash: "10000.00",
      clientRequestId: "rf-f2-r",
    }, CASHIER);
    expect(ok).toBeTruthy();
    const after = (await db().select().from(s.invoices).where(eq(s.invoices.id, 602)))[0];
    expect(after.paidAmount).toBe("5000.00"); // 5000 مدفوع + 5000 مرتجع = الإجمالي، بلا تجاوز
    expect(Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, partyId)))[0].currentBalance)).toBe(0);
  });
});

describe("F3 — أجرة COUNTER على مسار المسوّدة تُرفض حتى ش٦", () => {
  it("commitDraft لبند تخصيصٍ hasDelivery+COUNTER بأجرة > 0 ⇒ BAD_REQUEST ولا مستندات", async () => {
    const shift = await openReception();
    const p = await promoteDraft({
      branchId: 1,
      header: { customerId: 1 },
      lines: [{
        lineKind: "CUSTOM", quantity: "1", unitPrice: "45000.00", title: "درع بتوصيل",
        printSpec: JSON.stringify({
          laborCost: "0", priority: "NORMAL",
          hasDelivery: true, deliveryAddress: "بغداد", deliveryCost: "3000", deliveryFeeCollection: "COUNTER",
        }),
      }],
    }, CASHIER);

    await expect(commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "45000.00", shiftId: shift.shiftId,
      collectNow: null,
    }, CASHIER)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect((await db().select().from(s.workOrders)).length).toBe(0);
    expect((await db().select().from(s.invoices)).length).toBe(0);
    // المسوّدة تبقى OPEN — الموظّف يبدّل طريقة الأجرة ويعيد التثبيت.
    const draft = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, p.draftId)))[0];
    expect(draft.status).toBe("OPEN");

    // «المندوب يقبضها» (COURIER) يمرّ من نفس المسوّدة بعد تعديل المواصفة.
    await db().update(s.receptionDraftLines)
      .set({ printSpec: JSON.stringify({ laborCost: "0", priority: "NORMAL", hasDelivery: true, deliveryAddress: "بغداد", deliveryCost: "3000", deliveryFeeCollection: "COURIER" }) })
      .where(eq(s.receptionDraftLines.draftId, p.draftId));
    const ok = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "45000.00", shiftId: shift.shiftId,
      collectNow: null,
    }, CASHIER);
    expect(ok.workOrders.length).toBe(1);
  });
});

describe("F4 — ختم فاتورة التسليم: وردية استقبالٍ أو لا شيء", () => {
  it("منفّذٌ ورديته RETAIL فقط ⇒ فاتورة التسليم بلا shiftId (خارج طابور الاستقبال) وإيصال الدفعة على درجه", async () => {
    // أمرُ شغلٍ بلا عربون (لا إيصال عند الإنشاء ⇒ لا حاجة لوردية المُنشئ).
    const wo = await createWorkOrder({
      branchId: 1, customerId: 1, baseVariantId: null, title: "لوحة",
      salePrice: "10000", quantity: 1, deposit: "0",
    }, CASHIER) as { workOrderId: number };
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, wo.workOrderId));

    // المنفّذ الثاني يفتح وردية **تجزئة** فقط — لا استقبال.
    const retail = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 5, branchId: 1 });

    const res = await deliverWorkOrder(
      { workOrderId: wo.workOrderId, payment: { amount: "10000", method: "CASH" } },
      CASHIER2,
    );

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(inv.shiftId).toBeNull(); // كان يُختم بوردية RETAIL فتظهر «مبيعات» في Z تجزئةٍ بلا نقدها كاملاً
    // إيصال الدفعة على درج المنفّذ الفعليّ (النقد قُبض فعلاً هناك — المحاسبة على المستلَم).
    const rcpt = (await db().select().from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, res.invoiceId), eq(s.receipts.direction, "IN"))))[0];
    expect(Number(rcpt.shiftId)).toBe(retail.shiftId);
    expect(rcpt.cashBucket).toBe("DRAWER");
    // خارج طابور محطة الاستقبال (النطاق البنيويّ: وردية RECEPTION فقط).
    const page = await listReceptionInvoices({ branchId: 1, sinceDays: 7 });
    expect(page.rows.find((r) => r.id === res.invoiceId)).toBeUndefined();
  });

  it("منفّذٌ له وردية استقبال مفتوحة ⇒ الفاتورة تُختم بها وتظهر في الطابور (السلوك المقصود يبقى)", async () => {
    const wo = await createWorkOrder({
      branchId: 1, customerId: 1, baseVariantId: null, title: "لوحة",
      salePrice: "10000", quantity: 1, deposit: "0",
    }, CASHIER) as { workOrderId: number };
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, wo.workOrderId));
    const rec = await openReception(5);

    const res = await deliverWorkOrder(
      { workOrderId: wo.workOrderId, payment: { amount: "10000", method: "CASH" } },
      CASHIER2,
    );

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(Number(inv.shiftId)).toBe(rec.shiftId);
    const page = await listReceptionInvoices({ branchId: 1, sinceDays: 7 });
    expect(page.rows.find((r) => r.id === res.invoiceId)).toBeTruthy();
  });
});

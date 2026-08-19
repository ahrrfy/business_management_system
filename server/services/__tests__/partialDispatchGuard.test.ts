/**
 * ش٥ — الإرسال الجزئيّ: الطلبُ الواحد لا يخرج نصفه بصمت (١٩/٨).
 *
 * **العطبُ:** سلّةُ الاستقبال الواحدة تُنتج فاتورةَ بضاعةٍ جاهزة **وأوامرَ شغلٍ** معاً؛ والإسناد
 * يمسّ الفاتورة وحدها. فالمندوب يأخذ القرطاسية، والمطبوعاتُ ما زالت تحت التنفيذ — ولا شاشةَ
 * تقول ذلك لأحد: يتّصل الزبون غاضباً، والاستقبالُ لا يعرف أنّ طلبه خرج ناقصاً أصلاً.
 *
 * الثوابت المحروسة:
 *  (أ) أخٌ غيرُ جاهز ⇒ **رفض** بأرقامه (فشلٌ مغلق).
 *  (ب) الإقرار الصريح يمرّ — ويُكتب في حدث الإرسالية بأرقام الإخوة (لا إذنَ مجهول).
 *  (ج) كلُّ الإخوة جاهزون/مُسلَّمون/ملغَون ⇒ يمرّ بلا إقرار.
 *  (د) **فاتورةٌ بلا مسوّدة إطلاقاً ⇒ سلوكٌ مطابقٌ لليوم حرفياً** (صفر انحدار على المسار الشائع).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";

const TABLES = [
  "deliveryEvents", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "workOrderMaterials", "workOrders", "receptionDraftLines", "receptionDrafts",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const ACTOR = { userId: 1, branchId: 1, role: "manager" };

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "شركة توصيل", partyType: "COMPANY", branchId: 1, isActive: true, defaultFee: "0" },
  ]);
});

/** فاتورةٌ غير مدفوعة (COD) — أبسطُ حالةِ إسناد. */
async function invoice(id: number, number: string) {
  await db().insert(s.invoices).values({
    id, branchId: 1, invoiceNumber: number, customerId: 1,
    subtotal: "10000.00", total: "10000.00", paidAmount: "0.00",
    status: "PENDING", sourceType: "POS", createdBy: 1,
  } as never);
  return id;
}

/** مسوّدةُ استقبالٍ مرتبطةٌ بالفاتورة، وأمرُ شغلٍ ابنٌ لها بالحالة المطلوبة. */
async function draftWithChild(draftId: number, invoiceId: number, woStatus: string, orderNumber: string) {
  await db().insert(s.receptionDrafts).values({
    id: draftId, draftNumber: `DRF-T-${draftId}`, branchId: 1, customerId: 1,
    draftStatus: "COMMITTED", commitRequestId: `crq-t-${draftId}`, committedInvoiceId: invoiceId, createdBy: 1,
  } as never);
  await db().insert(s.workOrders).values({
    branchId: 1, customerId: 1, orderNumber, title: "مطبوعات",
    quantity: 1, salePrice: "5000.00", deposit: "0.00",
    status: woStatus, draftId, createdBy: 1,
  } as never);
}

const dispatch = (invoiceId: number, extra: Record<string, unknown> = {}) =>
  dispatchInvoiceToDelivery(
    { invoiceId, partyId: 1, deliveryFee: "0", clientRequestId: `t-${invoiceId}-${JSON.stringify(extra)}`, ...extra },
    ACTOR as never,
  );

describe("ش٥ — حارس الإرسال الجزئيّ", () => {
  it("⭐ (أ) أخٌ غيرُ جاهز ⇒ رفضٌ بأرقامه", async () => {
    await invoice(101, "INV-T-101");
    await draftWithChild(11, 101, "IN_PROGRESS", "WO-T-0001");

    await expect(dispatch(101)).rejects.toThrowError(/لم يجهز|WO-T-0001/);

    // فشلٌ مغلق ⇒ لا إرسالية ولا عهدة نصفية.
    const cns = await db().select().from(s.deliveryConsignments);
    expect(cns).toHaveLength(0);
  });

  it("⭐ (ب) الإقرار الصريح يمرّ ويُكتب في حدث الإرسالية", async () => {
    await invoice(102, "INV-T-102");
    await draftWithChild(12, 102, "RECEIVED", "WO-T-0002");

    const res = await dispatch(102, { partialDispatchConfirmed: true });
    expect(res.consignmentId).toBeGreaterThan(0);

    const events = await db().select().from(s.deliveryEvents)
      .where(eq(s.deliveryEvents.consignmentId, res.consignmentId));
    const assigned = events.find((e) => e.eventType === "ASSIGNED");
    expect(assigned).toBeTruthy();
    const payload = assigned!.payload as { partialDispatch?: boolean; unreadySiblings?: Array<{ orderNumber: string }> };
    // بلا هذا لا يُعرف بعد أسبوعٍ **من** أذن بخروج نصف الطلب ولا **ما** تُرك خلفه.
    expect(payload.partialDispatch).toBe(true);
    expect(payload.unreadySiblings?.[0]?.orderNumber).toBe("WO-T-0002");
  });

  it("⭐ (ج) كلُّ الإخوة جاهزون ⇒ يمرّ بلا إقرار", async () => {
    await invoice(103, "INV-T-103");
    await draftWithChild(13, 103, "READY", "WO-T-0003");
    const res = await dispatch(103);
    expect(res.consignmentId).toBeGreaterThan(0);
  });

  it("⭐ (د) فاتورةٌ بلا مسوّدة ⇒ سلوكٌ مطابقٌ لليوم (صفر انحدار)", async () => {
    await invoice(104, "INV-T-104");
    const res = await dispatch(104);
    expect(res.consignmentId).toBeGreaterThan(0);
    const events = await db().select().from(s.deliveryEvents)
      .where(eq(s.deliveryEvents.consignmentId, res.consignmentId));
    const payload = events.find((e) => e.eventType === "ASSIGNED")!.payload as { partialDispatch?: boolean };
    expect(payload.partialDispatch).toBeUndefined();
  });

  it("أخٌ مُسلَّمٌ أو ملغىً لا يُعدّ عائقاً", async () => {
    await invoice(105, "INV-T-105");
    await db().insert(s.receptionDrafts).values({
      id: 15, draftNumber: "DRF-T-15", branchId: 1, customerId: 1,
      draftStatus: "COMMITTED", commitRequestId: "crq-t-15", committedInvoiceId: 105, createdBy: 1,
    } as never);
    await db().insert(s.workOrders).values([
      { branchId: 1, customerId: 1, orderNumber: "WO-T-0005", title: "أ", quantity: 1, salePrice: "1.00", deposit: "0.00", status: "DELIVERED", draftId: 15, createdBy: 1 },
      { branchId: 1, customerId: 1, orderNumber: "WO-T-0006", title: "ب", quantity: 1, salePrice: "1.00", deposit: "0.00", status: "CANCELLED", draftId: 15, createdBy: 1 },
    ] as never);
    const res = await dispatch(105);
    expect(res.consignmentId).toBeGreaterThan(0);
  });
});

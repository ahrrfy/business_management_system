/**
 * **المرتجعُ المُعلَن ≠ المرتجعُ المستلَم** (٢١/٨) — إطار المالك، نسخة ٢.
 *
 * شركةُ التوصيل تُعلن رجوعَ طردٍ قبل وصوله بأيّام. وقبل هذه الشريحة لم يكن ثمّة إلّا
 * `returnConsignment` — لحظةُ الاستلام التي تُعيد المخزون وتُرجع الفاتورة وتردّ العربون
 * دفعةً واحدة. فالموظّف بين خطأين: يُشغّلها عند الإعلان **فيعود للمخزون صنفٌ لم يصل ولم
 * يُفحَص** ويُباع وهو ليس في الرفّ؛ أو ينتظر فيبقى تعرّضُ التحصيل على الجهة أسابيع.
 *
 * الثوابت المحروسة:
 *  (أ) الإعلانُ يُحرّر التعرّض **ولا يمسّ مخزوناً ولا فاتورةً ولا عربوناً ولا أمرَ شغل**.
 *  (ب) الطردُ يبقى `DISPATCHED` — لأنّه بالطريق فعلاً — ويُوسَم بـ`returnDeclaredAt`.
 *  (ج) **التحرير مرّةً واحدة**: الاستلامُ بعد الإعلان لا يُحرّر ثانيةً.
 *      ⚠️ حارسٌ صريحٌ لا بنيويّ: `deliveryLedgerEntries.eventKey` **بلا فهرسٍ فريد** في
 *      المخطّط، فالإدراجُ المكرَّر يمرّ بلا خطأ ويُحرّر المبلغ مرّتين.
 *  (د) الاستلامُ بعد الإعلان يُكمل العكس كاملاً (مخزون + فاتورة).
 *  (هـ) طردٌ حُصِّل منه مالٌ لا يُعلَن — مسارُه الاسترجاع الكامل.
 *  (و) لا إعلانَ مكرَّر، ولا إعلانَ لطردٍ غير مُرسَل، وعزلُ الفرع حاكم.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { dispatchToDelivery } from "../delivery/dispatch";
import { listInTransitConsignments } from "../delivery/queries";
import { declareConsignmentReturn } from "../delivery/declaredReturn";
import { returnConsignment } from "../delivery/returns";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { money, round2 } from "../money";
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

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  sharedShiftId = null;
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "rc2", name: "موظف فرع آخر", email: "r2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "شركة التوصيل السريع", partyKind: "COMPANY", currentBalance: "0.00", isActive: true },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
});

/** وردية استقبالٍ واحدة لكل ملف — فتحُ ثانيةٍ في الفرع نفسه مرفوضٌ بحكم التصميم. */
let sharedShiftId: number | null = null;
async function receptionShift() {
  if (sharedShiftId != null) return sharedShiftId;
  const sh = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  sharedShiftId = sh.shiftId;
  return sharedShiftId;
}

/** أمرُ توصيلٍ مُرسَل — بلا عربون ⇒ كلُّه COD على الشركة. */
async function dispatchedOrder(reqId: string, salePrice: string) {
  const shiftId = await receptionShift();
  const r = await checkoutReception({
    branchId: 1, shiftId, customerId: 1,
    paidAmount: "0", clientRequestId: reqId,
    workOrders: [{
      title: "طلب توصيل", quantity: 1, salePrice, materials: [],
      hasDelivery: true, deliveryAddress: "بغداد", deliveryPhone: "+9647701234567",
    }],
  } as never, CASHIER as never);
  const woId = (r as { workOrders: { workOrderId: number }[] }).workOrders[0].workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  const d = await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: `d-${reqId}` }, CASHIER as never);
  return { workOrderId: woId, consignmentId: d.consignmentId, invoiceId: d.invoiceId };
}

const cnOf = async (id: number) =>
  (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)))[0];
const invOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const custBalance = async () =>
  Number((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance);

/** مجموعُ ما حُرِّر من تعرّضٍ على الإرسالية — الرقم الذي يتضاعف لو تكرّر التحرير. */
async function releasedTotal(consignmentId: number) {
  const rows = await db().select().from(s.deliveryLedgerEntries)
    .where(eq(s.deliveryLedgerEntries.consignmentId, consignmentId));
  return round2(rows.filter((r) => r.entryType === "COD_RELEASED")
    .reduce((sum, r) => sum.plus(money(r.amount)), money(0)));
}
const stockOf = async () =>
  Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity);

describe("المرتجع المُعلَن ≠ المستلَم", () => {
  it("⭐ (أ)+(ب) الإعلان يُحرّر التعرّض ولا يمسّ مخزوناً ولا فاتورةً ولا حالةَ الطرد", async () => {
    const a = await dispatchedOrder("dr-1", "20000.00");
    const stockBefore = await stockOf();
    expect(await custBalance()).toBe(20000);

    const res = await declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "رفض العميل الاستلام", clientRequestId: "decl-1" },
      CASHIER as never,
    );
    expect(res.declared).toBe(true);
    expect(res.releasedExposure).toBe("20000.00");

    // التعرّضُ حُرِّر — وهذا كلُّ ما يفعله الإعلان.
    expect((await releasedTotal(a.consignmentId)).toFixed(2)).toBe("20000.00");

    const cn = await cnOf(a.consignmentId);
    expect(cn.returnDeclaredAt).toBeTruthy();
    expect(cn.returnDeclaredReason).toBe("رفض العميل الاستلام");
    expect(Number(cn.returnDeclaredBy)).toBe(CASHIER.userId);
    // ⛔ الطردُ ما زال بالطريق فعلاً — لا تتغيّر حالتُه.
    expect(cn.status).toBe("DISPATCHED");
    expect(cn.parcelStatus).not.toBe("RETURNED");

    // ⛔ ولا شيءَ آخر تحرّك: البضاعةُ لم تصل ولم تُفحَص.
    expect(await stockOf()).toBe(stockBefore);
    expect((await invOf(a.invoiceId)).status).not.toBe("RETURNED");
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, a.workOrderId)))[0];
    expect(wo.status).not.toBe("CANCELLED");
  });

  it("⭐ (ج)+(د) الاستلامُ بعد الإعلان يُكمل العكس — والتعرّضُ يُحرَّر مرّةً واحدة", async () => {
    const a = await dispatchedOrder("dr-2", "15000.00");
    const stockBefore = await stockOf();
    await declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "عنوان خاطئ", clientRequestId: "decl-2" },
      CASHIER as never,
    );
    expect((await releasedTotal(a.consignmentId)).toFixed(2)).toBe("15000.00");

    // وصل الطردُ وفُحص ⇒ العكسُ الكامل.
    await returnConsignment(a.consignmentId, {
      ...(CASHIER as never), clientRequestId: "ret-2", returnReason: "عنوان خاطئ",
    } as never);

    // ⚠️ الثابتُ الحاكم: **١٥٬٠٠٠ لا ٣٠٬٠٠٠**. لولا الحارس الصريح لتضاعف — لا فهرسَ فريداً
    // على `eventKey` يمنع الإدراج الثاني.
    expect((await releasedTotal(a.consignmentId)).toFixed(2)).toBe("15000.00");

    // والآن فقط يقع الأثرُ الكامل.
    const cn = await cnOf(a.consignmentId);
    expect(cn.parcelStatus).toBe("RETURNED");
    expect((await invOf(a.invoiceId)).status).toBe("RETURNED");
    // ملاحظة: هذه التجهيزةُ أمرُ خدمةٍ بلا مواد ⇒ لا سطرَ مخزونٍ يعود أصلاً. الثابتُ
    // المقصود هنا أنّ **الاستلام** هو ما يُكمل العكس (الفاتورة والحالة والذمّة) بعد أن
    // اكتفى الإعلانُ بتحرير التعرّض — وثباتُ المخزون عند الإعلان محروسٌ في الحالة (أ).
    expect(await stockOf()).toBe(stockBefore);
    expect(await custBalance()).toBe(0);
  });

  it("⭐ (هـ) طردٌ حُصِّل منه مالٌ لا يُعلَن — مسارُه الاسترجاع الكامل", async () => {
    const a = await dispatchedOrder("dr-3", "9000.00");
    await db().update(s.deliveryConsignments)
      .set({ collectedAmount: "9000.00" })
      .where(eq(s.deliveryConsignments.id, a.consignmentId));

    await expect(declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "رفض" }, CASHIER as never,
    )).rejects.toThrowError(/الاسترجاع الكامل|حُصِّل/);
  });

  it("⭐ (و) لا إعلانَ مكرَّر ولا سببَ فارغ ولا عبورَ فرع", async () => {
    const a = await dispatchedOrder("dr-4", "5000.00");
    await declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "لم يُعثر على العميل" }, CASHIER as never,
    );
    // مكرَّر ⇒ يُرفض (وإلّا حُرِّر التعرّض مرّتين).
    await expect(declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "مرّة أخرى" }, CASHIER as never,
    )).rejects.toThrowError(/مُعلَنٌ سلفاً/);

    const b = await dispatchedOrder("dr-5", "3000.00");
    await expect(declareConsignmentReturn(
      { consignmentId: b.consignmentId, reason: "ok" }, CASHIER as never,
    )).rejects.toThrowError(/سبب/);
    // موظّفُ فرعٍ آخر لا يُعلن على إرسالية فرعنا.
    await expect(declareConsignmentReturn(
      { consignmentId: b.consignmentId, reason: "رفض العميل" },
      { userId: 3, branchId: 2, role: "cashier" } as never,
    )).rejects.toThrowError(/فرعاً آخر/);
  });

  it("⭐ بعد الإعلان: لا إلغاءَ إسناد — وإلّا حُرِّر التعرّض مرّتين", async () => {
    // تصويبُ مراجعة Codex: وسمُ الإعلان أعمدةٌ إضافية، فالحرّاسُ القائمة **لا تراه**؛
    // و`cancelDeliveryAssignment` يقبل ASSIGNED ويكتب `COD_RELEASED` ثانياً.
    const a = await dispatchedOrder("dr-7", "12000.00");
    await declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "رفض العميل" }, CASHIER as never,
    );
    // الإلغاءُ صلاحيةُ مدير — نستعمله كي يبلغ الحارسَ المقصود لا حارسَ الدور.
    await expect(cancelDeliveryAssignment(
      { consignmentId: a.consignmentId, reason: "إلغاء", clientRequestId: "cancel-after-decl" } as never,
      { userId: 1, branchId: 1, role: "manager" } as never,
    )).rejects.toThrowError(/أُعلن رجوعُه/);
    // التحريرُ ما زال مرّةً واحدة.
    expect((await releasedTotal(a.consignmentId)).toFixed(2)).toBe("12000.00");
  });

  it("⭐ التعرّضُ المعروض يصفر بعد الإعلان — لا تُضخَّم لوحةُ التحصيل بمبلغٍ حُرِّر", async () => {
    const a = await dispatchedOrder("dr-8", "8000.00");
    const before = await db().select().from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, a.consignmentId));
    expect(Number(before[0].codAmount)).toBe(8000);

    await declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "عنوان خاطئ" }, CASHIER as never,
    );
    const rows = await listInTransitConsignments(1);
    const row = rows.find((r) => Number(r.id) === a.consignmentId)!;
    // `codAmount` يبقى كما هو (تاريخُ المستند)، لكنّ **المتبقّي المعروض** صفرٌ لأنّه حُرِّر.
    expect(Number(row.codDue)).toBe(0);
    expect(row.returnDeclaredAt).toBeTruthy();
    expect(row.returnDeclaredReason).toBe("عنوان خاطئ");
  });

  it("السببُ ورقمُ الكشف يبقيان ضمن حدّ العمود (500)", async () => {
    const a = await dispatchedOrder("dr-9", "4000.00");
    await declareConsignmentReturn({
      consignmentId: a.consignmentId,
      reason: "س".repeat(500),          // السببُ وحده يبلغ الحدّ
      statementNumber: "STMT-VERY-LONG-0001",
    }, CASHIER as never);
    const cn = await cnOf(a.consignmentId);
    expect((cn.returnDeclaredReason ?? "").length).toBeLessThanOrEqual(500);
    expect(cn.returnDeclaredReason).toContain("STMT-VERY-LONG-0001"); // الرقمُ يُصان
  });

  it("إعادةُ الإعلان بنفس المفتاح لا تُحرّر ثانيةً", async () => {
    const a = await dispatchedOrder("dr-6", "7000.00");
    await declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "رفض العميل", clientRequestId: "decl-idem" },
      CASHIER as never,
    );
    const replay = await declareConsignmentReturn(
      { consignmentId: a.consignmentId, reason: "رفض العميل", clientRequestId: "decl-idem" },
      CASHIER as never,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect((await releasedTotal(a.consignmentId)).toFixed(2)).toBe("7000.00");
  });
});

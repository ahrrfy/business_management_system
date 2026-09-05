/**
 * ش٤ — إلغاءٌ صادق: قرارُ خامةٍ تصريحيّ وسببٌ على المستند وحارسُ ما بعد الفوترة (١٩/٨).
 *
 * **العطبُ الجذريّ الذي تحرسه:** الإلغاء كان يعيد **كلَّ** الخامة للمخزون دائماً، ولا بديل.
 * فورقٌ طُبع عليه تصميمٌ خاطئ يعود صنفاً صالحاً بقيمته كاملةً: مخزونٌ يعدّ ما لا يوجد، وربحٌ
 * لم يقع، وهدرٌ حقيقيّ **لا يظهر في أيّ تقرير** — فلا يعرف المالك أنّه ينزف.
 *
 * الثوابت المحروسة:
 *  (أ) بلا قرار ⇒ رجوعٌ كامل — **صفر تغيّرٍ سلوكيّ** لكلّ مستدعٍ قائم.
 *  (ب) قرارٌ جزئيّ ⇒ يعود ما قُرِّر وحده، والباقي قيدُ **خسارة** بلا أيّ حركة مخزون.
 *  (ج) `CONSUME − CANCEL − WASTE = 0` — لا دينارَ يبقى معلّقاً في WIP.
 *  (د) مجموعٌ لا يساوي المستهلَك ⇒ **رفض** (لا امتصاصَ صامت).
 *  (هـ) سطرٌ ناقصٌ من القرار ⇒ رفض (لا سطرَ ضمنيّ).
 *  (و) السببُ يُكتب على الأمر لا في التدقيق وحده.
 *  (ز) أمرٌ صدرت فاتورتُه ⇒ **يُرفض الإلغاء** ويُحال للاسترجاع.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { startWorkOrder } from "../workOrder/lifecycle";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import { money, round2 } from "../money";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "workOrderControlRequests", "workOrderEvents", "workOrderDesignApprovals", "workOrderDesignRevisions",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "serviceTypes", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const OWNER = { userId: 3, branchId: 1, role: "admin", isOwner: true };

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "o", name: "مالك معتمد", email: "o@t.test", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم", defaultKind: "SERVICE_REQUEST", defaultPriority: "HIGH",
    slaHours: 24, isActive: true, blocksExecution: true,
  });
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.products).values([{ id: 1, name: "ورق" }, { id: 2, name: "حبر" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "P-1", costPrice: "500.00" },
    { id: 2, productId: 2, sku: "I-1", costPrice: "250.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
  ]);
});

/** أمرٌ بمادّتين: ١٠ ورق × ٥٠٠ + ٤ حبر × ٢٥٠ = ٦٠٠٠. */
async function startedOrder(reqId: string) {
  const r = await createWorkOrder({
    branchId: 1, customerId: 1, title: "لوحة", quantity: 1, salePrice: "20000.00", deposit: "0",
    materials: [{ variantId: 1, baseQuantity: 10 }, { variantId: 2, baseQuantity: 4 }],
    clientRequestId: reqId,
  } as never, CASHIER);
  const woId = Number((r as { workOrderId: number }).workOrderId);
  const approval = await requestWorkOrderDesignApproval({
    workOrderId: woId,
    requestKey: `cancel-waste-design-request:${randomUUID()}`,
    note: "اعتماد النسخة الحالية قبل استهلاك مواد الاختبار",
  }, CASHIER);
  await decideWorkOrderDesignApproval({
    approvalId: Number(approval.approval.id),
    decisionKey: `cancel-waste-design-decision:${randomUUID()}`,
    decision: "APPROVED",
    reason: "ثبتت موافقة العميل على النسخة الحالية",
    evidence: { type: "WHATSAPP_MESSAGE", reference: `wamid.cancel-waste.${randomUUID()}` },
  }, MANAGER);
  await startWorkOrder(woId, CASHIER);
  return woId;
}

async function cancelGoverned(
  workOrderId: number,
  input: {
    reason: string;
    materials?: Array<{ workOrderMaterialId: number; returnBase: number; wasteBase: number }>;
  },
) {
  const [workOrder] = await db().select({ version: s.workOrders.version })
    .from(s.workOrders).where(eq(s.workOrders.id, workOrderId));
  const request = await requestWorkOrderControl({
    requestKey: `cancel-waste-control:${randomUUID()}`,
    workOrderId,
    requestType: "CANCEL",
    baseVersion: Number(workOrder.version),
    reason: input.reason,
    payload: { refundShiftId: null, materials: input.materials ?? null },
  }, MANAGER);
  return approveWorkOrderControlRequest(
    Number(request.id),
    OWNER,
    "راجعت سبب الإلغاء وتسوية المواد والهدر قبل الاعتماد",
  );
}

const stockOf = async (variantId: number) =>
  Number((await db().select().from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1))))[0].quantity);

const matsOf = async (woId: number) =>
  await db().select().from(s.workOrderMaterials).where(eq(s.workOrderMaterials.workOrderId, woId));

/**
 * صافي WIP من القيود: CONSUME مديناً ناقص CANCEL/WASTE دائناً.
 *
 * ⚠️ التمييزُ بـ`dedupeKey` **لا** بـ`postingProfile`: العمود الأخير لا يُملأ إلّا حين يكون
 * الدفترُ المزدوج مُفعَّلاً (وهو OFF افتراضياً — §٦)، فالتأكيدُ عليه يمرّ فارغاً دائماً
 * ⇒ اختبارٌ **أخضرُ كاذب** لا يمسك شيئاً. و`dedupeKey` يُكتب في كل الأحوال.
 */
async function wipNet() {
  const rows = await db().select({ key: s.accountingEntries.dedupeKey, amount: s.accountingEntries.amount })
    .from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
  let net = money(0);
  for (const r of rows) {
    const k = r.key ?? "";
    if (k.startsWith("WO-WIP-CONSUME:")) net = net.plus(money(r.amount));
    if (k.startsWith("WO-WIP-CANCEL:") || k.startsWith("WO-WIP-WASTE:")) net = net.minus(money(r.amount));
  }
  return round2(net);
}

const entriesByKeyPrefix = async (prefix: string) =>
  (await db().select().from(s.accountingEntries)).filter((e) => (e.dedupeKey ?? "").startsWith(prefix));

describe("ش٤ — إلغاء أمر الشغل: قرار الخامة والسبب", () => {
  it("⭐ (أ) بلا قرار ⇒ رجوعٌ كامل وصفر هدر — السلوك القائم حرفياً", async () => {
    const woId = await startedOrder("cw-1");
    expect(await stockOf(1)).toBe(90);

    await cancelGoverned(woId, { reason: "العميل ألغى الطلب" });

    expect(await stockOf(1)).toBe(100);
    expect(await stockOf(2)).toBe(100);
    expect(await entriesByKeyPrefix("WO-WIP-WASTE:")).toHaveLength(0);
    expect((await wipNet()).toFixed(2)).toBe("0.00");
  });

  it("⭐ (ب)+(ج) قرارٌ جزئيّ: يعود المقرَّر وحده، والباقي خسارةٌ بلا حركة مخزون، وWIP يصفر", async () => {
    const woId = await startedOrder("cw-2");
    const mats = await matsOf(woId);
    const paper = mats.find((m) => Number(m.variantId) === 1)!;
    const ink = mats.find((m) => Number(m.variantId) === 2)!;

    // أُتلف ٤ ورقات (٤ × ٥٠٠ = ٢٠٠٠) وسلم الحبر كلّه.
    await cancelGoverned(woId, {
      reason: "تلف أثناء الطباعة",
      materials: [
        { workOrderMaterialId: Number(paper.id), returnBase: 6, wasteBase: 4 },
        { workOrderMaterialId: Number(ink.id), returnBase: 4, wasteBase: 0 },
      ],
    });

    expect(await stockOf(1)).toBe(96); // ٩٠ + ٦ الراجعة — لا ١٠٠
    expect(await stockOf(2)).toBe(100);

    const waste = await entriesByKeyPrefix("WO-WIP-WASTE:");
    expect(waste).toHaveLength(1);
    expect(round2(money(waste[0].amount)).toFixed(2)).toBe("2000.00");

    // ⛔ الهدر قيدٌ فقط: المادّة خُصمت عند البدء، وخصمُها ثانيةً سالبٌ كاذب.
    const wasteMoves = await db().select({ n: sql<number>`COUNT(*)` }).from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceType, "STOCK_EXPENSE"));
    expect(Number(wasteMoves[0].n)).toBe(0);

    expect((await wipNet()).toFixed(2)).toBe("0.00");
  });

  it("⭐ (د) مجموعُ الرجوع والهدر لا يساوي المستهلَك ⇒ رفض", async () => {
    const woId = await startedOrder("cw-3");
    const mats = await matsOf(woId);
    await expect(
      cancelGoverned(woId, {
        reason: "خطأ إنتاج موثق يحتاج تسوية مواد",
        materials: mats.map((m) => ({
          workOrderMaterialId: Number(m.id),
          returnBase: Number(m.baseQuantity) - 1,
          wasteBase: 0, // ينقص واحد — يتبخّر
        })),
      }),
    ).rejects.toThrowError(/لا يساوي المستهلَك/);
    expect(await stockOf(1)).toBe(90); // رفضٌ ذرّيّ: لا رجوعَ جزئيّ
  });

  it("⭐ (هـ) سطرٌ ناقصٌ من القرار ⇒ رفض (لا سطرَ ضمنيّ)", async () => {
    const woId = await startedOrder("cw-4");
    const mats = await matsOf(woId);
    await expect(
      cancelGoverned(woId, {
        reason: "خطأ إنتاج موثق بقرار مواد ناقص",
        materials: [{ workOrderMaterialId: Number(mats[0].id), returnBase: Number(mats[0].baseQuantity), wasteBase: 0 }],
      }),
    ).rejects.toThrowError(/ناقص/);
  });

  it("⭐ (و) السببُ والفاعلُ والوقتُ تُكتَب على الأمر نفسه", async () => {
    const woId = await startedOrder("cw-5");
    await cancelGoverned(woId, { reason: "لم يحضر العميل لاستلام الطلب" });
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.cancelReason).toBe("لم يحضر العميل لاستلام الطلب");
    // الإلغاء الحاكم يُنفَّذ لحظة الاعتماد، لذلك يُنسب إلى صاحب القرار المستقل
    // لا إلى طالب الإلغاء (فصل الواجبات).
    expect(Number(wo.cancelledBy)).toBe(OWNER.userId);
    expect(wo.cancelledAt).toBeTruthy();
  });

  it("⭐ (ز) أمرٌ صدرت فاتورتُه ⇒ يُرفض الإلغاء ويُحال للاسترجاع", async () => {
    const woId = await startedOrder("cw-6");
    await db().insert(s.invoices).values({
      id: 900, branchId: 1, invoiceNumber: "INV-T-900", customerId: 1,
      subtotal: "20000.00", total: "20000.00", paidAmount: "0.00", status: "PENDING", sourceType: "WORKORDER",
      createdBy: 2,
    } as never);
    await db().update(s.workOrders).set({ invoiceId: 900 }).where(eq(s.workOrders.id, woId));

    await expect(cancelGoverned(woId, { reason: "إلغاء موثق بعد صدور الفاتورة" }))
      .rejects.toThrowError(/فاتورة|استرجاع/);
    expect(await stockOf(1)).toBe(90); // لم تعد المواد — لا عكسَ نصفيّ
  });

  it("قرارُ هدرٍ على أمرٍ لم يبدأ ⇒ رفض صريح لا قبولٌ صامت", async () => {
    const r = await createWorkOrder({
      branchId: 1, customerId: 1, title: "بلا بدء", quantity: 1, salePrice: "5000.00", deposit: "0",
      materials: [{ variantId: 1, baseQuantity: 2 }], clientRequestId: "cw-7",
    } as never, CASHIER);
    const woId = Number((r as { workOrderId: number }).workOrderId);
    await expect(
      cancelGoverned(woId, { reason: "خطأ موثق قبل بدء التنفيذ", materials: [{ workOrderMaterialId: 1, returnBase: 2, wasteBase: 0 }] }),
    ).rejects.toThrowError(/لم يبدأ|لا خامة/);
  });
});

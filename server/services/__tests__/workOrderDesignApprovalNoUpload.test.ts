/**
 * **الاعتمادُ بلا رفعِ ملفّ تصميم** (قرار المالك ١/٩/٢٦):
 * «لا حاجة لرفع التصميم، فقط الضغط على موافق يكفي — الرفعُ يملأ الخادم بأشياء لا فائدة منها».
 *
 * الحائطُ كان في الواجهة وحدها (`revision != null` قبل إظهار زرّ الطلب)، والخادمُ يُثبّت
 * النسخةَ الأولى تلقائياً. هذه الاختبارات تُثبت أنّ **الدورة كاملةً** تمرّ بلا صورةٍ واحدة:
 * طلب ← قرار ← بدءُ تنفيذ — وأنّ ما يُحفَظ سجلٌّ حقيقيّ (نسخةٌ مبصومة ومهمّةٌ محسومة) لا
 * موافقةٌ وهميّة. وتحرس أيضاً أنّ الحرّاس التي لم تُمَسّ ما زالت تعمل.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import {
  decideWorkOrderDesignApproval,
  getCurrentWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import { startWorkOrder } from "../workOrder/lifecycle";

const TABLES = [
  "workOrderEvents", "workOrderDesignApprovals", "workOrderDesignRevisions",
  "taskEvents", "tasks", "serviceTypes", "idempotencyKeys", "accountingEntries",
  "receipts", "inventoryMovements", "workOrderMaterials", "workOrderImages",
  "workOrders", "invoiceItems", "invoices", "branchStock", "productPrices",
  "productUnits", "productVariants", "products", "shifts", "customers",
  "branches", "users", "auditLogs",
];

const CREATOR = { userId: 2, branchId: 1, role: "cashier" };
const TECH = { userId: 4, branchId: 1, role: "print_operator" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "csh", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "tech", name: "فنّي", role: "print_operator", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0.00" });
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    isActive: true,
    blocksExecution: true,
  } as never);
});

/** أمرٌ **بلا أيّ صورة** — لا `designImages` ولا `setWorkOrderDesign` قطّ. */
async function orderWithoutAnyDesignFile(key: string) {
  const result = await createWorkOrder({
    branchId: 1,
    customerId: 1,
    title: "لوحة إعلانية",
    customizationText: "خطّ عريض — اسم المحل فقط",
    assignedTo: TECH.userId,
    quantity: 1,
    salePrice: "50000.00",
    deposit: "0",
    materials: [{ variantId: 1, baseQuantity: 5 }],
    designImages: [],
    clientRequestId: key,
  } as never, CREATOR);
  return Number((result as { workOrderId: number }).workOrderId);
}

describe("اعتماد التصميم بلا رفع ملفّ", () => {
  it("⭐ الدورةُ كاملةً بلا صورةٍ واحدة: طلب ← اعتماد ← بدءُ التنفيذ", async () => {
    const woId = await orderWithoutAnyDesignFile("no-upload-1");

    // لا صورةَ في القاعدة قبل الطلب ولا بعده — وهذا هو بيتُ القصيد (حجمُ الخادم).
    expect(await db().select().from(s.workOrderImages).where(eq(s.workOrderImages.workOrderId, woId)))
      .toHaveLength(0);
    const beforeView = await getCurrentWorkOrderDesignApproval(woId, TECH);
    expect(beforeView.approval).toBeNull();

    const requested = await requestWorkOrderDesignApproval(
      { workOrderId: woId, requestKey: "no-upload-req-1", note: null },
      TECH,
    );
    expect(requested.approval.status).toBe("PENDING");

    // الخادمُ ثبّت النسخةَ الأولى وبصمها من نصّ التخصيص وحده.
    const revisions = await db().select().from(s.workOrderDesignRevisions)
      .where(eq(s.workOrderDesignRevisions.workOrderId, woId));
    expect(revisions).toHaveLength(1);
    expect(Number(revisions[0].revision)).toBe(1);
    expect(revisions[0].contentHash).toHaveLength(64);
    expect(await db().select().from(s.workOrderImages).where(eq(s.workOrderImages.workOrderId, woId)))
      .toHaveLength(0);

    await decideWorkOrderDesignApproval({
      approvalId: Number(requested.approval.id),
      decisionKey: "no-upload-dec-1",
      decision: "APPROVED",
      reason: "وافق العميل على التصميم",
      evidence: { type: "OTHER", reference: "موافقة العميل على نسخة التصميم 1 — أمر WO — حضورياً" },
    }, MANAGER);

    const afterView = await getCurrentWorkOrderDesignApproval(woId, TECH);
    expect(afterView.approval?.status).toBe("APPROVED");
    expect(afterView.images).toHaveLength(0);

    // والتنفيذ مفتوحٌ (لم يعد الاعتمادُ شرطاً له أصلاً بعد ١/٩/٢٦).
    await startWorkOrder(woId, TECH);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)).limit(1))[0];
    expect(wo.status).toBe("IN_PROGRESS");
  });

  it("سجلُّ القرار حقيقيّ: مهمّةٌ محسومة ودليلٌ محفوظ — لا موافقةٌ وهميّة", async () => {
    const woId = await orderWithoutAnyDesignFile("no-upload-2");
    const requested = await requestWorkOrderDesignApproval(
      { workOrderId: woId, requestKey: "no-upload-req-2", note: null },
      TECH,
    );
    const taskId = Number(requested.approval.taskId);
    expect(taskId).toBeGreaterThan(0);

    await decideWorkOrderDesignApproval({
      approvalId: Number(requested.approval.id),
      decisionKey: "no-upload-dec-2",
      decision: "APPROVED",
      reason: "أكّد العميل بالهاتف",
      evidence: { type: "OTHER", reference: "مكالمة هاتفية مع العميل — نسخة 1" },
    }, MANAGER);

    const task = (await db().select().from(s.tasks).where(eq(s.tasks.id, taskId)).limit(1))[0];
    expect(task.taskStatus).toBe("RESOLVED");
    const approval = (await db().select().from(s.workOrderDesignApprovals)
      .where(eq(s.workOrderDesignApprovals.id, Number(requested.approval.id))).limit(1))[0];
    expect(approval.evidenceType).toBe("OTHER");
    expect(approval.evidenceReference).toContain("العميل");
    expect(Number(approval.reviewedBy)).toBe(MANAGER.userId);
  });

  /**
   * ⭐ **انقلب العقد** (قرار المالك ١/٩/٢٦): كان هنا حارسٌ يؤكّد أنّ التنفيذ لا يبدأ بلا
   * اعتماد. حُذفت الخطوةُ من المسار كلّياً، فصار الاختبار يحرس **عدم** عودة الحجز — ويبقى
   * فصلُ الواجبات محروساً على مسار القرار نفسه لمن اختار توثيقه.
   */
  it("⭐ التنفيذ يبدأ بلا أيّ اعتماد، وفصلُ الواجبات باقٍ على القرار نفسه", async () => {
    const woId = await orderWithoutAnyDesignFile("no-upload-3");
    await startWorkOrder(woId, TECH);
    expect(
      (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)).limit(1))[0].status,
    ).toBe("IN_PROGRESS");

    const requested = await requestWorkOrderDesignApproval(
      { workOrderId: woId, requestKey: "no-upload-req-3", note: null },
      TECH,
    );
    // الطالبُ نفسه (وهو الفنّي المسنَد) لا يعتمد طلبه ولو مُنح صلاحية المراجعة صراحةً.
    await expect(decideWorkOrderDesignApproval({
      approvalId: Number(requested.approval.id),
      decisionKey: "no-upload-dec-3",
      decision: "APPROVED",
      reason: "وافق العميل على التصميم",
      evidence: { type: "OTHER", reference: "موافقة حضورية" },
    }, { ...TECH, permissionsOverride: { workorders: "FULL" } } as never))
      .rejects.toThrow(/فصل الواجبات/);
  });

  /**
   * **حالةُ بلاغ المالك حرفياً**: أمرٌ بلا رأس نسخةٍ إطلاقاً (أمرٌ تاريخيّ سابقٌ لعمود النسخ).
   * البطاقةُ كانت تعرض «لا توجد نسخة تصميم مثبتة بعد — احفظ ملف التصميم أولاً» وتُخفي الزرّ،
   * بينما الخادمُ يُثبّت الرأسَ عند أوّل طلبٍ بلا أيّ رفع.
   */
  it("⭐ أمرٌ بلا رأس نسخةٍ إطلاقاً: الطلبُ يُثبّتها تلقائياً بلا رفعِ ملفّ", async () => {
    const woId = await orderWithoutAnyDesignFile("no-upload-4");
    await db().delete(s.workOrderDesignRevisions)
      .where(eq(s.workOrderDesignRevisions.workOrderId, woId));
    const orphanView = await getCurrentWorkOrderDesignApproval(woId, TECH);
    expect(orphanView.revision).toBeNull();

    const requested = await requestWorkOrderDesignApproval(
      { workOrderId: woId, requestKey: "no-upload-req-4", note: null },
      TECH,
    );
    expect(requested.approval.status).toBe("PENDING");
    const rebuilt = await getCurrentWorkOrderDesignApproval(woId, TECH);
    expect(rebuilt.revision).not.toBeNull();
    expect(rebuilt.images).toHaveLength(0);

    await decideWorkOrderDesignApproval({
      approvalId: Number(requested.approval.id),
      decisionKey: "no-upload-dec-4",
      decision: "APPROVED",
      reason: "وافق العميل على التصميم",
      evidence: { type: "OTHER", reference: "موافقة حضورية عند الكاونتر" },
    }, MANAGER);
    await startWorkOrder(woId, TECH);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)).limit(1))[0];
    expect(wo.status).toBe("IN_PROGRESS");
  });
});

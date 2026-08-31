import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { setWorkOrderDesign } from "../workOrder/design";
import {
  decideWorkOrderDesignApproval,
  getCurrentWorkOrderDesignApproval,
  getWorkOrderDesignApprovalByTask,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import { markWorkOrderReady, startWorkOrder } from "../workOrder/lifecycle";
import {
  cancelTask,
  claimTask,
  reopenTask,
  resolveTask,
} from "../tasks/lifecycle";

const TABLES = [
  "workOrderEvents",
  "workOrderDesignApprovals",
  "workOrderDesignRevisions",
  "taskEvents",
  "tasks",
  "serviceTypes",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "workOrderMaterials",
  "workOrderImages",
  "workOrders",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
  "auditLogs",
];

const CREATOR = { userId: 2, branchId: 1, role: "cashier" };
const REQUESTER = { userId: 3, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const OTHER_BRANCH_MANAGER = { userId: 5, branchId: 2, role: "manager" };
const DELEGATED_REVIEWER = {
  userId: 6,
  branchId: 1,
  role: "accountant",
  permissionsOverride: { workorders: "FULL" },
};
const CREATOR_AS_DELEGATED_REVIEWER = {
  ...CREATOR,
  permissionsOverride: { workorders: "FULL" },
};
const TECH_AS_DELEGATED_REVIEWER = {
  userId: 4,
  branchId: 1,
  role: "print_operator",
  permissionsOverride: { workorders: "FULL" },
};

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "manager",
      name: "مدير",
      email: "manager@t.test",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "creator",
      name: "منشئ",
      email: "creator@t.test",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 3,
      openId: "requester",
      name: "طالب",
      email: "requester@t.test",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 4,
      openId: "tech",
      name: "فنّي",
      email: "tech@t.test",
      role: "print_operator",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 5,
      openId: "branch2-manager",
      name: "مدير 2",
      email: "manager2@t.test",
      role: "manager",
      loginMethod: "local",
      branchId: 2,
    },
    {
      id: 6,
      openId: "delegated",
      name: "مراجع مفوض",
      email: "delegated@t.test",
      role: "accountant",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 7,
      openId: "self-manager",
      name: "مدير طالب",
      email: "self@t.test",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d
    .insert(s.customers)
    .values([
      { id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null },
    ]);
  await d.insert(s.products).values([{ id: 1, name: "ورق" }]);
  await d
    .insert(s.productVariants)
    .values([{ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" }]);
  await d
    .insert(s.productUnits)
    .values([
      {
        id: 1,
        variantId: 1,
        unitName: "قطعة",
        conversionFactor: "1",
        isBaseUnit: true,
      },
    ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    isActive: true,
    blocksExecution: true,
  } as never);
});

async function order(
  key: string,
  options: {
    customizationText?: string | null;
    assignedTo?: number | null;
    branchId?: number;
  } = {},
) {
  const branchId = options.branchId ?? 1;
  const result = await createWorkOrder(
    {
      branchId,
      customerId: 1,
      title: "لوحة إعلانية",
      customizationText: options.customizationText,
      assignedTo: options.assignedTo,
      quantity: 1,
      salePrice: "50000.00",
      deposit: "0",
      materials: [{ variantId: 1, baseQuantity: 5 }],
      designImages: [],
      clientRequestId: key,
    } as never,
    { ...CREATOR, branchId },
  );
  return Number((result as { workOrderId: number }).workOrderId);
}

async function request(woId: number, key: string, actor = REQUESTER) {
  const result = await requestWorkOrderDesignApproval(
    {
      workOrderId: woId,
      requestKey: key,
      note: "يرجى توثيق رد العميل",
    },
    actor,
  );
  return result.approval;
}

async function approve(
  approvalId: number,
  key: string,
  actor = DELEGATED_REVIEWER,
) {
  return decideWorkOrderDesignApproval(
    {
      approvalId,
      decisionKey: key,
      decision: "APPROVED",
      reason: "وافق العميل على النسخة النهائية",
      evidence: { type: "WHATSAPP_MESSAGE", reference: "wamid.design.1001" },
    },
    actor as never,
  );
}

describe("اعتماد تصميم أمر الشغل المتخصص", () => {
  it("ينشئ رأس نسخة مبصومة حتى مع صفر صور، ويحفظ النص عند customizationText=undefined", async () => {
    const woId = await order("design-head-zero", {
      customizationText: "طباعة أمامية فقط",
    });
    const first = (
      await db()
        .select()
        .from(s.workOrderDesignRevisions)
        .where(eq(s.workOrderDesignRevisions.workOrderId, woId))
    )[0];
    expect(Number(first.revision)).toBe(1);
    expect(first.customizationSnapshot).toBe("طباعة أمامية فقط");
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await db()
        .select()
        .from(s.workOrderImages)
        .where(eq(s.workOrderImages.workOrderId, woId)),
    ).toHaveLength(0);

    const changed = await setWorkOrderDesign(
      { workOrderId: woId, images: [{ url: PNG }] },
      CREATOR,
    );
    expect(changed.revision).toBe(2);
    const wo = (
      await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId))
    )[0];
    expect(wo.customizationText).toBe("طباعة أمامية فقط");
    const second = (
      await db()
        .select()
        .from(s.workOrderDesignRevisions)
        .where(
          and(
            eq(s.workOrderDesignRevisions.workOrderId, woId),
            eq(s.workOrderDesignRevisions.revision, 2),
          ),
        )
    )[0];
    expect(second.customizationSnapshot).toBe("طباعة أمامية فقط");
  });

  it("يفصل الطالب ومنشئ النسخة والفنّي المسند عن المراجع حتى مع تفويض FULL", async () => {
    const selfWo = await order("design-sod-requester");
    const selfApproval = await request(
      selfWo,
      "request-self",
      MANAGER as never,
    );
    await expect(
      approve(Number(selfApproval.id), "decision-self", MANAGER as never),
    ).rejects.toThrow(/فصل الواجبات/);

    const creatorWo = await order("design-sod-creator");
    const creatorApproval = await request(creatorWo, "request-creator");
    await expect(
      approve(
        Number(creatorApproval.id),
        "decision-creator",
        CREATOR_AS_DELEGATED_REVIEWER as never,
      ),
    ).rejects.toThrow(/فصل الواجبات/);

    const assignedWo = await order("design-sod-assignee", { assignedTo: 4 });
    const assignedApproval = await request(assignedWo, "request-assignee");
    await expect(
      approve(
        Number(assignedApproval.id),
        "decision-assignee",
        TECH_AS_DELEGATED_REVIEWER as never,
      ),
    ).rejects.toThrow(/فصل الواجبات/);
  });

  it("يقبل المراجع ذي المنح الصريح module-aware ويرفض القرار بلا دليل", async () => {
    const woId = await order("design-module-aware");
    const approval = await request(woId, "request-module-aware");
    await expect(
      decideWorkOrderDesignApproval(
        {
          approvalId: Number(approval.id),
          decisionKey: "decision-no-evidence",
          decision: "APPROVED",
          reason: "وافق العميل على التصميم",
          evidence: { type: "OTHER", reference: "" },
        },
        DELEGATED_REVIEWER as never,
      ),
    ).rejects.toThrow(/مرجع الدليل/);

    await approve(Number(approval.id), "decision-module-aware");
    const row = (
      await db()
        .select()
        .from(s.workOrderDesignApprovals)
        .where(eq(s.workOrderDesignApprovals.id, Number(approval.id)))
    )[0];
    expect(row.status).toBe("APPROVED");
    expect(Number(row.reviewedBy)).toBe(DELEGATED_REVIEWER.userId);
  });

  it("يرفض النسخة القديمة أو بصمة تغيّرت بعد الطلب", async () => {
    const staleWo = await order("design-stale-revision");
    const staleApproval = await request(staleWo, "request-stale-revision");
    await setWorkOrderDesign(
      { workOrderId: staleWo, images: [{ url: PNG }], note: "تعديل بعد الطلب" },
      CREATOR,
    );
    await expect(
      approve(Number(staleApproval.id), "decision-stale-revision"),
    ).rejects.toThrow(/محسوم|أحدث|قديم/);

    const hashWo = await order("design-stale-hash", {
      customizationText: "نص أصلي",
    });
    const hashApproval = await request(hashWo, "request-stale-hash");
    await db()
      .update(s.workOrders)
      .set({ customizationText: "تعديل مباشر غير مبصوم" })
      .where(eq(s.workOrders.id, hashWo));
    await expect(
      approve(Number(hashApproval.id), "decision-stale-hash"),
    ).rejects.toThrow(/تغيّر محتوى التصميم/);
  });

  it("يمنع resolve/cancel/reopen العام ويجعل المسار المتخصص هو المخرج الوحيد", async () => {
    const woId = await order("design-general-task-paths");
    const approval = await request(woId, "request-general-paths");
    const taskId = Number(approval.taskId);

    await expect(cancelTask(taskId, "إغلاق يدوي", MANAGER)).rejects.toThrow(
      /المسار.*المتخصص|قرار اعتماد التصميم/,
    );
    await claimTask(taskId, MANAGER);
    await expect(resolveTask(taskId, MANAGER, "وافق العميل")).rejects.toThrow(
      /المسار.*المتخصص|قرار اعتماد التصميم/,
    );

    await approve(Number(approval.id), "decision-specialized");
    const task = (
      await db().select().from(s.tasks).where(eq(s.tasks.id, taskId))
    )[0];
    expect(task.taskStatus).toBe("RESOLVED");
    await expect(
      reopenTask(taskId, MANAGER, "إعادة فتح يدوية"),
    ).rejects.toThrow(/المسار.*المتخصص|قرار اعتماد التصميم/);
  });

  it("يحجز البدء قبل أي أثر مخزني، ثم يسمح بعد اعتماد النسخة الحالية فقط", async () => {
    const woId = await order("design-start-gate");
    const beforeStock = Number(
      (
        await db()
          .select()
          .from(s.branchStock)
          .where(
            and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1)),
          )
      )[0].quantity,
    );
    const beforeMoves = Number(
      (
        await db()
          .select({ count: sql<number>`COUNT(*)` })
          .from(s.inventoryMovements)
      )[0].count,
    );

    await expect(startWorkOrder(woId, CREATOR)).rejects.toThrow(
      /لم تُعتمد|الاعتماد|تغيير التصميم/,
    );
    expect(
      Number(
        (
          await db()
            .select()
            .from(s.branchStock)
            .where(
              and(
                eq(s.branchStock.branchId, 1),
                eq(s.branchStock.variantId, 1),
              ),
            )
        )[0].quantity,
      ),
    ).toBe(beforeStock);
    expect(
      Number(
        (
          await db()
            .select({ count: sql<number>`COUNT(*)` })
            .from(s.inventoryMovements)
        )[0].count,
      ),
    ).toBe(beforeMoves);

    const approval = await request(woId, "request-start-gate");
    await approve(Number(approval.id), "decision-start-gate");
    await startWorkOrder(woId, CREATOR);
    expect(
      Number(
        (
          await db()
            .select()
            .from(s.branchStock)
            .where(
              and(
                eq(s.branchStock.branchId, 1),
                eq(s.branchStock.variantId, 1),
              ),
            )
        )[0].quantity,
      ),
    ).toBe(95);

    await setWorkOrderDesign(
      { workOrderId: woId, images: [{ url: PNG }], note: "نسخة بعد البدء" },
      CREATOR,
    );
    await expect(markWorkOrderReady(woId, CREATOR)).rejects.toThrow(
      /لم تُعتمد|الاعتماد|تغيير التصميم/,
    );
  });

  it("يفرض عزل الفرع ويعيد الطلب والقرار المطابقين فقط", async () => {
    const woId = await order("design-idempotency");
    const first = await requestWorkOrderDesignApproval(
      {
        workOrderId: woId,
        requestKey: "request-exact",
        note: "نفس الملاحظة",
      },
      REQUESTER,
    );
    const replay = await requestWorkOrderDesignApproval(
      {
        workOrderId: woId,
        requestKey: "request-exact",
        note: "نفس الملاحظة",
      },
      REQUESTER,
    );
    expect(replay.replayed).toBe(true);
    expect(Number(replay.approval.id)).toBe(Number(first.approval.id));
    await expect(
      requestWorkOrderDesignApproval(
        {
          workOrderId: woId,
          requestKey: "request-exact",
          note: "حمولة مختلفة",
        },
        REQUESTER,
      ),
    ).rejects.toThrow(/حمولة مختلفة|نسخة/);
    await expect(
      getCurrentWorkOrderDesignApproval(woId, OTHER_BRANCH_MANAGER),
    ).rejects.toThrow(/فرع/);
    await expect(
      getWorkOrderDesignApprovalByTask(
        Number(first.approval.taskId),
        OTHER_BRANCH_MANAGER,
      ),
    ).rejects.toThrow(/فرع/);

    const decisionInput = {
      approvalId: Number(first.approval.id),
      decisionKey: "decision-exact",
      decision: "APPROVED" as const,
      reason: "وافق العميل على النسخة النهائية",
      evidence: { type: "EMAIL" as const, reference: "mail-message-1001" },
    };
    const decision = await decideWorkOrderDesignApproval(
      decisionInput,
      DELEGATED_REVIEWER as never,
    );
    expect(decision.replayed).toBe(false);
    const decisionReplay = await decideWorkOrderDesignApproval(
      decisionInput,
      DELEGATED_REVIEWER as never,
    );
    expect(decisionReplay.replayed).toBe(true);
    await expect(
      decideWorkOrderDesignApproval(
        {
          ...decisionInput,
          reason: "سبب مختلف تحت المفتاح نفسه",
        },
        DELEGATED_REVIEWER as never,
      ),
    ).rejects.toThrow(/محسوم|مختلف/);
  });
});

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest, contentHash, getImageStore, objectKeyFor } from "../../lib/imageStore";
import { approveStudioTask, assignStudioTask, bulkAssignStudioTasks, attestStudioProcessing as finalizeStudioProcessing, authorizeStudioProcessing, bindStudioProcessingCandidate, cleanupStudioStaging, createStudioCampaign, createStudioCampaignBacklog, getStudioCampaignAnalytics, getStudioDashboard, getStudioCandidatePreview, getStudioSourcePreview, listStudioProducts, previewStudioCampaignBacklog, listStudioTasks, rejectStudioTask, resolveStudioBarcode, revertStudioTask, saveStudioDraft, sendStudioDueNotifications, submitStudioCandidate as submitStudioCandidateService, updateStudioTaskSchedule, type ProductStudioActor } from "../productStudioService";
import { sweepProductStudioStagingOnce } from "../productStudioStagingWorker";

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_1X1_ALT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII=";
const WEBP_1X1 = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

async function attestStudioProcessing(actor: ProductStudioActor, taskId: number, mode: "PRO" | "AI", adminOverrideReason?: string | null): Promise<string> {
  const authorization = await authorizeStudioProcessing(actor, taskId, mode, adminOverrideReason);
  return finalizeStudioProcessing(actor, taskId, mode, authorization, adminOverrideReason);
}

type SubmitInput = Parameters<typeof submitStudioCandidateService>[1];
function submitStudioCandidate(actor: ProductStudioActor, input: Omit<SubmitInput, "thumbnailDataUrl"> & { thumbnailDataUrl?: string }) {
  return submitStudioCandidateService(actor, {
    ...input,
    thumbnailDataUrl: input.thumbnailDataUrl ?? WEBP_1X1,
  });
}

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

const manager: ProductStudioActor = { userId: 1, branchId: 1, role: "manager" };
const worker: ProductStudioActor = {
  userId: 2,
  branchId: 1,
  role: "print_operator",
};
const otherWorker: ProductStudioActor = {
  userId: 3,
  branchId: 1,
  role: "print_operator",
};
const managerTwo: ProductStudioActor = {
  userId: 4,
  branchId: 2,
  role: "manager",
};
const workerTwo: ProductStudioActor = {
  userId: 5,
  branchId: 2,
  role: "print_operator",
};
const admin: ProductStudioActor = { userId: 6, branchId: null, role: "admin" };
const auditor: ProductStudioActor = { userId: 7, branchId: 1, role: "auditor" };

let storeDir = "";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "studio-manager",
      name: "المدير",
      role: "manager",
      branchId: 1,
    },
    {
      id: 2,
      openId: "studio-worker",
      name: "موظف الصور والمحتوى",
      role: "print_operator",
      branchId: 1,
    },
    {
      id: 3,
      openId: "studio-other",
      name: "موظف آخر",
      role: "print_operator",
      branchId: 1,
    },
    {
      id: 4,
      openId: "studio-manager-2",
      name: "مدير الفرع الثاني",
      role: "manager",
      branchId: 2,
    },
    {
      id: 5,
      openId: "studio-worker-2",
      name: "موظف الفرع الثاني",
      role: "print_operator",
      branchId: 2,
    },
    {
      id: 6,
      openId: "studio-admin",
      name: "الأدمن",
      role: "admin",
      branchId: null,
    },
    {
      id: 7,
      openId: "studio-auditor",
      name: "المدقق",
      role: "auditor",
      branchId: 1,
    },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم بأربعة ألوان", description: "وصف حالي" },
    { id: 2, name: "دفتر الفرع الثاني", description: "وصف الفرع الثاني" },
  ]);
}

beforeEach(async () => {
  storeDir = await mkdtemp(path.join(tmpdir(), "erp-product-studio-"));
  process.env.IMAGE_STORE_DRIVER = "fs";
  process.env.IMAGE_STORE_DIR = storeDir;
  __resetImageStoreForTest();
  await seed();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  __resetImageStoreForTest();
  delete process.env.IMAGE_STORE_DIR;
  delete process.env.IMAGE_STORE_DRIVER;
  delete process.env.R2_GC_MODE;
  delete process.env.R2_GC_DELETE_CONFIRM;
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

describe("product studio governed workflow", () => {
  it("previews and creates a campaign backlog once without assigning or publishing", async () => {
    await db()
      .insert(s.products)
      .values([
        { id: 3, name: "منتج ناقص أول" },
        { id: 4, name: "منتج ناقص ثان" },
      ]);
    await db().insert(s.productImages).values({
      productId: 1,
      url: "/api/img/product/approved",
      reviewStatus: "APPROVED",
      isPrimary: true,
    });
    await db().insert(s.productImageJobs).values({
      productId: 2,
      branchId: 1,
      mode: "FLATTEN",
      status: "ASSIGNED",
      createdBy: manager.userId,
      activeSlot: 1,
      revision: 1,
      templateVersion: 1,
    });
    const campaign = await createStudioCampaign(manager, {
      name: "اكتمال صور الصيف",
      status: "ACTIVE",
      dueAt: new Date("2026-08-25T12:00:00.000Z"),
    });

    await expect(previewStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toMatchObject({ count: 2, productIds: [3, 4] });
    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toEqual({ createdCount: 2 });
    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toEqual({ createdCount: 0 });

    const rows = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignedTo: null,
          status: "ASSIGNED",
          dueAt: campaign.dueAt,
        }),
      ]),
    );
    const unassigned = rows.find((row) => row.productId === 3)!;
    await expect(assignStudioTask(manager, { productId: 3, assigneeId: worker.userId })).resolves.toEqual({ taskId: Number(unassigned.id), revision: 2 });
    const [claimed] = await db()
      .select()
      .from(s.productImageJobs)
      .where(eq(s.productImageJobs.id, Number(unassigned.id)));
    expect(claimed).toMatchObject({
      campaignId: campaign.campaignId,
      assignedTo: worker.userId,
      revision: 2,
    });
    await expect(
      bulkAssignStudioTasks(manager, {
        productIds: [4],
        assigneeId: worker.userId,
        priority: "HIGH",
      }),
    ).resolves.toEqual({ createdCount: 1 });
    const [bulkClaimed] = await db()
      .select()
      .from(s.productImageJobs)
      .where(eq(s.productImageJobs.productId, 4));
    expect(bulkClaimed).toMatchObject({
      campaignId: campaign.campaignId,
      assignedTo: worker.userId,
      priority: "HIGH",
      revision: 2,
    });
    expect(await db().select().from(s.productImages)).toHaveLength(1);
  });

  it("isolates campaigns by branch even when the catalog is global", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة الفرع الرئيسي",
      status: "ACTIVE",
    });
    await expect(previewStudioCampaignBacklog(managerTwo, campaign.campaignId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deduplicates automatic assignment and rejection notifications by event key", async () => {
    const assigned = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
    });
    await submitStudioCandidate(worker, {
      taskId: assigned.taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
      expectedRevision: assigned.revision,
    });
    await rejectStudioTask(manager, assigned.taskId, "الخلفية تحتاج تنظيفاً أدق", undefined, 2);

    const notices = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId));
    expect(notices.map((row) => row.eventKey).sort()).toEqual([`product-studio:${assigned.taskId}:assigned:${worker.userId}`, `product-studio:${assigned.taskId}:rejected:r3`]);
    expect(new Set(notices.map((row) => row.eventKey)).size).toBe(notices.length);
  });

  it("deduplicates approaching-deadline alerts and sends managers overdue exceptions only", async () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    await db().insert(s.products).values({ id: 3, name: "منتج متأخر" });
    await db()
      .insert(s.productImageJobs)
      .values([
        {
          productId: 1,
          branchId: 1,
          mode: "FLATTEN",
          status: "ASSIGNED",
          assignedTo: worker.userId,
          createdBy: manager.userId,
          activeSlot: 1,
          dueAt: new Date("2026-08-20T10:00:00.000Z"),
          revision: 1,
        },
        {
          productId: 3,
          branchId: 1,
          mode: "FLATTEN",
          status: "ASSIGNED",
          assignedTo: null,
          createdBy: manager.userId,
          activeSlot: 1,
          dueAt: new Date("2026-08-19T11:00:00.000Z"),
          revision: 1,
        },
      ]);

    await expect(sendStudioDueNotifications(manager, now)).resolves.toEqual({
      createdCount: 2,
    });
    await expect(sendStudioDueNotifications(manager, now)).resolves.toEqual({
      createdCount: 0,
    });

    const workerNotices = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId));
    const managerNotices = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, manager.userId));
    expect(workerNotices).toEqual([
      expect.objectContaining({
        eventKey: expect.stringContaining(":due:"),
        kind: "TASK_ASSIGNED",
      }),
    ]);
    expect(managerNotices).toEqual([
      expect.objectContaining({
        eventKey: expect.stringContaining(":overdue:"),
        kind: "APPROVAL_REQUIRED",
      }),
    ]);
  });

  it("reports campaign progress, first-pass approval, rejection reasons and median cycle time", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة القياس",
      status: "ACTIVE",
    });
    const now = new Date("2026-08-19T12:00:00.000Z");
    await db()
      .insert(s.productImageJobs)
      .values([
        {
          productId: 1,
          campaignId: campaign.campaignId,
          branchId: 1,
          mode: "FLATTEN",
          status: "APPROVED",
          createdBy: manager.userId,
          revision: 3,
          activeSlot: null,
          createdAt: new Date("2026-08-19T10:00:00.000Z"),
          reviewedAt: now,
        },
        {
          productId: 2,
          campaignId: campaign.campaignId,
          branchId: 1,
          mode: "FLATTEN",
          status: "REJECTED",
          createdBy: manager.userId,
          revision: 2,
          activeSlot: 1,
          rejectionReason: "الصورة غير حادة",
          createdAt: new Date("2026-08-19T11:00:00.000Z"),
          reviewedAt: now,
        },
      ]);
    const approved = (await db().select({ id: s.productImageJobs.id }).from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId)))[0]!;
    await db()
      .insert(s.auditLogs)
      .values({
        userId: manager.userId,
        branchId: 1,
        action: "productStudio.reject",
        entityType: "productImageJob",
        entityId: String(approved.id),
        newValue: { reason: "قص غير دقيق" },
      });

    await expect(getStudioCampaignAnalytics(manager, campaign.campaignId)).resolves.toMatchObject({
      total: 2,
      approved: 1,
      rejected: 1,
      completionPercent: 50,
      firstPassApprovalRate: 0,
      medianCycleMinutes: 90,
      rejectionReasons: expect.arrayContaining([
        { reason: "الصورة غير حادة", count: 1 },
        { reason: "قص غير دقيق", count: 1 },
      ]),
    });
  });
  it("rejects stale revisions without overwriting a newer mobile save", async () => {
    const { taskId, revision } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      priority: "HIGH",
      dueAt: new Date("2026-08-20T09:00:00.000Z"),
    });

    await expect(
      saveStudioDraft(worker, {
        taskId,
        expectedRevision: revision,
        proposedDescription: "المسودة الأحدث",
      }),
    ).resolves.toEqual({ ok: true, revision: 2 });

    await expect(
      saveStudioDraft(worker, {
        taskId,
        expectedRevision: revision,
        proposedDescription: "مسودة قديمة يجب ألا تطمس الأحدث",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [stored] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(stored).toMatchObject({
      proposedDescription: "المسودة الأحدث",
      priority: "HIGH",
      revision: 2,
    });
    expect(stored?.dueAt?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  it("rolls back an entire bulk assignment when any product already has an active task", async () => {
    await db().insert(s.products).values({ id: 3, name: "منتج ثالث" });
    await assignStudioTask(manager, {
      productId: 2,
      assigneeId: worker.userId,
    });

    await expect(
      bulkAssignStudioTasks(manager, {
        productIds: [1, 2, 3],
        assigneeId: worker.userId,
        priority: "URGENT",
        dueAt: new Date("2026-08-21T09:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const rows = await db().select().from(s.productImageJobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productId).toBe(2);
  });

  it("lets only the branch manager revise an active task priority and deadline", async () => {
    const { taskId, revision } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
    });
    await expect(
      updateStudioTaskSchedule(managerTwo, {
        taskId,
        expectedRevision: revision,
        priority: "URGENT",
        dueAt: new Date("2026-08-20T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      updateStudioTaskSchedule(manager, {
        taskId,
        expectedRevision: revision,
        priority: "URGENT",
        dueAt: new Date("2026-08-20T10:00:00.000Z"),
      }),
    ).resolves.toEqual({ ok: true, revision: 2 });
  });

  it("paginates task filters and reports exception-focused SLA metrics", async () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    await db()
      .insert(s.products)
      .values([
        { id: 3, name: "منتج ثالث" },
        { id: 4, name: "منتج رابع" },
        { id: 5, name: "منتج عند الحد" },
      ]);
    await db()
      .insert(s.productImageJobs)
      .values([
        {
          productId: 1,
          branchId: 1,
          mode: "FLATTEN",
          status: "ASSIGNED",
          assignedTo: null,
          assignedBy: manager.userId,
          createdBy: manager.userId,
          activeSlot: 1,
          priority: "URGENT",
          dueAt: new Date("2026-08-19T11:59:59.000Z"),
          revision: 1,
          templateVersion: 1,
        },
        {
          productId: 3,
          branchId: 1,
          mode: "FLATTEN",
          status: "IN_PROGRESS",
          assignedTo: worker.userId,
          assignedBy: manager.userId,
          createdBy: manager.userId,
          activeSlot: 1,
          priority: "HIGH",
          dueAt: new Date("2026-08-19T11:59:58.000Z"),
          revision: 1,
          templateVersion: 1,
        },
        {
          productId: 4,
          branchId: 1,
          mode: "FLATTEN",
          status: "APPROVED",
          assignedTo: worker.userId,
          assignedBy: manager.userId,
          createdBy: manager.userId,
          activeSlot: null,
          priority: "NORMAL",
          dueAt: new Date("2026-08-19T07:59:59.000Z"),
          revision: 3,
          createdAt: new Date("2026-08-19T08:00:00.000Z"),
          reviewedAt: new Date("2026-08-19T10:00:00.000Z"),
          templateVersion: 1,
        },
        {
          productId: 5,
          branchId: 1,
          mode: "FLATTEN",
          status: "PENDING_REVIEW",
          assignedTo: worker.userId,
          assignedBy: manager.userId,
          createdBy: manager.userId,
          activeSlot: 1,
          priority: "LOW",
          dueAt: now,
          revision: 1,
          templateVersion: 1,
        },
      ]);

    const queue = await listStudioTasks(manager, {
      scope: "QUEUE",
      limit: 10,
      now,
    });
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: 1,
          priority: "URGENT",
          overdue: true,
        }),
      ]),
    );
    expect(
      (
        await listStudioTasks(manager, {
          scope: "QUEUE",
          priority: ["URGENT"],
          now,
        })
      ).items,
    ).toEqual([expect.objectContaining({ productId: 1 })]);
    expect((await listStudioTasks(manager, { scope: "REVIEW", overdue: true, now })).items).toEqual([]);
    expect(
      (
        await listStudioTasks(manager, {
          scope: "HISTORY",
          overdue: false,
          now,
        })
      ).items,
    ).toEqual([
      expect.objectContaining({
        productId: 4,
        status: "APPROVED",
        overdue: false,
      }),
    ]);
    const first = await listStudioTasks(manager, {
      scope: "QUEUE",
      priority: ["URGENT", "HIGH"],
      overdue: true,
      limit: 1,
      now,
    });
    expect(first.items).toEqual([expect.objectContaining({ overdue: true, revision: 1 })]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listStudioTasks(manager, {
      scope: "QUEUE",
      priority: ["URGENT", "HIGH"],
      overdue: true,
      limit: 1,
      cursor: first.nextCursor,
      now,
    });
    expect(second.items).toEqual([expect.objectContaining({ overdue: true, revision: 1 })]);
    expect(new Set([...first.items, ...second.items].map((item) => item.productId))).toEqual(new Set([1, 3]));

    const dashboard = await getStudioDashboard(manager, now);
    expect(dashboard).toMatchObject({
      unassigned: 1,
      overdue: 2,
      completedToday: 1,
      medianCycleMinutes: 120,
    });
  });

  it("searches server-side beyond the former 40-row picker limit", async () => {
    const d = db();
    await d.insert(s.products).values(
      Array.from({ length: 41 }, (_, index) => ({
        id: index + 10,
        name: `منتج تمهيدي ${index + 1}`,
      })).concat({ id: 99, name: "المنتج البعيد المطلوب" }),
    );

    const result = await listStudioProducts(manager, { search: "البعيد" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      productId: 99,
      productName: "المنتج البعيد المطلوب",
    });
    expect(result.nextCursor).toBeNull();
  });

  it("returns twenty products per opaque cursor page without repeating a product", async () => {
    const d = db();
    await d.insert(s.products).values(
      Array.from({ length: 43 }, (_, index) => ({
        id: index + 200,
        name: `صنف صفحة ${String(index + 1).padStart(2, "0")}`,
      })),
    );

    const first = await listStudioProducts(manager, {});
    expect(first.rows).toHaveLength(20);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toMatch(/^\d+$/);
    const second = await listStudioProducts(manager, {
      cursor: first.nextCursor,
    });
    expect(second.rows).toHaveLength(20);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.productId)).size).toBe(40);
  });

  it("normalizes Arabic names and ranks SKU and barcode matches without duplicate products", async () => {
    const d = db();
    await d.insert(s.products).values([
      { id: 100, name: "مكتبة عربية" },
      { id: 101, name: "قلم باركود" },
    ]);
    await d.insert(s.productVariants).values([
      { id: 100, productId: 100, sku: "BOOK-AR", costPrice: "1" },
      { id: 101, productId: 101, sku: "PEN-778", costPrice: "1" },
    ]);
    await d.insert(s.productUnits).values({
      id: 100,
      variantId: 101,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      barcode: "6001000000017",
    });
    await d.insert(s.productUnitBarcodes).values({ productUnitId: 100, barcode: "6001000000093" });

    await expect(listStudioProducts(manager, { search: "مكتبه" })).resolves.toMatchObject({
      rows: [expect.objectContaining({ productId: 100, matchKind: "NAME_PREFIX" })],
    });
    await expect(listStudioProducts(manager, { search: "PEN-778" })).resolves.toMatchObject({
      rows: [expect.objectContaining({ productId: 101, matchKind: "SKU" })],
    });
    await expect(listStudioProducts(manager, { search: "6001000000017" })).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          productId: 101,
          unitId: 100,
          matchKind: "BARCODE_PRIMARY",
        }),
      ],
    });
    const alias = await listStudioProducts(manager, {
      search: "6001000000093",
    });
    expect(alias.rows).toEqual([
      expect.objectContaining({
        productId: 101,
        unitId: 100,
        matchKind: "BARCODE_ALIAS",
      }),
    ]);
  });

  it("normalizes Arabic variant names even when the parent product name does not match", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 103, name: "منتج محايد" });
    await d.insert(s.productVariants).values({
      id: 103,
      productId: 103,
      sku: "MED-NEEDLE",
      variantName: "إبرَة طبية",
      costPrice: "1",
    });

    await expect(listStudioProducts(manager, { search: "ابره" })).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          productId: 103,
          variantId: 103,
          matchKind: "NAME_PREFIX",
        }),
      ],
    });
  });

  it("rejects a cursor reused after the inactive-visibility scope changes", async () => {
    const d = db();
    await d.insert(s.products).values(
      Array.from({ length: 21 }, (_, index) => ({
        id: index + 300,
        name: `نطاق المؤشر ${index + 1}`,
      })),
    );
    const first = await listStudioProducts(manager, { includeInactive: false });

    await expect(
      listStudioProducts(manager, {
        cursor: first.nextCursor,
        includeInactive: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("excludes inactive products unless a manager asks to inspect them and never exposes commercial fields", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 102, name: "منتج متوقف", isActive: false });
    await d.insert(s.productVariants).values({ id: 102, productId: 102, sku: "OFF-1", costPrice: "999.99" });
    await d.insert(s.productUnits).values({
      id: 102,
      variantId: 102,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      barcode: "6001000000024",
    });

    await expect(listStudioProducts(worker, { search: "OFF-1", includeInactive: true })).resolves.toEqual({ rows: [], nextCursor: null });
    await expect(listStudioProducts(manager, { search: "OFF-1", includeInactive: true })).resolves.toMatchObject({
      rows: [expect.objectContaining({ productId: 102, isActive: false })],
    });
    const resolved = await resolveStudioBarcode(manager, "6001000000024");
    expect(resolved).toMatchObject({
      productId: 102,
      variantId: 102,
      unitId: 102,
      isActive: false,
    });
    expect(resolved).not.toHaveProperty("costPrice");
    expect(resolved).not.toHaveProperty("price");
    expect(resolved).not.toHaveProperty("stock");
  });

  it("blocks manager edits on an employee task and requires an audited admin override", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
    });

    await expect(
      saveStudioDraft(manager, {
        taskId,
        proposedDescription: "تعديل المدير على مهمة العامل",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      saveStudioDraft(admin, {
        taskId,
        proposedDescription: "تصحيح إداري بلا مسوغ",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      saveStudioDraft(admin, {
        taskId,
        proposedDescription: "تصحيح إداري موثق",
        adminOverrideReason: "معالجة تعذر العامل عن إكمال المهمة",
      }),
    ).resolves.toEqual({ ok: true });

    const overrideAudit = await db()
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityId, String(taskId)), eq(s.auditLogs.action, "productStudio.adminOverride.saveDraft")));
    expect(overrideAudit).toHaveLength(1);
    expect(overrideAudit[0]?.newValue).toMatchObject({
      reason: "معالجة تعذر العامل عن إكمال المهمة",
      assignedTo: worker.userId,
    });
  });

  it("rejects assign-to-self approval and permits only an audited admin correction", async () => {
    const { taskId } = await assignStudioTask(admin, {
      productId: 1,
      assigneeId: admin.userId,
      sourceImageId: null,
    });
    await submitStudioCandidate(admin, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    });

    await expect(approveStudioTask(admin, taskId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(approveStudioTask(admin, taskId, "تصحيح إداري موثق بعد تعذر المراجعة المستقلة")).resolves.toMatchObject({ imageId: expect.any(Number) });

    const [job] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(job?.submittedBy).toBe(admin.userId);
    expect(job?.reviewedBy).toBe(admin.userId);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.entityId, String(taskId)), eq(s.auditLogs.action, "productStudio.adminOverride.approve"))),
    ).toHaveLength(1);
  });

  it("audits every admin provider override and requires a separate review reason", async () => {
    const editReason = "إكمال موثق نيابة عن العامل المتعذر";
    const reviewReason = "مراجعة إدارية طارئة لغياب مراجع مستقل";
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const receipt = await attestStudioProcessing(admin, taskId, "PRO", editReason);
    await bindStudioProcessingCandidate(admin, {
      taskId,
      processingReceipt: receipt,
      candidateDataUrl: PNG_1X1,
      adminOverrideReason: editReason,
    });
    await submitStudioCandidate(admin, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "CUT",
      processingReceipt: receipt,
      adminOverrideReason: editReason,
    });

    await expect(rejectStudioTask(admin, taskId, "النتيجة تحتاج معالجة أدق")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await rejectStudioTask(admin, taskId, "النتيجة تحتاج معالجة أدق", reviewReason);

    const rows = await db()
      .select({ action: s.auditLogs.action, newValue: s.auditLogs.newValue })
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityId, String(taskId)));
    const overrides = new Map(rows.filter((row) => row.action.startsWith("productStudio.adminOverride.")).map((row) => [row.action, row.newValue as { reason?: string }]));
    for (const action of ["processing", "processingAttestation", "bindProcessingProof", "submit"]) {
      expect(overrides.get(`productStudio.adminOverride.${action}`)).toMatchObject({ reason: editReason });
    }
    expect(overrides.get("productStudio.adminOverride.reject")).toMatchObject({
      reason: reviewReason,
    });
  });

  it("rejects draft and submit while a provider processing lease is live", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const authorization = await authorizeStudioProcessing(worker, taskId, "PRO");
    await expect(
      saveStudioDraft(worker, {
        taskId,
        proposedDescription: "نسخة أقدم أثناء المعالجة",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      submitStudioCandidate(worker, {
        taskId,
        originalDataUrl: PNG_1X1,
        processedDataUrl: PNG_1X1,
        mode: "FLATTEN",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(finalizeStudioProcessing(worker, taskId, "PRO", authorization)).resolves.toEqual(expect.any(String));
  });

  it("rejects provider authorization while a candidate upload lease is live", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const store = getImageStore();
    const originalPut = store.put.bind(store);
    let releasePut!: () => void;
    const blockedPut = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let putReached!: () => void;
    const reachedPut = new Promise<void>((resolve) => {
      putReached = resolve;
    });
    vi.spyOn(store, "put").mockImplementationOnce(async (key, data, mime) => {
      putReached();
      await blockedPut;
      return originalPut(key, data, mime);
    });

    const upload = submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    });
    await reachedPut;
    await expect(authorizeStudioProcessing(worker, taskId, "PRO")).rejects.toMatchObject({ code: "CONFLICT" });
    releasePut();
    await expect(upload).resolves.toEqual({ ok: true });
  });

  it("keeps the last submitter disqualified after reassignment and fails closed for rolling-version NULL", async () => {
    const first = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: manager.userId,
      sourceImageId: null,
    });
    await submitStudioCandidate(manager, {
      taskId: first.taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    });
    await db().update(s.productImageJobs).set({ assignedTo: worker.userId }).where(eq(s.productImageJobs.id, first.taskId));
    await expect(approveStudioTask(manager, first.taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const second = await assignStudioTask(manager, {
      productId: 2,
      assigneeId: manager.userId,
      sourceImageId: null,
    });
    await submitStudioCandidate(manager, {
      taskId: second.taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    // عقد نشر متدرج: عقدة قديمة قد تترك submittedBy=NULL؛ assignedTo هو البديل الآمن.
    await db().update(s.productImageJobs).set({ submittedBy: null }).where(eq(s.productImageJobs.id, second.taskId));
    await expect(approveStudioTask(manager, second.taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("enforces one active owner per product and rejects another employee's writes", async () => {
    const results = await Promise.allSettled([assignStudioTask(manager, { productId: 1, assigneeId: 2 }), assignStudioTask(manager, { productId: 1, assigneeId: 3 })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [task] = await db().select().from(s.productImageJobs);
    expect(task?.activeSlot).toBe(1);
    const owner = Number(task?.assignedTo) === worker.userId ? worker : otherWorker;
    const stranger = owner.userId === worker.userId ? otherWorker : worker;
    await expect(
      saveStudioDraft(stranger, {
        taskId: Number(task?.id),
        proposedDescription: "ممنوع",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps a pending candidate private, publishes once atomically, audits, and restores the original", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
    });
    await saveStudioDraft(worker, {
      taskId,
      proposedName: "قلم ألوان عملي",
      proposedDescription: "أربعة ألوان في قلم واحد.",
      proposedMarketingCopy: "اختيار واضح للاستخدام اليومي.",
    });
    const aiReceipt = await attestStudioProcessing(worker, taskId, "AI");
    await bindStudioProcessingCandidate(worker, {
      taskId,
      processingReceipt: aiReceipt,
      candidateDataUrl: PNG_1X1,
    });
    await expect(
      submitStudioCandidate(otherWorker, {
        taskId,
        originalDataUrl: PNG_1X1,
        processedDataUrl: PNG_1X1,
        mode: "FLATTEN",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
      processingReceipt: aiReceipt,
      proposedName: "قلم ألوان موثوق",
      proposedDescription: "وصف أُرسل ذرياً مع الصورة.",
      proposedMarketingCopy: "نص ترويجي صادق.",
    });

    const [pending] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(pending?.status).toBe("PENDING_REVIEW");
    expect(pending?.originalObjectKey).toMatch(/^single\/studio\/original\//);
    expect(pending?.processedObjectKey).toMatch(/^single\/studio\/candidate\//);
    expect(pending?.processedUrl).toBe(WEBP_1X1);
    expect(JSON.stringify(pending)).not.toContain(PNG_1X1);
    expect(await db().select().from(s.productImages)).toHaveLength(0);

    const safeTask = (await listStudioTasks(worker, { scope: "MINE" })).items[0];
    expect(safeTask).toBeDefined();
    expect(Object.keys(safeTask ?? {})).not.toEqual(expect.arrayContaining(["costPrice", "price", "stock", "objectKey", "originalObjectKey", "processedObjectKey"]));

    const approvals = await Promise.allSettled([approveStudioTask(manager, taskId), approveStudioTask(manager, taskId)]);
    expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [approvedJob] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    const [published] = await db().select().from(s.productImages).where(eq(s.productImages.productId, 1));
    expect(approvedJob?.status).toBe("APPROVED");
    expect(approvedJob?.activeSlot).toBeNull();
    expect(approvedJob?.processedUrl).toBeNull();
    expect(published?.reviewStatus).toBe("APPROVED");
    expect(published?.objectKey).toBe(approvedJob?.processedObjectKey);
    expect(published?.originalKey).toBe(approvedJob?.originalObjectKey);
    expect(published?.url).toMatch(/^\/api\/img\/product\/\d+\?v=/);
    expect(published?.origin).toBe("STUDIO_AI");
    expect(published?.thumbDataUrl).toBe(WEBP_1X1);
    const [updatedProduct] = await db().select().from(s.products).where(eq(s.products.id, 1));
    expect(updatedProduct?.name).toBe("قلم ألوان موثوق");
    expect(updatedProduct?.description).toContain("نص ترويجي صادق");
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.entityId, String(taskId)), eq(s.auditLogs.action, "productStudio.approve"))),
    ).toHaveLength(1);

    const auditDashboard = await getStudioDashboard(auditor);
    expect(auditDashboard.canAudit).toBe(true);
    expect(auditDashboard.canManage).toBe(false);
    expect(auditDashboard.counts.APPROVED).toBe(1);
    await expect(listStudioTasks(auditor, { scope: "HISTORY" })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: taskId, status: "APPROVED" })],
    });
    await expect(getStudioCandidatePreview(auditor, taskId)).resolves.toMatchObject({ processedMime: "image/png" });

    await revertStudioTask(manager, taskId);
    const [restored] = await db()
      .select()
      .from(s.productImages)
      .where(eq(s.productImages.id, Number(published?.id)));
    expect(restored?.objectKey).toMatch(/^single\/studio\/candidate\//);
    expect(restored?.contentHash).toBe(approvedJob?.sourceContentHash);
    expect(restored?.origin).toBe("ORIGINAL");
    await expect(revertStudioTask(manager, taskId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.entityId, String(taskId)), eq(s.auditLogs.action, "productStudio.revert"))),
    ).toHaveLength(1);
  });

  it("requires a clear rejection reason and returns the same task to its owner", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
    });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "CUT",
    });
    await expect(rejectStudioTask(manager, taskId, "لا")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await rejectStudioTask(manager, taskId, "الخلفية تحتاج تنظيفاً أدق");
    const [rejected] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(rejected?.status).toBe("REJECTED");
    expect(rejected?.assignedTo).toBe(worker.userId);
    expect(rejected?.activeSlot).toBe(1);
    expect(rejected?.rejectionReason).toBe("الخلفية تحتاج تنظيفاً أدق");
    await expect(saveStudioDraft(worker, { taskId, proposedDescription: "تم التنظيف" })).resolves.toEqual({ ok: true });
  });

  it("isolates every task operation by branch while admin can cross branches", async () => {
    const { taskId } = await assignStudioTask(managerTwo, {
      productId: 2,
      assigneeId: workerTwo.userId,
    });
    await submitStudioCandidate(workerTwo, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    expect((await listStudioTasks(manager, { scope: "REVIEW" })).items).toHaveLength(0);
    await expect(getStudioCandidatePreview(manager, taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getStudioSourcePreview(manager, taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveStudioTask(manager, taskId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(rejectStudioTask(manager, taskId, "سبب واضح من فرع خاطئ")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveStudioTask(admin, taskId)).resolves.toMatchObject({
      imageId: expect.any(Number),
    });
  });

  it("keeps the first original immutable through rejection and serializes concurrent uploads with a DB lease", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    });
    const [first] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    await rejectStudioTask(manager, taskId, "نحتاج معالجة أخرى للصورة");

    const attempts = await Promise.allSettled([
      submitStudioCandidate(worker, {
        taskId,
        originalDataUrl: PNG_1X1_ALT,
        processedDataUrl: PNG_1X1_ALT,
        mode: "FLATTEN",
      }),
      submitStudioCandidate(worker, {
        taskId,
        originalDataUrl: PNG_1X1_ALT,
        processedDataUrl: PNG_1X1,
        mode: "CUT",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const [resubmitted] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(resubmitted?.originalObjectKey).toBe(first?.originalObjectKey);
    expect(resubmitted?.sourceContentHash).toBe(first?.sourceContentHash);
    expect(resubmitted?.uploadLeaseToken).toBeNull();
    expect(resubmitted?.reviewedAt).toBeNull();
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.entityId, String(taskId)), eq(s.auditLogs.action, "productStudio.submit"))),
    ).toHaveLength(2);
  });

  it("rejects a slow upload after its DB lease expires and a newer draft is saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = new Date("2026-08-17T08:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const store = getImageStore();
    const originalPut = store.put.bind(store);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let uploadReached!: () => void;
    const reachedUpload = new Promise<void>((resolve) => {
      uploadReached = resolve;
    });
    let firstPut = true;
    vi.spyOn(store, "put").mockImplementation(async (...args) => {
      const result = await originalPut(...args);
      if (firstPut) {
        firstPut = false;
        uploadReached();
        await blocked;
      }
      return result;
    });

    const slowSubmit = submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    await reachedUpload;
    vi.setSystemTime(new Date(startedAt.getTime() + 121_000));
    await saveStudioDraft(worker, {
      taskId,
      proposedDescription: "مسودة أحدث بعد انتهاء مهلة الرفع",
    });
    unblock();

    await expect(slowSubmit).rejects.toMatchObject({ code: "CONFLICT" });
    const [task] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(task).toMatchObject({
      status: "IN_PROGRESS",
      proposedDescription: "مسودة أحدث بعد انتهاء مهلة الرفع",
      processedObjectKey: null,
      uploadLeaseToken: null,
      uploadLeaseExpiresAt: null,
    });
  });

  it("rejects approval when product content or the source image changed after assignment", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
      proposedDescription: "وصف مقترح",
    });
    await db().update(s.products).set({ description: "تعديل أحدث من شاشة المنتج" }).where(eq(s.products.id, 1));
    await expect(approveStudioTask(manager, taskId)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // مهمة منفصلة على صورة منشورة: اللقطة تؤخذ خادمياً، ثم تغيير hash المصدر يمنع طمس النسخة الأحدث.
    await db().update(s.productImageJobs).set({ status: "FAILED", activeSlot: null }).where(eq(s.productImageJobs.id, taskId));
    const originalBytes = Buffer.from(PNG_1X1.slice(PNG_1X1.indexOf(",") + 1), "base64");
    const originalHash = contentHash(originalBytes);
    const originalKey = objectKeyFor(originalHash, "image/png", "single/studio/candidate");
    await getImageStore().put(originalKey, originalBytes, "image/png");
    const [image] = await db()
      .insert(s.productImages)
      .values({
        productId: 1,
        url: "/api/img/product/pending",
        objectKey: originalKey,
        contentHash: originalHash,
        mime: "image/png",
        reviewStatus: "APPROVED",
        isPrimary: true,
      })
      .$returningId();
    const second = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: Number(image.id),
    });
    await expect(getStudioSourcePreview(worker, second.taskId)).resolves.toMatchObject({ mime: "image/png" });
    await submitStudioCandidate(worker, {
      taskId: second.taskId,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    await db()
      .update(s.productImages)
      .set({ contentHash: "f".repeat(64) })
      .where(eq(s.productImages.id, Number(image.id)));
    await expect(approveStudioTask(manager, second.taskId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails closed on incomplete R2 credentials and truncated image data without leaving an upload lease", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.IMAGE_STORE_DRIVER = "r2";
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_IMAGE_BUCKET;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    __resetImageStoreForTest();
    await expect(
      submitStudioCandidate(worker, {
        taskId,
        originalDataUrl: PNG_1X1,
        processedDataUrl: PNG_1X1,
        mode: "FLATTEN",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    process.env.IMAGE_STORE_DRIVER = "fs";
    process.env.IMAGE_STORE_DIR = storeDir;
    __resetImageStoreForTest();
    const truncated = PNG_1X1.slice(0, -16);
    await expect(
      submitStudioCandidate(worker, {
        taskId,
        originalDataUrl: PNG_1X1,
        processedDataUrl: truncated,
        mode: "FLATTEN",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [task] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(task?.uploadLeaseToken).toBeNull();
    expect(task?.processedObjectKey).toBeNull();
  });

  it("يرفض مصغرة malformed/oversize/غير مطابقة ويعيد التحقق منها عند الاعتماد", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const common = {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN" as const,
    };

    await expect(
      submitStudioCandidate(worker, {
        ...common,
        thumbnailDataUrl: `data:image/png;base64,${Buffer.from("not-webp").toString("base64")}`,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      submitStudioCandidate(worker, {
        ...common,
        thumbnailDataUrl: `data:image/webp;base64,${"A".repeat(180_000)}`,
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });

    const mismatchedBytes = Buffer.from(WEBP_1X1.slice(WEBP_1X1.indexOf(",") + 1), "base64");
    mismatchedBytes.writeUInt16LE(2, 26); // المرشح 1×1؛ المصغرة المعلنة 2×1.
    const mismatched = `data:image/webp;base64,${mismatchedBytes.toString("base64")}`;
    await expect(
      submitStudioCandidate(worker, {
        ...common,
        thumbnailDataUrl: mismatched,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await submitStudioCandidate(worker, common);
    // عبث DB بين submit وapprove: يعاد التحقق داخل قفل الاعتماد ولا تُنشر المصغرة المخالفة.
    await db().update(s.productImageJobs).set({ processedUrl: mismatched }).where(eq(s.productImageJobs.id, taskId));
    await expect(approveStudioTask(manager, taskId)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await db().select().from(s.productImages)).toHaveLength(0);
  });

  it("does not copy a legacy source or create a task on production without R2", async () => {
    await db().insert(s.productImages).values({
      productId: 1,
      url: PNG_1X1,
      reviewStatus: "APPROVED",
      isPrimary: true,
    });
    process.env.NODE_ENV = "production";
    delete process.env.IMAGE_STORE_DRIVER;
    __resetImageStoreForTest();

    await expect(assignStudioTask(manager, { productId: 1, assigneeId: worker.userId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.productImageJobs)).toHaveLength(0);
    expect(await db().select().from(s.productImageObjectStaging)).toHaveLength(0);
    expect(await readdir(storeDir)).toHaveLength(0);
  });

  it("reports object-store readiness without hiding dashboard history", async () => {
    await expect(getStudioDashboard(manager)).resolves.toMatchObject({
      storageReady: true,
    });
    process.env.NODE_ENV = "production";
    delete process.env.IMAGE_STORE_DRIVER;
    __resetImageStoreForTest();
    await expect(getStudioDashboard(manager)).resolves.toMatchObject({
      storageReady: false,
      counts: expect.any(Object),
    });
  });

  it("blocks candidate preview and approval server-side when storage becomes unavailable", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    process.env.NODE_ENV = "production";
    delete process.env.IMAGE_STORE_DRIVER;
    __resetImageStoreForTest();

    await expect(getStudioCandidatePreview(manager, taskId)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(approveStudioTask(manager, taskId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await db().select().from(s.productImages)).toHaveLength(0);
    expect((await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId)))[0]?.status).toBe("PENDING_REVIEW");
  });

  it("skips production staging GC without R2 and preserves the database reference", async () => {
    const objectKey = `single/studio/candidate/ab/${"a".repeat(64)}.png`;
    await db()
      .insert(s.productImageObjectStaging)
      .values({
        objectKey,
        state: "PENDING",
        touchedAt: new Date(Date.now() - 48 * 60 * 60_000),
      });
    process.env.NODE_ENV = "production";
    delete process.env.IMAGE_STORE_DRIVER;
    __resetImageStoreForTest();

    await expect(sweepProductStudioStagingOnce()).resolves.toBe(0);
    expect(await db().select().from(s.productImageObjectStaging)).toEqual([expect.objectContaining({ objectKey, state: "PENDING" })]);
    expect(await readdir(storeDir)).toHaveLength(0);
  });

  it("keeps staging GC audit-only and starts 90-day retention when the last reference is first proven lost", async () => {
    const bytes = Buffer.from(PNG_1X1.slice(PNG_1X1.indexOf(",") + 1), "base64");
    const key = objectKeyFor(contentHash(bytes), "image/png", "single/studio/candidate");
    await getImageStore().put(key, bytes, "image/png");
    await db()
      .insert(s.productImageObjectStaging)
      .values({
        objectKey: key,
        state: "PENDING",
        touchedAt: new Date(Date.now() - 91 * 24 * 60 * 60_000),
      });
    await expect(cleanupStudioStaging()).resolves.toBe(0);
    expect((await getImageStore().head(key)).exists).toBe(true);
    expect(await db().select().from(s.productImageObjectStaging)).toEqual([
      expect.objectContaining({
        objectKey: key,
        state: "PENDING",
        referencedAt: expect.any(Date),
      }),
    ]);

    const referencedKey = objectKeyFor(contentHash(Buffer.concat([bytes, Buffer.from("orphan")])), "image/png", "single/studio/candidate");
    await getImageStore().put(referencedKey, bytes, "image/png");
    const previousReference = new Date(Date.now() - 120 * 24 * 60 * 60_000);
    await db().insert(s.productImageObjectStaging).values({
      objectKey: referencedKey,
      state: "REFERENCED",
      touchedAt: previousReference,
      referencedAt: previousReference,
    });
    const beforeSweep = Date.now();
    await expect(cleanupStudioStaging()).resolves.toBe(0);
    expect((await getImageStore().head(referencedKey)).exists).toBe(true);
    const transitioned = (await db().select().from(s.productImageObjectStaging).where(eq(s.productImageObjectStaging.objectKey, referencedKey)))[0]!;
    expect(transitioned.state).toBe("PENDING");
    // MySQL TIMESTAMP here has second precision, so allow sub-second truncation only.
    expect(transitioned.referencedAt!.getTime()).toBeGreaterThanOrEqual(beforeSweep - 1_000);
  });

  it("deletes only an eligible unreferenced object in explicit delete mode and preserves a referenced object", async () => {
    const firstBytes = Buffer.from(PNG_1X1.slice(PNG_1X1.indexOf(",") + 1), "base64");
    const secondBytes = Buffer.from(PNG_1X1_ALT.slice(PNG_1X1_ALT.indexOf(",") + 1), "base64");
    const unreferencedKey = objectKeyFor(contentHash(firstBytes), "image/png", "single/studio/candidate");
    const referencedKey = objectKeyFor(contentHash(secondBytes), "image/png", "single/studio/candidate");
    await Promise.all([getImageStore().put(unreferencedKey, firstBytes, "image/png"), getImageStore().put(referencedKey, secondBytes, "image/png")]);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60_000);
    await db()
      .insert(s.productImageObjectStaging)
      .values([
        {
          objectKey: unreferencedKey,
          state: "PENDING",
          referencedAt: old,
          touchedAt: old,
        },
        {
          objectKey: referencedKey,
          state: "REFERENCED",
          referencedAt: old,
          touchedAt: old,
        },
      ]);
    await db()
      .insert(s.productImages)
      .values({
        productId: 1,
        url: "/api/img/product/referenced",
        objectKey: referencedKey,
        contentHash: contentHash(secondBytes),
        mime: "image/png",
        reviewStatus: "APPROVED",
        isPrimary: true,
      });
    process.env.R2_GC_MODE = "delete";
    process.env.R2_GC_DELETE_CONFIRM = "DELETE_RETAINED_R2_OBJECTS";
    const authorize = vi.fn();

    await expect(cleanupStudioStaging()).rejects.toMatchObject({
      code: "R2_GC_MIRROR_MANIFEST_REQUIRED",
    });
    expect((await getImageStore().head(unreferencedKey)).exists).toBe(true);
    expect((await getImageStore().head(referencedKey)).exists).toBe(true);

    await expect(
      cleanupStudioStaging(5, {
        loadDeletionAuthorization: async () => ({ authorize }),
      }),
    ).resolves.toBe(1);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(unreferencedKey);
    expect((await getImageStore().head(unreferencedKey)).exists).toBe(false);
    expect((await getImageStore().head(referencedKey)).exists).toBe(true);
    expect(await db().select().from(s.productImageObjectStaging)).toEqual([
      expect.objectContaining({
        objectKey: referencedKey,
        state: "REFERENCED",
      }),
    ]);
  });

  it("rejects reverting an older job after a newer job published identical bytes", async () => {
    const first = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    await submitStudioCandidate(worker, {
      taskId: first.taskId,
      originalDataUrl: PNG_1X1_ALT,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    });
    const { imageId } = await approveStudioTask(manager, first.taskId);
    const second = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: imageId,
    });
    await submitStudioCandidate(worker, {
      taskId: second.taskId,
      processedDataUrl: PNG_1X1,
      mode: "CUT",
    });
    await approveStudioTask(manager, second.taskId);
    await expect(revertStudioTask(manager, first.taskId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("publishes only server-attested Pro/AI modes and clears an unused stale proof", async () => {
    const first = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const proReceipt = await attestStudioProcessing(worker, first.taskId, "PRO");
    await bindStudioProcessingCandidate(worker, {
      taskId: first.taskId,
      processingReceipt: proReceipt,
      candidateDataUrl: PNG_1X1,
    });
    await submitStudioCandidate(worker, {
      taskId: first.taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "CUT",
      processingReceipt: proReceipt,
    });
    const { imageId } = await approveStudioTask(manager, first.taskId);
    expect((await db().select().from(s.productImages).where(eq(s.productImages.id, imageId)).limit(1))[0]?.origin).toBe("STUDIO_PRO");

    const second = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: imageId,
    });
    await attestStudioProcessing(worker, second.taskId, "AI");
    // رفع/تعديل يدوي بعد تشغيل AI لا يحمل receipt؛ لا يجوز أن يرث تصنيف AI القديم.
    await submitStudioCandidate(worker, {
      taskId: second.taskId,
      processedDataUrl: PNG_1X1_ALT,
      mode: "FLATTEN",
    });
    await approveStudioTask(manager, second.taskId);
    const [published] = await db().select().from(s.productImages).where(eq(s.productImages.id, imageId));
    const [job] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, second.taskId));
    expect(published?.origin).toBe("STUDIO_FREE");
    expect(job?.processingProofTokenHash).toBeNull();
    expect(job?.mode).toBe("FLATTEN");
  });

  it("binds provider receipts to final bytes and rejects overwrite, replay, and expiry", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const overwritten = await attestStudioProcessing(worker, taskId, "PRO");
    const current = await attestStudioProcessing(worker, taskId, "AI");
    await expect(
      bindStudioProcessingCandidate(worker, {
        taskId,
        processingReceipt: overwritten,
        candidateDataUrl: PNG_1X1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await bindStudioProcessingCandidate(worker, {
      taskId,
      processingReceipt: current,
      candidateDataUrl: PNG_1X1,
    });

    await expect(
      submitStudioCandidate(worker, {
        taskId,
        originalDataUrl: PNG_1X1,
        processedDataUrl: PNG_1X1_ALT,
        mode: "FLATTEN",
        processingReceipt: current,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
      processingReceipt: current,
    });
    await rejectStudioTask(manager, taskId, "اختبار إعادة الإرسال الآمن");
    await expect(
      submitStudioCandidate(worker, {
        taskId,
        processedDataUrl: PNG_1X1,
        mode: "FLATTEN",
        processingReceipt: current,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const expired = await attestStudioProcessing(worker, taskId, "AI");
    await bindStudioProcessingCandidate(worker, {
      taskId,
      processingReceipt: expired,
      candidateDataUrl: PNG_1X1,
    });
    await db()
      .update(s.productImageJobs)
      .set({ processingProofExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(s.productImageJobs.id, taskId));
    await expect(
      submitStudioCandidate(worker, {
        taskId,
        processedDataUrl: PNG_1X1,
        mode: "CUT",
        processingReceipt: expired,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

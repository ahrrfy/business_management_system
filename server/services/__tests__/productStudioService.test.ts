import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest, contentHash, getImageStore, objectKeyFor } from "../../lib/imageStore";
import { createAppNotification } from "../appNotificationService";
import { approveStudioTask, assignStudioTask, bulkAssignStudioTasks, bulkCancelStudioBacklog, cancelStudioTask, attestStudioProcessing as finalizeStudioProcessing, authorizeStudioProcessing, bindStudioProcessingCandidate, cleanupStudioStaging, createStudioCampaign, createStudioCampaignBacklog, getStudioCampaignAnalytics, getStudioDashboard, getStudioCandidatePreview, getStudioSourcePreview, claimStudioProductByBarcode, createTemporaryCampaignPhotographer, revokeTemporaryCampaignPhotographers, grantStudioAccess, listStudioAssignees, getStudioCampaignBoard, listStudioProductImages, listStudioProducts, previewStudioCampaignBacklog, listStudioTasks, reconcileStudioAssignmentNotifications, reconcileStudioCampaignTransitionNotifications, rejectStudioTask, resolveStudioBarcode, revertStudioTask, saveStudioDraft, sendStudioDueNotifications, submitStudioCandidate as submitStudioCandidateService, transitionStudioCampaign, updateStudioTaskSchedule, getStudioTaskPreviousImages, type ProductStudioActor } from "../productStudioService";
import { sweepProductStudioStagingOnce } from "../productStudioStagingWorker";
import { reserveStudioImageTasks, bulkReassignStudioTasks } from "../productStudioService";
import { discoverImageGaps, getImageHealthCounts, getTopGapCategories } from "../productStudioDiscovery";

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_1X1_ALT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII=";
const WEBP_1X1 = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
const PAST_DB_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");
/** JPEG أساسيّ ١×١ صالح البصمة والبنية (يبدأ FFD8FF وينتهي FFD9) — لفحص توحيد image/jpg. */
const JPEG_1X1 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

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
    // ٢٥/٨/٢٦: كان تاريخاً ثابتاً `2026-08-25T12:00:00Z` — يوم كتابة الاختبار — فبقي يمرّ
    // حتى بلغ الحاسوب تلك اللحظة، ومنها صار `dueAt < now()` فيرمي `createStudioCampaign`
    // بـ«موعد الحملة يجب أن يكون بعد بدايتها» (validator). النمط الآمن: نسبيّ للحاضر.
    //
    // ⚠️ محاذاة الثانية إلزاميّة: MySQL DATETIME يخزّن بدقّة الثانية ويقرّب المللي إلى أقرب
    // ثانية (`.500+` يقرّب لأعلى). بلا `setMilliseconds(0)` تُرجع القراءة قيمةً مختلفة عن
    // قيمة الإدخال ⇒ `expect(rows).toEqual(arrayContaining({dueAt: campaign.dueAt}))` يفشل
    // (المخزَّن `40.000Z` ≠ المُدخَل `39.634Z`). أُصلح على PR #804 بعد أوّل CI أخضر.
    const dueAt = new Date(Date.now() + 86_400_000);
    dueAt.setMilliseconds(0);
    const campaign = await createStudioCampaign(manager, {
      name: "اكتمال صور الصيف",
      status: "ACTIVE",
      dueAt,
    });
    expect(campaign.startsAt).toEqual(expect.any(Date));

    await expect(previewStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toMatchObject({
      count: 2,
      items: [
        { id: 3, name: "منتج ناقص أول" },
        { id: 4, name: "منتج ناقص ثان" },
      ],
      truncated: false,
    });
    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toEqual({ createdCount: 2, remaining: 0 });
    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toEqual({ createdCount: 0, remaining: 0 });

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

  it("enforces branch-scoped legal campaign transitions and stamps activation start", async () => {
    const draft = await createStudioCampaign(manager, {
      name: "حملة انتقالات",
      status: "DRAFT",
    });
    await expect(transitionStudioCampaign(managerTwo, {
      campaignId: draft.campaignId,
      status: "ACTIVE",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // كان `2026-08-29` ثابتاً — يمرّ اليوم لكن سينكسر تلقائياً بعد ٤ أيام (٢٩/٨/٢٦). دفاعياً: نسبيّ.
    await expect(transitionStudioCampaign(manager, {
      campaignId: draft.campaignId,
      status: "ACTIVE",
      dueAt: new Date(Date.now() + 4 * 86_400_000),
    })).resolves.toMatchObject({ status: "ACTIVE", startsAt: expect.any(Date) });
    await expect(transitionStudioCampaign(manager, {
      campaignId: draft.campaignId,
      status: "DRAFT",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(transitionStudioCampaign(manager, {
      campaignId: draft.campaignId,
      status: "COMPLETED",
    })).resolves.toMatchObject({ status: "COMPLETED" });

    const cancellable = await createStudioCampaign(manager, {
      name: "حملة ملغاة",
      status: "DRAFT",
    });
    await expect(transitionStudioCampaign(manager, {
      campaignId: cancellable.campaignId,
      status: "CANCELLED",
    })).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("يحفظ نوايا انتقال الحملة ذرّياً ويعيد الفاشل وحده بعد نجاح جزئي", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة إشعار موثوق",
      status: "ACTIVE",
      assigneeIds: [worker.userId, otherWorker.userId],
    });
    const selectiveNotificationWriter = vi.fn(async (input: Parameters<typeof createAppNotification>[0]) => {
      if (input.userId === worker.userId) throw new Error("createAppNotification unavailable");
      return createAppNotification(input);
    });

    await expect(transitionStudioCampaign(
      manager,
      { campaignId: campaign.campaignId, status: "PAUSED" },
      selectiveNotificationWriter,
    )).resolves.toMatchObject({ status: "PAUSED" });
    expect(selectiveNotificationWriter).toHaveBeenCalledTimes(2);
    expect((await db().select().from(s.productStudioCampaigns).where(eq(s.productStudioCampaigns.id, campaign.campaignId)))[0]).toMatchObject({ status: "PAUSED" });
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId))).toEqual([]);
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, otherWorker.userId))).toHaveLength(1);

    const intents = await db().select().from(s.appNotificationOutbox);
    const campaignIntents = intents.filter((row) => row.eventKey.includes(`studio.campaign.transition:${campaign.campaignId}:`));
    expect(campaignIntents).toHaveLength(2);
    expect(campaignIntents.find((row) => row.recipientUserId === worker.userId)).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(campaignIntents.find((row) => row.recipientUserId === otherWorker.userId)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });

    await db()
      .update(s.appNotificationOutbox)
      .set({ availableAt: PAST_DB_TIMESTAMP })
      .where(and(eq(s.appNotificationOutbox.recipientUserId, worker.userId), eq(s.appNotificationOutbox.status, "PENDING")));

    await expect(reconcileStudioCampaignTransitionNotifications(manager)).resolves.toMatchObject({ createdCount: 1, claimedCount: 1 });
    await expect(reconcileStudioCampaignTransitionNotifications(manager)).resolves.toMatchObject({ createdCount: 0, claimedCount: 0 });

    const [notice] = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId));
    expect(notice).toMatchObject({
      title: "حملة تصوير موقوفة مؤقّتاً",
      entityType: "productStudioCampaign",
      entityId: campaign.campaignId,
      requiresAction: false,
    });
    expect(notice.eventKey).toBe(campaignIntents.find((row) => row.recipientUserId === worker.userId)?.eventKey);
    expect((await db().select().from(s.appNotificationOutbox).where(eq(s.appNotificationOutbox.eventKey, notice.eventKey)))[0]).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
  });

  it("يمنع عاملين متزامنين من مضاعفة إشعار الانتقال نفسه", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة سباق المصالحة",
      status: "ACTIVE",
      assigneeIds: [worker.userId],
    });
    await transitionStudioCampaign(manager, { campaignId: campaign.campaignId, status: "PAUSED" }, async () => {
      throw new Error("defer delivery");
    });
    await db().update(s.appNotificationOutbox).set({ availableAt: PAST_DB_TIMESTAMP }).where(eq(s.appNotificationOutbox.status, "PENDING"));

    const results = await Promise.all([
      reconcileStudioCampaignTransitionNotifications(manager),
      reconcileStudioCampaignTransitionNotifications(manager),
    ]);

    expect(results.reduce((sum, result) => sum + result.createdCount, 0)).toBe(1);
    const notices = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId));
    expect(notices).toHaveLength(1);
    expect(await db().select().from(s.nativePushOutbox).where(eq(s.nativePushOutbox.eventKey, notices[0].eventKey))).toHaveLength(1);
  });

  it("لا يختم النية إذا أعاد الكاتب duplicate بلا إشعار تطبيق دائم", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة تعارض ناقص",
      status: "ACTIVE",
      assigneeIds: [worker.userId],
    });

    await transitionStudioCampaign(
      manager,
      { campaignId: campaign.campaignId, status: "PAUSED" },
      async () => ({ created: false }),
    );

    const [intent] = await db().select().from(s.appNotificationOutbox);
    expect(intent).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(intent.lastError).toContain("without matching durable app notification");
    expect(await db().select().from(s.appNotifications)).toEqual([]);

    await db().update(s.appNotificationOutbox).set({ availableAt: PAST_DB_TIMESTAMP }).where(eq(s.appNotificationOutbox.id, intent.id));
    await expect(reconcileStudioCampaignTransitionNotifications(manager)).resolves.toMatchObject({ createdCount: 1, claimedCount: 1, failedCount: 0 });
    expect((await db().select().from(s.appNotificationOutbox).where(eq(s.appNotificationOutbox.id, intent.id)))[0]).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
  });

  it("لا يسمح لاستئنافٍ أحدث أن يتجاوز إشعار إيقافٍ فشل قبله", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة ترتيب الاستعادة",
      status: "ACTIVE",
      assigneeIds: [worker.userId],
    });
    await transitionStudioCampaign(manager, { campaignId: campaign.campaignId, status: "PAUSED" }, async () => {
      throw new Error("pause delivery unavailable");
    });

    await transitionStudioCampaign(manager, { campaignId: campaign.campaignId, status: "ACTIVE" });
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId))).toEqual([]);
    const pending = await db()
      .select()
      .from(s.appNotificationOutbox)
      .where(eq(s.appNotificationOutbox.status, "PENDING"))
      .orderBy(s.appNotificationOutbox.id);
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map((row) => row.streamKey))).toEqual(new Set([`studio.campaign:${campaign.campaignId}:user:${worker.userId}`]));

    await db().update(s.appNotificationOutbox).set({ availableAt: PAST_DB_TIMESTAMP }).where(eq(s.appNotificationOutbox.id, pending[0].id));
    await expect(reconcileStudioCampaignTransitionNotifications(manager)).resolves.toMatchObject({ createdCount: 2, claimedCount: 2, failedCount: 0 });

    const delivered = await db()
      .select()
      .from(s.appNotifications)
      .where(eq(s.appNotifications.userId, worker.userId))
      .orderBy(s.appNotifications.id);
    expect(delivered.map((notice) => notice.title)).toEqual([
      "حملة تصوير موقوفة مؤقّتاً",
      "استُؤنفت حملة تصوير",
    ]);
  });

  it("لا تُجوّع دفعة فاشلة بالكامل تدفّقاً أحدث خارج حد السحب", async () => {
    const eventKeys = [0, 1, 2].map((index) => `studio.outbox.saturation:${index}`);
    await db().insert(s.appNotificationOutbox).values(eventKeys.map((eventKey, index) => ({
      branchId: 1,
      recipientUserId: worker.userId,
      streamKey: `studio.outbox.saturation.stream:${index}`,
      occurrenceId: `saturation-${index}`,
      eventKey,
      payload: {
        userId: worker.userId,
        kind: "TASK_ASSIGNED",
        title: `اختبار طابور ${index}`,
        body: "اختبار عدم تجويع التدفقات اللاحقة",
        route: "/catalog/image-studio",
        eventKey,
        entityType: "productStudioCampaign",
        entityId: 9000 + index,
        requiresAction: false,
      },
    })));
    const writer = vi.fn(async (input: Parameters<typeof createAppNotification>[0]) => {
      if (input.eventKey !== eventKeys[2]) throw new Error("persistent writer failure");
      return createAppNotification(input);
    });

    await expect(reconcileStudioCampaignTransitionNotifications(manager, { limit: 2, notificationWriter: writer }))
      .resolves.toMatchObject({ createdCount: 0, claimedCount: 2, failedCount: 2 });
    const [firstRetry] = await db()
      .select()
      .from(s.appNotificationOutbox)
      .where(eq(s.appNotificationOutbox.eventKey, eventKeys[0]));
    expect(firstRetry.attemptCount).toBe(1);
    expect(firstRetry.availableAt.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(firstRetry.availableAt.getTime() - Date.now()).toBeLessThan(6 * 60_000);
    await db()
      .update(s.appNotificationOutbox)
      .set({ availableAt: PAST_DB_TIMESTAMP })
      .where(and(eq(s.appNotificationOutbox.status, "PENDING"), eq(s.appNotificationOutbox.attemptCount, 1)));
    await expect(reconcileStudioCampaignTransitionNotifications(manager, { limit: 2, notificationWriter: writer }))
      .resolves.toMatchObject({ createdCount: 0, claimedCount: 2, failedCount: 2 });

    await expect(reconcileStudioCampaignTransitionNotifications(manager, { limit: 2, notificationWriter: writer }))
      .resolves.toMatchObject({ createdCount: 1, claimedCount: 1, failedCount: 0 });
    expect((await db().select().from(s.appNotificationOutbox).where(eq(s.appNotificationOutbox.eventKey, eventKeys[2])))[0]).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
  });

  it("يُنشئ إشعاراً فريداً لكل انتقال متكرر ولا تضاعفه المصالحة", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة انتقالات متكررة",
      status: "ACTIVE",
      assigneeIds: [worker.userId],
    });

    for (const status of ["PAUSED", "ACTIVE", "PAUSED", "ACTIVE"] as const) {
      await expect(transitionStudioCampaign(manager, { campaignId: campaign.campaignId, status })).resolves.toMatchObject({ status });
    }

    const notices = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId));
    const transitionNotices = notices.filter((row) => row.entityType === "productStudioCampaign");
    expect(transitionNotices).toHaveLength(4);
    expect(new Set(transitionNotices.map((row) => row.eventKey)).size).toBe(4);
    expect(transitionNotices.filter((row) => row.title === "حملة تصوير موقوفة مؤقّتاً")).toHaveLength(2);
    expect(transitionNotices.filter((row) => row.title === "استُؤنفت حملة تصوير")).toHaveLength(2);

    await expect(reconcileStudioCampaignTransitionNotifications(manager)).resolves.toMatchObject({ createdCount: 0, claimedCount: 0 });
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId))).toHaveLength(4);
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
    expect(notices.map((row) => row.eventKey).sort()).toEqual([`product-studio:${assigned.taskId}:assigned:${worker.userId}:r${assigned.revision}`, `product-studio:${assigned.taskId}:rejected:r3`]);
    expect(new Set(notices.map((row) => row.eventKey)).size).toBe(notices.length);

    // إعادة إسناد المهمة نفسها إلى الموظف نفسه تُشعِره من جديد. بمفتاحٍ بلا مراجعة كان
    // الإشعار الثاني يُبتلَع بوصفه مكرَّراً فلا يعلم أنّ المهمة عادت إليه.
    await cancelStudioTask(manager, { taskId: assigned.taskId, reason: "إعادة توزيع العمل" });
    const reassigned = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    const after = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId));
    expect(after.filter((row) => row.eventKey.includes(":assigned:"))).toHaveLength(2);
    expect(after.some((row) => row.eventKey === `product-studio:${reassigned.taskId}:assigned:${worker.userId}:r${reassigned.revision}`)).toBe(true);
  });

  it("does not send routine assignment or rejection notices to managers", async () => {
    const assigned = await assignStudioTask(admin, {
      productId: 1,
      assigneeId: manager.userId,
    });
    await submitStudioCandidate(manager, {
      taskId: assigned.taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
      expectedRevision: assigned.revision,
    });
    await rejectStudioTask(admin, assigned.taskId, "الخلفية تحتاج تنظيفاً أدق", undefined, 2);
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, manager.userId))).toEqual([]);
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
    // المتأخّرات تُجمَّع في إشعارٍ واحد للمدير في اليوم، لا إشعاراً لكل مهمة:
    // حملةٌ تَسِم آلاف المهام بموعدٍ واحد كانت تُغرق المدير وتُعيد المحاولة كل خمس دقائق.
    // مفتاحُ الحدث يضمّ شريحةَ العدّ (band) ⇒ قفزةٌ ماديّة (٥ ⇒ ٤٠) تُنتج مفتاحاً جديداً
    // فيُبلَّغ المدير — وشريحةٌ واحدة تُدمَج بلا تكرار. الجذر: تدقيق ٢٤/٨.
    expect(managerNotices).toEqual([
      expect.objectContaining({
        eventKey: `product-studio:overdue-digest:2026-08-19:band:0-9:branch:1:manager:${manager.userId}`,
        kind: "APPROVAL_REQUIRED",
        body: "لديك 1 مهمة استوديو تجاوزت موعدها.",
      }),
    ]);

    // مهمة متأخرة إضافية في اليوم نفسه لا تُنشئ إشعاراً ثانياً.
    await db().insert(s.products).values({ id: 4, name: "منتج متأخر ثانٍ" });
    await db()
      .insert(s.productImageJobs)
      .values({
        productId: 4,
        branchId: 1,
        mode: "FLATTEN",
        status: "ASSIGNED",
        assignedTo: null,
        createdBy: manager.userId,
        activeSlot: 1,
        dueAt: new Date("2026-08-19T09:00:00.000Z"),
        revision: 1,
      });
    await expect(sendStudioDueNotifications(manager, now)).resolves.toEqual({ createdCount: 0 });
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, manager.userId))).toHaveLength(1);
  });

  it("⭐ يُصالح إشعارَ الإسناد المفقود — مهمّةٌ مُسنَدةٌ وموظّفٌ لا يعلم", async () => {
    // العطب: `notifyStudioAssignment` تُستدعى **بعد** المعاملة وتبتلع الفشل بتحذير.
    // فانقطاعٌ لحظيّ ⇒ مهمّةٌ مُسنَدةٌ بلا إشعار، بلا أثر، وبلا إعادة محاولة.
    await db().insert(s.productImageJobs).values({
      productId: 1, branchId: 1, mode: "FLATTEN", status: "ASSIGNED",
      assignedTo: worker.userId, assignedBy: manager.userId, assignedAt: new Date(Date.now() - 60 * 60_000),
      createdBy: manager.userId, activeSlot: 1, revision: 1,
    });
    const [job] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.assignedTo, worker.userId));
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId))).toHaveLength(0);

    await expect(reconcileStudioAssignmentNotifications(manager)).resolves.toMatchObject({ createdCount: 1 });
    const notices = await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId));
    expect(notices).toEqual([
      expect.objectContaining({ route: `/catalog/image-studio?task=${job.id}`, requiresAction: true }),
    ]);

    await expect(reconcileStudioAssignmentNotifications(manager)).resolves.toMatchObject({ createdCount: 0 });
  });

  it("⭐ حفظُ مسودةٍ يرفع revision ولا يُنتج إشعاراً ثانياً (مراجعة Codex)", async () => {
    // النسخة الأولى قاست الوجود بمفتاح الحدث، والمفتاح يحمل `revision` — و`saveStudioDraft`
    // يرفعه. فكان كل حفظٍ يُولّد مفتاحاً «مفقوداً» ⇒ إشعار «مهمة جديدة» بعد كل تعديل.
    await db().insert(s.productImageJobs).values({
      productId: 1, branchId: 1, mode: "FLATTEN", status: "ASSIGNED",
      assignedTo: worker.userId, assignedBy: manager.userId, assignedAt: new Date(Date.now() - 60 * 60_000),
      createdBy: manager.userId, activeSlot: 1, revision: 1,
    });
    await expect(reconcileStudioAssignmentNotifications(manager)).resolves.toMatchObject({ createdCount: 1 });
    // يرتفع التنقيح كما يفعل حفظُ المسودة تماماً.
    await db().update(s.productImageJobs).set({ revision: 7 }).where(eq(s.productImageJobs.assignedTo, worker.userId));
    await expect(reconcileStudioAssignmentNotifications(manager)).resolves.toMatchObject({ createdCount: 0 });
    expect(await db().select().from(s.appNotifications).where(eq(s.appNotifications.userId, worker.userId))).toHaveLength(1);
  });

  it("⭐ المسحُ الذاتيّ بالباركود ليس إسناداً — لا يُصالَح (مراجعة Codex)", async () => {
    // `claimStudioProductByBarcode` يضع assignedBy = assignedTo ولا يُشعر عمداً: الماسح
    // يعلم بما مسح. وهو مسار العمل الأساسيّ في الحملات — فمصالحتُه تُشعر كل مصوّرٍ بمنتجٍ
    // مسحه بيده، وتعُدّ ذلك «إصلاح فشل» في السجلّ.
    await db().insert(s.productImageJobs).values({
      productId: 1, branchId: 1, mode: "FLATTEN", status: "ASSIGNED",
      assignedTo: worker.userId, assignedBy: worker.userId, assignedAt: new Date(Date.now() - 60 * 60_000),
      createdBy: worker.userId, activeSlot: 1, revision: 1,
    });
    await expect(reconcileStudioAssignmentNotifications(manager)).resolves.toMatchObject({ createdCount: 0, missing: 0 });
  });

  it("لا يُصالح إسناداً جديداً داخل مهلة السماح — لا نسابق المُرسِل المباشر", async () => {
    await db().insert(s.productImageJobs).values({
      productId: 1, branchId: 1, mode: "FLATTEN", status: "ASSIGNED",
      assignedTo: worker.userId, assignedBy: manager.userId, assignedAt: new Date(),
      createdBy: manager.userId, activeSlot: 1, revision: 1,
    });
    await expect(reconcileStudioAssignmentNotifications(manager)).resolves.toMatchObject({ createdCount: 0 });
  });

  it("لا يُصالح ما لا ينتظر الموظّف: المعتمَدة وقيد المراجعة", async () => {
    await db().insert(s.productImageJobs).values([
      { productId: 1, branchId: 1, mode: "FLATTEN", status: "APPROVED", assignedTo: worker.userId, assignedBy: manager.userId, assignedAt: new Date(Date.now() - 60 * 60_000), createdBy: manager.userId, activeSlot: null, revision: 2 },
      { productId: 2, branchId: 1, mode: "FLATTEN", status: "PENDING_REVIEW", assignedTo: worker.userId, assignedBy: manager.userId, assignedAt: new Date(Date.now() - 60 * 60_000), createdBy: manager.userId, activeSlot: 1, revision: 1 },
    ]);
    await expect(reconcileStudioAssignmentNotifications(manager)).resolves.toMatchObject({ createdCount: 0 });
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
      .values([
        {
          userId: manager.userId,
          branchId: 1,
          action: "productStudio.reject",
          entityType: "productImageJob",
          entityId: String(approved.id),
          newValue: { reason: "قص غير دقيق" },
          createdAt: new Date("2026-08-19T11:00:00.000Z"),
        },
        {
          userId: manager.userId,
          branchId: 1,
          action: "productStudio.approve",
          entityType: "productImageJob",
          entityId: String(approved.id),
          createdAt: new Date("2026-08-19T12:00:00.000Z"),
        },
      ]);

    await expect(getStudioCampaignAnalytics(manager, campaign.campaignId)).resolves.toMatchObject({
      total: 2,
      approved: 1,
      rejected: 1,
      completionPercent: 50,
      firstPassApprovalRate: 0,
      medianCycleMinutes: 120,
      rejectionReasons: expect.arrayContaining([
        { reason: "الصورة غير حادة", count: 1 },
        { reason: "قص غير دقيق", count: 1 },
      ]),
    });
  });

  it("counts only jobs without an assignee as campaign unassigned work", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة الإسناد",
      status: "ACTIVE",
    });
    await db().insert(s.productImageJobs).values([
      {
        productId: 1,
        campaignId: campaign.campaignId,
        branchId: 1,
        mode: "FLATTEN",
        status: "ASSIGNED",
        assignedTo: worker.userId,
        createdBy: manager.userId,
        activeSlot: 1,
        revision: 1,
      },
      {
        productId: 2,
        campaignId: campaign.campaignId,
        branchId: 1,
        mode: "FLATTEN",
        status: "ASSIGNED",
        assignedTo: null,
        createdBy: manager.userId,
        activeSlot: 1,
        revision: 1,
      },
    ]);

    await expect(
      getStudioCampaignAnalytics(manager, campaign.campaignId),
    ).resolves.toMatchObject({ unassigned: 1 });
  });

  it("uses every first review outcome as the first-pass denominator", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة رفض أولي",
      status: "ACTIVE",
    });
    const [created] = await db()
      .insert(s.productImageJobs)
      .values({
        productId: 1,
        campaignId: campaign.campaignId,
        branchId: 1,
        mode: "FLATTEN",
        status: "REJECTED",
        createdBy: manager.userId,
        rejectionReason: "الصورة غير حادة",
        reviewedAt: new Date("2026-08-19T12:00:00.000Z"),
        activeSlot: 1,
        revision: 2,
      })
      .$returningId();
    await db().insert(s.auditLogs).values({
      userId: manager.userId,
      branchId: 1,
      action: "productStudio.reject",
      entityType: "productImageJob",
      entityId: String(created.id),
      newValue: { reason: "الصورة غير حادة" },
    });
    await expect(getStudioCampaignAnalytics(manager, campaign.campaignId)).resolves.toMatchObject({
      approved: 0,
      rejected: 1,
      firstPassApprovalRate: 0,
      medianCycleMinutes: null,
    });
  });

  it("keeps an approve-first reverted job completed and first-pass approved", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "حملة استرجاع اعتماد",
      status: "ACTIVE",
    });
    const [created] = await db()
      .insert(s.productImageJobs)
      .values({
        productId: 1,
        campaignId: campaign.campaignId,
        branchId: 1,
        mode: "FLATTEN",
        status: "REVERTED",
        createdBy: manager.userId,
        createdAt: new Date("2026-08-19T11:00:00.000Z"),
        reviewedAt: new Date("2026-08-19T12:05:00.000Z"),
        activeSlot: null,
        revision: 3,
      })
      .$returningId();
    const taskId = Number(created.id);
    await db().insert(s.auditLogs).values([
      {
        userId: manager.userId,
        branchId: 1,
        action: "productStudio.approve",
        entityType: "productImageJob",
        entityId: String(taskId),
        createdAt: new Date("2026-08-19T12:00:00.000Z"),
      },
      {
        userId: manager.userId,
        branchId: 1,
        action: "productStudio.revert",
        entityType: "productImageJob",
        entityId: String(taskId),
        createdAt: new Date("2026-08-19T12:05:00.000Z"),
      },
    ]);

    await expect(getStudioCampaignAnalytics(manager, campaign.campaignId)).resolves.toMatchObject({
      total: 1,
      approved: 0,
      completed: 1,
      completionPercent: 100,
      firstPassApprovalRate: 100,
      medianCycleMinutes: 60,
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

  it("opens a scanned owned task outside the first fifty without widening task access", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => 100 + index);
    await db().insert(s.products).values(ids.map((id) => ({ id, name: `منتج المسح ${id}` })));
    await db().insert(s.productVariants).values({ id: 100, productId: 100, sku: "SCAN-OLD-SKU", variantName: "الأزرق", costPrice: "0" });
    await db().insert(s.productUnits).values({ id: 100, variantId: 100, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "SCAN-OLD-100" });
    await db().insert(s.productImageJobs).values(ids.map((id) => ({
      id,
      productId: id,
      variantId: id === 100 ? 100 : null,
      branchId: 1,
      mode: "FLATTEN" as const,
      status: "ASSIGNED" as const,
      assignedTo: worker.userId,
      assignedBy: manager.userId,
      createdBy: manager.userId,
      activeSlot: 1,
      revision: 1,
      templateVersion: 1,
      updatedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, id - 100)),
    })));

    const firstPage = await listStudioTasks(worker, { scope: "MINE", limit: 50 });
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items.some((task) => Number(task.id) === 100)).toBe(false);
    const claimed = await claimStudioProductByBarcode(worker, "SCAN-OLD-100");
    expect(claimed).toMatchObject({ taskId: 100, claimed: false, revision: 1 });
    const exact = await listStudioTasks(worker, { scope: "MINE", taskId: claimed.taskId, limit: 1 });
    expect(exact.items).toMatchObject([{ id: 100, productId: 100, variantId: 100, assignedTo: worker.userId, revision: 1 }]);
    expect(exact.nextCursor).toBeNull();
    expect((await listStudioTasks(otherWorker, { scope: "MINE", taskId: 100 })).items).toEqual([]);
    expect((await listStudioTasks(managerTwo, { scope: "QUEUE", taskId: 100 })).items).toEqual([]);
    expect((await listStudioTasks(worker, { scope: "REVIEW", taskId: 100 })).items).toEqual([]);
    await expect(listStudioTasks(worker, { scope: "MINE", taskId: 100, cursor: firstPage.nextCursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
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
    // مهمة المنتج ١ حالتها ASSIGNED بلا منفّذ (طابور حملة). لا تُعَدّ عملاً جارياً:
    // عدُّها كذلك هو ما جعل الإنتاج يعرض «قيد العمل ٤٢٨٥» و«غير المسندة ٤٢٨٥» معاً.
    expect(dashboard.counts.ASSIGNED).toBe(1);
    expect(dashboard.ownedCounts.ASSIGNED).toBe(0);
    expect(dashboard.inProgress).toBe(1);
    expect(dashboard.active).toBe(3);
    // المتأخّر بلا منفّذ يظهر في العدّادين، ويُعاد صراحةً كي لا تعرضه الشاشة مشكلتين.
    expect(dashboard.overdueUnassigned).toBe(1);
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

  it("resolves an owned product task server-side beyond the first fifty rows", async () => {
    const productRows = Array.from({ length: 51 }, (_, index) => ({
      id: index + 10,
      name: `منتج مهمة ${index + 1}`,
    }));
    await db().insert(s.products).values(productRows);
    await db().insert(s.productImageJobs).values(
      productRows.map((product) => ({
        productId: product.id,
        branchId: 1,
        mode: "FLATTEN" as const,
        status: "ASSIGNED" as const,
        assignedTo: worker.userId,
        createdBy: manager.userId,
        activeSlot: 1,
        revision: 1,
      })),
    );

    const result = await listStudioTasks(worker, {
      scope: "MINE",
      productId: 10,
      limit: 1,
    });

    expect(result.items).toEqual([
      expect.objectContaining({ productId: 10, assignedTo: worker.userId }),
    ]);
  });

  it("does not reveal a scanned product task assigned to another employee", async () => {
    await db().insert(s.productImageJobs).values({
      productId: 1,
      branchId: 1,
      mode: "FLATTEN",
      status: "ASSIGNED",
      assignedTo: otherWorker.userId,
      createdBy: manager.userId,
      activeSlot: 1,
      revision: 1,
    });

    await expect(
      listStudioTasks(worker, {
        scope: "MINE",
        productId: 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
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

  it("resolves uppercase alphanumeric barcodes case-insensitively (Code39 / internal ALR)", async () => {
    // انحدارٌ حقيقيّ (بلاغ المالك): باركود أبجديّ-رقميّ بأحرفٍ كبيرة — كباركودات Code39
    // على بدائل الملازم — كان يُبلَّغ «الباركود غير معروف» في الاستوديو رغم وجود المنتج.
    // الجذر: `contextFor` قارن حرفياً (`"MLZ6A" !== "mlz6a"`) بعد أن صغّر `normalizeSearchText`
    // الاستعلامَ، بينما ترتيبُ حروف MySQL (لا يُميّز الحالة) وجد الصفَّ في SQL.
    const d = db();
    await d.insert(s.products).values({ id: 105, name: "ملزمة سادس النموذجيّة" });
    await d.insert(s.productVariants).values({ id: 105, productId: 105, sku: "MLZ-6", costPrice: "1" });
    await d.insert(s.productUnits).values({
      id: 105,
      variantId: 105,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      barcode: "MLZ6A", // أحرف كبيرة ⇒ يُصنَّف Code39، وكان يسقط قبل الإصلاح
    });
    await d.insert(s.productUnitBarcodes).values({ productUnitId: 105, barcode: "ALR0001084" });

    // مسحٌ بنفس الحالة (كما يعيدها الماسح الضوئيّ) ⇒ يُطابق الأساسيّ.
    await expect(listStudioProducts(manager, { search: "MLZ6A" })).resolves.toMatchObject({
      rows: [expect.objectContaining({ productId: 105, unitId: 105, matchKind: "BARCODE_PRIMARY" })],
    });
    // إدخالٌ يدويّ بأحرفٍ صغيرة للباركود الداخليّ ⇒ يُطابق البديل نفسه (بلا حساسيّة للحالة).
    await expect(listStudioProducts(manager, { search: "alr0001084" })).resolves.toMatchObject({
      rows: [expect.objectContaining({ productId: 105, unitId: 105, matchKind: "BARCODE_ALIAS" })],
    });
    // resolveStudioBarcode لم يعد يرمي NOT_FOUND على منتجٍ موجود فعلاً.
    await expect(resolveStudioBarcode(manager, "MLZ6A")).resolves.toMatchObject({
      productId: 105,
      variantId: 105,
      unitId: 105,
      matchKind: "BARCODE_PRIMARY",
    });
  });

  it("(٤/٩) يحلّ باركوداً مخزَّناً بمسافةٍ طرفية أو بأرقامٍ عربية-هندية — إرثٌ حُفظ قبل تطبيع الحفظ", async () => {
    // الجذر الحقيقيّ لبلاغ «الرمز الممسوح لا يطابق» المتكرّر: مخطّطات الحفظ كانت بلا `.trim()`،
    // فحُفظ «10095 » بمسافةٍ طرفية، بينما مساواةُ SQL الخامّة في `listStudioProducts` لا تراه ⇒ لا يدخل
    // الصفحةَ أصلاً ولا يصل إلى `contextFor` (الذي طُبِّع في #912 — فكان الإصلاح السابق يُصلح نصف
    // السلسلة). الإدراج هنا خامٌّ (يتجاوز الخدمة) لمحاكاة صفٍّ إرثيّ.
    const d = db();
    await d.insert(s.products).values({ id: 108, name: "المنهج — الأستاذ ٢٠٢٧" });
    await d.insert(s.productVariants).values({ id: 108, productId: 108, sku: "MNHJ-27", costPrice: "1" });
    await d.insert(s.productUnits).values({ id: 108, variantId: 108, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: " 10095 " });
    await d.insert(s.productUnitBarcodes).values({ productUnitId: 108, barcode: "٩٩٩٠٠٠٠١٠٠٩٥" });

    await expect(listStudioProducts(manager, { search: "10095" })).resolves.toMatchObject({
      rows: [expect.objectContaining({ productId: 108, unitId: 108, matchKind: "BARCODE_PRIMARY" })],
    });
    await expect(resolveStudioBarcode(manager, "10095")).resolves.toMatchObject({ productId: 108, variantId: 108, unitId: 108, matchKind: "BARCODE_PRIMARY" });
    await expect(resolveStudioBarcode(manager, "999000010095")).resolves.toMatchObject({ productId: 108, unitId: 108, matchKind: "BARCODE_ALIAS" });
    // المصوّر (غير المدير) يصل إليه أيضاً — المسار لا يعتمد على `includeInactive`.
    await expect(resolveStudioBarcode(worker, "10095")).resolves.toMatchObject({ productId: 108 });
    // ومُدخلٌ يدويّ بأرقامٍ عربية على الحقل يُطبَّع قبل المطابقة.
    await expect(resolveStudioBarcode(worker, "١٠٠٩٥")).resolves.toMatchObject({ productId: 108 });
  });

  it("يستعمل محلّل الباركود المركزي للمسافة الداخلية وتكافؤ UPC-A/EAN-13", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 109, name: "منتج مورد متعدد الترميز" });
    await d.insert(s.productVariants).values({ id: 109, productId: 109, sku: "SUP-109", variantName: "قياسي", costPrice: "1" });
    await d.insert(s.productUnits).values([
      { id: 109, variantId: 109, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "AB  12" },
      { id: 119, variantId: 109, unitName: "علبة", conversionFactor: "10", isBaseUnit: false, barcode: "0036000291452" },
    ]);

    await expect(resolveStudioBarcode(worker, "AB  12")).resolves.toMatchObject({
      productId: 109,
      unitId: 109,
      matchKind: "BARCODE_PRIMARY",
    });
    await expect(resolveStudioBarcode(worker, "036000291452")).resolves.toMatchObject({
      productId: 109,
      unitId: 119,
      matchKind: "BARCODE_PRIMARY",
    });
    await expect(listStudioProducts(manager, { search: "AB  12" })).resolves.toMatchObject({ rows: [{ unitId: 109, matchKind: "BARCODE_PRIMARY" }] });
    await expect(listStudioProducts(manager, { search: "036000291452" })).resolves.toMatchObject({ rows: [{ unitId: 119, matchKind: "BARCODE_PRIMARY" }] });
    await d.update(s.productUnits).set({ barcode: "1  0095" }).where(eq(s.productUnits.id, 109));
    await expect(resolveStudioBarcode(worker, "1  0095")).resolves.toMatchObject({ productId: 109, unitId: 109 });
    await expect(listStudioProducts(manager, { search: "1  0095" })).resolves.toMatchObject({ rows: [{ unitId: 109, matchKind: "BARCODE_PRIMARY" }] });
    await expect(resolveStudioBarcode(worker, "10095")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("(٤/٩، Codex P1) يرفض الغموض: باركودان إرثيّان لمنتجين يتطبّعان لنفس الرمز ⇒ لا يفتح عملاً لمنتجٍ خاطئ", async () => {
    // نظير حارس الكاشير: أخذُ أوّل صفٍّ مطابقٍ يجعل الاختيار رهنَ ترتيب الاسم فيفتح تصويراً لمنتجٍ خاطئ.
    const d = db();
    await d.insert(s.products).values([
      { id: 110, name: "دفتر أ" },
      { id: 111, name: "دفتر ب" },
    ]);
    await d.insert(s.productVariants).values([
      { id: 110, productId: 110, sku: "DFT-A", costPrice: "1" },
      { id: 111, productId: 111, sku: "DFT-B", costPrice: "1" },
    ]);
    await d.insert(s.productUnits).values([
      { id: 110, variantId: 110, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: " 77700 " }, // مسافة ⇒ 77700
      { id: 111, variantId: 111, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "77700\t" }, // تبويب ⇒ 77700
    ]);
    await expect(resolveStudioBarcode(manager, "77700")).rejects.toMatchObject({ code: "CONFLICT" });
    // وحين يبقى منتجٌ واحدٌ ملوَّث (نُظّف الآخر) ⇒ يُحسَم له بلا غموض.
    await d.update(s.productUnits).set({ barcode: "77701" }).where(eq(s.productUnits.id, 111));
    await expect(resolveStudioBarcode(manager, "77700")).resolves.toMatchObject({ productId: 110, matchKind: "BARCODE_PRIMARY" });
  });

  it("البديل: يُكشف بباركوده، وصورته منفصلة عن الأساس، ويظهر في كشف الناقصة ثمّ يختفي بصورته", async () => {
    // تحقّقٌ شاملٌ لطلب المالك: (١) الاستوديو يكشف البديل بباركوده المستقلّ (يحلّه إلى
    // متغيّر البديل بالذات)، (٢) صورةُ البديل منفصلةٌ عن الأساس — لكل باركود مسار صورته،
    // (٣) البديلُ بلا صورةٍ خاصّة يظهر في «كشف المنتجات الناقصة صورًا»، ويختفي حين تُضاف
    // صورتُه هو (لا تكفيه صورةُ الأساس المشتركة).
    const d = db();
    await d.insert(s.products).values({ id: 106, name: "ملزمة سادس — علوم" });
    await d.insert(s.productVariants).values([
      { id: 106, productId: 106, sku: "MLZ-SCI", variantKind: "VARIANT", isActive: true, costPrice: "1" },
      { id: 107, productId: 106, sku: "MLZ-SCI-NASR", variantKind: "ALTERNATIVE", variantName: "طبعة النسر", isActive: true, costPrice: "1" },
    ]);
    await d.insert(s.productUnits).values([
      { id: 106, variantId: 106, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "9990000010016" },
      // باركود البديل أبجديّ-رقميّ (Code39) — عين حالة البلاغ.
      { id: 107, variantId: 107, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "NASR-6A" },
    ]);
    // للأساس صورتان معتمَدتان بمعرّف متغيّره (٢ ⇒ تتجاوز فحص SINGLE_IMAGE)؛ البديل بلا صورة.
    await d.insert(s.productImages).values([
      { productId: 106, variantId: 106, url: "u1", reviewStatus: "APPROVED" },
      { productId: 106, variantId: 106, url: "u2", reviewStatus: "APPROVED" },
    ]);

    // (١) الكشف: مسحُ باركود البديل الأبجديّ-رقميّ يحلّه إلى **متغيّر البديل** بالتحديد.
    await expect(resolveStudioBarcode(manager, "NASR-6A")).resolves.toMatchObject({
      productId: 106,
      variantId: 107,
      unitId: 107,
      matchKind: "BARCODE_PRIMARY",
    });

    // (٣) البديلُ بلا صورةٍ خاصّة ⇒ المنتج يظهر «بدائل ناقصة» في كشف الفجوات (صورةُ الأساس
    // لا تُغطّيه)، مع عدّادٍ صادق: متغيّران، واحدٌ بصورة، وواحدٌ ناقص.
    const gap = await discoverImageGaps(manager, {});
    expect(gap.items.find((r) => r.productId === 106)).toMatchObject({
      state: "VARIANTS_INCOMPLETE",
      variantCount: 2,
      variantsWithImages: 1,
      variantsMissing: 1,
    });
    // عدّادات لوحة الكشف (getImageHealthCounts) تعكس الفجوة أيضاً — لا منتجَ بلا متغيّرٍ ناقص
    // هنا سواه، فالعدّاد ١ بالضبط. مع الفخّ غير المُصلَح كان صفراً (يُصنَّف 106 خطأً NO_IMAGES).
    const counts = await getImageHealthCounts(manager);
    expect(counts.counts.VARIANTS_INCOMPLETE).toBe(1);
    // ملخّص أعلى الفئات فجوةً — المنتج بلا فئة، فتظهر فجوته في مجموعة «بلا فئة» (نفس فخّ
    // التأهيل + التجميع). مع الفخّ كان عمود «بدائل ناقصة» صفراً كاذباً.
    const cats = await getTopGapCategories(manager);
    const noCategory = cats.find((c) => c.categoryId === null);
    expect(noCategory?.variantsIncomplete ?? 0).toBeGreaterThanOrEqual(1);

    // (٢) صورةُ البديل منفصلةٌ عن الأساس: إضافتُها بمعرّف متغيّر البديل تُغلق فجوته وحده،
    // فيصير المنتج سليماً ويغيب عن الكشف الافتراضيّ (الذي يستبعد HEALTHY).
    await d.insert(s.productImages).values({ productId: 106, variantId: 107, url: "u3", reviewStatus: "APPROVED" });
    const afterGap = await discoverImageGaps(manager, {});
    expect(afterGap.items.find((r) => r.productId === 106)).toBeUndefined();
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

  it("لا يقرأ إثبات النسخ الاحتياطي إلا حين يوجد كائنٌ مؤهَّلٌ للحذف فعلاً", async () => {
    const bytes = Buffer.from(PNG_1X1.slice(PNG_1X1.indexOf(",") + 1), "base64");
    const referencedKey = objectKeyFor(contentHash(bytes), "image/png", "single/studio/candidate");
    await getImageStore().put(referencedKey, bytes, "image/png");
    const old = new Date(Date.now() - 91 * 24 * 60 * 60_000);
    await db().insert(s.productImageObjectStaging).values({ objectKey: referencedKey, state: "REFERENCED", referencedAt: old, touchedAt: old });
    await db().insert(s.productImages).values({
      productId: 1,
      url: "/api/img/product/referenced",
      objectKey: referencedKey,
      contentHash: contentHash(bytes),
      mime: "image/png",
      reviewStatus: "APPROVED",
      isPrimary: true,
    });
    process.env.R2_GC_MODE = "delete";
    process.env.R2_GC_DELETE_CONFIRM = "DELETE_RETAINED_R2_OBJECTS";
    const loadDeletionAuthorization = vi.fn(async () => ({ authorize: vi.fn() }));

    // الكائن مرجَعٌ حيّ ⇒ لا مرشّح للحذف. كان الإثبات يُحمَّل في رأس الدالّة دائماً،
    // وهو قراءةٌ وتجزئةٌ قد تبلغ غيغابايتات — بلا داعٍ إطلاقاً في هذه الحالة.
    await expect(cleanupStudioStaging(5, { loadDeletionAuthorization })).resolves.toBe(0);
    expect(loadDeletionAuthorization).not.toHaveBeenCalled();
    expect((await getImageStore().head(referencedKey)).exists).toBe(true);
  });

  it("لا يُحمّل الإثبات أكثر من مرّة مهما تعدّد المؤهَّلون في المسح الواحد", async () => {
    const old = new Date(Date.now() - 91 * 24 * 60 * 60_000);
    const keys: string[] = [];
    for (const source of [PNG_1X1, PNG_1X1_ALT, WEBP_1X1]) {
      const raw = Buffer.from(source.slice(source.indexOf(",") + 1), "base64");
      const mime = source.startsWith("data:image/webp") ? "image/webp" : "image/png";
      const key = objectKeyFor(contentHash(raw), mime, "single/studio/candidate");
      await getImageStore().put(key, raw, mime);
      await db().insert(s.productImageObjectStaging).values({ objectKey: key, state: "PENDING", referencedAt: old, touchedAt: old });
      keys.push(key);
    }
    process.env.R2_GC_MODE = "delete";
    process.env.R2_GC_DELETE_CONFIRM = "DELETE_RETAINED_R2_OBJECTS";
    const authorize = vi.fn();
    const loadDeletionAuthorization = vi.fn(async () => ({ authorize }));

    await expect(cleanupStudioStaging(10, { loadDeletionAuthorization })).resolves.toBe(3);
    // ثلاثة حُذفت، والإثبات قُرئ مرّةً واحدة لا ثلاثاً.
    expect(loadDeletionAuthorization).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(3);
    for (const key of keys) expect((await getImageStore().head(key)).exists).toBe(false);
    expect(await db().select().from(s.productImageObjectStaging)).toEqual([]);
  });

  it("keeps the chosen source image and the existing priority when adopting a backlog task", async () => {
    // مهمة أولى تُنتج صورةً معتمدة تصلح مصدراً لاحقاً.
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

    // مهمة طابور حملة: ASSIGNED بلا منفّذ، بأولوية عاجلة.
    await db().insert(s.productImageJobs).values({
      productId: 1,
      branchId: 1,
      mode: "FLATTEN",
      status: "ASSIGNED",
      assignedTo: null,
      createdBy: manager.userId,
      activeSlot: 1,
      priority: "URGENT",
      revision: 1,
      templateVersion: 1,
    });

    const adopted = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: imageId,
    });
    const [row] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, adopted.taskId));
    // كانت لقطة المصدر تُهمَل عند التبنّي، فيصطدم المنفّذ بـ«الصورة الأصلية مطلوبة لأول إرسال».
    expect(row).toMatchObject({
      assignedTo: worker.userId,
      sourceImageId: Number(imageId),
      priority: "URGENT",
    });
    expect(row!.originalObjectKey).toEqual(expect.any(String));
    expect(row!.sourceContentHash).toEqual(expect.any(String));
    // ومفتاح المصدر يصير مرجَعاً فلا يلتقطه كنس المخزون.
    expect(await db().select().from(s.productImageObjectStaging).where(eq(s.productImageObjectStaging.objectKey, row!.originalObjectKey!))).toEqual([expect.objectContaining({ state: "REFERENCED" })]);
    // والمنفّذ يستطيع الإرسال بلا أصلٍ جديد لأنّ الأصل محفوظ.
    await expect(
      submitStudioCandidate(worker, {
        taskId: adopted.taskId,
        processedDataUrl: PNG_1X1,
        mode: "FLATTEN",
      }),
    ).resolves.toMatchObject({ ok: true });
    const [submitted] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, adopted.taskId));
    expect(submitted).toMatchObject({ status: "PENDING_REVIEW" });
  });

  it("preserves backlog priority on bulk assign unless the manager states one", async () => {
    await db().insert(s.productImageJobs).values({
      productId: 1,
      branchId: 1,
      mode: "FLATTEN",
      status: "ASSIGNED",
      assignedTo: null,
      createdBy: manager.userId,
      activeSlot: 1,
      priority: "URGENT",
      revision: 1,
      templateVersion: 1,
    });
    await expect(bulkAssignStudioTasks(manager, { productIds: [1], assigneeId: worker.userId })).resolves.toEqual({ createdCount: 1 });
    const [row] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.productId, 1));
    // الحشو بـNORMAL كان يخفض حزمة مهامٍ عاجلة صامتاً لمجرّد أنّ الإسناد الجماعي لم يمرّر أولوية.
    expect(row).toMatchObject({ assignedTo: worker.userId, priority: "URGENT" });
  });

  it("يلغي مهمة الطابور فيحرّر المنتج لمهمة جديدة ويحفظ أثر الإلغاء", async () => {
    await db().insert(s.productImageJobs).values({
      productId: 1,
      branchId: 1,
      mode: "FLATTEN",
      status: "ASSIGNED",
      assignedTo: null,
      createdBy: manager.userId,
      activeSlot: 1,
      revision: 1,
      templateVersion: 1,
    });
    const [queued] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.productId, 1));

    await expect(cancelStudioTask(manager, { taskId: Number(queued!.id), reason: "قصر" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(cancelStudioTask(worker, { taskId: Number(queued!.id), reason: "حملة وُلِّدت على الفرع الخطأ" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(cancelStudioTask(manager, { taskId: Number(queued!.id), reason: "حملة وُلِّدت على الفرع الخطأ", expectedRevision: 99 })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(cancelStudioTask(manager, { taskId: Number(queued!.id), reason: "حملة وُلِّدت على الفرع الخطأ", expectedRevision: 1 })).resolves.toEqual({ ok: true, revision: 2 });
    const [cancelled] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, Number(queued!.id)));
    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      // تفريغ activeSlot هو المقصد: القيد الفريد كان يحتجز المنتج خلف المهمة الخاطئة.
      activeSlot: null,
      cancellationReason: "حملة وُلِّدت على الفرع الخطأ",
      cancelledBy: manager.userId,
      revision: 2,
    });
    expect(cancelled!.cancelledAt).toEqual(expect.any(Date));

    // المنتج صار يقبل مهمة صحيحة بديلة — وهذا ما كان مستحيلاً قبل الإلغاء.
    await expect(assignStudioTask(manager, { productId: 1, assigneeId: worker.userId })).resolves.toMatchObject({ revision: 1 });
    // ولا تُلغى مهمة ملغاة مرّتين.
    await expect(cancelStudioTask(manager, { taskId: Number(queued!.id), reason: "محاولة ثانية للإلغاء" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يمنع إلغاء المهمة المعتمدة ويوجّه إلى استرجاع الأصل", async () => {
    const task = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    await submitStudioCandidate(worker, {
      taskId: task.taskId,
      originalDataUrl: PNG_1X1_ALT,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    });
    await approveStudioTask(manager, task.taskId);
    await expect(cancelStudioTask(manager, { taskId: task.taskId, reason: "إلغاء مهمة منشورة" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يلغي طابور الحملة جماعياً بلا مساس بعملٍ بدأه موظف", async () => {
    await db()
      .insert(s.products)
      .values([
        { id: 3, name: "منتج ثالث" },
        { id: 4, name: "منتج رابع" },
      ]);
    const campaign = await createStudioCampaign(manager, { name: "حملة خاطئة", status: "ACTIVE" });
    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toMatchObject({ createdCount: 4 });

    // موظف بدأ العمل على إحداها: تُسنَد ثم تنتقل إلى IN_PROGRESS.
    await assignStudioTask(manager, { productId: 3, assigneeId: worker.userId });
    const [started] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.productId, 3));
    await saveStudioDraft(worker, { taskId: Number(started!.id), proposedName: "اسم مقترح", expectedRevision: Number(started!.revision) });

    await expect(bulkCancelStudioBacklog(manager, { campaignId: campaign.campaignId, reason: "الحملة وُلِّدت بنطاقٍ خاطئ" })).resolves.toEqual({ cancelledCount: 3, remaining: 0 });

    const rows = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId));
    const byProduct = new Map(rows.map((row) => [Number(row.productId), row]));
    // الثلاثة غير المسنَدة أُلغيت وحُرِّرت خانتها.
    for (const productId of [1, 2, 4]) {
      expect(byProduct.get(productId)).toMatchObject({ status: "CANCELLED", activeSlot: null, cancelledBy: manager.userId });
    }
    // وعملُ الموظف لم يُمَسّ: الإلغاء الجماعيّ لا يمحو ما بدأه أحد.
    expect(byProduct.get(3)).toMatchObject({ status: "IN_PROGRESS", assignedTo: worker.userId, activeSlot: 1, cancelledAt: null });

    // النداء الثاني لا يجد ما يُلغيه.
    await expect(bulkCancelStudioBacklog(manager, { campaignId: campaign.campaignId, reason: "الحملة وُلِّدت بنطاقٍ خاطئ" })).resolves.toEqual({ cancelledCount: 0, remaining: 0 });
    // والملغاة تظهر في السجلّ لا تختفي.
    expect((await listStudioTasks(manager, { scope: "HISTORY" })).items.filter((item) => item.status === "CANCELLED")).toHaveLength(3);
  });

  it("إلغاء الحملة يجرّ طابورها ويُبقي عمل الموظف", async () => {
    await db()
      .insert(s.products)
      .values([
        { id: 3, name: "منتج ثالث" },
        { id: 4, name: "منتج رابع" },
      ]);
    const campaign = await createStudioCampaign(manager, { name: "حملة تُلغى", status: "ACTIVE" });
    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toMatchObject({ createdCount: 4 });
    await assignStudioTask(manager, { productId: 3, assigneeId: worker.userId });

    await expect(transitionStudioCampaign(manager, { campaignId: campaign.campaignId, status: "CANCELLED", reason: "الحملة أُنشئت بالخطأ" })).resolves.toMatchObject({
      status: "CANCELLED",
      // ثلاثةٌ غير مسنَدة تُلغى مع الحملة؛ المُسنَدة لا.
      cancelledTasks: 3,
      remainingTasks: 0,
    });

    const rows = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId));
    const byProduct = new Map(rows.map((row) => [Number(row.productId), row]));
    for (const productId of [1, 2, 4]) {
      expect(byProduct.get(productId)).toMatchObject({
        status: "CANCELLED",
        activeSlot: null,
        cancellationReason: "الحملة أُنشئت بالخطأ",
        cancelledBy: manager.userId,
      });
    }
    // عملُ الموظف لم يُمَسّ بقرارٍ إداريّ على الحملة.
    expect(byProduct.get(3)).toMatchObject({ status: "ASSIGNED", assignedTo: worker.userId, activeSlot: 1, cancelledAt: null });
    // والمنتجات المحرَّرة تقبل مهاماً جديدة رغم أنّ حملتها ملغاة.
    await expect(assignStudioTask(manager, { productId: 4, assigneeId: worker.userId })).resolves.toMatchObject({ revision: 1 });
  });

  it("إكمال الحملة لا يلغي شيئاً، وبلا سببٍ صريح يُنسَب الإلغاء إلى الحملة", async () => {
    const campaign = await createStudioCampaign(manager, { name: "حملة القياس", status: "ACTIVE" });
    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toMatchObject({ createdCount: 2 });

    // الإكمال حالةٌ نهائية أخرى ولا يجرّ إلغاءً.
    await expect(transitionStudioCampaign(manager, { campaignId: campaign.campaignId, status: "COMPLETED" })).resolves.toMatchObject({ cancelledTasks: 0, remainingTasks: 0 });
    expect((await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId))).every((row) => row.status === "ASSIGNED")).toBe(true);

    const second = await createStudioCampaign(manager, { name: "حملة بلا سبب", status: "ACTIVE" });
    await transitionStudioCampaign(manager, { campaignId: second.campaignId, status: "CANCELLED" });
    const [row] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, second.campaignId));
    // لا مهام لهذه الحملة، لكن العقد يبقى: السبب المشتقّ يسمّي الحملة حين لا يكتب المدير سبباً.
    expect(row).toBeUndefined();
    expect((await db().select().from(s.productStudioCampaigns).where(eq(s.productStudioCampaigns.id, second.campaignId)))[0]).toMatchObject({ status: "CANCELLED" });
  });

  it("يسمح للمنفّذ بإرسال صور بلا سقف يومي داخلي", async () => {
    const previous = process.env.PRODUCT_STUDIO_SUBMIT_DAILY_LIMIT;
    process.env.PRODUCT_STUDIO_SUBMIT_DAILY_LIMIT = "2";
    try {
      const task = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
      await submitStudioCandidate(worker, { taskId: task.taskId, originalDataUrl: PNG_1X1_ALT, processedDataUrl: PNG_1X1, mode: "FLATTEN" });
      await rejectStudioTask(manager, task.taskId, "أعد المحاولة بخلفية أوضح");
      await submitStudioCandidate(worker, { taskId: task.taskId, processedDataUrl: PNG_1X1, mode: "FLATTEN" });
      await rejectStudioTask(manager, task.taskId, "أعد المحاولة مرة أخرى");

      // لا تتحول القيمة البيئية القديمة إلى سقف: المحاولة الثالثة تنجح أيضاً.
      await expect(submitStudioCandidate(worker, { taskId: task.taskId, processedDataUrl: PNG_1X1, mode: "FLATTEN" })).resolves.toMatchObject({ ok: true });
      expect(await db().select().from(s.productStudioSubmitQuota).where(eq(s.productStudioSubmitQuota.userId, worker.userId))).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.PRODUCT_STUDIO_SUBMIT_DAILY_LIMIT;
      else process.env.PRODUCT_STUDIO_SUBMIT_DAILY_LIMIT = previous;
    }
  });

  it("لوحة المنفّذ تُعلن نطاقها الشخصيّ ولا تعرض صفراً كاذباً لما لا ينطبق", async () => {
    await db().insert(s.products).values({ id: 3, name: "منتج ثالث" });
    await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    await assignStudioTask(manager, { productId: 3, assigneeId: otherWorker.userId });
    await db().insert(s.productImageJobs).values({
      productId: 2,
      branchId: 1,
      mode: "FLATTEN",
      status: "ASSIGNED",
      assignedTo: null,
      createdBy: manager.userId,
      activeSlot: 1,
      revision: 1,
      templateVersion: 1,
    });

    const mine = await getStudioDashboard(worker);
    // مهمةٌ واحدة له، لا الثلاث التي في الفرع — والعنوان يجب أن يقول ذلك.
    expect(mine).toMatchObject({ scopeKind: "PERSONAL", inProgress: 1, active: 1 });
    // «غير المسندة» في نطاقٍ شخصيّ شرطٌ متناقض (مسنَدةٌ لي وغير مسنَدة معاً) ⇒ لا ينطبق لا صفر.
    expect(mine.unassigned).toBeNull();
    expect(mine.overdueUnassigned).toBeNull();

    const branch = await getStudioDashboard(manager);
    expect(branch).toMatchObject({ scopeKind: "BRANCH", inProgress: 2, unassigned: 1, active: 3 });
    expect(await getStudioDashboard(admin)).toMatchObject({ scopeKind: "ALL" });
  });

  it("صور المنتج لا تُقرأ بلا فاعل مخوَّل", async () => {
    await expect(listStudioProductImages(worker, 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listStudioProductImages(manager, 1)).resolves.toEqual([]);
    await expect(listStudioProductImages(auditor, 1)).resolves.toEqual([]);
  });

  it("يقبل image/jpg ويخزّنه باسمه القياسيّ بلا مفتاحٍ بامتداد bin", async () => {
    const task = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    const jpgDataUrl = JPEG_1X1.replace("data:image/jpeg;", "data:image/jpg;");
    await expect(
      submitStudioCandidate(worker, {
        taskId: task.taskId,
        originalDataUrl: jpgDataUrl,
        processedDataUrl: JPEG_1X1,
        mode: "FLATTEN",
      }),
    ).resolves.toMatchObject({ ok: true });
    const [row] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, task.taskId));
    // كان الاسم غير القياسيّ يُنتج مفتاح `.bin` (يُبطل إزالة التكرار) ثمّ يسقط بخطأ ٥٠٠.
    expect(row!.originalMime).toBe("image/jpeg");
    expect(row!.originalObjectKey).toMatch(/\.jpg$/);
    expect(row!.originalObjectKey).not.toMatch(/\.bin$/);
  });

  it("حملةٌ بنطاق فئة تشمل فروعها ولا تتجاوزها إلى بقيّة الكتالوج", async () => {
    await db().insert(s.categories).values([
      { id: 10, name: "قرطاسية" },
      { id: 11, name: "أقلام", parentId: 10 },
      { id: 12, name: "هدايا" },
    ]);
    await db().insert(s.products).values([
      { id: 3, name: "قلم حبر", categoryId: 11 },
      { id: 4, name: "دفتر", categoryId: 10 },
      { id: 5, name: "درع تكريم", categoryId: 12 },
    ]);
    const campaign = await createStudioCampaign(manager, { name: "حملة القرطاسية", status: "ACTIVE", scopeKind: "CATEGORY", scopeCategoryId: 10, requiredImages: 3 });
    expect(campaign).toMatchObject({ scopeKind: "CATEGORY", requiredImages: 3 });

    await createStudioCampaignBacklog(manager, campaign.campaignId);
    const rows = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId));
    const ids = rows.map((r) => Number(r.productId)).sort((a, b) => a - b);
    // الفئة ١٠ وفرعها ١١ فقط — والمنتجان ١ و٢ بلا فئة، و٥ في فئةٍ أخرى.
    expect(ids).toEqual([3, 4]);
  });

  it("حملةٌ بنطاق منتجاتٍ مختارة لا تُولّد لغيرها، وترفض الحفظ بلا اختيار", async () => {
    await db().insert(s.products).values([{ id: 3, name: "منتج ثالث" }, { id: 4, name: "منتج رابع" }]);
    await expect(createStudioCampaign(manager, { name: "حملة بلا اختيار", status: "ACTIVE", scopeKind: "PRODUCTS" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(createStudioCampaign(manager, { name: "حملة بلا فئة", status: "ACTIVE", scopeKind: "CATEGORY" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const campaign = await createStudioCampaign(manager, { name: "حملة مختارة", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [3, 4] });
    await createStudioCampaignBacklog(manager, campaign.campaignId);
    const ids = (await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId))).map((r) => Number(r.productId)).sort((a, b) => a - b);
    expect(ids).toEqual([3, 4]);
  });

  it("مسحُ الباركود يسحب منتج الحملة إلى يد المصوّر، ويمنع سحب ما بيد زميل", async () => {
    await db().insert(s.productVariants).values({ id: 900, productId: 1, sku: "STUDIO-A", costPrice: "1" });
    await db().insert(s.productUnits).values({ id: 900, variantId: 900, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6001000000772" });
    const campaign = await createStudioCampaign(manager, {
      name: "حملة المسح",
      status: "ACTIVE",
      scopeKind: "PRODUCTS",
      scopeProductIds: [1],
      assigneeIds: [worker.userId],
    });
    await createStudioCampaignBacklog(manager, campaign.campaignId);

    // ليس من مصوّري الحملة ⇒ لا يسحب.
    await expect(claimStudioProductByBarcode(otherWorker, "6001000000772")).rejects.toMatchObject({ code: "FORBIDDEN" });

    const claimed = await claimStudioProductByBarcode(worker, "6001000000772");
    expect(claimed).toMatchObject({ claimed: true, productName: expect.any(String) });
    const [row] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, claimed.taskId));
    expect(row).toMatchObject({ assignedTo: worker.userId });
    expect(row!.assignedAt).toEqual(expect.any(Date));

    // إعادة المسح من صاحبها تفتحها بلا سحبٍ ثانٍ؛ وزميلٌ آخر يُمنع.
    await expect(claimStudioProductByBarcode(worker, "6001000000772")).resolves.toMatchObject({ claimed: false, taskId: claimed.taskId });
    await expect(claimStudioProductByBarcode(otherWorker, "6001000000772")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("⭐ بديلان في المنتج نفسه — كلٌّ يُصوَّر مستقلاً بلا تصادم (هجرة 0268)", async () => {
    // ALTERNATIVE = منتجٌ حقيقيٌّ مستقل (ماركة/منشأ مختلف) يُباع تحت الاسم الجامع نفسه.
    // كان القيد الفريد `uq_pijob_product_active` يُقفل المنتج كلّه خلف مصوّرٍ واحد.
    // الآن المفتاح (productId, variantScope=IFNULL(variantId,0), activeSlot) يعزل كلاًّ.
    await db().insert(s.productVariants).values([
      { id: 910, productId: 1, sku: "ALT-BRAND-A", variantName: "ماركة A", variantKind: "ALTERNATIVE", costPrice: "1" },
      { id: 911, productId: 1, sku: "ALT-BRAND-B", variantName: "ماركة B", variantKind: "ALTERNATIVE", costPrice: "1" },
    ]);
    await db().insert(s.productUnits).values([
      { id: 910, variantId: 910, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6001000000910" },
      { id: 911, variantId: 911, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6001000000911" },
    ]);
    const campaign = await createStudioCampaign(manager, {
      name: "حملة البدائل",
      status: "ACTIVE",
      scopeKind: "PRODUCTS",
      scopeProductIds: [1],
      requiredImages: 2,
      assigneeIds: [worker.userId, otherWorker.userId],
    });
    // مصوّرٌ يصوّر البديل A، وزميلٌ يصوّر البديل B على المنتج نفسه — لا تصادم.
    const claimA = await claimStudioProductByBarcode(worker, "6001000000910");
    const claimB = await claimStudioProductByBarcode(otherWorker, "6001000000911");
    expect(claimA.claimed).toBe(true);
    expect(claimB.claimed).toBe(true);
    expect(claimA.taskId).not.toBe(claimB.taskId);
    const rows = await db().select({ id: s.productImageJobs.id, variantId: s.productImageJobs.variantId, assignedTo: s.productImageJobs.assignedTo })
      .from(s.productImageJobs)
      .where(and(eq(s.productImageJobs.campaignId, campaign.campaignId), eq(s.productImageJobs.activeSlot, 1)));
    expect(rows).toHaveLength(2);
    const byVariant = new Map(rows.map((r) => [Number(r.variantId), Number(r.assignedTo)]));
    expect(byVariant.get(910)).toBe(worker.userId);
    expect(byVariant.get(911)).toBe(otherWorker.userId);
    // مسحٌ ثانٍ للبديل A من زميلٍ ثالث ⇒ CONFLICT على البديل نفسه (لا يمسّ البديل الآخر).
    await expect(claimStudioProductByBarcode(otherWorker, "6001000000910")).rejects.toMatchObject({ code: "CONFLICT" });
    // بعد الاعتماد الصورةُ تذهب للبديل: productImages.variantId = 910.
    await submitStudioCandidate(worker, { taskId: claimA.taskId, originalDataUrl: PNG_1X1_ALT, processedDataUrl: PNG_1X1, mode: "FLATTEN" });
    await approveStudioTask(manager, claimA.taskId);
    const [image] = await db().select({ variantId: s.productImages.variantId, productId: s.productImages.productId })
      .from(s.productImages)
      .where(and(eq(s.productImages.productId, 1), eq(s.productImages.variantId, 910)));
    expect(image).toMatchObject({ productId: 1, variantId: 910 });
  });

  it("reserves the full multi-image allowance independently for each variant", async () => {
    await db().insert(s.productVariants).values([
      { id: 912, productId: 1, sku: "ALT-MULTI-A", variantName: "زاوية A", variantKind: "ALTERNATIVE", costPrice: "1" },
      { id: 913, productId: 1, sku: "ALT-MULTI-B", variantName: "زاوية B", variantKind: "ALTERNATIVE", costPrice: "1" },
    ]);
    await db().insert(s.productUnits).values([
      { id: 912, variantId: 912, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6001000000912" },
      { id: 913, variantId: 913, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6001000000913" },
    ]);
    await createStudioCampaign(manager, {
      name: "ثلاث صور لكل بديل", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1],
      requiredImages: 3, assigneeIds: [worker.userId],
    });
    const firstA = await claimStudioProductByBarcode(worker, "6001000000912");
    const firstB = await claimStudioProductByBarcode(worker, "6001000000913");
    const [batchA, batchB] = await Promise.all([
      reserveStudioImageTasks(worker, { taskId: firstA.taskId, count: 3 }),
      reserveStudioImageTasks(worker, { taskId: firstB.taskId, count: 3 }),
    ]);
    expect(batchA.tasks.map((task) => task.activeSlot)).toEqual([1, 2, 3]);
    expect(batchB.tasks.map((task) => task.activeSlot)).toEqual([1, 2, 3]);
  });

  it("reserves, processes, and publishes every campaign photo independently", async () => {
    const [legacy] = await db().insert(s.productImages).values({
      productId: 1, url: PNG_1X1, isPrimary: true, sortOrder: 0,
      reviewStatus: "APPROVED", origin: "ORIGINAL",
    }).$returningId();
    const campaign = await createStudioCampaign(manager, {
      name: "تصوير متعدد", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1],
      requiredImages: 3, imagesPolicy: "ANY_REGARDLESS",
    });
    await createStudioCampaignBacklog(manager, campaign.campaignId);
    const first = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    const batch = await reserveStudioImageTasks(worker, { taskId: first.taskId, count: 3 });
    expect(batch.tasks).toHaveLength(3);
    expect(batch.maxImages).toBe(3);
    expect(batch.tasks.map((task) => task.activeSlot)).toEqual([1, 2, 3]);
    expect(new Set(batch.tasks.map((task) => task.taskId)).size).toBe(3);
    const repeated = await Promise.all([
      reserveStudioImageTasks(worker, { taskId: first.taskId, count: 3 }),
      reserveStudioImageTasks(worker, { taskId: first.taskId, count: 3 }),
    ]);
    expect(repeated.map((row) => row.tasks.map((task) => task.taskId))).toEqual([
      batch.tasks.map((task) => task.taskId), batch.tasks.map((task) => task.taskId),
    ]);
    await expect(reserveStudioImageTasks(worker, { taskId: first.taskId, count: 4 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reserveStudioImageTasks(otherWorker, { taskId: first.taskId, count: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const originals = [PNG_1X1, PNG_1X1_ALT, JPEG_1X1];
    const candidates = [PNG_1X1_ALT, JPEG_1X1, WEBP_1X1];
    const receipts: string[] = [];
    for (const [index, task] of batch.tasks.entries()) {
      await saveStudioDraft(worker, { taskId: task.taskId, proposedDescription: "" });
      const receipt = await attestStudioProcessing(worker, task.taskId, "AI");
      receipts.push(receipt);
      await bindStudioProcessingCandidate(worker, {
        taskId: task.taskId,
        processingReceipt: receipt,
        candidateDataUrl: candidates[index],
      });
      await submitStudioCandidate(worker, {
        taskId: task.taskId,
        originalDataUrl: originals[index],
        processedDataUrl: candidates[index],
        mode: "FLATTEN",
        processingReceipt: receipt,
      });
      const preview = await getStudioCandidatePreview(worker, task.taskId);
      expect(preview.originalBase64).toBe(originals[index].split(",")[1]);
      expect(preview.processedBase64).toBe(candidates[index].split(",")[1]);
    }
    expect(new Set(receipts).size).toBe(3);
    const pending = await db().select().from(s.productImageJobs)
      .where(inArray(s.productImageJobs.id, batch.tasks.map((task) => task.taskId)));
    for (const [index, task] of batch.tasks.entries()) {
      const row = pending.find((candidate) => Number(candidate.id) === task.taskId);
      expect(row).toMatchObject({ status: "PENDING_REVIEW", mode: "AI" });
      expect(row?.sourceContentHash).toBe(contentHash(Buffer.from(originals[index].split(",")[1], "base64")));
      expect(row?.processedContentHash).toBe(contentHash(Buffer.from(candidates[index].split(",")[1], "base64")));
    }
    await rejectStudioTask(manager, batch.tasks[1].taskId, "أعد ضبط الإضاءة");
    const source = await getStudioSourcePreview(worker, batch.tasks[1].taskId);
    expect(source.base64).toBe(PNG_1X1_ALT.split(",")[1]);
    const retriedReceipt = await attestStudioProcessing(worker, batch.tasks[1].taskId, "AI");
    await bindStudioProcessingCandidate(worker, {
      taskId: batch.tasks[1].taskId,
      processingReceipt: retriedReceipt,
      candidateDataUrl: candidates[1],
    });
    await submitStudioCandidate(worker, {
      taskId: batch.tasks[1].taskId,
      processedDataUrl: candidates[1],
      mode: "FLATTEN",
      processingReceipt: retriedReceipt,
    });
    for (const task of [batch.tasks[2], batch.tasks[0], batch.tasks[1]]) await approveStudioTask(manager, task.taskId);
    const images = await db().select().from(s.productImages)
      .where(eq(s.productImages.productId, 1))
      .orderBy(asc(s.productImages.sortOrder));
    expect(images).toHaveLength(4);
    expect(images.every((image) => image.reviewStatus === "APPROVED")).toBe(true);
    const generated = images.filter((image) => image.publishedStudioJobId != null);
    const generatedByTask = new Map(generated.map((image) => [Number(image.publishedStudioJobId), image]));
    for (const [index, task] of batch.tasks.entries()) {
      expect(generatedByTask.get(task.taskId)?.contentHash).toBe(contentHash(Buffer.from(candidates[index].split(",")[1], "base64")));
      expect(generatedByTask.get(task.taskId)).toMatchObject({
        isPrimary: false,
        sortOrder: task.activeSlot,
      });
    }
    expect(generated.map((image) => image.origin)).toEqual(["STUDIO_AI", "STUDIO_AI", "STUDIO_AI"]);
    expect(generated.map((image) => image.isPrimary)).toEqual([false, false, false]);
    expect(generated.map((image) => image.sortOrder)).toEqual([1, 2, 3]);
    expect(images.find((image) => Number(image.id) === Number(legacy.id))).toMatchObject({ isPrimary: true, sortOrder: 0 });
  });

  it("publishes a fresh multi-image campaign in slot order even when reviews are out of order", async () => {
    const campaign = await createStudioCampaign(manager, {
      name: "ترتيب منتج جديد", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [2],
      requiredImages: 3, imagesPolicy: "ANY_REGARDLESS",
    });
    await createStudioCampaignBacklog(manager, campaign.campaignId);
    const first = await assignStudioTask(manager, { productId: 2, assigneeId: worker.userId, sourceImageId: null });
    const batch = await reserveStudioImageTasks(worker, { taskId: first.taskId, count: 3 });
    const candidates = [PNG_1X1, PNG_1X1_ALT, JPEG_1X1];
    for (const [index, task] of batch.tasks.entries()) {
      await submitStudioCandidate(worker, {
        taskId: task.taskId,
        originalDataUrl: candidates[index],
        processedDataUrl: candidates[index],
        mode: "FLATTEN",
      });
    }
    for (const task of [batch.tasks[2], batch.tasks[0], batch.tasks[1]]) {
      await approveStudioTask(manager, task.taskId);
    }
    const images = await db().select().from(s.productImages).where(eq(s.productImages.productId, 2));
    const byTask = new Map(images.map((image) => [Number(image.publishedStudioJobId), image]));
    for (const task of batch.tasks) {
      expect(byTask.get(task.taskId)).toMatchObject({
        isPrimary: task.activeSlot === 1,
        sortOrder: task.activeSlot - 1,
      });
    }
  });

  it("appends consecutive manual studio approvals instead of treating null campaigns as one batch", async () => {
    const first = await assignStudioTask(manager, { productId: 2, assigneeId: worker.userId, sourceImageId: null });
    await submitStudioCandidate(worker, {
      taskId: first.taskId, originalDataUrl: PNG_1X1, processedDataUrl: PNG_1X1, mode: "FLATTEN",
    });
    await approveStudioTask(manager, first.taskId);
    const second = await assignStudioTask(manager, { productId: 2, assigneeId: worker.userId, sourceImageId: null });
    await submitStudioCandidate(worker, {
      taskId: second.taskId, originalDataUrl: PNG_1X1_ALT, processedDataUrl: PNG_1X1_ALT, mode: "FLATTEN",
    });
    await approveStudioTask(manager, second.taskId);

    const images = await db().select().from(s.productImages)
      .where(eq(s.productImages.productId, 2))
      .orderBy(asc(s.productImages.sortOrder));
    expect(images.map((image) => ({ primary: image.isPrimary, sort: image.sortOrder }))).toEqual([
      { primary: true, sort: 0 },
      { primary: false, sort: 1 },
    ]);
  });

  it("claims an available sibling before another photographer's older job", async () => {
    await db().insert(s.productVariants).values({ id: 901, productId: 1, sku: "BATCH-SCAN", costPrice: "1" });
    await db().insert(s.productUnits).values({ id: 901, variantId: 901, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6001000000901" });
    await createStudioCampaign(manager, { name: "التقاط جماعي", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1], requiredImages: 3, assigneeIds: [worker.userId, otherWorker.userId] });
    const first = await claimStudioProductByBarcode(worker, "6001000000901");
    const batch = await reserveStudioImageTasks(worker, { taskId: first.taskId, count: 3 });
    await bulkReassignStudioTasks(manager, { taskIds: [batch.tasks[2].taskId], newAssigneeId: null });
    const claimed = await claimStudioProductByBarcode(otherWorker, "6001000000901");
    expect(claimed.taskId).toBe(batch.tasks[2].taskId);
  });

  it("bulk assignment preserves all queued sibling jobs", async () => {
    const campaign = await createStudioCampaign(manager, { name: "دفعة الطابور", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1], requiredImages: 3 });
    await createStudioCampaignBacklog(manager, campaign.campaignId);
    const first = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    const batch = await reserveStudioImageTasks(worker, { taskId: first.taskId, count: 3 });
    await bulkReassignStudioTasks(manager, { taskIds: batch.tasks.map((task) => task.taskId), newAssigneeId: null });
    expect(await bulkAssignStudioTasks(manager, { productIds: [1], assigneeId: worker.userId })).toMatchObject({ createdCount: 3 });
    const jobs = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.productId, 1));
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.assignedTo === worker.userId)).toBe(true);
    await bulkReassignStudioTasks(manager, { taskIds: [batch.tasks[1].taskId], newAssigneeId: null });
    const after = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.productId, 1));
    expect(after.filter((job) => job.assignedTo == null).map((job) => Number(job.id))).toEqual([batch.tasks[1].taskId]);
  });

  it("ANY_REGARDLESS does not consume another campaign's image allowance", async () => {
    const firstCampaign = await createStudioCampaign(manager, { name: "الحملة الأولى", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1], requiredImages: 1 });
    await createStudioCampaignBacklog(manager, firstCampaign.campaignId);
    const first = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    const second = await createStudioCampaign(manager, { name: "الحملة الثانية", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1], requiredImages: 3, imagesPolicy: "ANY_REGARDLESS" });
    // A different variant scope can have work in an independent campaign.
    await db().insert(s.productVariants).values({ id: 901, productId: 1, sku: "OTHER-CAMPAIGN", costPrice: "1" });
    await db().update(s.productImageJobs).set({ variantId: 901 }).where(eq(s.productImageJobs.id, first.taskId));
    const other = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    await db().update(s.productImageJobs).set({ campaignId: second.campaignId }).where(eq(s.productImageJobs.id, other.taskId));
    const batch = await reserveStudioImageTasks(worker, { taskId: other.taskId, count: 3 });
    expect(batch.maxImages).toBe(3);
    expect(batch.tasks).toHaveLength(3);
  });

  it("does not grant multiple photos for standalone, single-image or paused campaigns", async () => {
    const standalone = await assignStudioTask(manager, { productId: 2, assigneeId: worker.userId });
    await expect(reserveStudioImageTasks(worker, { taskId: standalone.taskId, count: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const campaign = await createStudioCampaign(manager, {
      name: "صورة واحدة", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1], requiredImages: 1,
    });
    await createStudioCampaignBacklog(manager, campaign.campaignId);
    const first = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    await expect(reserveStudioImageTasks(worker, { taskId: first.taskId, count: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.productStudioCampaigns).set({ requiredImages: 3, status: "PAUSED" }).where(eq(s.productStudioCampaigns.id, campaign.campaignId));
    await expect(reserveStudioImageTasks(worker, { taskId: first.taskId, count: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("توجيه عدد الصور نافذٌ: المنتج يبقى ناقصاً حتى يبلغ العدد المطلوب", async () => {
    const campaign = await createStudioCampaign(manager, { name: "حملة ثلاث صور", status: "ACTIVE", scopeKind: "PRODUCTS", scopeProductIds: [1], requiredImages: 3 });
    await createStudioCampaignBacklog(manager, campaign.campaignId);

    const task = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    await submitStudioCandidate(worker, { taskId: task.taskId, originalDataUrl: PNG_1X1_ALT, processedDataUrl: PNG_1X1, mode: "FLATTEN" });
    await approveStudioTask(manager, task.taskId);

    // بالتعريف القديم («بلا أيّ صورة معتمدة») كان المنتج يخرج من الطابور بعد الأولى
    // فيصير التوجيه زينةً. الآن يبقى ناقصاً حتى الثالثة.
    await expect(previewStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toMatchObject({ count: 1 });
    const board = await getStudioCampaignBoard(manager, campaign.campaignId);
    expect(board.requiredImages).toBe(3);
    expect(board.breakdown.notGenerated).toBe(1);
    // وحدةُ الرقمين **منتجات** لا مهامّ: منتجٌ واحد لم يبلغ الثلاث ⇒ ٠ مكتمل من ١، ومتبقٍّ ١.
    // كان `done` يعُدّ المهام المعتمدة فتقرأ اللوحة «أُنجز ١ · متبقٍّ ١» عن الشيء نفسه.
    expect(board).toMatchObject({ done: 0, remaining: 1, totalProducts: 1 });

    await expect(createStudioCampaignBacklog(manager, campaign.campaignId)).resolves.toMatchObject({ createdCount: 1 });
    const second = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    const remainder = await reserveStudioImageTasks(worker, { taskId: second.taskId, count: 2 });
    expect(remainder.tasks.map((row) => row.activeSlot)).toEqual([2, 3]);
    for (const [index, row] of remainder.tasks.entries()) {
      await submitStudioCandidate(worker, {
        taskId: row.taskId,
        originalDataUrl: index === 0 ? PNG_1X1_ALT : JPEG_1X1,
        processedDataUrl: index === 0 ? PNG_1X1_ALT : JPEG_1X1,
        mode: "FLATTEN",
      });
    }
    await approveStudioTask(manager, remainder.tasks[1].taskId);
    await approveStudioTask(manager, remainder.tasks[0].taskId);
    const published = await db().select().from(s.productImages)
      .where(eq(s.productImages.productId, 1))
      .orderBy(asc(s.productImages.sortOrder));
    expect(published.map((image) => image.sortOrder)).toEqual([0, 1, 2]);
    expect(published.map((image) => image.isPrimary)).toEqual([true, false, false]);
  });

  it("المصوّر يمسح فيُنشأ عمله فوراً بلا انتظار توليد المدير", async () => {
    await db().insert(s.productVariants).values({ id: 901, productId: 1, sku: "SCAN-A", costPrice: "1" });
    await db().insert(s.productUnits).values({ id: 901, variantId: 901, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6001000000901" });
    const campaign = await createStudioCampaign(manager, {
      name: "حملة بلا توليد",
      status: "ACTIVE",
      scopeKind: "PRODUCTS",
      scopeProductIds: [1],
      requiredImages: 2,
      assigneeIds: [worker.userId],
    });
    // لم يُولَّد أيّ طابور إطلاقاً.
    expect(await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.campaignId, campaign.campaignId))).toEqual([]);

    const claimed = await claimStudioProductByBarcode(worker, "6001000000901");
    expect(claimed).toMatchObject({ claimed: true, approvedImages: 0, requiredImages: 2 });
    const [row] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, claimed.taskId));
    expect(row).toMatchObject({ assignedTo: worker.userId, campaignId: campaign.campaignId, activeSlot: 1 });

    // ومن ليس مصوّراً في الحملة لا يُنشئ شيئاً بالمسح.
    await expect(claimStudioProductByBarcode(otherWorker, "6001000000901")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("لوحة الحملة تفصل المنجَز عن المتبقّي بمعانيه لا برقمٍ واحد", async () => {
    await db().insert(s.products).values([{ id: 3, name: "منتج ثالث" }, { id: 4, name: "منتج رابع" }]);
    const campaign = await createStudioCampaign(manager, {
      name: "حملة اللوحة",
      status: "ACTIVE",
      scopeKind: "PRODUCTS",
      scopeProductIds: [1, 3, 4],
      assigneeIds: [worker.userId],
    });
    await createStudioCampaignBacklog(manager, campaign.campaignId);
    await assignStudioTask(manager, { productId: 3, assigneeId: worker.userId });

    const board = await getStudioCampaignBoard(manager, campaign.campaignId);
    expect(board).toMatchObject({ done: 0, remaining: 3 });
    expect(board.breakdown).toMatchObject({ queued: 2, inProgress: 1, awaitingReview: 0, notGenerated: 0 });
    expect(board.photographers).toEqual([expect.objectContaining({ userId: worker.userId, active: 1, done: 0 })]);
  });

  it("المصوّر المؤقّت: صلاحية استوديو فقط، وانتهاءٌ يتبع الحملة، ورمزٌ يُعرض مرّةً", async () => {
    const due = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const campaign = await createStudioCampaign(manager, { name: "حملة مؤقّتة", status: "ACTIVE", dueAt: due });
    const issued = await createTemporaryCampaignPhotographer(manager, { campaignId: campaign.campaignId, name: "مصوّر خارجي" });

    // الرمز قويّ لا PIN: عشرون محرفاً بمجموعاتٍ للقراءة.
    expect(issued.code.replace(/-/g, "")).toHaveLength(20);
    // MySQL TIMESTAMP يجبر ما دون الثانية (اقتطاعاً أو تقريباً) ⇒ نافذة ثانيةٍ واحدة.
    expect(Math.abs(issued.expiresAt.getTime() - due.getTime())).toBeLessThanOrEqual(1000);

    const [account] = await db().select().from(s.users).where(eq(s.users.id, issued.userId));
    expect(account).toMatchObject({ role: "print_operator", branchId: 1, isActive: true });
    expect(Math.abs(account!.accessExpiresAt!.getTime() - due.getTime())).toBeLessThanOrEqual(1000);
    // كل الوحدات مغلقة عدا الاستوديو — قالب print_operator وحده يفتح CRM وأوامر الشغل.
    const perms = account!.permissionsOverride as Record<string, string>;
    expect(perms.productStudio).toBe("FULL");
    expect(Object.entries(perms).filter(([key, level]) => key !== "productStudio" && level !== "NONE")).toEqual([]);
    // ولا يُخزَّن الرمز نصّاً في أيّ عمود.
    expect(JSON.stringify(account)).not.toContain(issued.code.replace(/-/g, ""));
    // وأُضيف مصوّراً للحملة تلقائياً.
    expect(await db().select().from(s.productStudioCampaignAssignees).where(eq(s.productStudioCampaignAssignees.userId, issued.userId))).toHaveLength(1);

    // الإغلاق يُبطل الوصول والجلسات القائمة معاً.
    await expect(revokeTemporaryCampaignPhotographers(manager, campaign.campaignId)).resolves.toEqual({ revoked: 1 });
    const [revoked] = await db().select().from(s.users).where(eq(s.users.id, issued.userId));
    expect(revoked).toMatchObject({ isActive: false });
    // الانتهاء في الماضي يقيناً — لا على «الآن» الذي قد يقرّبه TIMESTAMP لأعلى فيصير مستقبلاً.
    expect(revoked!.accessExpiresAt!.getTime()).toBeLessThan(Date.now());
  });

  it("يرفض إنشاء مصوّر مؤقّت لحملةٍ منتهية أو لغير المدير", async () => {
    const campaign = await createStudioCampaign(manager, { name: "حملة الرفض", status: "ACTIVE", dueAt: new Date(Date.now() + 86_400_000) });
    await expect(createTemporaryCampaignPhotographer(worker, { campaignId: campaign.campaignId, name: "محاولة موظف" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createTemporaryCampaignPhotographer(managerTwo, { campaignId: campaign.campaignId, name: "مدير فرع آخر" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await transitionStudioCampaign(manager, { campaignId: campaign.campaignId, status: "CANCELLED", reason: "أُلغيت الحملة" });
    await expect(createTemporaryCampaignPhotographer(manager, { campaignId: campaign.campaignId, name: "بعد الإلغاء" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("قائمة المصوّرين تُظهر كل الكادر مع علَم الصلاحية، والمنح صريحٌ ومُدقَّق", async () => {
    const listed = await listStudioAssignees(manager);
    const byId = new Map(listed.map((u) => [u.id, u]));
    // الكاشير/المندوب كانوا يُحذفون من القائمة فيبدو الكادر ناقصاً بلا سبب ظاهر.
    expect(byId.has(worker.userId)).toBe(true);
    expect(byId.get(worker.userId)?.canStudio).toBe(true);
    const [plain] = await db().insert(s.users).values({ openId: "studio-plain", name: "كاشير بلا صلاحية", role: "cashier", branchId: 1, isActive: true }).$returningId();
    const plainId = Number(plain.id);
    const withPlain = new Map((await listStudioAssignees(manager)).map((u) => [u.id, u]));
    expect(withPlain.get(plainId)).toMatchObject({ canStudio: false });

    // ولا يُسنَد قبل المنح.
    const campaign = await createStudioCampaign(manager, { name: "حملة المنح", status: "ACTIVE" });
    await expect(createStudioCampaign(manager, { name: "حملة بموظفٍ بلا صلاحية", status: "ACTIVE", assigneeIds: [plainId] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(grantStudioAccess(manager, plainId)).resolves.toMatchObject({ granted: true });
    expect((await listStudioAssignees(manager)).find((u) => u.id === plainId)?.canStudio).toBe(true);
    // المنح لا يمسّ وحدةً أخرى ولا يرفع الدور.
    const [after] = await db().select().from(s.users).where(eq(s.users.id, plainId));
    expect(after).toMatchObject({ role: "cashier" });
    expect((after!.permissionsOverride as Record<string, string>).productStudio).toBe("FULL");
    // ويصير قابلاً للإسناد فعلاً.
    await expect(createStudioCampaign(manager, { name: "حملة بعد المنح", status: "ACTIVE", assigneeIds: [plainId] })).resolves.toMatchObject({ assigneeIds: [plainId] });
    // وإعادة المنح لا تُكرّر شيئاً، ومديرُ فرعٍ آخر يُرفض.
    await expect(grantStudioAccess(manager, plainId)).resolves.toMatchObject({ granted: false });
    await expect(grantStudioAccess(managerTwo, plainId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    void campaign;
  });

  it("يعزل الإلغاء الجماعي بالفرع", async () => {
    const campaign = await createStudioCampaign(manager, { name: "حملة فرع واحد", status: "ACTIVE" });
    await expect(bulkCancelStudioBacklog(managerTwo, { campaignId: campaign.campaignId, reason: "محاولة من فرعٍ آخر" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(bulkCancelStudioBacklog(worker, { campaignId: campaign.campaignId, reason: "محاولة من موظف" })).rejects.toMatchObject({ code: "FORBIDDEN" });
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

  it("keeps an accepted provider proof valid when a later preview is cancelled", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const accepted = await attestStudioProcessing(worker, taskId, "AI");
    await bindStudioProcessingCandidate(worker, {
      taskId,
      processingReceipt: accepted,
      candidateDataUrl: PNG_1X1,
    });
    // توليدُ معاينة ثانية ينجح، لكن المصوّر يلغيها ولا يربط receipt الجديد.
    await attestStudioProcessing(worker, taskId, "AI");
    await expect(submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1_ALT,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
      processingReceipt: accepted,
    })).resolves.toBeDefined();
    const [job] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(job?.mode).toBe("AI");
  });

  it("does not let one accepted provider receipt move to different candidate bytes", async () => {
    const { taskId } = await assignStudioTask(manager, {
      productId: 1,
      assigneeId: worker.userId,
      sourceImageId: null,
    });
    const receipt = await attestStudioProcessing(worker, taskId, "AI");
    await bindStudioProcessingCandidate(worker, {
      taskId,
      processingReceipt: receipt,
      candidateDataUrl: PNG_1X1,
    });
    await expect(bindStudioProcessingCandidate(worker, {
      taskId,
      processingReceipt: receipt,
      candidateDataUrl: PNG_1X1_ALT,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

  it("getStudioTaskPreviousImages يعيد صور المنتج المعتمدة السابقة بترتيب الأسبقية والأمر للمصوّر المخوّل", async () => {
    const task = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    // إدخال صورتين معتمدتين للمنتج 1: واحدة رئيسية وواحدة ثانوية
    await db().insert(s.productImages).values([
      {
        id: 901,
        productId: 1,
        url: "https://example.com/img901.png",
        isPrimary: 0,
        sortOrder: 2,
        reviewStatus: "APPROVED",
        thumbDataUrl: PNG_1X1,
        storageKey: "p1-secondary",
      },
      {
        id: 902,
        productId: 1,
        url: "https://example.com/img902.png",
        isPrimary: 1,
        sortOrder: 1,
        reviewStatus: "APPROVED",
        thumbDataUrl: PNG_1X1_ALT,
        storageKey: "p1-primary",
      },
      {
        id: 903,
        productId: 1,
        url: "https://example.com/img903.png",
        isPrimary: 0,
        sortOrder: 3,
        reviewStatus: "PENDING_REVIEW", // غير معتمدة، لا يجب أن تظهر
        thumbDataUrl: PNG_1X1,
        storageKey: "p1-pending",
      },
    ]);

    const prev = await getStudioTaskPreviousImages(worker, task.taskId);
    expect(prev).toHaveLength(2);
    expect(prev[0]).toMatchObject({ id: 902, isPrimary: true, sortOrder: 1 });
    expect(prev[1]).toMatchObject({ id: 901, isPrimary: false, sortOrder: 2 });

    // مصوّر لا يملك المهمة ولا الفرع يُرفض
    const stranger: ProductStudioActor = { userId: 99, branchId: 2, role: "print_operator" };
    await expect(getStudioTaskPreviousImages(stranger, task.taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

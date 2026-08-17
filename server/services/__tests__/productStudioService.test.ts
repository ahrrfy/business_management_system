import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest, contentHash, getImageStore, objectKeyFor } from "../../lib/imageStore";
import {
  approveStudioTask,
  assignStudioTask,
  attestStudioProcessing,
  bindStudioProcessingCandidate,
  cleanupStudioStaging,
  getStudioDashboard,
  getStudioCandidatePreview,
  getStudioSourcePreview,
  listStudioTasks,
  rejectStudioTask,
  revertStudioTask,
  saveStudioDraft,
  submitStudioCandidate,
  type ProductStudioActor,
} from "../productStudioService";
import { sweepProductStudioStagingOnce } from "../productStudioStagingWorker";

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_1X1_ALT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII=";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

const manager: ProductStudioActor = { userId: 1, branchId: 1, role: "manager" };
const worker: ProductStudioActor = { userId: 2, branchId: 1, role: "print_operator" };
const otherWorker: ProductStudioActor = { userId: 3, branchId: 1, role: "print_operator" };
const managerTwo: ProductStudioActor = { userId: 4, branchId: 2, role: "manager" };
const workerTwo: ProductStudioActor = { userId: 5, branchId: 2, role: "print_operator" };
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
    { id: 1, openId: "studio-manager", name: "المدير", role: "manager", branchId: 1 },
    { id: 2, openId: "studio-worker", name: "موظف الصور والمحتوى", role: "print_operator", branchId: 1 },
    { id: 3, openId: "studio-other", name: "موظف آخر", role: "print_operator", branchId: 1 },
    { id: 4, openId: "studio-manager-2", name: "مدير الفرع الثاني", role: "manager", branchId: 2 },
    { id: 5, openId: "studio-worker-2", name: "موظف الفرع الثاني", role: "print_operator", branchId: 2 },
    { id: 6, openId: "studio-admin", name: "الأدمن", role: "admin", branchId: null },
    { id: 7, openId: "studio-auditor", name: "المدقق", role: "auditor", branchId: 1 },
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
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

describe("product studio governed workflow", () => {
  it("enforces one active owner per product and rejects another employee's writes", async () => {
    const results = await Promise.allSettled([
      assignStudioTask(manager, { productId: 1, assigneeId: 2 }),
      assignStudioTask(manager, { productId: 1, assigneeId: 3 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [task] = await db().select().from(s.productImageJobs);
    expect(task?.activeSlot).toBe(1);
    const owner = Number(task?.assignedTo) === worker.userId ? worker : otherWorker;
    const stranger = owner.userId === worker.userId ? otherWorker : worker;
    await expect(saveStudioDraft(stranger, { taskId: Number(task?.id), proposedDescription: "ممنوع" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps a pending candidate private, publishes once atomically, audits, and restores the original", async () => {
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    await saveStudioDraft(worker, {
      taskId,
      proposedName: "قلم ألوان عملي",
      proposedDescription: "أربعة ألوان في قلم واحد.",
      proposedMarketingCopy: "اختيار واضح للاستخدام اليومي.",
    });
    const aiReceipt = await attestStudioProcessing(worker, taskId, "AI");
    await bindStudioProcessingCandidate(worker, { taskId, processingReceipt: aiReceipt, candidateDataUrl: PNG_1X1 });
    await expect(submitStudioCandidate(otherWorker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

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
    expect(pending?.processedUrl).toBeNull();
    expect(JSON.stringify(pending)).not.toContain("data:image/");
    expect(await db().select().from(s.productImages)).toHaveLength(0);

    const safeTask = (await listStudioTasks(worker, { scope: "MINE" }))[0];
    expect(safeTask).toBeDefined();
    expect(Object.keys(safeTask ?? {})).not.toEqual(expect.arrayContaining([
      "costPrice", "price", "stock", "objectKey", "originalObjectKey", "processedObjectKey",
    ]));

    const approvals = await Promise.allSettled([
      approveStudioTask(manager, taskId),
      approveStudioTask(manager, taskId),
    ]);
    expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [approvedJob] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    const [published] = await db().select().from(s.productImages).where(eq(s.productImages.productId, 1));
    expect(approvedJob?.status).toBe("APPROVED");
    expect(approvedJob?.activeSlot).toBeNull();
    expect(published?.reviewStatus).toBe("APPROVED");
    expect(published?.objectKey).toBe(approvedJob?.processedObjectKey);
    expect(published?.originalKey).toBe(approvedJob?.originalObjectKey);
    expect(published?.url).toMatch(/^\/api\/img\/product\/\d+\?v=/);
    expect(published?.origin).toBe("STUDIO_AI");
    const [updatedProduct] = await db().select().from(s.products).where(eq(s.products.id, 1));
    expect(updatedProduct?.name).toBe("قلم ألوان موثوق");
    expect(updatedProduct?.description).toContain("نص ترويجي صادق");
    expect(await db().select().from(s.auditLogs).where(and(
      eq(s.auditLogs.entityId, String(taskId)),
      eq(s.auditLogs.action, "productStudio.approve"),
    ))).toHaveLength(1);

    const auditDashboard = await getStudioDashboard(auditor);
    expect(auditDashboard.canAudit).toBe(true);
    expect(auditDashboard.canManage).toBe(false);
    expect(auditDashboard.counts.APPROVED).toBe(1);
    await expect(listStudioTasks(auditor, { scope: "HISTORY" }))
      .resolves.toEqual([expect.objectContaining({ id: taskId, status: "APPROVED" })]);
    await expect(getStudioCandidatePreview(auditor, taskId))
      .resolves.toMatchObject({ processedMime: "image/png" });

    await revertStudioTask(manager, taskId);
    const [restored] = await db().select().from(s.productImages).where(eq(s.productImages.id, Number(published?.id)));
    expect(restored?.objectKey).toMatch(/^single\/studio\/candidate\//);
    expect(restored?.contentHash).toBe(approvedJob?.sourceContentHash);
    expect(restored?.origin).toBe("ORIGINAL");
    await expect(revertStudioTask(manager, taskId)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.auditLogs).where(and(
      eq(s.auditLogs.entityId, String(taskId)),
      eq(s.auditLogs.action, "productStudio.revert"),
    ))).toHaveLength(1);
  });

  it("requires a clear rejection reason and returns the same task to its owner", async () => {
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "CUT",
    });
    await expect(rejectStudioTask(manager, taskId, "لا"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await rejectStudioTask(manager, taskId, "الخلفية تحتاج تنظيفاً أدق");
    const [rejected] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(rejected?.status).toBe("REJECTED");
    expect(rejected?.assignedTo).toBe(worker.userId);
    expect(rejected?.activeSlot).toBe(1);
    expect(rejected?.rejectionReason).toBe("الخلفية تحتاج تنظيفاً أدق");
    await expect(saveStudioDraft(worker, { taskId, proposedDescription: "تم التنظيف" }))
      .resolves.toEqual({ ok: true });
  });

  it("isolates every task operation by branch while admin can cross branches", async () => {
    const { taskId } = await assignStudioTask(managerTwo, { productId: 2, assigneeId: workerTwo.userId });
    await submitStudioCandidate(workerTwo, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    expect(await listStudioTasks(manager, { scope: "REVIEW" })).toHaveLength(0);
    await expect(getStudioCandidatePreview(manager, taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getStudioSourcePreview(manager, taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveStudioTask(manager, taskId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rejectStudioTask(manager, taskId, "سبب واضح من فرع خاطئ"))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveStudioTask(admin, taskId)).resolves.toMatchObject({ imageId: expect.any(Number) });
  });

  it("keeps the first original immutable through rejection and serializes concurrent uploads with a DB lease", async () => {
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
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
    expect(await db().select().from(s.auditLogs).where(and(
      eq(s.auditLogs.entityId, String(taskId)),
      eq(s.auditLogs.action, "productStudio.submit"),
    ))).toHaveLength(2);
  });

  it("rejects a slow upload after its DB lease expires and a newer draft is saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = new Date("2026-08-17T08:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    const store = getImageStore();
    const originalPut = store.put.bind(store);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let uploadReached!: () => void;
    const reachedUpload = new Promise<void>((resolve) => { uploadReached = resolve; });
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
    await saveStudioDraft(worker, { taskId, proposedDescription: "مسودة أحدث بعد انتهاء مهلة الرفع" });
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
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
      proposedDescription: "وصف مقترح",
    });
    await db().update(s.products).set({ description: "تعديل أحدث من شاشة المنتج" }).where(eq(s.products.id, 1));
    await expect(approveStudioTask(manager, taskId)).rejects.toMatchObject({ code: "CONFLICT" });

    // مهمة منفصلة على صورة منشورة: اللقطة تؤخذ خادمياً، ثم تغيير hash المصدر يمنع طمس النسخة الأحدث.
    await db().update(s.productImageJobs).set({ status: "FAILED", activeSlot: null }).where(eq(s.productImageJobs.id, taskId));
    const originalBytes = Buffer.from(PNG_1X1.slice(PNG_1X1.indexOf(",") + 1), "base64");
    const originalHash = contentHash(originalBytes);
    const originalKey = objectKeyFor(originalHash, "image/png", "single/studio/candidate");
    await getImageStore().put(originalKey, originalBytes, "image/png");
    const [image] = await db().insert(s.productImages).values({
      productId: 1,
      url: "/api/img/product/pending",
      objectKey: originalKey,
      contentHash: originalHash,
      mime: "image/png",
      reviewStatus: "APPROVED",
      isPrimary: true,
    }).$returningId();
    const second = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: Number(image.id) });
    await expect(getStudioSourcePreview(worker, second.taskId)).resolves.toMatchObject({ mime: "image/png" });
    await submitStudioCandidate(worker, {
      taskId: second.taskId,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    await db().update(s.productImages).set({ contentHash: "f".repeat(64) }).where(eq(s.productImages.id, Number(image.id)));
    await expect(approveStudioTask(manager, second.taskId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails closed on incomplete R2 credentials and truncated image data without leaving an upload lease", async () => {
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.IMAGE_STORE_DRIVER = "r2";
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_IMAGE_BUCKET;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    __resetImageStoreForTest();
    await expect(submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    process.env.IMAGE_STORE_DRIVER = "fs";
    process.env.IMAGE_STORE_DIR = storeDir;
    __resetImageStoreForTest();
    const truncated = PNG_1X1.slice(0, -16);
    await expect(submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: truncated,
      mode: "FLATTEN",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [task] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId));
    expect(task?.uploadLeaseToken).toBeNull();
    expect(task?.processedObjectKey).toBeNull();
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

    await expect(assignStudioTask(manager, { productId: 1, assigneeId: worker.userId }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.productImageJobs)).toHaveLength(0);
    expect(await db().select().from(s.productImageObjectStaging)).toHaveLength(0);
    expect(await readdir(storeDir)).toHaveLength(0);
  });

  it("reports object-store readiness without hiding dashboard history", async () => {
    await expect(getStudioDashboard(manager)).resolves.toMatchObject({ storageReady: true });
    process.env.NODE_ENV = "production";
    delete process.env.IMAGE_STORE_DRIVER;
    __resetImageStoreForTest();
    await expect(getStudioDashboard(manager)).resolves.toMatchObject({
      storageReady: false,
      counts: expect.any(Object),
    });
  });

  it("blocks candidate preview and approval server-side when storage becomes unavailable", async () => {
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "CUT",
    });
    process.env.NODE_ENV = "production";
    delete process.env.IMAGE_STORE_DRIVER;
    __resetImageStoreForTest();

    await expect(getStudioCandidatePreview(manager, taskId))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(approveStudioTask(manager, taskId))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.productImages)).toHaveLength(0);
    expect((await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, taskId)))[0]?.status)
      .toBe("PENDING_REVIEW");
  });

  it("skips production staging GC without R2 and preserves the database reference", async () => {
    const objectKey = `single/studio/candidate/ab/${"a".repeat(64)}.png`;
    await db().insert(s.productImageObjectStaging).values({
      objectKey,
      state: "PENDING",
      touchedAt: new Date(Date.now() - 48 * 60 * 60_000),
    });
    process.env.NODE_ENV = "production";
    delete process.env.IMAGE_STORE_DRIVER;
    __resetImageStoreForTest();

    await expect(sweepProductStudioStagingOnce()).resolves.toBe(0);
    expect(await db().select().from(s.productImageObjectStaging)).toEqual([
      expect.objectContaining({ objectKey, state: "PENDING" }),
    ]);
    expect(await readdir(storeDir)).toHaveLength(0);
  });

  it("sweeps old unreferenced pending and referenced staging objects", async () => {
    const bytes = Buffer.from(PNG_1X1.slice(PNG_1X1.indexOf(",") + 1), "base64");
    const key = objectKeyFor(contentHash(bytes), "image/png", "single/studio/candidate");
    await getImageStore().put(key, bytes, "image/png");
    await db().insert(s.productImageObjectStaging).values({
      objectKey: key,
      state: "PENDING",
      touchedAt: new Date(Date.now() - 48 * 60 * 60_000),
    });
    await expect(cleanupStudioStaging()).resolves.toBe(1);
    expect((await getImageStore().head(key)).exists).toBe(false);
    expect(await db().select().from(s.productImageObjectStaging)).toHaveLength(0);

    const referencedKey = objectKeyFor(contentHash(Buffer.concat([bytes, Buffer.from("orphan")])), "image/png", "single/studio/candidate");
    await getImageStore().put(referencedKey, bytes, "image/png");
    await db().insert(s.productImageObjectStaging).values({
      objectKey: referencedKey,
      state: "REFERENCED",
      touchedAt: new Date(Date.now() - 48 * 60 * 60_000),
      referencedAt: new Date(Date.now() - 48 * 60 * 60_000),
    });
    await expect(cleanupStudioStaging()).resolves.toBe(1);
    expect((await getImageStore().head(referencedKey)).exists).toBe(false);
  });

  it("rejects reverting an older job after a newer job published identical bytes", async () => {
    const first = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    await submitStudioCandidate(worker, {
      taskId: first.taskId,
      originalDataUrl: PNG_1X1_ALT,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
    });
    const { imageId } = await approveStudioTask(manager, first.taskId);
    const second = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: imageId });
    await submitStudioCandidate(worker, { taskId: second.taskId, processedDataUrl: PNG_1X1, mode: "CUT" });
    await approveStudioTask(manager, second.taskId);
    await expect(revertStudioTask(manager, first.taskId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("publishes only server-attested Pro/AI modes and clears an unused stale proof", async () => {
    const first = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    const proReceipt = await attestStudioProcessing(worker, first.taskId, "PRO");
    await bindStudioProcessingCandidate(worker, { taskId: first.taskId, processingReceipt: proReceipt, candidateDataUrl: PNG_1X1 });
    await submitStudioCandidate(worker, {
      taskId: first.taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "CUT",
      processingReceipt: proReceipt,
    });
    const { imageId } = await approveStudioTask(manager, first.taskId);
    expect((await db().select().from(s.productImages).where(eq(s.productImages.id, imageId)).limit(1))[0]?.origin).toBe("STUDIO_PRO");

    const second = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: imageId });
    await attestStudioProcessing(worker, second.taskId, "AI");
    // رفع/تعديل يدوي بعد تشغيل AI لا يحمل receipt؛ لا يجوز أن يرث تصنيف AI القديم.
    await submitStudioCandidate(worker, { taskId: second.taskId, processedDataUrl: PNG_1X1_ALT, mode: "FLATTEN" });
    await approveStudioTask(manager, second.taskId);
    const [published] = await db().select().from(s.productImages).where(eq(s.productImages.id, imageId));
    const [job] = await db().select().from(s.productImageJobs).where(eq(s.productImageJobs.id, second.taskId));
    expect(published?.origin).toBe("STUDIO_FREE");
    expect(job?.processingProofTokenHash).toBeNull();
    expect(job?.mode).toBe("FLATTEN");
  });

  it("binds provider receipts to final bytes and rejects overwrite, replay, and expiry", async () => {
    const { taskId } = await assignStudioTask(manager, { productId: 1, assigneeId: worker.userId, sourceImageId: null });
    const overwritten = await attestStudioProcessing(worker, taskId, "PRO");
    const current = await attestStudioProcessing(worker, taskId, "AI");
    await expect(bindStudioProcessingCandidate(worker, {
      taskId,
      processingReceipt: overwritten,
      candidateDataUrl: PNG_1X1,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await bindStudioProcessingCandidate(worker, { taskId, processingReceipt: current, candidateDataUrl: PNG_1X1 });

    await expect(submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1_ALT,
      mode: "FLATTEN",
      processingReceipt: current,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
      processingReceipt: current,
    });
    await rejectStudioTask(manager, taskId, "اختبار إعادة الإرسال الآمن");
    await expect(submitStudioCandidate(worker, {
      taskId,
      processedDataUrl: PNG_1X1,
      mode: "FLATTEN",
      processingReceipt: current,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const expired = await attestStudioProcessing(worker, taskId, "AI");
    await bindStudioProcessingCandidate(worker, { taskId, processingReceipt: expired, candidateDataUrl: PNG_1X1 });
    await db().update(s.productImageJobs).set({ processingProofExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(s.productImageJobs.id, taskId));
    await expect(submitStudioCandidate(worker, {
      taskId,
      processedDataUrl: PNG_1X1,
      mode: "CUT",
      processingReceipt: expired,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest } from "../../lib/imageStore";
import { truncateAllTables } from "../../services/__tests__/__testUtils__";

const providerMocks = vi.hoisted(() => ({
  generateStudioImage: vi.fn<typeof import("../../services/aiImageStudioService").generateStudioImage>(async () => ({ imageBase64: "QUJD", mimeType: "image/png" })),
}));

vi.mock("../../services/imageStudioSettingsService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/imageStudioSettingsService")>(),
  getAiStudioRuntime: vi.fn(async () => ({
    apiKey: "qa-ai-key",
    provider: "GEMINI",
    model: "qa-model",
    basePrompt: "خلفية بيضاء",
  })),
}));

vi.mock("../../services/aiImageStudioService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/aiImageStudioService")>(),
  generateStudioImage: providerMocks.generateStudioImage,
}));

vi.mock("../../services/imageStudioUsageGuard", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/imageStudioUsageGuard")>(),
  runGuardedImageStudioCall: vi.fn(async (input: { run: () => Promise<unknown> }) => input.run()),
}));

import { imageStudioRouter } from "../imageStudioRouter";

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

function caller(role: string, productStudio?: "FULL" | "READ" | "NONE", options: { id?: number; branchId?: number | null } = {}) {
  return imageStudioRouter.createCaller({
    req: { headers: {} }, res: {}, sessionId: null, platformAdmin: null,
    user: {
      id: options.id ?? 92, role, branchId: options.branchId === undefined ? 1 : options.branchId,
      permissionsOverride: productStudio ? { productStudio } : null, totpEnabledAt: new Date(),
    },
  } as never);
}

async function seedStudioTasks() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الأول", code: "STUDIO-B1", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "STUDIO-B2", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 92, openId: "studio-route-owner", role: "print_operator", branchId: 1 },
    { id: 93, openId: "studio-route-other", role: "print_operator", branchId: 1 },
    { id: 94, openId: "studio-route-foreign", role: "print_operator", branchId: 2 },
    { id: 95, openId: "studio-route-manager", role: "manager", branchId: 1 },
  ]);
  await db().insert(s.products).values([
    { id: 920, name: "منتج مهمة المالك" }, { id: 921, name: "منتج مهمة موظف آخر" },
    { id: 922, name: "منتج مهمة فرع آخر" }, { id: 923, name: "منتج مهمة بلا مسح" },
    { id: 924, name: "منتج مهمة المدير" },
  ]);
  await db().insert(s.productImageJobs).values([
    { id: 920, productId: 920, branchId: 1, assignedTo: 92, barcodeVerifiedBy: 92, barcodeVerifiedAt: new Date(), createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
    { id: 921, productId: 921, branchId: 1, assignedTo: 93, barcodeVerifiedBy: 93, barcodeVerifiedAt: new Date(), createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
    { id: 922, productId: 922, branchId: 2, assignedTo: 94, barcodeVerifiedBy: 94, barcodeVerifiedAt: new Date(), createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
    { id: 923, productId: 923, branchId: 1, assignedTo: 92, createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
    { id: 924, productId: 924, branchId: 1, assignedTo: 95, barcodeVerifiedBy: 95, barcodeVerifiedAt: new Date(), createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
  ]);
}

beforeEach(async () => {
  await truncateAllTables();
  __resetImageStoreForTest();
  providerMocks.generateStudioImage.mockClear();
  await seedStudioTasks();
});

describe("image studio worker permission", () => {
  it("exposes only the task-bound AI transform", () => {
    expect(imageStudioRouter._def.procedures).toHaveProperty("aiStudioTransform");
    expect(imageStudioRouter._def.procedures).not.toHaveProperty("proCutout");
  });

  it("blocks a user without productStudio FULL before calling the provider", async () => {
    await expect(caller("cashier").aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
  });

  it("requires taskId for a worker before calling AI", async () => {
    const worker = caller("print_operator");
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
  });

  it("blocks a task owner until the server has confirmed its barcode scan", async () => {
    await expect(caller("print_operator").aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 923 }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("مسح باركود") });
    expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
  });

  it.each([
    [921, "FORBIDDEN"],
    [922, "FORBIDDEN"],
  ] as const)("rejects an unowned/foreign task before calling AI", async (taskId, code) => {
    const worker = caller("print_operator");
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId }))
      .rejects.toMatchObject({ code });
    expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
  });

  it("allows AI for the task owner and returns a task-bound receipt", async () => {
    const worker = caller("print_operator");
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 }))
      .resolves.toMatchObject({ processingReceipt: expect.any(String) });
    expect(providerMocks.generateStudioImage).toHaveBeenCalledTimes(1);
  });

  // ⭐ جذر بلاغ المالك (٢٤/٨): NO_IMAGE/BLOCKED كانا يظهران للمستخدم كرسالةٍ عامّة «جرّب مجدّداً» بلا
  // معرفة السبب. بعد إصلاح التقاط تشخيص المزوّد يجب أن تُلحق الرسالة العربية بنصّ الرفض / finishReason
  // كي يعرف المالك ما جرى (نموذج خاطئ؟ رفض ضمنيّ؟). حارسٌ منع الرجعة إلى العمى.
  it.each([
    { kind: "NO_IMAGE" as const, detail: "finishReason=STOP · نصّ المزوّد: \"I cannot edit\"", code: "BAD_REQUEST" },
    { kind: "BLOCKED" as const, detail: "blockReason=SAFETY", code: "BAD_REQUEST" },
  ])("AI provider $kind ⇒ يُلحق تفصيل المزوّد بالرسالة العربية للمستخدم", async ({ kind, detail, code }) => {
    const { AiImageError } = await import("../../services/aiImageStudioService");
    providerMocks.generateStudioImage.mockImplementationOnce(async () => {
      throw new AiImageError(kind, 200, detail);
    });
    const worker = caller("print_operator");
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 })).rejects.toMatchObject({
      code,
      message: expect.stringContaining(detail),
    });
  });

  // AUTH/QUOTA لا يجب أن تُسرّب تفاصيل الشبكة/المفتاح — الرسالة العامّة تكفي.
  it.each([
    { kind: "AUTH" as const, code: "PRECONDITION_FAILED", secret: "api key sk-abcd1234" },
    { kind: "QUOTA" as const, code: "PRECONDITION_FAILED", secret: "Bearer 4kJk9-secret-token" },
    { kind: "SERVICE" as const, code: "INTERNAL_SERVER_ERROR", secret: "internal stack trace at /home/deploy" },
  ])("AI provider $kind ⇒ لا يُسرّب تفصيل المزوّد (رسالة عامّة فقط)", async ({ kind, code, secret }) => {
    const { AiImageError } = await import("../../services/aiImageStudioService");
    providerMocks.generateStudioImage.mockImplementationOnce(async () => {
      throw new AiImageError(kind, 500, secret);
    });
    const worker = caller("print_operator");
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 })).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining(secret),
    });
  });

  it("requires a task for managers and confines processing to their own assignment", async () => {
    const managerCaller = caller("manager", undefined, { id: 95 });
    await expect(managerCaller.aiStudioTransform({ imageDataUrl: PNG_1X1 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(managerCaller.aiStudioTransform({
      imageDataUrl: PNG_1X1,
      taskId: 921,
      adminOverrideReason: "محاولة غير مسموحة للمدير",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(managerCaller.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 923 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
  });

  it("preserves a manager's authority for their own task only", async () => {
    const manager = caller("manager", undefined, { id: 95 });
    await expect(manager.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920, adminOverrideReason: "محاولة غير مسموحة للمدير" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(manager.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 924 })).resolves.toMatchObject({ processingReceipt: expect.any(String) });
  });

  it("serializes provider use per task before consuming a second quota", async () => {
    let releaseProvider!: () => void;
    const blockedProvider = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerReached!: () => void;
    const reachedProvider = new Promise<void>((resolve) => { providerReached = resolve; });
    providerMocks.generateStudioImage.mockImplementationOnce(async () => {
      providerReached();
      await blockedProvider;
      return { imageBase64: "QUJD", mimeType: "image/png" };
    });
    const worker = caller("print_operator");
    const first = worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 });
    await reachedProvider;
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    releaseProvider();
    await expect(first).resolves.toMatchObject({ processingReceipt: expect.any(String) });
    expect(providerMocks.generateStudioImage).toHaveBeenCalledTimes(1);
  });

  it("releases the processing lease when the provider fails so retry can proceed", async () => {
    providerMocks.generateStudioImage.mockRejectedValueOnce(new Error("provider unavailable"));
    const worker = caller("print_operator");
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 }))
      .rejects.toThrow("provider unavailable");
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 }))
      .resolves.toMatchObject({ processingReceipt: expect.any(String) });
    expect(providerMocks.generateStudioImage).toHaveBeenCalledTimes(2);
  });

  it("fails before provider use when the private image store is unavailable", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDriver = process.env.IMAGE_STORE_DRIVER;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.IMAGE_STORE_DRIVER;
      __resetImageStoreForTest();
      const worker = caller("print_operator");
      await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, taskId: 920 }))
        .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDriver === undefined) delete process.env.IMAGE_STORE_DRIVER;
      else process.env.IMAGE_STORE_DRIVER = previousDriver;
      __resetImageStoreForTest();
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest } from "../../lib/imageStore";
import { truncateAllTables } from "../../services/__tests__/__testUtils__";

const providerMocks = vi.hoisted(() => ({
  callRemovebg: vi.fn(async () => ({ cutout: Buffer.from("cutout"), creditsCharged: 1, isPreview: false })),
}));

vi.mock("../../services/imageStudioSettingsService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/imageStudioSettingsService")>(),
  getDecryptedRemovebgKey: vi.fn(async () => "qa-removebg-key"),
}));

vi.mock("../../services/removebgService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/removebgService")>(),
  callRemovebg: providerMocks.callRemovebg,
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
    { id: 924, productId: 924, branchId: 1, assignedTo: 95, createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
  ]);
}

beforeEach(async () => {
  await truncateAllTables();
  providerMocks.callRemovebg.mockClear();
  __resetImageStoreForTest();
  await seedStudioTasks();
});

describe("image studio worker permission", () => {
  it("does not expose a generative image route", () => {
    expect(imageStudioRouter._def.procedures).not.toHaveProperty("aiStudioTransform");
  });

  it("blocks a user without productStudio FULL before calling the provider", async () => {
    await expect(caller("cashier").proCutout({ imageDataUrl: PNG_1X1, taskId: 920 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(providerMocks.callRemovebg).not.toHaveBeenCalled();
  });

  it("requires a task id before calling the provider", async () => {
    await expect(caller("print_operator").proCutout({ imageDataUrl: PNG_1X1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(providerMocks.callRemovebg).not.toHaveBeenCalled();
  });

  it("blocks a task owner until the server has confirmed its barcode scan", async () => {
    await expect(caller("print_operator").proCutout({ imageDataUrl: PNG_1X1, taskId: 923 })).rejects.toMatchObject({
      code: "FORBIDDEN", message: expect.stringContaining("مسح باركود"),
    });
    expect(providerMocks.callRemovebg).not.toHaveBeenCalled();
  });

  it("allows only the verified owner to process the exact task", async () => {
    await expect(caller("print_operator").proCutout({ imageDataUrl: PNG_1X1, taskId: 920 })).resolves.toMatchObject({ processingReceipt: expect.any(String) });
    await expect(caller("print_operator").proCutout({ imageDataUrl: PNG_1X1, taskId: 921 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("print_operator").proCutout({ imageDataUrl: PNG_1X1, taskId: 922 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(providerMocks.callRemovebg).toHaveBeenCalledTimes(1);
  });

  it("preserves a manager's authority for their own task only", async () => {
    const manager = caller("manager", undefined, { id: 95 });
    await expect(manager.proCutout({ imageDataUrl: PNG_1X1, taskId: 920, adminOverrideReason: "محاولة غير مسموحة للمدير" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(manager.proCutout({ imageDataUrl: PNG_1X1, taskId: 924 })).resolves.toMatchObject({ processingReceipt: expect.any(String) });
  });

  it("serializes provider use per task before consuming a second quota", async () => {
    let releaseProvider!: () => void;
    const blockedProvider = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerReached!: () => void;
    const reachedProvider = new Promise<void>((resolve) => { providerReached = resolve; });
    providerMocks.callRemovebg.mockImplementationOnce(async () => {
      providerReached(); await blockedProvider;
      return { cutout: Buffer.from("cutout"), creditsCharged: 1, isPreview: false };
    });
    const worker = caller("print_operator");
    const first = worker.proCutout({ imageDataUrl: PNG_1X1, taskId: 920 });
    await reachedProvider;
    await expect(worker.proCutout({ imageDataUrl: PNG_1X1, taskId: 920 })).rejects.toMatchObject({ code: "CONFLICT" });
    releaseProvider();
    await expect(first).resolves.toMatchObject({ processingReceipt: expect.any(String) });
  });

  it("releases a failed processing lease so the same scan-confirmed task can retry", async () => {
    providerMocks.callRemovebg.mockRejectedValueOnce(new Error("provider unavailable"));
    const worker = caller("print_operator");
    await expect(worker.proCutout({ imageDataUrl: PNG_1X1, taskId: 920 })).rejects.toThrow("provider unavailable");
    await expect(worker.proCutout({ imageDataUrl: PNG_1X1, taskId: 920 })).resolves.toMatchObject({ processingReceipt: expect.any(String) });
    expect(providerMocks.callRemovebg).toHaveBeenCalledTimes(2);
  });

  it("fails before provider use when the private image store is unavailable", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDriver = process.env.IMAGE_STORE_DRIVER;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.IMAGE_STORE_DRIVER;
      __resetImageStoreForTest();
      await expect(caller("print_operator").proCutout({ imageDataUrl: PNG_1X1, taskId: 920 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(providerMocks.callRemovebg).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDriver === undefined) delete process.env.IMAGE_STORE_DRIVER;
      else process.env.IMAGE_STORE_DRIVER = previousDriver;
      __resetImageStoreForTest();
    }
  });
});

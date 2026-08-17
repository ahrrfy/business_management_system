import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";

const providerMocks = vi.hoisted(() => ({
  callRemovebg: vi.fn(async () => ({ cutout: Buffer.from("cutout"), creditsCharged: 1, isPreview: false })),
  generateStudioImage: vi.fn(async () => ({ imageBase64: "QUJD", mimeType: "image/png" })),
}));

vi.mock("../../services/imageStudioSettingsService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/imageStudioSettingsService")>(),
  getDecryptedRemovebgKey: vi.fn(async () => "qa-removebg-key"),
  getAiStudioRuntime: vi.fn(async () => ({
    apiKey: "qa-ai-key",
    provider: "GEMINI",
    model: "qa-model",
    basePrompt: "خلفية بيضاء",
  })),
}));

vi.mock("../../services/removebgService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/removebgService")>(),
  callRemovebg: providerMocks.callRemovebg,
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

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

function caller(
  role: string,
  productStudio?: "FULL" | "READ" | "NONE",
  options: { id?: number; branchId?: number | null } = {},
) {
  return imageStudioRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: options.id ?? 92,
      role,
      branchId: options.branchId === undefined ? 1 : options.branchId,
      permissionsOverride: productStudio ? { productStudio } : null,
      totpEnabledAt: new Date(),
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
    { id: 920, name: "منتج مهمة المالك" },
    { id: 921, name: "منتج مهمة موظف آخر" },
    { id: 922, name: "منتج مهمة فرع آخر" },
  ]);
  await db().insert(s.productImageJobs).values([
    { id: 920, productId: 920, branchId: 1, assignedTo: 92, createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
    { id: 921, productId: 921, branchId: 1, assignedTo: 93, createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
    { id: 922, productId: 922, branchId: 2, assignedTo: 94, createdBy: 95, mode: "FLATTEN", status: "ASSIGNED", activeSlot: 1 },
  ]);
}

beforeEach(async () => {
  providerMocks.callRemovebg.mockClear();
  providerMocks.generateStudioImage.mockClear();
  await seedStudioTasks();
});

describe("image studio worker permission", () => {
  it("blocks a user without productStudio FULL before calling the provider", async () => {
    await expect(caller("cashier").proCutout({ imageDataUrl: PNG_1X1, taskId: 920 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(providerMocks.callRemovebg).not.toHaveBeenCalled();
  });

  it.each([
    ["remove.bg", "proCutout"],
    ["AI", "aiStudioTransform"],
  ] as const)("requires taskId for a worker before calling %s", async (_label, procedure) => {
    const worker = caller("print_operator");
    const request = procedure === "proCutout"
      ? worker.proCutout({ imageDataUrl: PNG_1X1 })
      : worker.aiStudioTransform({ imageDataUrl: PNG_1X1, mode: "EDIT" });

    await expect(request).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(providerMocks.callRemovebg).not.toHaveBeenCalled();
    expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
  });

  it.each([
    ["remove.bg", "proCutout", 921, "FORBIDDEN"],
    ["remove.bg", "proCutout", 922, "FORBIDDEN"],
    ["AI", "aiStudioTransform", 921, "FORBIDDEN"],
    ["AI", "aiStudioTransform", 922, "FORBIDDEN"],
  ] as const)("rejects an unowned/foreign task before calling %s", async (_label, procedure, taskId, code) => {
    const worker = caller("print_operator");
    const request = procedure === "proCutout"
      ? worker.proCutout({ imageDataUrl: PNG_1X1, taskId })
      : worker.aiStudioTransform({ imageDataUrl: PNG_1X1, mode: "EDIT", taskId });

    await expect(request).rejects.toMatchObject({ code });
    expect(providerMocks.callRemovebg).not.toHaveBeenCalled();
    expect(providerMocks.generateStudioImage).not.toHaveBeenCalled();
  });

  it("allows both providers for the task owner and returns task-bound receipts", async () => {
    const worker = caller("print_operator");
    await expect(worker.proCutout({ imageDataUrl: PNG_1X1, taskId: 920 }))
      .resolves.toMatchObject({ processingReceipt: expect.any(String) });
    await expect(worker.aiStudioTransform({ imageDataUrl: PNG_1X1, mode: "EDIT", taskId: 920 }))
      .resolves.toMatchObject({ processingReceipt: expect.any(String) });
    expect(providerMocks.callRemovebg).toHaveBeenCalledTimes(1);
    expect(providerMocks.generateStudioImage).toHaveBeenCalledTimes(1);
  });

  it("keeps manager self-service available without a delegated task", async () => {
    await expect(caller("manager", undefined, { id: 95 }).proCutout({ imageDataUrl: PNG_1X1 }))
      .resolves.toMatchObject({ cutoutDataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(providerMocks.callRemovebg).toHaveBeenCalledTimes(1);
  });
});

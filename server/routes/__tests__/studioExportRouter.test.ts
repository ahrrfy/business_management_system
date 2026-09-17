import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserFromRequest: vi.fn(),
  normalizeOwnerAuthority: vi.fn(),
  resolveCustomRole: vi.fn(),
  hasModuleAccess: vi.fn(),
  twoFactorEnrollmentRequired: vi.fn(),
  streamStudioImageExport: vi.fn(),
}));

vi.mock("../../auth/session", () => ({
  getUserFromRequest: mocks.getUserFromRequest,
}));
vi.mock("../../context", () => ({
  normalizeOwnerAuthority: mocks.normalizeOwnerAuthority,
  resolveCustomRole: mocks.resolveCustomRole,
}));
vi.mock("../../../shared/permissions", () => ({
  hasModuleAccess: mocks.hasModuleAccess,
}));
vi.mock("../../trpc", () => ({
  twoFactorEnrollmentRequired: mocks.twoFactorEnrollmentRequired,
}));
vi.mock("../../logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../../services/productStudioImageExport", () => ({
  streamStudioImageExport: mocks.streamStudioImageExport,
}));

import { studioExportRouter } from "../studioExportRouter";

async function withStudioExportServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use("/api/studio", studioExportRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("studio image export route", () => {
  beforeEach(() => {
    mocks.getUserFromRequest.mockResolvedValue({
      id: 7,
      branchId: 1,
      role: "manager",
      isOwner: false,
      permissionsOverride: null,
    });
    mocks.resolveCustomRole.mockResolvedValue(undefined);
    mocks.hasModuleAccess.mockReturnValue(true);
    mocks.twoFactorEnrollmentRequired.mockReturnValue(false);
    mocks.streamStudioImageExport.mockImplementation(
      async (_actor, _scope, res) => {
        res.status(200).type("application/zip").end("zip");
      },
    );
  });

  afterEach(() => vi.clearAllMocks());

  it("يرفض الاستعلام المسبق بلا جلسة ولا يبدأ بناء الأرشيف", async () => {
    mocks.getUserFromRequest.mockResolvedValueOnce(null);
    await withStudioExportServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/studio/export.zip?scope=ALL&preflight=1`,
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "مصادقةٌ مطلوبة",
      });
    });
    expect(mocks.streamStudioImageExport).not.toHaveBeenCalled();
  });

  it("يفحص الجلسة والنطاق بخفة ثم يترك التنزيل الحقيقي لمسار البث", async () => {
    await withStudioExportServer(async (baseUrl) => {
      const preflight = await fetch(
        `${baseUrl}/api/studio/export.zip?scope=PRODUCTS&productIds=1,2&preflight=1`,
      );
      expect(preflight.status).toBe(200);
      await expect(preflight.json()).resolves.toEqual({ ok: true });
      expect(mocks.streamStudioImageExport).not.toHaveBeenCalled();

      const download = await fetch(
        `${baseUrl}/api/studio/export.zip?scope=PRODUCTS&productIds=1,2`,
      );
      expect(download.status).toBe(200);
      await expect(download.text()).resolves.toBe("zip");
    });
    expect(mocks.streamStudioImageExport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, branchId: 1, role: "manager" }),
      { kind: "PRODUCTS", productIds: [1, 2] },
      expect.anything(),
    );
  });

  it("يرفض نطاقاً غير صالح قبل بناء الأرشيف", async () => {
    await withStudioExportServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/studio/export.zip?scope=PRODUCTS&productIds=`,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "productIds (CSV) مطلوبة لنطاق PRODUCTS",
      });
    });
    expect(mocks.streamStudioImageExport).not.toHaveBeenCalled();
  });

  it("تستخدم الواجهة preflight مع الكوكي ثم تنزيل المتصفح الأصيل بلا Blob", async () => {
    const source = await readFile(
      "client/src/components/product-studio/StudioImageExportPanel.tsx",
      "utf8",
    );
    expect(source).toContain('fetch(preflightUrl, { credentials: "include" })');
    expect(source).toContain("window.location.assign(downloadUrl)");
    expect(source).not.toContain("await check.blob(");
    expect(source).not.toContain("new Blob(");
  });
});

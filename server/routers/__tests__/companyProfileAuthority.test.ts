import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateCompanyProfile: vi.fn(async (input: any, actor: any) => ({
    id: 1,
    name: input.name,
    tradeName: input.tradeName ?? null,
    shortName: input.shortName ?? null,
    legalSubtitle: input.legalSubtitle ?? null,
    commercialRegistry: input.commercialRegistry ?? null,
    taxNumber: input.taxNumber ?? null,
    chamberLicense: input.chamberLicense ?? null,
    address: input.address ?? null,
    phones: input.phones ?? [],
    logoUrl: input.logoUrl ?? null,
    footerText: input.footerText ?? null,
    updatedBy: actor.userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  getCompanyProfile: vi.fn(async () => ({
    id: 1,
    name: "شركة الرؤية التجريبية",
    tradeName: "رؤية",
    shortName: "رؤية",
    legalSubtitle: null,
    commercialRegistry: "CR-12345",
    taxNumber: "TX-67890",
    chamberLicense: null,
    address: "بغداد",
    phones: [{ label: "المبيعات", number: "+9647701234567" }],
    logoUrl: null,
    footerText: null,
    updatedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("../../services/companyProfileService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/companyProfileService")>()),
  updateCompanyProfile: mocks.updateCompanyProfile,
  getCompanyProfile: mocks.getCompanyProfile,
}));

vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  logAudit: mocks.logAudit,
}));

import { systemRouter } from "../systemRouter";

function caller(user: { id: number; role: string; branchId: number | null } | null) {
  return systemRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: user ? "test-session" : null,
    platformAdmin: null,
    user: user ? { ...user, totpEnabledAt: new Date() } : null,
  } as never);
}

describe("systemRouter.companyProfile — بوّابات الصلاحية والتحقّق لهوية المنشأة", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getCompanyProfile: متاح لأي مستخدم مُصادَق (كاشير، مدير، أدمن)", async () => {
    const cashier = caller({ id: 10, role: "cashier", branchId: 2 });
    const profile = await cashier.getCompanyProfile();
    expect(profile.name).toBe("شركة الرؤية التجريبية");
    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
  });

  it("getCompanyProfile: يُرفض للزائر غير المسجل", async () => {
    const anonymous = caller(null);
    await expect(anonymous.getCompanyProfile()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.getCompanyProfile).not.toHaveBeenCalled();
  });

  it("updateCompanyProfile: يُرفض للكاشير والمحاسب ومدير الفرع (adminProcedure حصراً)", async () => {
    const manager = caller({ id: 5, role: "manager", branchId: 1 });
    await expect(
      manager.updateCompanyProfile({ name: "اسم جديد" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateCompanyProfile).not.toHaveBeenCalled();

    const cashier = caller({ id: 8, role: "cashier", branchId: 1 });
    await expect(
      cashier.updateCompanyProfile({ name: "اسم جديد" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateCompanyProfile).not.toHaveBeenCalled();
  });

  it("updateCompanyProfile: يسمح لمدير المنشأة (admin) بتعديل الهوية ويدقّق العملية", async () => {
    const admin = caller({ id: 1, role: "admin", branchId: null });
    const res = await admin.updateCompanyProfile({
      name: "شركة الرؤية المحدودة",
      tradeName: "الرؤية",
      taxNumber: "TX-9999",
    });

    expect(res.ok).toBe(true);
    expect(res.profile.name).toBe("شركة الرؤية المحدودة");
    expect(mocks.updateCompanyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "شركة الرؤية المحدودة", tradeName: "الرؤية", taxNumber: "TX-9999" }),
      { userId: 1 },
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "system.companyProfile.update" }),
    );
  });

  it("updateCompanyProfile: يرفض الاسم الفارغ عند حدود المخطط Zod", async () => {
    const admin = caller({ id: 1, role: "admin", branchId: null });
    await expect(
      admin.updateCompanyProfile({ name: "" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.updateCompanyProfile).not.toHaveBeenCalled();
  });

  it("updateCompanyProfile: يقبل تمرير قائمة هواتف فارغة ويحيلها للخدمة", async () => {
    const admin = caller({ id: 1, role: "admin", branchId: null });
    const res = await admin.updateCompanyProfile({
      name: "شركة النهرين",
      phones: [],
    });

    expect(res.ok).toBe(true);
    expect(mocks.updateCompanyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "شركة النهرين", phones: [] }),
      { userId: 1 },
    );
  });
});

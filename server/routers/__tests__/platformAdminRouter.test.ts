/**
 * اختبارات وحدة وتحكّم platformAdminRouter:
 * - فحص حدود المدخلات Zod (أرقام المعرفات السالبة، الصفر، الكسور العشرية).
 * - تفويض مدير المنصة (platformAdminProcedure) ورفض الطلبات غير المصادقة.
 * - تعذّر الوصول لقاعدة بيانات تحكم المنصة (getControlDb() === null).
 * - فحص شركة غير مسجّلة أو محذوفة (NOT_FOUND).
 * - التقاط أخطاء اتصال قاعدة بيانات الشركة المستأجرة المعزولة (unreachable).
 * - سلامة تقرير الفحص والقياسات الحية عند اتصال قاعدة بيانات الشركة بنجاح (healthy).
 * - إجراء تفعيل/تعطيل الشركة وتدقيق العمليات (setActive).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mockCompanies = [
  {
    id: 1,
    code: "co_alroya",
    name: "شركة الرؤية للتجارة والطباعة",
    dbHost: "127.0.0.1",
    dbPort: 3306,
    dbName: "erp_co_alroya",
    dbUser: "erp_co_alroya_user",
    isActive: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    id: 2,
    code: "co_nahrain",
    name: "شركة النهرين للقرطاسية",
    dbHost: "10.0.0.5",
    dbPort: 3306,
    dbName: "erp_co_nahrain",
    dbUser: "erp_co_nahrain_user",
    isActive: 0,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
  },
];

let controlDbAvailable = true;
let tenantDbThrowError: Error | null = null;
let tenantUserCount = 15;
let tenantBranchCount = 2;

const mockControlDb: any = {
  select: () => ({
    from: (_table: any) => ({
      where: (cond: any) => ({
        limit: (_n: number) => {
          if (!controlDbAvailable) return Promise.resolve([]);
          // استخراج id من شرط المطابقة البسيط
          const companyId = cond?.val ?? cond?.right ?? cond?.value;
          const found = mockCompanies.filter((c) => (companyId ? c.id === companyId : true));
          return Promise.resolve(found);
        },
      }),
    }),
  }),
};

vi.mock("../../tenancy/controlDb", () => ({
  getControlDb: () => (controlDbAvailable ? mockControlDb : null),
}));

import { branches, users } from "../../../drizzle/schema";

vi.mock("../../db", () => ({
  withTenantDb: vi.fn(async (companyId: number, fn: (db: any) => Promise<any>) => {
    if (tenantDbThrowError) {
      throw tenantDbThrowError;
    }
    const fakeTenantDb = {
      select: (_fields: any) => ({
        from: (table: any) => {
          if (table === branches) {
            return Promise.resolve([{ count: tenantBranchCount }]);
          }
          return Promise.resolve([{ count: tenantUserCount }]);
        },
      }),
    };
    return fn(fakeTenantDb);
  }),
}));

const mockAuditLogs: any[] = [];
vi.mock("../../tenancy/platformAudit", () => ({
  logPlatformAudit: vi.fn(async (_ctx: any, entry: any) => {
    mockAuditLogs.push(entry);
  }),
  listPlatformAudit: vi.fn(async () => ({ items: [], total: 0 })),
}));

const mockSetCompanyActive = vi.fn(async (_id: number, _isActive: boolean) => undefined);
vi.mock("../../tenancy/registry", () => ({
  listCompanies: vi.fn(async () => mockCompanies),
  setCompanyActive: (id: number, active: boolean) => mockSetCompanyActive(id, active),
}));

vi.mock("../../tenancy/provisionRequests", () => ({
  createProvisionRequest: vi.fn(async () => ({ id: 10, tempPassword: "Temp@Password123" })),
  getProvisionRequestStatus: vi.fn(async (id: number) => ({ id, status: "completed" })),
  listRecentProvisionRequests: vi.fn(async () => []),
}));

vi.mock("../../tenancy/platformAuth", () => ({
  signPlatformSession: vi.fn(async () => "mock-platform-jwt-token"),
}));

vi.mock("../../tenancy/platformAdminService", () => ({
  verifyPlatformAdminCredentials: vi.fn(async (email: string) => {
    if (email === "admin@platform.local") {
      return { id: 1, email, name: "مدير المنصة" };
    }
    return null;
  }),
}));

import { platformAdminRouter } from "../platformAdminRouter";

function createCaller(platformAdmin: { id: number; email: string; name: string } | null) {
  return platformAdminRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
    platformAdmin,
    user: null,
    sessionId: null,
  } as never);
}

describe("platformAdminRouter — إدارة وفحص الشركات على مستوى المنصة", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controlDbAvailable = true;
    tenantDbThrowError = null;
    tenantUserCount = 15;
    tenantBranchCount = 2;
    mockAuditLogs.length = 0;
  });

  describe("بوابة التفويض والصلاحيات (platformAdminProcedure)", () => {
    it("يرفض استدعاء inspect للزائر غير المصرّح له (UNAUTHORIZED)", async () => {
      const unauthCaller = createCaller(null);
      await expect(unauthCaller.companies.inspect({ id: 1 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("يرفض استدعاء setActive للزائر غير المصرّح له (UNAUTHORIZED)", async () => {
      const unauthCaller = createCaller(null);
      await expect(unauthCaller.companies.setActive({ id: 1, isActive: false })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("فحص حدود المدخلات Zod لمعرّفات الشركات (id)", () => {
    const adminCaller = createCaller({ id: 1, email: "super@platform.local", name: "Super Admin" });

    it("يرفض المعرّف السالب (-1) بخطأ BAD_REQUEST", async () => {
      await expect(adminCaller.companies.inspect({ id: -1 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("يرفض المعرّف السالب الكبير (-9999) بخطأ BAD_REQUEST", async () => {
      await expect(adminCaller.companies.inspect({ id: -9999 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("يرفض الصفر (0) بخطأ BAD_REQUEST (يجب أن يكون المعرّف موجباً قطعيّاً)", async () => {
      await expect(adminCaller.companies.inspect({ id: 0 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("يرفض الأرقام العشرية غير الصحيحة (1.5) بخطأ BAD_REQUEST", async () => {
      await expect(adminCaller.companies.inspect({ id: 1.5 as any })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("يرفض السلاسل النصية ('abc') بخطأ BAD_REQUEST", async () => {
      await expect(adminCaller.companies.inspect({ id: "abc" as any })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("يرفض معرّف سالب في setActive", async () => {
      await expect(adminCaller.companies.setActive({ id: -5, isActive: true })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  describe("صلابة معالجة الأخطاء وحالات عدم التوفّر (Resilience & Error Capture)", () => {
    const adminCaller = createCaller({ id: 1, email: "super@platform.local", name: "Super Admin" });

    it("يُلقي NOT_FOUND برسالة واضحة عند تعذّر الوصول لقاعدة تحكّم المنصّة (getControlDb === null)", async () => {
      controlDbAvailable = false;
      await expect(adminCaller.companies.inspect({ id: 1 })).rejects.toThrowError(
        /قاعدة بيانات المنصة غير متصلة أو وضع تعدد الشركات غير مفعل/,
      );
    });

    it("يُلقي NOT_FOUND برقم الشركة عند طلب فحص شركة غير موجودة في قاعدة التحكم", async () => {
      // محاكاة إرجاع مصفوفة فارغة لشركة برقم غير مسجل
      const origSelect = mockControlDb.select;
      mockControlDb.select = () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      });

      try {
        await expect(adminCaller.companies.inspect({ id: 999 })).rejects.toThrowError(
          /الشركة رقم 999 غير مسجّلة في سجل تحكّم المنصّة أو تم حذفها/,
        );
      } finally {
        mockControlDb.select = origSelect;
      }
    });

    it("يلتقط تعذّر اتصال قاعدة بيانات المستأجر المعزولة ويعيد تقريراً بحالة unreachable دون إسقاط الخادم", async () => {
      tenantDbThrowError = new Error("connect ECONNREFUSED 10.0.0.5:3306 — Database container is offline");

      const report = await adminCaller.companies.inspect({ id: 1 });

      expect(report.company.id).toBe(1);
      expect(report.company.name).toBe("شركة الرؤية للتجارة والطباعة");
      expect(report.metrics.status).toBe("unreachable");
      expect(report.metrics.userCount).toBe(0);
      expect(report.metrics.branchCount).toBe(0);
      expect(report.metrics.error).toContain("ECONNREFUSED 10.0.0.5:3306");
      expect(report.databaseStatus).toBe("ERROR");
      expect(report.databaseError).toContain("ECONNREFUSED 10.0.0.5:3306");
    });

    it("يلتقط تعذّر الاتصال الناتج عن انتهاء المهلة (ETIMEDOUT) بأمان", async () => {
      tenantDbThrowError = new Error("ETIMEDOUT connection timed out");

      const report = await adminCaller.companies.inspect({ id: 1 });

      expect(report.metrics.status).toBe("unreachable");
      expect(report.metrics.error).toContain("ETIMEDOUT");
      expect(report.databaseStatus).toBe("ERROR");
    });
  });

  describe("تقرير الفحص عند اتصال قاعدة المستأجر بنجاح (Healthy)", () => {
    const adminCaller = createCaller({ id: 1, email: "super@platform.local", name: "Super Admin" });

    it("يعيد القياسات الحية للمستخدمين والفروع بحالة healthy", async () => {
      tenantUserCount = 28;
      tenantBranchCount = 4;

      const report = await adminCaller.companies.inspect({ id: 1 });

      expect(report.company.id).toBe(1);
      expect(report.company.code).toBe("co_alroya");
      expect(report.company.dbName).toBe("erp_co_alroya");
      expect(report.company.isActive).toBe(true);
      expect(report.metrics.status).toBe("healthy");
      expect(report.metrics.userCount).toBe(28);
      expect(report.metrics.branchCount).toBe(4);
      expect(report.metrics.error).toBeUndefined();
      expect(report.databaseStatus).toBe("CONNECTED");
      expect(report.databaseError).toBeNull();
    });
  });

  describe("إجراء تفعيل/تعطيل الشركة (setActive) وتدقيقها", () => {
    const adminCaller = createCaller({ id: 5, email: "ops@platform.local", name: "Operations Admin" });

    it("يغيّر حالة النشاط ويسجّل سجلّ التدقيق بنجاح", async () => {
      const res = await adminCaller.companies.setActive({ id: 1, isActive: false });
      expect(res.success).toBe(true);
      expect(mockSetCompanyActive).toHaveBeenCalledWith(1, false);

      expect(mockAuditLogs).toContainEqual(
        expect.objectContaining({
          action: "company.setActive",
          companyId: 1,
          success: true,
          platformAdminId: 5,
          actorEmail: "ops@platform.local",
          details: { isActive: false },
        }),
      );
    });

    it("يسجّل فشل العملية في التدقيق ويعيد رمي الخطأ عند فشل خدمة التبديل", async () => {
      mockSetCompanyActive.mockRejectedValueOnce(new Error("Database deadlock during status change"));

      await expect(adminCaller.companies.setActive({ id: 2, isActive: true })).rejects.toThrow(
        "Database deadlock during status change",
      );

      expect(mockAuditLogs).toContainEqual(
        expect.objectContaining({
          action: "company.setActive",
          companyId: 2,
          success: false,
          platformAdminId: 5,
          actorEmail: "ops@platform.local",
        }),
      );
    });
  });
});

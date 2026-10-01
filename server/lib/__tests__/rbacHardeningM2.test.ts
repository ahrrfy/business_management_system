import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { resolveActorBranchId, canCrossBranches } from "../branchAuthority";
import { PERM_OVERRIDE } from "../../routers/userRouter";
import {
  isLegacySessionAllowed,
  validateUserForSession,
  isSessionRevokedByTimestamp,
} from "../../auth/session";

describe("Milestone 2 RBAC Hardening: canCrossBranches Authority Matrix", () => {
  it("يمنح سلطة عبور الفروع للأدمن والمالك فقط ويحجبها عن الأدوار الأخرى", () => {
    expect(canCrossBranches({ role: "admin", isOwner: false })).toBe(true);
    expect(canCrossBranches({ role: "manager", isOwner: true })).toBe(true);
    expect(canCrossBranches({ role: "admin", isOwner: true })).toBe(true);

    expect(canCrossBranches({ role: "manager", isOwner: false })).toBe(false);
    expect(canCrossBranches({ role: "cashier", isOwner: false })).toBe(false);
    expect(canCrossBranches({ role: "warehouse", isOwner: false })).toBe(false);
    expect(canCrossBranches({ role: "accountant", isOwner: false })).toBe(false);
    expect(canCrossBranches({ role: "user", isOwner: false })).toBe(false);
    expect(canCrossBranches(null)).toBe(false);
    expect(canCrossBranches(undefined)).toBe(false);
  });
});

describe("Milestone 2 RBAC Hardening: VULN-RBAC-02 (Default Branch Elimination & Precedence)", () => {
  it("Admin مع branchId = 1 ويمرر inputBranchId = 2 يُحَل بنجاح إلى 2 (أولوية اختيار الأدمن)", () => {
    const adminWithHomeBranch = {
      user: {
        role: "admin",
        isOwner: false,
        branchId: 1,
      },
    };
    expect(resolveActorBranchId(adminWithHomeBranch, 2)).toBe(2);
  });

  it("Admin مع branchId = 1 دون تمرير inputBranchId يسقط بأمان على فرعه المسند 1", () => {
    const adminWithHomeBranch = {
      user: {
        role: "admin",
        isOwner: false,
        branchId: 1,
      },
    };
    expect(resolveActorBranchId(adminWithHomeBranch)).toBe(1);
    expect(resolveActorBranchId(adminWithHomeBranch, null)).toBe(1);
    expect(resolveActorBranchId(adminWithHomeBranch, undefined)).toBe(1);
  });

  it("Admin مع branchId = null عند غياب inputBranchId يرمي BAD_REQUEST لإلزامه بتحديد الفرع", () => {
    const adminNoBranch = {
      user: {
        role: "admin",
        isOwner: false,
        branchId: null,
      },
    };
    expect(() => resolveActorBranchId(adminNoBranch)).toThrowError(TRPCError);
    expect(() => resolveActorBranchId(adminNoBranch, null)).toThrowError(TRPCError);
    expect(() => resolveActorBranchId(adminNoBranch, undefined)).toThrowError(TRPCError);

    try {
      resolveActorBranchId(adminNoBranch);
    } catch (err: any) {
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("يجب تحديد الفرع (branchId)");
    }
  });

  it("Admin يمرر inputBranchId غير موجب (0 أو سالب) يرمي BAD_REQUEST لعدم صلاحية المعرف", () => {
    const adminWithHomeBranch = {
      user: {
        role: "admin",
        isOwner: false,
        branchId: 1,
      },
    };
    const adminNoBranch = {
      user: {
        role: "admin",
        isOwner: false,
        branchId: null,
      },
    };

    expect(() => resolveActorBranchId(adminWithHomeBranch, 0)).toThrowError(TRPCError);
    expect(() => resolveActorBranchId(adminWithHomeBranch, -1)).toThrowError(TRPCError);
    expect(() => resolveActorBranchId(adminNoBranch, 0)).toThrowError(TRPCError);
    expect(() => resolveActorBranchId(adminNoBranch, -5)).toThrowError(TRPCError);

    try {
      resolveActorBranchId(adminWithHomeBranch, 0);
    } catch (err: any) {
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("معرف الفرع غير صالح");
    }
  });

  it("Owner عابر للفروع مع branchId = 1 ويمرر inputBranchId = 4 يُحَل بنجاح إلى 4", () => {
    const ownerCtx = {
      user: {
        role: "manager",
        isOwner: true,
        branchId: 1,
      },
    };
    expect(resolveActorBranchId(ownerCtx, 4)).toBe(4);
    expect(resolveActorBranchId(ownerCtx)).toBe(1);
    expect(resolveActorBranchId(ownerCtx, null)).toBe(1);
  });

  it("يقبل inputBranchId للمستخدم الإداري/المالك عند غياب الفرع المسند", () => {
    const adminNoBranch = {
      user: {
        role: "admin",
        isOwner: false,
        branchId: null,
      },
    };
    expect(resolveActorBranchId(adminNoBranch, 4)).toBe(4);

    const ownerNoBranch = {
      user: {
        role: "manager",
        isOwner: true,
        branchId: null,
      },
    };
    expect(resolveActorBranchId(ownerNoBranch, 7)).toBe(7);
  });

  it("مستخدم عادي مع branchId = 3 ويمرر inputBranchId = 5 يُحصر بفرعه المسند 3 ويتجاهل المدخل الأجنبي", () => {
    const cashierCtx = {
      user: {
        role: "cashier",
        isOwner: false,
        branchId: 3,
      },
    };
    expect(resolveActorBranchId(cashierCtx, 5)).toBe(3);
    expect(resolveActorBranchId(cashierCtx)).toBe(3);
    expect(resolveActorBranchId(cashierCtx, null)).toBe(3);
  });

  it("مدير فرع عادي (manager بلا isOwner) مع branchId = 2 يُحصر بفرعه ويتجاهل محاولات العبور", () => {
    const branchManagerCtx = {
      user: {
        role: "manager",
        isOwner: false,
        branchId: 2,
      },
    };
    expect(resolveActorBranchId(branchManagerCtx, 1)).toBe(2);
    expect(resolveActorBranchId(branchManagerCtx)).toBe(2);
  });

  it("يرمي FORBIDDEN لمستخدم غير مرتفع (cashier/warehouse/manager) عند غياب الفرع المسند حتى لو مرر inputBranchId", () => {
    const roles = ["cashier", "warehouse", "manager", "accountant", "user"];
    for (const role of roles) {
      const ctx = {
        user: {
          role,
          isOwner: false,
          branchId: null,
        },
      };
      expect(() => resolveActorBranchId(ctx)).toThrowError(TRPCError);
      expect(() => resolveActorBranchId(ctx, 2)).toThrowError(TRPCError);

      try {
        resolveActorBranchId(ctx, 2);
      } catch (err: any) {
        expect(err.code).toBe("FORBIDDEN");
        expect(err.message).toContain("لا فرع مُسنَد لهذا المستخدم");
      }
    }
  });
});

describe("Milestone 2 RBAC Hardening: VULN-RBAC-03 (Genuine Constrained Permission Override Schema)", () => {
  it("يقبل المفاتيح النظامية الصالحة وقيم الوصول المصرح بها من المخطط الحقيقي المستورد", () => {
    const validOverrides = {
      crm: "FULL",
      sales: "READ",
      inventory: "NONE",
      customers: "FULL",
    };
    const parsed = PERM_OVERRIDE.parse(validOverrides);
    expect(parsed).toEqual(validOverrides);
  });

  it("يقبل null أو undefined أو كائناً فارغاً", () => {
    expect(PERM_OVERRIDE.parse(null)).toBeNull();
    expect(PERM_OVERRIDE.parse(undefined)).toBeUndefined();
    expect(PERM_OVERRIDE.parse({})).toEqual({});
  });

  it("المطابقة المضادة (Inversion): يرفض حقن أي مفتاح عشوائي غير مصرح به", () => {
    const maliciousOverrides = {
      crm: "FULL",
      injected_module_exploit: "FULL",
    };
    const res = PERM_OVERRIDE.safeParse(maliciousOverrides);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i: any) => i.path.includes("injected_module_exploit"))).toBe(true);
    }
  });

  it("يرفض القيم غير المصرح بها لمستويات الوصول", () => {
    const invalidAccess = {
      crm: "SUPERUSER",
    };
    const res = PERM_OVERRIDE.safeParse(invalidAccess);
    expect(res.success).toBe(false);
  });
});

describe("Milestone 2 RBAC Hardening: VULN-RBAC-04 (Genuine Session Token Enforcement Logic)", () => {
  it("يرفض التوكنات القديمة (بلا sid) إذا تم تعطيل الجلسات القديمة ببيئة التشغيل", () => {
    expect(isLegacySessionAllowed(false, { ALLOW_LEGACY_SESSIONS: "false" })).toBe(false);
    expect(isLegacySessionAllowed(false, { DISABLE_LEGACY_SESSIONS: "true" })).toBe(false);
    expect(isLegacySessionAllowed(false, {})).toBe(true);
    expect(isLegacySessionAllowed(true, { DISABLE_LEGACY_SESSIONS: "true" })).toBe(true);
  });

  it("يرفض المستخدم غير النشط أو ذو الحالة المعطلة", () => {
    expect(validateUserForSession(null)).toBe(false);
    expect(validateUserForSession(undefined)).toBe(false);
    expect(validateUserForSession({ isActive: false })).toBe(false);
    expect(validateUserForSession({ isActive: true, status: "SUSPENDED" })).toBe(false);
    expect(validateUserForSession({ isActive: true, status: "ACTIVE" })).toBe(true);
    expect(validateUserForSession({ isActive: true })).toBe(true);
  });

  it("يرفض التوكن عند عدم تطابق إصدار التوكن tokenVersion", () => {
    expect(validateUserForSession({ isActive: true, tokenVersion: 2 }, 1)).toBe(false);
    expect(validateUserForSession({ isActive: true, tokenVersion: 2 }, 2)).toBe(true);
    expect(validateUserForSession({ isActive: true, tokenVersion: null }, 1)).toBe(true);
  });

  it("يرفض الحساب المنتهي صلاحيته الزمنية accessExpiresAt", () => {
    const now = Date.now();
    expect(
      validateUserForSession(
        { isActive: true, accessExpiresAt: new Date(now - 5000) },
        undefined,
        now,
      ),
    ).toBe(false);
    expect(
      validateUserForSession(
        { isActive: true, accessExpiresAt: new Date(now + 60000) },
        undefined,
        now,
      ),
    ).toBe(true);
  });

  it("يرفض التوكن إذا كان وقت إصداره iat يسبق أو يطابق وقت إبطال الجلسات sessionsValidFrom", () => {
    const revokedAtSec = 1759147200; // 2025-09-29T12:00:00Z in seconds
    const revokedAtDate = new Date(revokedAtSec * 1000);

    // Passed as numeric seconds:
    expect(isSessionRevokedByTimestamp(revokedAtSec - 10, revokedAtSec)).toBe(true);
    expect(isSessionRevokedByTimestamp(revokedAtSec, revokedAtSec)).toBe(true);
    expect(isSessionRevokedByTimestamp(revokedAtSec + 1, revokedAtSec)).toBe(false);
    expect(isSessionRevokedByTimestamp(revokedAtSec, 0)).toBe(false);

    // Passed as Date object:
    expect(isSessionRevokedByTimestamp(revokedAtSec - 10, revokedAtDate)).toBe(true);
    expect(isSessionRevokedByTimestamp(revokedAtSec, revokedAtDate)).toBe(true);
    expect(isSessionRevokedByTimestamp(revokedAtSec + 1, revokedAtDate)).toBe(false);
    expect(isSessionRevokedByTimestamp(revokedAtSec, null)).toBe(false);
  });
});

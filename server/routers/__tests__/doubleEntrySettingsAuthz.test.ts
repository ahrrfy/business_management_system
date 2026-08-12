import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeOwnerAuthority } from "../../context";
import { router, settingsAdminProcedure } from "../../trpc";
import { reportsRouter } from "../reportsRouter";

const authorityProbe = router({
  setDoubleEntryMode: settingsAdminProcedure
    .input(z.object({ target: z.enum(["SHADOW", "ACTIVE"]) }))
    .mutation(({ input }) => input.target),
});

type ProbeRole = "admin" | "manager" | "accountant" | "auditor" | "cashier";

function caller(role: ProbeRole) {
  return authorityProbe.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 41,
      role,
      branchId: 1,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

function actualReportsCaller(role: ProbeRole) {
  return reportsRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 41,
      role,
      branchId: 1,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("صلاحية التحكم بوضع الدفتر المزدوج", () => {
  it("يطبع مالك الشركة إلى عقد admin قبل بوابة التحكم", async () => {
    const owner = normalizeOwnerAuthority({
      id: 42,
      role: "manager",
      isOwner: true,
      permissionsOverride: { reports: "NONE" },
    } as never);

    expect(owner.role).toBe("admin");
    expect(owner.permissionsOverride).toBeNull();
    await expect(caller(owner.role).setDoubleEntryMode({ target: "SHADOW" })).resolves.toBe("SHADOW");
  });

  it("يسمح للمالك/المدير العام (admin الفعلي) ببدء الظل وطلب التفعيل", async () => {
    await expect(caller("admin").setDoubleEntryMode({ target: "SHADOW" })).resolves.toBe("SHADOW");
    await expect(caller("admin").setDoubleEntryMode({ target: "ACTIVE" })).resolves.toBe("ACTIVE");
  });

  it.each(["manager", "accountant", "auditor", "cashier"] as const)(
    "يرفض الدور %s حتى لو كانت شاشة التقرير مقروءة له",
    async (role) => {
      await expect(caller(role).setDoubleEntryMode({ target: "SHADOW" }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("الـendpoint الفعلي يرفض مدير الفرع قبل دخول خدمة التغيير", async () => {
    await expect(actualReportsCaller("manager").setDoubleEntryMode({ target: "SHADOW" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("لا يقبل هدفاً ثالثاً مثل OFF عبر عقد الـAPI", async () => {
    await expect(caller("admin").setDoubleEntryMode({ target: "OFF" } as never)).rejects.toBeTruthy();
  });
});

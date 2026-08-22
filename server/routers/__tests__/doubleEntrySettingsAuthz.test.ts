import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeOwnerAuthority } from "../../context";
import { router, settingsAdminProcedure } from "../../trpc";
import { reportsRouter } from "../reportsRouter";

const authorityProbe = router({
  setDoubleEntryMode: settingsAdminProcedure
    .input(
      z.discriminatedUnion("target", [
        z.object({ target: z.literal("SHADOW") }),
        z.object({ target: z.literal("ACTIVE") }),
        z.object({
          target: z.literal("OFF"),
          reason: z.string().trim().min(10).max(500),
        }),
      ]),
    )
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

function actualReportsCaller(
  role: ProbeRole,
  permissionsOverride: Record<string, "NONE" | "READ" | "FULL"> | null = null,
) {
  return reportsRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 41,
      role,
      branchId: 1,
      permissionsOverride,
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
    await expect(
      caller("admin").setDoubleEntryMode({
        target: "OFF",
        reason: "إيقاف تشغيلي مدقق",
      }),
    ).resolves.toBe("OFF");
  });

  it.each(["manager", "accountant", "auditor", "cashier"] as const)(
    "يرفض الدور %s حتى لو كانت شاشة التقرير مقروءة له",
    async (role) => {
      await expect(caller(role).setDoubleEntryMode({ target: "SHADOW" }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("الـendpoint الفعلي يرفض مدير الفرع قبل دخول خدمة التغيير", async () => {
    await expect(actualReportsCaller("manager").setDoubleEntryMode({
      target: "SHADOW",
      preparationToken: "x".repeat(40),
      expectedOpeningHash: "a".repeat(64),
      allocations: [],
    }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يرفض مدير الفرع عن تقرير المطابقة نفسه بما يطابق إخفاء التبويب", async () => {
    await expect(
      actualReportsCaller("manager").reconcile({ month: "2026-08" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يحمي نافذة إتاحة تقارير الدفتر ببوابة صلاحية reports", async () => {
    await expect(
      actualReportsCaller("cashier").doubleEntryReportAvailability(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      actualReportsCaller("manager", { reports: "NONE" })
        .doubleEntryReportAvailability(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يرفض مدير الفرع عن إعداد معاينة الافتتاح قبل دخول خدمة القراءة", async () => {
    await expect(
      actualReportsCaller("manager").prepareDoubleEntryShadow({ allocations: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("لا يفتح منح settings/FULL لمدير الفرع إجراءات الأدمن الحاكمة", async () => {
    const blocked = actualReportsCaller("manager", { settings: "FULL" });
    await expect(
      blocked.prepareDoubleEntryShadow({ allocations: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      blocked.setDoubleEntryMode({ target: "ACTIVE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      blocked.setDoubleEntryPolicyApproval({
        action: "APPROVE",
        reference: "محضر مراجعة رقم ١٢٣",
        accountantName: "محاسب خارجي",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يرفض OFF بلا سبب ويرفض سبباً أقصر من الحد المدقق", async () => {
    await expect(
      actualReportsCaller("admin").setDoubleEntryMode({ target: "OFF" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      actualReportsCaller("admin").setDoubleEntryMode({
        target: "OFF",
        reason: "قصير",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض مدير الفرع عن إيقاف الدفتر ولو قدم سبباً صالحاً", async () => {
    await expect(
      actualReportsCaller("manager").setDoubleEntryMode({
        target: "OFF",
        reason: "إيقاف تشغيلي مدقق",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يفرض عقد مصادقة السياسة ويرفض مدير الفرع ولو كانت المدخلات صالحة", async () => {
    await expect(
      actualReportsCaller("admin").setDoubleEntryPolicyApproval({
        action: "APPROVE",
        reference: "قصير",
        accountantName: "محاسب",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      actualReportsCaller("manager").setDoubleEntryPolicyApproval({
        action: "APPROVE",
        reference: "محضر مراجعة رقم ١٢٣",
        accountantName: "محاسب خارجي",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

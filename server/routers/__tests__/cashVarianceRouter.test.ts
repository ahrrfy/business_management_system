import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { cashVarianceRouter } from "../cashVarianceRouter";

function context(role: string): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 91,
      role,
      branchId: 1,
      name: "مستخدم اختبار فرق النقد",
      email: "cash-variance@test.local",
      isActive: true,
      isOwner: role === "admin",
    } as TrpcContext["user"],
  };
}

describe("عقد API لفروقات النقد", () => {
  it("يعرّض مسارات الإدراج والقراءة والقرار فقط من الراوتر المحمي", () => {
    expect(Object.keys(cashVarianceRouter._def.procedures).sort()).toEqual([
      "approve",
      "get",
      "list",
      "propose",
      "reject",
      "responsibleUsers",
    ]);
  });

  it("يمنع الكاشير قبل الوصول إلى خدمة القراءة", async () => {
    await expect(cashVarianceRouter.createCaller(context("cashier")).list({ branchId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يرفض تعيين مسؤول عهدة من العميل عند حد API", async () => {
    await expect(cashVarianceRouter.createCaller(context("manager")).propose({
      sourceType: "CUSTODY",
      sourceId: 1,
      reasonCode: "CUSTODY_LOSS",
      reason: "عجز مثبت بمحضر عد مستقل صالح للاختبار",
      evidenceReference: "evidence://custody/owner",
      responsibleUserId: 2,
      clientRequestId: "variance-api-contract",
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يقبل عقد المطابقة اليومية بلا تعيين موظف من العميل", async () => {
    await expect(cashVarianceRouter.createCaller(context("manager")).propose({
      sourceType: "DAILY_TREASURY",
      sourceId: 1,
      reasonCode: "COUNT_ERROR",
      reason: "فرق يومي مثبت بمحضر عد مستقل صالح للاختبار",
      evidenceReference: "evidence://daily/count",
      clientRequestId: "variance-daily-api-contract",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("يرفض حقن مسؤول في عقد المطابقة اليومية", async () => {
    await expect(cashVarianceRouter.createCaller(context("manager")).propose({
      sourceType: "DAILY_TREASURY",
      sourceId: 1,
      reasonCode: "COUNT_ERROR",
      reason: "فرق يومي مثبت بمحضر عد مستقل صالح للاختبار",
      evidenceReference: "evidence://daily/no-employee",
      responsibleUserId: 2,
      clientRequestId: "variance-daily-no-employee-contract",
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض سبب عجز العهدة لمصدر المطابقة اليومية قبل بلوغ الخدمة", async () => {
    await expect(cashVarianceRouter.createCaller(context("manager")).propose({
      sourceType: "DAILY_TREASURY",
      sourceId: 1,
      reasonCode: "CUSTODY_LOSS",
      reason: "فرق يومي لا يجوز تحميله على عهدة موظف",
      evidenceReference: "evidence://daily/not-custody",
      clientRequestId: "variance-daily-reason-contract",
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

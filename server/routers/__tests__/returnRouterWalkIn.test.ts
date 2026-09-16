import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type { TrpcContext } from "../../context";

const mocks = vi.hoisted(() => {
  let hasPending = false;
  return {
    returnSaleInTx: vi.fn(),
    returnSaleAsOwner: vi.fn(async () => ({ returnedTotal: "1250.00", fullyReturned: true })),
    returnSaleDirect: vi.fn(async () => {
      if (hasPending) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "توجد معاملة رقابية معلّقة على هذه الفاتورة",
        });
      }
      return { returnedTotal: "1250.00", fullyReturned: true };
    }),
    requestSalesControl: vi.fn(async () => ({ id: 101, status: "PENDING", payloadHash: "abc", replayed: false })),
    logAudit: vi.fn(async () => undefined),
    setHasPending: (val: boolean) => { hasPending = val; },
    withTx: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const queryResult = (fields?: Record<string, unknown>) => ({
        limit: async () => {
          if (fields && "sourceType" in fields) {
            return [{ sourceType: "POS", branchId: 1, createdBy: 1, workOrderCreatedBy: null }];
          }
          return hasPending ? [{ id: 999 }] : [];
        },
      });
      return fn({
        select: (fields?: Record<string, unknown>) => ({
          from: () => ({
            where: () => queryResult(fields),
            leftJoin: () => ({
              where: () => queryResult(fields),
            }),
          }),
        }),
      });
    }),
  };
});

vi.mock("../../services/returnService", () => ({
  returnSaleInTx: mocks.returnSaleInTx,
  returnSaleAsOwner: mocks.returnSaleAsOwner,
  returnSaleDirect: mocks.returnSaleDirect,
}));
vi.mock("../../services/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/tx")>()),
  withTx: mocks.withTx,
}));
vi.mock("../../services/sale/controlRequests", () => ({ requestSalesControl: mocks.requestSalesControl }));
vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  logAudit: mocks.logAudit,
}));

import { returnRouter } from "../returnRouter";

/**
 * ⚠️ **`isOwner` يقرّر المسار** (قرار المالك ١/٩/٢٦): المالكُ ينفّذ مرتجعه فوراً، وغيرُه
 * يُنشئ طلباً صفريّ الأثر. كان هذا الملفّ يستعمل سياقاً بـ`isOwner: true` ويتوقّع مسار
 * الطلب — فصار يختبر المسار الخطأ بعد إضافة تنفيذ المالك. السياقان مفصولان الآن.
 */
function context(overrides?: { isOwner?: boolean; role?: string }): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 1, role: overrides?.role ?? "manager", branchId: 1, name: "مدير الاختبار",
      email: "returns-manager@test.local", isActive: true, isOwner: overrides?.isOwner ?? false,
    } as TrpcContext["user"],
  };
}
const ownerContext = () => context({ isOwner: true, role: "admin" });

const base = {
  invoiceId: 77,
  lines: [{ invoiceItemId: 88, baseQuantity: 1 }],
  clientRequestId: "api-walkin-resolution-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setHasPending(false);
});

describe("returns.create — طلب صفري الأثر للزبون العابر", () => {
  it("يحفظ resolution الكامل في حمولة الطلب ولا ينفّذ المرتجع", async () => {
    const caller = returnRouter.createCaller(context());
    await caller.create({
      ...base,
      resolution: {
        kind: "IMMEDIATE_REFUND",
        method: "CASH",
        amount: "1250.00",
        shiftId: 9,
        reason: "المنتج غير مطابق",
        disposition: "RESTOCK",
      },
    });

    expect(mocks.requestSalesControl).toHaveBeenCalledWith(expect.objectContaining({
      requestType: "SALES_RETURN",
      reason: "المنتج غير مطابق",
      payload: expect.objectContaining({ resolution: expect.objectContaining({
        method: "CASH", amount: "1250.00", shiftId: 9,
        reason: "المنتج غير مطابق", disposition: "RESTOCK",
      }) }),
    }), expect.objectContaining({ userId: 1, branchId: 1, role: "manager" }));
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      newValue: expect.objectContaining({
        requestId: 101, payloadHash: "abc", reason: "المنتج غير مطابق",
      }),
    }));
  });

  it("يرفض resolution بلا reason أو disposition (وshiftId اختياريّ الآن)", async () => {
    const caller = returnRouter.createCaller(context());
    const resolution = {
      kind: "IMMEDIATE_REFUND" as const,
      method: "CASH" as const,
      amount: "1250.00",
      shiftId: 9,
      reason: "سبب واضح",
      disposition: "DAMAGED" as const,
    };

    // ⛔ `shiftId` **لم يعد إلزامياً** (١/٩/٢٦): بلا وردية مفتوحة يخرج النقد من خزينة الفرع
    // للإداريّ بوسم `SALE_RETURN_COMPENSATION`. اشتراطُه كان يحجب مرتجع الزبون العابر النقديّ
    // خارج ساعات الوردية حجباً كاملاً. أمّا السببُ ومصيرُ البضاعة فيبقيان إلزاميَّين.
    for (const missing of ["reason", "disposition"] as const) {
      const invalid = { ...resolution } as Record<string, unknown>;
      delete invalid[missing];
      await expect(caller.create({ ...base, resolution: invalid } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(mocks.requestSalesControl).not.toHaveBeenCalled();
  });

  it("⭐ المالك ينفّذ فوراً بلا طلب — والعائد mode=EXECUTED", async () => {
    const caller = returnRouter.createCaller(ownerContext());
    const res = await caller.create({
      ...base,
      refund: { amount: "1250.00", method: "CASH", shiftId: 9 },
      restock: true,
      reason: "تنفيذ المالك الفوريّ",
    });

    expect(mocks.requestSalesControl).not.toHaveBeenCalled();
    expect(mocks.returnSaleAsOwner).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 77, ownerReason: "تنفيذ المالك الفوريّ" }),
      expect.objectContaining({ userId: 1 }),
    );
    expect(res).toMatchObject({ mode: "EXECUTED" });
  });

  it("لا يكسر حمولة العميل المسجّل التاريخية؛ refund/restock يبقيان مقبولين", async () => {
    const caller = returnRouter.createCaller(context());
    await caller.create({
      ...base,
      refund: { amount: "10.00", method: "CASH", shiftId: 9 },
      restock: false,
      reason: "إرجاع عميل مسجل",
    });
    expect(mocks.requestSalesControl).toHaveBeenCalledWith(expect.objectContaining({
      requestType: "SALES_RETURN",
      payload: expect.objectContaining({
        refund: { amount: "10.00", method: "CASH", shiftId: 9 },
        restock: false,
      }),
    }), expect.anything());
  });

  it("⭐ التنفيذ المباشر للإدارة (directExecution: true) ينفّذ فوراً بلا طلب تحكّم", async () => {
    const caller = returnRouter.createCaller(context({ role: "manager" }));
    const res = await caller.create({
      ...base,
      refund: { amount: "1250.00", method: "CASH", shiftId: 9 },
      restock: true,
      reason: "تنفيذ المدير المباشر",
      directExecution: true,
    });

    expect(mocks.requestSalesControl).not.toHaveBeenCalled();
    expect(mocks.returnSaleDirect).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 77, operatorReason: "تنفيذ المدير المباشر" }),
      expect.objectContaining({ userId: 1, role: "manager" }),
    );
    expect(res).toMatchObject({ mode: "EXECUTED" });
  });

  it("⭐ التنفيذ المباشر للكاشير (directExecution: true) ينفّذ فوراً بلا طلب تحكّم", async () => {
    const caller = returnRouter.createCaller(context({ role: "cashier" }));
    const res = await caller.create({
      ...base,
      refund: { amount: "1250.00", method: "CASH", shiftId: 9 },
      restock: true,
      reason: "تنفيذ الكاشير المباشر",
      directExecution: true,
    });

    expect(mocks.requestSalesControl).not.toHaveBeenCalled();
    expect(mocks.returnSaleDirect).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 77, operatorReason: "تنفيذ الكاشير المباشر" }),
      expect.objectContaining({ userId: 1, role: "cashier" }),
    );
    expect(res).toMatchObject({ mode: "EXECUTED" });
  });

  it("وجود طلب رقابي معلّق على الفاتورة يرفض التنفيذ المباشر بـ CONFLICT", async () => {
    mocks.setHasPending(true);
    const caller = returnRouter.createCaller(context({ role: "manager" }));
    await expect(
      caller.create({
        ...base,
        refund: { amount: "1250.00", method: "CASH", shiftId: 9 },
        restock: true,
        reason: "تنفيذ مباشر مع وجود طلب معلق",
        directExecution: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("التنفيذ المباشر المعاد (idempotentReplay) لا يكرّر كتابة سجل التدقيق", async () => {
    mocks.returnSaleDirect.mockResolvedValueOnce({ returnedTotal: "1250.00", fullyReturned: true, idempotentReplay: true });
    mocks.logAudit.mockClear();

    const caller = returnRouter.createCaller(context({ role: "cashier" }));
    const res = await caller.create({
      ...base,
      refund: { amount: "1250.00", method: "CASH", shiftId: 9 },
      restock: true,
      reason: "إعادة تنفيذ مباشر",
      directExecution: true,
    });

    expect(mocks.logAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "return.execute" }),
    );
    expect(res).toMatchObject({ mode: "EXECUTED" });
  });

  it("يرفض تنفيذ الكاشير المباشر لفاتورة أنشأها زميل بـ FORBIDDEN", async () => {
    // كاشير بمعرّف 99 يحاول إرجاع فاتورة أنشأها المستخدم 1
    const coworkerCaller = returnRouter.createCaller({
      req: { headers: {} } as TrpcContext["req"],
      res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
      user: {
        id: 99, role: "cashier", branchId: 1, name: "كاشير زميل",
        email: "coworker@test.local", isActive: true, isOwner: false,
      } as TrpcContext["user"],
    });

    await expect(
      coworkerCaller.create({
        ...base,
        refund: { amount: "1250.00", method: "CASH", shiftId: 9 },
        restock: true,
        reason: "محاولة إرجاع فاتورة زميل",
        directExecution: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.returnSaleDirect).not.toHaveBeenCalled();
  });
});


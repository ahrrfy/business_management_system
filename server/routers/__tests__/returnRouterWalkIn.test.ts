import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../context";

const mocks = vi.hoisted(() => ({
  returnSaleInTx: vi.fn(),
  returnSaleAsOwner: vi.fn(async () => ({ returnedTotal: "1250.00", fullyReturned: true })),
  requestSalesControl: vi.fn(async () => ({ id: 101, status: "PENDING", payloadHash: "abc", replayed: false })),
  logAudit: vi.fn(async () => undefined),
  withTx: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ sourceType: "POS" }] }) }) }),
  })),
}));

vi.mock("../../services/returnService", () => ({
  returnSaleInTx: mocks.returnSaleInTx,
  returnSaleAsOwner: mocks.returnSaleAsOwner,
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

beforeEach(() => vi.clearAllMocks());

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
});

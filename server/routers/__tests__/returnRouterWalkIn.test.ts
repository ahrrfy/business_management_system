import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../context";

const mocks = vi.hoisted(() => ({
  returnSale: vi.fn(async () => ({ invoiceId: 77, returnedTotal: "1250.00", fullyReturned: true })),
  returnSaleInTx: vi.fn(),
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("../../services/returnService", () => ({
  returnSale: mocks.returnSale,
  returnSaleInTx: mocks.returnSaleInTx,
}));
vi.mock("../../services/auditService", () => ({ logAudit: mocks.logAudit }));

import { returnRouter } from "../returnRouter";

function context(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 1, role: "admin", branchId: 1, name: "مالك الاختبار",
      email: "returns-owner@test.local", isActive: true, isOwner: true,
    } as TrpcContext["user"],
  };
}

const base = {
  invoiceId: 77,
  lines: [{ invoiceItemId: 88, baseQuantity: 1 }],
  clientRequestId: "api-walkin-resolution-1",
};

beforeEach(() => vi.clearAllMocks());

describe("returns.create — عقد resolution للزبون العابر", () => {
  it("يمرّر resolution الكامل إلى الخدمة ويسجّل السبب والتصرف في التدقيق", async () => {
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

    expect(mocks.returnSale).toHaveBeenCalledWith(expect.objectContaining({
      resolution: expect.objectContaining({
        method: "CASH", amount: "1250.00", shiftId: 9,
        reason: "المنتج غير مطابق", disposition: "RESTOCK",
      }),
    }), expect.objectContaining({ userId: 1, branchId: 1, role: "admin" }));
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      newValue: expect.objectContaining({
        refund: "1250.00", resolution: "IMMEDIATE_REFUND",
        reason: "المنتج غير مطابق", disposition: "RESTOCK",
      }),
    }));
  });

  it("يرفض resolution بلا reason أو disposition أو shiftId قبل دخول الخدمة", async () => {
    const caller = returnRouter.createCaller(context());
    const resolution = {
      kind: "IMMEDIATE_REFUND" as const,
      method: "CASH" as const,
      amount: "1250.00",
      shiftId: 9,
      reason: "سبب واضح",
      disposition: "DAMAGED" as const,
    };

    for (const missing of ["reason", "disposition", "shiftId"] as const) {
      const invalid = { ...resolution } as Record<string, unknown>;
      delete invalid[missing];
      await expect(caller.create({ ...base, resolution: invalid } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(mocks.returnSale).not.toHaveBeenCalled();
  });

  it("لا يكسر حمولة العميل المسجّل التاريخية؛ refund/restock يبقيان مقبولين", async () => {
    const caller = returnRouter.createCaller(context());
    await caller.create({
      ...base,
      refund: { amount: "10.00", method: "CASH", shiftId: 9 },
      restock: false,
    });
    expect(mocks.returnSale).toHaveBeenCalledWith(expect.objectContaining({
      refund: { amount: "10.00", method: "CASH", shiftId: 9 },
      restock: false,
    }), expect.anything());
  });
});

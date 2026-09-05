import { beforeEach, describe, expect, it, vi } from "vitest";

const deliveryMocks = vi.hoisted(() => ({
  listCourierAccounts: vi.fn(async () => [{ id: 20, name: "مندوب" }]),
  getDeliveryParty: vi.fn(async () => ({ id: 1, branchId: 1, name: "جهة" })),
  createDeliveryParty: vi.fn(async () => ({ id: 1 })),
  updateDeliveryParty: vi.fn(async () => ({ id: 1 })),
  setDeliveryPartyActive: vi.fn(async () => ({ id: 1 })),
  dispatchToDelivery: vi.fn(async () => ({ consignmentId: 11, codAmount: "100.00" })),
  recordDeliveryRemittance: vi.fn(async () => ({
    remittanceId: 12,
    collectedTotal: "100.00",
    feesTotal: "0.00",
    netRemitted: "100.00",
    shortfallTotal: "0.00",
  })),
  settleDeliveryBalance: vi.fn(async () => ({ receiptId: 13 })),
  writeOffDeliveryShortfall: vi.fn(async () => ({ entryId: 14 })),
  requestDeliveryCodWriteOff: vi.fn(async () => ({ id: 14, status: "PENDING" as const })),
  listDeliveryCodWriteOffRequests: vi.fn(async () => []),
  approveDeliveryCodWriteOff: vi.fn(async () => ({ request: { id: 14, status: "APPROVED" as const } })),
  rejectDeliveryCodWriteOff: vi.fn(async () => ({ request: { id: 14, status: "REJECTED" as const } })),
}));
const auditMocks = vi.hoisted(() => ({ logAudit: vi.fn(async () => undefined) }));

vi.mock("../../services/deliveryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/deliveryService")>()),
  ...deliveryMocks,
}));
vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  ...auditMocks,
}));
vi.mock("../../services/delivery/writeoffRequests", () => ({
  requestDeliveryCodWriteOff: deliveryMocks.requestDeliveryCodWriteOff,
  listDeliveryCodWriteOffRequests: deliveryMocks.listDeliveryCodWriteOffRequests,
  approveDeliveryCodWriteOff: deliveryMocks.approveDeliveryCodWriteOff,
  rejectDeliveryCodWriteOff: deliveryMocks.rejectDeliveryCodWriteOff,
}));

import { deliveryRouter } from "../deliveryRouter";

function caller(store: "NONE" | "FULL") {
  return deliveryRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 91,
      role: store === "NONE" ? "manager" : "user",
      branchId: 1,
      permissionsOverride: { store },
      totpEnabledAt: new Date(),
    },
  } as never);
}

function adminCaller() {
  return deliveryRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 92,
      role: "admin",
      branchId: 1,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

function authorityCalls(c: ReturnType<typeof caller>) {
  return [
    () => c.courierAccounts(),
    () => c.createParty({ partyType: "INDIVIDUAL", name: "جهة اختبار" }),
    () => c.updateParty({ id: 1, name: "جهة معدلة" }),
    () => c.setPartyActive({ id: 1, isActive: false }),
    () => c.dispatch({
      workOrderId: 1,
      partyId: 1,
      clientRequestId: "dispatch-auth-1",
    }),
    () => c.recordRemittance({
      partyId: 1,
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }],
      countedCash: "100.00",
      clientRequestId: "remit-auth-1",
    }),
    () => c.settle({
      partyId: 1,
      amount: "100.00",
      clientRequestId: "settle-auth-1",
    }),
  ];
}

function writeOff(c: ReturnType<typeof caller> | ReturnType<typeof adminCaller>) {
  return c.writeOff({
    partyId: 1,
    amount: "100.00",
    reason: "عجز مثبت للاختبار",
    evidenceNote: "محضر مطابقة موقع من طرفين",
    clientRequestId: "writeoff-auth-1",
  });
}

describe("deliveryRouter — module-aware authority", () => {
  beforeEach(() => vi.clearAllMocks());

  it("override store=NONE يقيد manager قبل بلوغ dispatch/remittance/settle/party admin", async () => {
    for (const invoke of authorityCalls(caller("NONE"))) {
      await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(deliveryMocks.listCourierAccounts).not.toHaveBeenCalled();
    expect(deliveryMocks.createDeliveryParty).not.toHaveBeenCalled();
    expect(deliveryMocks.updateDeliveryParty).not.toHaveBeenCalled();
    expect(deliveryMocks.setDeliveryPartyActive).not.toHaveBeenCalled();
    expect(deliveryMocks.dispatchToDelivery).not.toHaveBeenCalled();
    expect(deliveryMocks.recordDeliveryRemittance).not.toHaveBeenCalled();
    expect(deliveryMocks.settleDeliveryBalance).not.toHaveBeenCalled();
    expect(deliveryMocks.requestDeliveryCodWriteOff).not.toHaveBeenCalled();
  });

  it("المنح الصريح store=FULL يفتح التشغيل ولا يفتح شطب COD", async () => {
    for (const invoke of authorityCalls(caller("FULL"))) {
      await expect(invoke()).resolves.toBeDefined();
    }
    await expect(writeOff(caller("FULL"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deliveryMocks.listCourierAccounts).toHaveBeenCalledOnce();
    expect(deliveryMocks.createDeliveryParty).toHaveBeenCalledOnce();
    expect(deliveryMocks.updateDeliveryParty).toHaveBeenCalledOnce();
    expect(deliveryMocks.setDeliveryPartyActive).toHaveBeenCalledOnce();
    expect(deliveryMocks.dispatchToDelivery).toHaveBeenCalledOnce();
    expect(deliveryMocks.recordDeliveryRemittance).toHaveBeenCalledOnce();
    expect(deliveryMocks.settleDeliveryBalance).toHaveBeenCalledOnce();
    expect(deliveryMocks.requestDeliveryCodWriteOff).not.toHaveBeenCalled();
  });

  it("يفتح مراجعة طلب الشطب لمن اجتاز deliveryManagerProcedure دون منحه إنشاء الطلب", async () => {
    const reviewer = caller("FULL");
    await expect(reviewer.listWriteOffRequests({ status: "PENDING" })).resolves.toEqual([]);
    await expect(reviewer.approveWriteOffRequest({
      id: 14,
      expectedVersion: 1,
      decisionKey: "writeoff-review-approve",
    })).resolves.toBeDefined();
    await expect(reviewer.rejectWriteOffRequest({
      id: 15,
      expectedVersion: 1,
      decisionKey: "writeoff-review-reject",
      reason: "الإثبات غير كافٍ",
    })).resolves.toBeDefined();

    expect(deliveryMocks.approveDeliveryCodWriteOff).toHaveBeenCalledWith(
      expect.objectContaining({ id: 14 }),
      expect.objectContaining({ reviewAuthorized: true, userId: 91 }),
    );
    await expect(caller("NONE").approveWriteOffRequest({
      id: 14,
      expectedVersion: 1,
      decisionKey: "writeoff-review-denied",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("شطب COD يتطلب أدمن فعلياً + سبباً وإثباتاً", async () => {
    await expect(writeOff(adminCaller())).resolves.toBeDefined();
    expect(deliveryMocks.requestDeliveryCodWriteOff).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKey: "writeoff-auth-1",
        reason: "عجز مثبت للاختبار",
        evidenceNote: "محضر مطابقة موقع من طرفين",
      }),
      expect.objectContaining({ userId: 92, role: "admin" }),
    );
    expect(deliveryMocks.writeOffDeliveryShortfall).not.toHaveBeenCalled();

    await expect(adminCaller().writeOff({
      partyId: 1,
      amount: "100.00",
      reason: "عجز مثبت للاختبار",
      clientRequestId: "writeoff-auth-2",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountingEntries, receipts, shifts, workOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money } from "../money";

const state = vi.hoisted(() => ({ applied: vi.fn(), fee: vi.fn(), drawer: vi.fn(), treasury: vi.fn() }));
vi.mock("../deposits", () => ({ appliedCollectionsForWorkOrder: state.applied }));
vi.mock("../workOrder/deliveryFeeRefund", () => ({ workOrderFeeHeldNet: state.fee }));
vi.mock("../cash/cashAvailability", () => ({ MATERIALIZED_RECEIPT_STATUSES: ["COMPLETED", "REVERSED"], computeDrawerCashBalance: state.drawer, computeTreasuryCashBalance: state.treasury }));
vi.mock("../delivery/shipments", () => ({ loadShipmentMembersTx: vi.fn() }));

import { loadWorkOrderDepositReceiptSet } from "../workOrder/depositReceiptSet";
import { workOrderRefundPreflight } from "../workOrder/refundPreflight";

const order = { id: 10, branchId: 1, invoiceId: null, deposit: "1000.00", depositReceiptId: 101 };
function receipt(id: number, paymentMethod: string, amount: string) {
  return { id, workOrderId: order.id, branchId: 1, invoiceId: null, direction: "IN", status: "COMPLETED", approvalStatus: "APPROVED", paymentMethod, amount };
}
/** Execute the real readers against a thenable query fixture; a read-only transaction rejects locking reads. */
function fixture(deposits: ReturnType<typeof receipt>[], options: { readOnly?: boolean; deposit?: string; anchor?: number | null } = {}) {
  const rows = new Map<unknown, unknown[]>([
    [workOrders, [{ ...order, deposit: options.deposit ?? order.deposit, depositReceiptId: options.anchor === undefined ? order.depositReceiptId : options.anchor }]],
    [accountingEntries, deposits.map(row => ({ receiptId: row.id }))],
    [receipts, deposits],
    [shifts, [{ shiftId: 21, userId: 2, userName: "Reception", shiftType: "RECEPTION", openingBalance: "0" }]],
  ]);
  const locks = vi.fn((mode: string) => {
    if (options.readOnly) throw new Error("SELECT FOR UPDATE is forbidden in a read-only transaction");
    return mode;
  });
  const tx = { select: () => {
    let table: unknown;
    const query = {
      from(value: unknown) { table = value; return query; },
      where() { return query; },
      orderBy() { return query; },
      limit() { return query; },
      leftJoin() { return query; },
      for(mode: string) { locks(mode); return query; },
      then(resolve: (value: unknown[]) => unknown, reject: (cause: unknown) => unknown) { return Promise.resolve(rows.get(table) ?? []).then(resolve, reject); },
    };
    return query;
  } } as unknown as Tx;
  return { tx, locks };
}

beforeEach(() => {
  state.applied.mockReset().mockResolvedValue([]);
  state.fee.mockReset().mockResolvedValue(money(0));
  state.drawer.mockReset().mockResolvedValue(money(500));
  state.treasury.mockReset().mockResolvedValue(money(1000));
});

describe("native split work-order refund preflight", () => {
  it("exposes drawer and treasury choices when the anchor is CARD but another deposit is CASH", async () => {
    const { tx, locks } = fixture([receipt(101, "CARD", "400.00"), receipt(102, "CASH", "600.00")], { readOnly: true });
    const result = await workOrderRefundPreflight(tx, order.id, "CANCEL", { exposeCash: true });
    expect(result).toMatchObject({ needsCashDrawer: true, estimatedCashOut: "600.00", treasuryCash: "1000.00", treasurySufficient: true, cardRefundAllowed: true,
      drawers: [{ shiftId: 21, expectedCash: "500.00", sufficient: false }] });
    expect(locks).not.toHaveBeenCalled();
  });

  it("adds every cash deposit and checks available cash against the full refund", async () => {
    const { tx } = fixture([receipt(101, "CASH", "300.00"), receipt(102, "CASH", "400.00"), receipt(103, "CARD", "300.00")]);
    const result = await workOrderRefundPreflight(tx, order.id, "CANCEL", { exposeCash: false });
    expect(result).toMatchObject({ needsCashDrawer: true, estimatedCashOut: "700.00", treasuryCash: null, treasurySufficient: true, drawers: [{ sufficient: false }] });
    expect(result!.drawers[0]).not.toHaveProperty("expectedCash");
  });

  it("counts held allocations once and keeps their cash-only refund restriction", async () => {
    state.applied.mockResolvedValue([{ amount: "200.00", method: "CASH" }]);
    state.fee.mockResolvedValue(money(50));
    const { tx } = fixture([receipt(101, "CARD", "400.00"), receipt(102, "CASH", "400.00")]);
    const result = await workOrderRefundPreflight(tx, order.id, "CANCEL", { exposeCash: true });
    expect(result).toMatchObject({ estimatedCashOut: "650.00", cardRefundAllowed: false });
    expect(state.applied).toHaveBeenCalledOnce();
  });

  it("requires no drawer or treasury balance for a fully noncash native deposit", async () => {
    const { tx } = fixture([receipt(101, "CARD", "400.00"), receipt(102, "TRANSFER", "600.00")]);
    const result = await workOrderRefundPreflight(tx, order.id, "CANCEL", { exposeCash: true });
    expect(result).toMatchObject({ needsCashDrawer: false, estimatedCashOut: "0.00", drawers: [], treasuryCash: null });
    expect(state.drawer).not.toHaveBeenCalled();
    expect(state.treasury).not.toHaveBeenCalled();
  });

  it("preserves held-only refunds when the legacy deposit column is zero", async () => {
    state.applied.mockResolvedValue([{ amount: "200.00", method: "CASH" }]);
    const { tx } = fixture([], { deposit: "0.00", anchor: null });
    expect(await workOrderRefundPreflight(tx, order.id, "CANCEL", { exposeCash: true })).toMatchObject({ estimatedCashOut: "200.00", needsCashDrawer: true, cardRefundAllowed: false });
  });
});

describe("deposit receipt reader locking", () => {
  it("locks all real deposit receipts by default for execution", async () => {
    const { tx, locks } = fixture([receipt(101, "CARD", "400.00"), receipt(102, "CASH", "600.00")]);
    expect(await loadWorkOrderDepositReceiptSet(tx, order, "1000.00")).toHaveLength(2);
    expect(locks).toHaveBeenCalledExactlyOnceWith("update");
  });

  it("supports read-only historical previews without weakening amount validation", async () => {
    const { tx, locks } = fixture([receipt(101, "CARD", "400.00"), receipt(102, "CASH", "600.00")], { readOnly: true });
    expect(await loadWorkOrderDepositReceiptSet(tx, order, "1000.00", { lock: false })).toHaveLength(2);
    await expect(loadWorkOrderDepositReceiptSet(tx, order, "999.00", { lock: false })).rejects.toThrow();
    expect(locks).not.toHaveBeenCalled();
  });
});

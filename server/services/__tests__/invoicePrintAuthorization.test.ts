import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOperationPermission,
  operationDecision,
  type OperationPolicy,
} from "../../../shared/operationPermissions";

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  audit: vi.fn(),
  locks: [] as string[],
  options: undefined as unknown,
}));
vi.mock("../tx", () => ({
  withTx: async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
    state.options = options;
    const tx = {
      select: () => {
        const q = {
          from: () => q,
          where: () => q,
          limit: () => q,
          for: (lock: string) => {
            state.locks.push(lock);
            return Promise.resolve(state.rows.shift() ?? []);
          },
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve(state.rows.shift() ?? []).then(resolve, reject),
        };
        return q;
      },
    };
    return work(tx);
  },
}));
vi.mock("../auditService", () => ({ logAuditTx: state.audit }));

import {
  assertDirectPrintBridgeAuthorized,
  assertInvoicePrintScope,
  authorizeInvoicePrint,
  type InvoicePrintActor,
} from "../invoicePrintAuthorization";

const actor: InvoicePrintActor = {
  userId: 7,
  branchId: 2,
  role: "cashier",
  canonical: true,
  scopedOwnerId: 7,
  invoiceScope: "sales",
};
const invoice = {
  id: 42,
  invoiceNumber: "INV-42",
  branchId: 2,
  createdBy: 7,
  status: "PAID",
  sourceType: "POS",
  shiftId: null,
  shiftType: null,
  workOrderCreatedBy: null,
};
const input = {
  invoiceId: 42,
  requestId: "9caea5d5-ea1a-47d8-82b6-052da22e1edc",
  purpose: "THERMAL" as const,
};
function policy(grant: boolean): OperationPolicy {
  return {
    version: 1,
    grants: { "operation.invoicePrinting.authorizeBridge": grant },
  };
}

beforeEach(() => {
  state.rows = [];
  state.locks = [];
  state.audit.mockReset();
});

describe("invoice print scope", () => {
  it("cannot cross the immutable invoice branch with a BRANCH record grant", () => {
    expect(() =>
      assertInvoicePrintScope(
        { ...actor, scopedOwnerId: null },
        { ...invoice, branchId: 3 },
        "THERMAL",
      ),
    ).toThrow(/الفرع/);
  });
  it("canonical OWN never inherits ownership through a work order", () => {
    expect(() =>
      assertInvoicePrintScope(
        actor,
        { ...invoice, createdBy: 8, workOrderCreatedBy: 7 },
        "THERMAL",
      ),
    ).toThrow(/أنشأتها/);
    expect(() =>
      assertInvoicePrintScope(
        { ...actor, canonical: false },
        { ...invoice, createdBy: 8, workOrderCreatedBy: 7 },
        "THERMAL",
      ),
    ).not.toThrow();
  });
  it("canonical BRANCH can print a colleague invoice in the assigned branch", () => {
    expect(() =>
      assertInvoicePrintScope(
        { ...actor, scopedOwnerId: null },
        { ...invoice, createdBy: 8 },
        "THERMAL",
      ),
    ).not.toThrow();
  });
  it("keeps legacy reception channel restrictions and the shiftless work-order exception", () => {
    const reception = {
      ...actor,
      canonical: false,
      invoiceScope: "reception" as const,
    };
    expect(() =>
      assertInvoicePrintScope(reception, invoice, "THERMAL"),
    ).toThrow(/قناة/);
    expect(() =>
      assertInvoicePrintScope(
        reception,
        { ...invoice, sourceType: "WORKORDER" },
        "THERMAL",
      ),
    ).not.toThrow();
  });
  it.each(["CANCELLED", "SUPERSEDED"])(
    "rejects the current %s state",
    (status) => {
      expect(() =>
        assertInvoicePrintScope(actor, { ...invoice, status }, "A4"),
      ).toThrow(/ألغيت|استبدلت/);
    },
  );
  it("permits a historical returned receipt but no new shipping label", () => {
    expect(() =>
      assertInvoicePrintScope(
        actor,
        { ...invoice, status: "RETURNED" },
        "THERMAL",
      ),
    ).not.toThrow();
    expect(() =>
      assertInvoicePrintScope(
        actor,
        { ...invoice, status: "RETURNED" },
        "SHIPPING_LABEL",
      ),
    ).toThrow(/مرتجعة/);
  });
  it("preserves owner branch and record authority", () => {
    expect(() =>
      assertInvoicePrintScope(
        { ...actor, isOwner: true },
        { ...invoice, branchId: 3, createdBy: 8 },
        "THERMAL",
      ),
    ).not.toThrow();
  });
});

describe("mandatory authorization journal", () => {
  it("locks the invoice and journals authorization without claiming completion", async () => {
    state.rows = [[invoice], [], [], []];
    await authorizeInvoicePrint(input, "PRINT", actor, { userId: 7 });
    expect(state.locks).toEqual(["update"]);
    expect(state.options).toEqual({ gate: "NONE" });
    expect(state.audit).toHaveBeenCalledOnce();
    expect(state.audit.mock.calls[0][2]).toMatchObject({
      action: "invoice.print_authorized",
      entityId: 42,
      newValue: { status: "AUTHORIZED_ONLY", requestId: input.requestId },
    });
  });
  it("a second distinct first-print request requires the independent reprint operation", async () => {
    state.rows = [[invoice], [], [], [{ id: 1 }]];
    await expect(
      authorizeInvoicePrint(input, "PRINT", actor, {}),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("replays an identical authorization id without a duplicate journal", async () => {
    state.rows = [
      [invoice],
      [],
      [
        {
          userId: 7,
          action: "invoice.print_authorized",
          newValue: { purpose: "THERMAL" },
        },
      ],
    ];
    await expect(
      authorizeInvoicePrint(input, "PRINT", actor, {}),
    ).resolves.toMatchObject({ authorized: true });
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("rejects replay under another actor or purpose", async () => {
    state.rows = [
      [invoice],
      [],
      [
        {
          userId: 8,
          action: "invoice.print_authorized",
          newValue: { purpose: "THERMAL" },
        },
      ],
    ];
    await expect(
      authorizeInvoicePrint(input, "PRINT", actor, {}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("journal failure prevents issuing an authorization", async () => {
    state.rows = [[invoice], [], [], []];
    state.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(
      authorizeInvoicePrint(input, "REPRINT", actor, {}),
    ).rejects.toThrow("audit unavailable");
  });
});

describe("direct bridge independent grant", () => {
  it("first-print and reprint grants remain independent in either direction", () => {
    for (const allowed of ["requestPrint", "requestReprint"]) {
      const denied =
        allowed === "requestPrint" ? "requestReprint" : "requestPrint";
      const user = {
        role: "cashier",
        operationPolicy: {
          version: 1 as const,
          grants: {
            [`operation.invoicePrinting.${allowed}`]: true,
            [`operation.invoicePrinting.${denied}`]: false,
          },
        },
      };
      expect(
        operationDecision(user, `invoicePrinting.${allowed}`).allowed,
      ).toBe(true);
      expect(operationDecision(user, `invoicePrinting.${denied}`).allowed).toBe(
        false,
      );
    }
  });
  it("has a real delegable catalog operation", () => {
    expect(
      getOperationPermission("invoicePrinting.authorizeBridge")?.delegable,
    ).toBe(true);
  });
  it("canonical manager denial overrides a broad legacy role", () => {
    expect(() =>
      assertDirectPrintBridgeAuthorized({
        role: "manager",
        operationPolicy: policy(false),
      }),
    ).toThrow(/الطابعة/);
  });
  it("a canonical grant permits an otherwise restricted legacy role", () => {
    expect(() =>
      assertDirectPrintBridgeAuthorized({
        role: "courier",
        operationPolicy: policy(true),
      }),
    ).not.toThrow();
  });
  it("legacy courier remains blocked while legacy cashier remains permitted", () => {
    expect(() =>
      assertDirectPrintBridgeAuthorized({ role: "courier" }),
    ).toThrow();
    expect(() =>
      assertDirectPrintBridgeAuthorized({ role: "cashier" }),
    ).not.toThrow();
  });
});

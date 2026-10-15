import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../context";
const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  period: vi.fn(),
  postEntry: vi.fn(async () => 777),
  adjustCustomerBalance: vi.fn(async () => undefined),
  updates: [] as Record<string, unknown>[],
}));
vi.mock("../../services/tx", () => ({
  withTx: async (run: (tx: unknown) => Promise<unknown>) => {
    let offset = 0;
    const tx = {
      select: () => {
        const rows = state.rows[offset++] ?? [];
        const query = {
          from: () => query,
          innerJoin: () => query,
          leftJoin: () => query,
          where: () => query,
          orderBy: () => query,
          for: () => query,
          limit: async () => rows,
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return query;
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            state.updates.push(values);
          },
        }),
      }),
    };
    return run(tx);
  },
}));
vi.mock("../../services/periodLockService", () => ({
  assertPeriodOpen: state.period,
}));
vi.mock("../../services/ledgerService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/ledgerService")>();
  return {
    ...actual,
    postEntry: state.postEntry,
    adjustCustomerBalance: state.adjustCustomerBalance,
  };
});
vi.mock("../../services/auditService", () => ({
  withMutationAuditScope: async (run: () => Promise<unknown>) => ({
    value: await run(),
    specializedAuditWritten: true,
  }),
  logAudit: vi.fn(),
  logAuditTx: vi.fn(),
  automaticActorForProcedure: vi.fn(),
  buildAutomaticAuditData: vi.fn(),
  auditMetadataFromContext: vi.fn(),
}));
vi.mock("../../realtime/financialRefresh", () => ({
  scheduleFinancialRefresh: vi.fn(),
}));
import { router } from "../../trpc";
import { returnRouter } from "../returnRouter";
const api = router({ returns: returnRouter });
const payload = {
  supplierId: 9,
  items: [{ variantId: 1, productName: "صنف", quantity: 1, unitCost: "100" }],
  settlement: { method: "CREDIT_OFFSET" as const, totalAmount: "100" },
};
const policy = (cost: boolean, execute = true) => ({
  version: 1 as const,
  grants: { "operation.returns.executePurchaseReturnCart": execute },
  dataVisibility: { purchaseCost: cost, profitMargin: cost },
});
const ctx = {
  req: {},
  res: {},
  sessionId: null,
  nativeClientId: null,
  platformAdmin: null,
  user: {
    id: 4,
    role: "warehouse",
    branchId: 2,
    isOwner: false,
    operationPolicyEnabled: true,
    resolvedOperationPolicy: policy(true),
  },
} as unknown as TrpcContext;
beforeEach(() => {
  state.period.mockReset();
  state.postEntry.mockClear();
  state.adjustCustomerBalance.mockClear();
  state.updates = [];
});
describe("purchase-return fresh transaction authority", () => {
  it.each([
    [false, true],
    [true, false],
  ])(
    "rejects permission revoked after request resolution: cost=%s execution=%s",
    async (cost, execute) => {
      state.rows = [
        [{ customRoleId: null }],
        [
          {
            id: 4,
            role: "warehouse",
            branchId: 2,
            isActive: true,
            isOwner: false,
            customRoleId: null,
            permissionsOverride: null,
            operationPolicy: policy(cost, execute),
          },
        ],
        [],
      ];
      await expect(
        api.createCaller(ctx).returns.executePurchaseReturnCart(payload),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(state.period).not.toHaveBeenCalled();
    },
  );
  it("reaches the supplier check only while both persisted permissions remain allowed", async () => {
    state.rows = [
      [{ customRoleId: null }],
      [
        {
          id: 4,
          role: "warehouse",
          branchId: 2,
          isActive: true,
          isOwner: false,
          customRoleId: null,
          permissionsOverride: null,
          operationPolicy: policy(true),
        },
      ],
      [],
    ];
    await expect(
      api.createCaller(ctx).returns.executePurchaseReturnCart(payload),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("المورد غير موجود"),
    });
    expect(state.period).toHaveBeenCalledOnce();
  });
  it("rejects clearing a canonical policy when the current legacy role cannot execute the action", async () => {
    state.rows = [
      [{ customRoleId: null }],
      [
        {
          id: 4,
          role: "warehouse",
          branchId: 2,
          isActive: true,
          isOwner: false,
          customRoleId: null,
          permissionsOverride: null,
          operationPolicy: null,
        },
      ],
      [],
    ];
    await expect(
      api.createCaller(ctx).returns.executePurchaseReturnCart(payload),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.period).not.toHaveBeenCalled();
  });
  it.each([null, { sales: "NONE" }, { reports: "NONE" }])(
    "uses the current legacy manager module and cost permissions: %s",
    async (permissionsOverride) => {
      const managerCtx = {
        ...ctx,
        user: {
          ...ctx.user!,
          role: "manager",
          totpEnabledAt: new Date(),
          operationPolicyEnabled: false,
          resolvedOperationPolicy: undefined,
        },
      } as TrpcContext;
      state.rows = [
        [{ customRoleId: null }],
        [
          {
            id: 4,
            role: "manager",
            branchId: 2,
            isActive: true,
            isOwner: false,
            customRoleId: null,
            permissionsOverride,
            operationPolicy: null,
          },
        ],
        [],
      ];
      if (permissionsOverride == null) {
        await expect(
          api
            .createCaller(managerCtx)
            .returns.executePurchaseReturnCart(payload),
        ).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: expect.stringContaining("المورد غير موجود"),
        });
        expect(state.period).toHaveBeenCalledOnce();
      } else {
        await expect(
          api
            .createCaller(managerCtx)
            .returns.executePurchaseReturnCart(payload),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(state.period).not.toHaveBeenCalled();
      }
    },
  );
  it("rejects cross-branch getOpenRefundDrawers for a branch-scoped cashier", async () => {
    const cashierCtx = {
      ...ctx,
      user: {
        id: 12,
        role: "cashier",
        branchId: 1,
        isActive: true,
        isOwner: false,
        operationPolicyEnabled: true,
        resolvedOperationPolicy: {
          version: 1 as const,
          grants: {
            "operation.returns.create": true,
            "operation.returns.getOpenRefundDrawers": true,
          },
        },
      },
    } as unknown as TrpcContext;
    await expect(
      api.createCaller(cashierCtx).returns.getOpenRefundDrawers({ branchId: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects DIGITAL_CARD products in executeSalesReturnCart before stock or cash movement", async () => {
    const cashierUserRow = {
      id: 12,
      role: "cashier",
      branchId: 1,
      isActive: true,
      isOwner: false,
      customRoleId: null,
      permissionsOverride: null,
      operationPolicy: {
        version: 1 as const,
        grants: {
          "operation.returns.create": true,
          "operation.returns.executeSalesReturnCart": true,
        },
      },
    };
    const cashierCtx = {
      ...ctx,
      user: {
        ...cashierUserRow,
        operationPolicyEnabled: true,
        resolvedOperationPolicy: cashierUserRow.operationPolicy,
      },
    } as unknown as TrpcContext;
    state.rows = [
      [{ customRoleId: null }],
      [cashierUserRow],
      [{ customRoleId: null }],
      [cashierUserRow],
      [{ customRoleId: null }],
      [cashierUserRow],
      [{ variantId: 3, productName: "بطاقة شحن رقمية" }],
    ];
    await expect(
      api.createCaller(cashierCtx).returns.executeSalesReturnCart({
        items: [
          {
            variantId: 3,
            productName: "بطاقة شحن رقمية",
            quantity: 1,
            unitPrice: "15.00",
          },
        ],
        settlement: {
          method: "CASH",
          totalAmount: "15.00",
          shiftId: 1,
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("الكروت الرقمية"),
    });
  });

  it("checks assertPeriodOpen on matchedInvoice.invoiceDate and rejects active installment plans in executeSalesReturnCart", async () => {
    const managerUserRow = {
      id: 4,
      role: "manager",
      branchId: 2,
      isActive: true,
      isOwner: false,
      customRoleId: null,
      permissionsOverride: null,
      operationPolicy: {
        version: 1 as const,
        grants: {
          "operation.returns.create": true,
          "operation.returns.executeSalesReturnCart": true,
          "operation.salesControl.approve": true,
        },
      },
    };
    const managerCtx = {
      ...ctx,
      user: {
        ...managerUserRow,
        totpEnabledAt: new Date(),
        operationPolicyEnabled: true,
        resolvedOperationPolicy: managerUserRow.operationPolicy,
      },
    } as unknown as TrpcContext;
    const originalInvoiceDate = new Date("2026-01-15T00:00:00.000Z");
    state.rows = [
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [], // digitalProductRows
      [{ id: 55, branchId: 2, status: "UNPAID", sourceType: "POS" }], // invPreview
      [], // deliveryPreview
      [], // deliveryConsignments gap lock
      [
        {
          id: 55,
          invoiceNumber: "INV-55",
          branchId: 2,
          customerId: 7,
          status: "UNPAID",
          sourceType: "POS",
          invoiceDate: originalInvoiceDate,
          total: "100.00",
          paidAmount: "0.00",
          returnedTotal: "0.00",
        },
      ], // locked invoice
      [{ id: 9, planNumber: "IP-2026-0009", status: "ACTIVE" }], // installmentPlans
    ];
    await expect(
      api.createCaller(managerCtx).returns.executeSalesReturnCart({
        invoiceNumber: "INV-55",
        items: [
          {
            variantId: 1,
            productName: "صنف",
            quantity: 1,
            unitPrice: "100.00",
          },
        ],
        settlement: {
          method: "CREDIT_OFFSET",
          totalAmount: "100.00",
        },
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("لا يمكن إرجاع الفاتورة كلياً أو جزئياً"),
    });
    expect(state.period).toHaveBeenCalledTimes(2);
    expect(state.period).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      originalInvoiceDate,
    );
  });

  it("posts RETURN_SALE_SERVICE onto SALES_PRINT, preserves frozen zero lineCost over positive unitCost, and skips returnedRestockedBaseQuantity on SERVICE lines", async () => {
    const managerUserRow = {
      id: 4,
      role: "manager",
      branchId: 2,
      isActive: true,
      isOwner: false,
      customRoleId: null,
      permissionsOverride: null,
      operationPolicy: {
        version: 1 as const,
        grants: {
          "operation.returns.create": true,
          "operation.returns.executeSalesReturnCart": true,
          "operation.salesControl.approve": true,
        },
      },
    };
    const managerCtx = {
      ...ctx,
      user: {
        ...managerUserRow,
        totpEnabledAt: new Date(),
        operationPolicyEnabled: true,
        resolvedOperationPolicy: managerUserRow.operationPolicy,
      },
    } as unknown as TrpcContext;
    const originalInvoiceDate = new Date("2026-10-15T00:00:00.000Z");
    state.rows = [
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [], // digitalProductRows
      [{ id: 88, branchId: 2, status: "UNPAID", sourceType: "POS" }], // invPreview
      [], // deliveryPreview
      [], // deliveryConsignments gap lock
      [
        {
          id: 88,
          invoiceNumber: "INV-88",
          branchId: 2,
          customerId: 7,
          status: "UNPAID",
          sourceType: "POS",
          invoiceDate: originalInvoiceDate,
          subtotal: "30.00",
          discountAmount: "0.00",
          taxAmount: "0.00",
          total: "30.00",
          paidAmount: "0.00",
          returnedTotal: "0.00",
        },
      ], // locked invoice
      [], // installmentPlans (none active)
      [
        {
          id: 501,
          invoiceId: 88,
          variantId: 2,
          productUnitId: 3,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "30.00",
          total: "30.00",
          unitCost: "5.00",
          lineCost: "0.00",
          isGift: false,
        },
      ], // invoiceItems
      [], // digitalSaleDetails
      [{ id: 3, variantId: 2, unitName: "خدمة", conversionFactor: "1", factor: "1" }], // resolveReturnBaseQuantity productUnits
      [{ variantId: 2, isService: true, isBundle: false }], // classifyVariants
      [], // consignByVariant
      [{ id: 2, costPrice: "5.00" }], // variantCostRows
      [], // reconcileDeliveryOnReturnTx deliveryConsignments
    ];
    const result = await api
      .createCaller(managerCtx)
      .returns.executeSalesReturnCart({
        invoiceNumber: "INV-88",
        disposition: "RESTOCK",
        customer: { customerId: 7, name: "عميل" },
        items: [
          {
            variantId: 2,
            invoiceItemId: 501,
            productUnitId: 3,
            productName: "خدمة طباعة",
            quantity: 1,
            unitPrice: "30.00",
          },
        ],
        settlement: {
          method: "CREDIT_OFFSET",
          totalAmount: "30.00",
        },
      });
    expect(result.ok).toBe(true);
    expect(state.postEntry).toHaveBeenCalledOnce();
    const [, postedPayload] = state.postEntry.mock.calls[0] as unknown as [
      unknown,
      Record<string, any>,
    ];
    expect(postedPayload.entryType).toBe("RETURN");
    expect(postedPayload.cost.toFixed(2)).toBe("0.00");
    expect(postedPayload.postingIntent.profile).toBe("RETURN_SALE_SERVICE");
    expect(
      postedPayload.postingSourceComponents.roleDebits.SALES_PRINT.toFixed(2),
    ).toBe("30.00");
    expect(
      postedPayload.postingSourceComponents.roleDebits.SALES_STATIONERY.toFixed(
        2,
      ),
    ).toBe("0.00");
    expect(state.updates[0]).not.toHaveProperty("returnedRestockedBaseQuantity");
  });
});

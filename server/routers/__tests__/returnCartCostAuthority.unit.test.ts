import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import type { Tx } from "../../db";
import type { TrpcContext } from "../../context";
const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  period: vi.fn(),
  domainReads: [] as string[],
  insertions: [] as string[],
  postEntry: vi.fn(async () => 777),
  adjustCustomerBalance: vi.fn(async () => undefined),
  adjustSupplierBalance: vi.fn(async () => undefined),
  updates: [] as Record<string, unknown>[],
}));
vi.mock("../../services/tx", () => ({
  withTx: async (run: (tx: unknown) => Promise<unknown>) => {
    // Route and transaction checks share one persisted actor, independently of
    // domain result ordering; the real scope assertion below owns the decision.
    const authorityRows = state.rows.filter((rows) =>
      rows.some(
        (row) =>
          typeof row === "object" && row != null && "customRoleId" in row,
      ),
    );
    const current = authorityRows
      .flat()
      .find(
        (row) => typeof row === "object" && row != null && "isActive" in row,
      );
    const domainRows = state.rows.filter(
      (rows) => !authorityRows.includes(rows),
    );
    let offset = 0;
    const tx = {
      select: () => {
        let rows: unknown[] = [];
        const query = {
          from: (table: Parameters<typeof getTableName>[0]) => {
            // These posting fixtures have no live approval intents. Keep those
            // added safety reads separate from the original business rows.
            const name = getTableName(table);
            if (name !== "users" && name !== "roles")
              state.domainReads.push(name);
            rows =
              name === "users"
                ? current
                  ? [current]
                  : []
                : name === "returnRequests" ||
                    name === "salesControlRequests" ||
                    name === "purchaseReturnRequests"
                  ? []
                  : (domainRows[offset++] ?? []);
            return query;
          },
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
      // No receipt, deposit application, remittance, or custody in these fixtures.
      // Actual source-paid/custody behavior is covered by the DB router suites.
      execute: async () => [[]],
      insert: (table: Parameters<typeof getTableName>[0]) => {
        state.insertions.push(getTableName(table));
        const ins = {
          values: () => ins,
          onDuplicateKeyUpdate: async () => [{ insertId: 901 }],
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve([{ insertId: 901 }]).then(resolve, reject),
        };
        return ins;
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            state.updates.push(values);
          },
        }),
      }),
    };
    const { assertExecutionAuthoritiesTx } =
      await import("../../services/authorization/operationExecutionScope");
    await assertExecutionAuthoritiesTx(tx as unknown as Tx);
    return run(tx);
  },
}));
vi.mock("../../services/periodLockService", () => ({
  assertPeriodOpen: state.period,
}));
vi.mock("../../services/ledgerService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/ledgerService")>();
  return {
    ...actual,
    postEntry: state.postEntry,
    adjustCustomerBalance: state.adjustCustomerBalance,
    adjustSupplierBalance: state.adjustSupplierBalance,
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
  withFinancialRefreshScope: async <T>(work: () => Promise<T>) => ({
    value: await work(),
    scheduled: false,
  }),
}));
import { router } from "../../trpc";
import { returnRouter } from "../returnRouter";
const api = router({ returns: returnRouter });
const payload = {
  supplierId: 9,
  reference: "SUPPLIER-RETURN-ACK",
  evidenceType: "SUPPLIER_ACKNOWLEDGEMENT" as const,
  reason: "اتفاق موثق على إعادة البضاعة",
  clientRequestId: "cost-authority-test",
  items: [{ variantId: 1, productName: "صنف", quantity: 1, unitCost: "100" }],
  settlement: { method: "CREDIT_OFFSET" as const, totalAmount: "100" },
};
const policy = (cost: boolean, execute = true) => ({
  version: 1 as const,
  grants: {
    "operation.returns.executePurchaseReturnCart": execute,
    "operation.purchaseReturnGovernance.requestReturn": true,
  },
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
  state.adjustSupplierBalance.mockClear();
  state.updates = [];
  state.domainReads = [];
  state.insertions = [];
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
      expect(state.domainReads).toEqual([]);
      expect(state.insertions).toEqual([]);
      expect(state.updates).toEqual([]);
      expect(state.postEntry).not.toHaveBeenCalled();
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
      code: "CONFLICT",
      message: expect.stringContaining("المورد غير نشط"),
    });
    expect(state.period).not.toHaveBeenCalled();
    expect(state.domainReads).toContain("suppliers");
    expect(state.insertions).toEqual([]);
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
          code: "CONFLICT",
          message: expect.stringContaining("المورد غير نشط"),
        });
        expect(state.period).not.toHaveBeenCalled();
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
      api
        .createCaller(cashierCtx)
        .returns.getOpenRefundDrawers({ branchId: 2 }),
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
      message: expect.stringContaining(
        "لا يمكن إرجاع الفاتورة كلياً أو جزئياً",
      ),
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
      [
        {
          id: 3,
          variantId: 2,
          unitName: "خدمة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity productUnits
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
    expect(state.updates[0]).not.toHaveProperty(
      "returnedRestockedBaseQuantity",
    );
  });

  it("allocates walk-in stocked return revenue to SALES_STATIONERY and selects RETURN_SALE_INVENTORY", async () => {
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
    state.rows = [
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [], // digitalProductRows
      [{ variantId: 2, isService: false, isBundle: false }], // classifyVariants
      [], // consignByVariant
      [{ id: 2, costPrice: "5.00" }], // variantCostRows
      [
        {
          id: 3,
          variantId: 2,
          unitName: "قطعة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity productUnits
      [{ id: 9, variantId: 2, branchId: 2, quantity: 10 }], // applyMovement branchStock lock
    ];
    const result = await api
      .createCaller(managerCtx)
      .returns.executeSalesReturnCart({
        disposition: "RESTOCK",
        customer: { name: "زبون عابر" },
        items: [
          {
            variantId: 2,
            productUnitId: 3,
            productName: "دفتر جامعي",
            quantity: 2,
            unitPrice: "20.00",
          },
        ],
        settlement: {
          method: "CARD",
          totalAmount: "40.00",
          reference: "POS-REF-900",
        },
      });
    expect(result.ok).toBe(true);
    const returnCall = state.postEntry.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as Record<string, any>)?.entryType === "RETURN",
    );
    expect(returnCall).toBeDefined();
    const [, postedPayload] = returnCall as unknown as [
      unknown,
      Record<string, any>,
    ];
    expect(postedPayload.postingIntent.profile).toBe("RETURN_SALE_INVENTORY");
    expect(
      postedPayload.postingSourceComponents.roleDebits.SALES_STATIONERY.toFixed(
        2,
      ),
    ).toBe("40.00");
    expect(
      postedPayload.postingSourceComponents.roleDebits.SALES_PRINT.toFixed(2),
    ).toBe("0.00");
    expect(
      postedPayload.postingSourceComponents.roleDebits.INVENTORY.toFixed(2),
    ).toBe("10.00");
    expect(
      postedPayload.postingSourceComponents.roleCredits.COGS.toFixed(2),
    ).toBe("10.00");
  });

  it("rejects unlinked walk-in consignment returns without an original invoice", async () => {
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
    state.rows = [
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [], // digitalProductRows
      [{ variantId: 5, isService: false, isBundle: false }], // classifyVariants
      [{ vid: 5, isConsign: true, cId: 77 }], // consignByVariant
    ];
    await expect(
      api.createCaller(managerCtx).returns.executeSalesReturnCart({
        disposition: "RESTOCK",
        customer: { name: "زبون عابر" },
        items: [
          {
            variantId: 5,
            productName: "ملزمة أمانة",
            quantity: 1,
            unitPrice: "50.00",
          },
        ],
        settlement: {
          method: "CARD",
          totalAmount: "50.00",
          reference: "POS-REF-CONSIGN",
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("أصناف الأمانة"),
    });
    expect(state.postEntry).not.toHaveBeenCalled();
    expect(state.adjustSupplierBalance).not.toHaveBeenCalled();
  });

  it("rejects cross-branch invoice return in executeSalesReturnCart with FORBIDDEN for non-admin", async () => {
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
    state.rows = [
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [], // digitalProductRows
      [{ id: 91, branchId: 1, status: "PAID", sourceType: "POS" }], // invPreview (branch 1 != actor branch 2)
      [], // deliveryPreview
      [], // deliveryConsignments gap lock
      [
        {
          id: 91,
          invoiceNumber: "INV-91",
          branchId: 1,
          customerId: 7,
          status: "PAID",
          sourceType: "POS",
          invoiceDate: new Date("2026-10-15T00:00:00.000Z"),
          total: "50.00",
          paidAmount: "50.00",
          returnedTotal: "0.00",
        },
      ], // locked invoice
    ];
    await expect(
      api.createCaller(managerCtx).returns.executeSalesReturnCart({
        invoiceNumber: "INV-91",
        items: [
          {
            variantId: 1,
            productName: "صنف",
            quantity: 1,
            unitPrice: "50.00",
          },
        ],
        settlement: {
          method: "CARD",
          totalAmount: "50.00",
          reference: "POS-REF-CROSS",
        },
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("تعذر إرجاع الفاتورة من هذا الفرع"),
    });
    expect(state.postEntry).not.toHaveBeenCalled();
  });

  it("keeps invoice status active while a gift line remains unreturned, and keeps RETURN_SALE_SERVICE when returning a paid service line with a zero-revenue gift inventory line", async () => {
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

    // 1) Return only the paid service line while the gift inventory line remains unreturned:
    state.rows = [
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [], // digitalProductRows
      [{ id: 89, branchId: 2, status: "PAID", sourceType: "POS" }], // invPreview
      [], // deliveryPreview
      [], // deliveryConsignments gap lock
      [
        {
          id: 89,
          invoiceNumber: "INV-89",
          branchId: 2,
          customerId: 7,
          status: "PAID",
          sourceType: "POS",
          invoiceDate: originalInvoiceDate,
          subtotal: "30.00",
          discountAmount: "0.00",
          taxAmount: "0.00",
          total: "30.00",
          paidAmount: "30.00",
          returnedTotal: "0.00",
        },
      ], // locked invoice
      [], // installmentPlans
      [
        {
          id: 501,
          invoiceId: 89,
          variantId: 2,
          productUnitId: 3,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "30.00",
          total: "30.00",
          unitCost: "0.00",
          lineCost: "0.00",
          isGift: false,
        },
        {
          id: 502,
          invoiceId: 89,
          variantId: 1,
          productUnitId: 1,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "0.00",
          total: "0.00",
          unitCost: "5.00",
          lineCost: "5.00",
          isGift: true,
        },
      ], // invoiceItems
      [], // digitalSaleDetails
      [
        {
          id: 3,
          variantId: 2,
          unitName: "خدمة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity
      [{ variantId: 2, isService: true, isBundle: false }], // classifyVariants
      [], // consignByVariant
      [{ id: 2, costPrice: "0.00" }], // variantCostRows
      [], // reconcileDeliveryOnReturnTx
    ];
    await api.createCaller(managerCtx).returns.executeSalesReturnCart({
      invoiceNumber: "INV-89",
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
        method: "STORE_CREDIT",
        totalAmount: "30.00",
      },
    });
    const invoiceUpdatePartial = state.updates.find((u) => "status" in u);
    expect(invoiceUpdatePartial?.status).toBe("PAID");

    // 2) Return both the paid service line and the zero-revenue gift inventory line together:
    state.postEntry.mockClear();
    state.updates = [];
    state.rows = [
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [{ customRoleId: null }],
      [managerUserRow],
      [], // digitalProductRows
      [{ id: 90, branchId: 2, status: "PAID", sourceType: "POS" }], // invPreview
      [], // deliveryPreview
      [], // deliveryConsignments gap lock
      [
        {
          id: 90,
          invoiceNumber: "INV-90",
          branchId: 2,
          customerId: 7,
          status: "PAID",
          sourceType: "POS",
          invoiceDate: originalInvoiceDate,
          subtotal: "30.00",
          discountAmount: "0.00",
          taxAmount: "0.00",
          total: "30.00",
          paidAmount: "30.00",
          returnedTotal: "0.00",
        },
      ], // locked invoice
      [], // installmentPlans
      [
        {
          id: 501,
          invoiceId: 90,
          variantId: 2,
          productUnitId: 3,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "30.00",
          total: "30.00",
          unitCost: "0.00",
          lineCost: "0.00",
          isGift: false,
        },
        {
          id: 502,
          invoiceId: 90,
          variantId: 1,
          productUnitId: 1,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "0.00",
          total: "0.00",
          unitCost: "5.00",
          lineCost: "5.00",
          isGift: true,
        },
      ], // invoiceItems
      [], // digitalSaleDetails
      [
        {
          id: 3,
          variantId: 2,
          unitName: "خدمة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity item 1
      [
        {
          id: 1,
          variantId: 1,
          unitName: "قطعة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity item 2
      [
        { variantId: 2, isService: true, isBundle: false },
        { variantId: 1, isService: false, isBundle: false },
      ], // classifyVariants
      [], // consignByVariant
      [
        { id: 2, costPrice: "0.00" },
        { id: 1, costPrice: "5.00" },
      ], // variantCostRows
      [{ id: 9, variantId: 1, branchId: 2, quantity: 10 }], // applyMovement branchStock lock for gift item
      [], // reconcileDeliveryOnReturnTx
    ];
    await api.createCaller(managerCtx).returns.executeSalesReturnCart({
      invoiceNumber: "INV-90",
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
        {
          variantId: 1,
          invoiceItemId: 502,
          productUnitId: 1,
          productName: "هدية قرطاسية",
          quantity: 1,
          unitPrice: "0.00",
        },
      ],
      settlement: {
        method: "STORE_CREDIT",
        totalAmount: "30.00",
      },
    });
    expect(state.postEntry).toHaveBeenCalledTimes(2);
    const [, returnPayload] = state.postEntry.mock.calls[0] as unknown as [
      unknown,
      Record<string, any>,
    ];
    const [, giftPayload] = state.postEntry.mock.calls[1] as unknown as [
      unknown,
      Record<string, any>,
    ];
    expect(returnPayload.entryType).toBe("RETURN");
    expect(returnPayload.postingIntent.profile).toBe("RETURN_SALE_SERVICE");
    expect(returnPayload.cost.toFixed(2)).toBe("0.00");
    expect(giftPayload.entryType).toBe("GIFT_OUT");
    expect(giftPayload.cost.toFixed(2)).toBe("-5.00");
    const invoiceUpdateFull = state.updates.find((u) => "status" in u);
    expect(invoiceUpdateFull?.status).toBe("RETURNED");
  });

  it("posts RETURN_SALE_MIXED and PURCHASE_CONSIGNMENT with discounted/taxed multi-line rounding remainder allocation for mixed inventory + service + consignment return", async () => {
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
      [{ id: 95, branchId: 2, status: "UNPAID", sourceType: "POS" }], // invPreview
      [], // deliveryPreview
      [], // deliveryConsignments gap lock
      [
        {
          id: 95,
          invoiceNumber: "INV-95",
          branchId: 2,
          customerId: 7,
          status: "UNPAID",
          sourceType: "POS",
          invoiceDate: originalInvoiceDate,
          subtotal: "100.00",
          discountAmount: "1.00",
          taxAmount: "10.00",
          total: "109.00",
          paidAmount: "0.00",
          returnedTotal: "0.00",
        },
      ], // locked invoice
      [], // installmentPlans
      [
        {
          id: 601,
          invoiceId: 95,
          variantId: 1,
          productUnitId: 1,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "33.33",
          total: "33.33",
          unitCost: "5.00",
          lineCost: "5.00",
          isGift: false,
        },
        {
          id: 602,
          invoiceId: 95,
          variantId: 2,
          productUnitId: 3,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "33.33",
          total: "33.33",
          unitCost: "0.00",
          lineCost: "0.00",
          isGift: false,
        },
        {
          id: 603,
          invoiceId: 95,
          variantId: 5,
          productUnitId: 5,
          quantity: "1",
          baseQuantity: 1,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
          unitPrice: "33.34",
          total: "33.34",
          unitCost: "20.00",
          lineCost: "20.00",
          isGift: false,
        },
      ], // invoiceItems
      [], // digitalSaleDetails
      [
        {
          id: 1,
          variantId: 1,
          unitName: "قطعة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity item 601
      [
        {
          id: 3,
          variantId: 2,
          unitName: "خدمة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity item 602
      [
        {
          id: 5,
          variantId: 5,
          unitName: "نسخة",
          conversionFactor: "1",
          factor: "1",
        },
      ], // resolveReturnBaseQuantity item 603
      [
        { variantId: 1, isService: false, isBundle: false },
        { variantId: 2, isService: true, isBundle: false },
        { variantId: 5, isService: false, isBundle: false },
      ], // classifyVariants
      [{ vid: 5, isConsign: true, cId: 77 }], // consignByVariant
      [
        { id: 1, costPrice: "99.00" },
        { id: 2, costPrice: "0.00" },
        { id: 5, costPrice: "99.00" },
      ], // variantCostRows (historical lineCost 5.00 and 20.00 must win over live 99.00)
      [{ id: 9, variantId: 1, branchId: 2, quantity: 10 }], // applyMovement branchStock lock item 601
      [{ id: 10, variantId: 5, branchId: 2, quantity: 10 }], // applyMovement branchStock lock item 603
      [], // reconcileDeliveryOnReturnTx
    ];
    const result = await api
      .createCaller(managerCtx)
      .returns.executeSalesReturnCart({
        invoiceNumber: "INV-95",
        disposition: "RESTOCK",
        customer: { customerId: 7, name: "عميل" },
        items: [
          {
            variantId: 1,
            invoiceItemId: 601,
            productUnitId: 1,
            productName: "دفتر مملوك",
            quantity: 1,
            unitPrice: "36.33",
          },
          {
            variantId: 2,
            invoiceItemId: 602,
            productUnitId: 3,
            productName: "خدمة طباعة",
            quantity: 1,
            unitPrice: "36.33",
          },
          {
            variantId: 5,
            invoiceItemId: 603,
            productUnitId: 5,
            productName: "ملزمة أمانة",
            quantity: 1,
            unitPrice: "36.34",
          },
        ],
        settlement: {
          method: "CREDIT_OFFSET",
          totalAmount: "109.00",
        },
      });
    expect(result.ok).toBe(true);
    expect(state.postEntry).toHaveBeenCalledTimes(2);
    const [, returnPayload] = state.postEntry.mock.calls[0] as unknown as [
      unknown,
      Record<string, any>,
    ];
    const [, consignPayload] = state.postEntry.mock.calls[1] as unknown as [
      unknown,
      Record<string, any>,
    ];
    expect(returnPayload.entryType).toBe("RETURN");
    expect(returnPayload.postingIntent.profile).toBe("RETURN_SALE_MIXED");
    expect(returnPayload.amount.toFixed(2)).toBe("-109.00");
    expect(returnPayload.revenue.toFixed(2)).toBe("-99.00");
    expect(returnPayload.taxAmount.toFixed(2)).toBe("-10.00");
    expect(returnPayload.cost.toFixed(2)).toBe("-5.00");
    expect(returnPayload.profit.toFixed(2)).toBe("-94.00");
    expect(
      returnPayload.postingSourceComponents.roleDebits.SALES_STATIONERY.toFixed(
        2,
      ),
    ).toBe("66.00");
    expect(
      returnPayload.postingSourceComponents.roleDebits.SALES_PRINT.toFixed(2),
    ).toBe("33.00");
    expect(
      returnPayload.postingSourceComponents.roleDebits.INVENTORY.toFixed(2),
    ).toBe("5.00");
    expect(
      returnPayload.postingSourceComponents.roleCredits.COGS.toFixed(2),
    ).toBe("5.00");

    expect(consignPayload.entryType).toBe("PURCHASE");
    expect(consignPayload.supplierId).toBe(77);
    expect(consignPayload.invoiceId).toBe(95);
    expect(consignPayload.postingIntent.profile).toBe("PURCHASE_CONSIGNMENT");
    expect(consignPayload.amount.toFixed(2)).toBe("-20.00");
    expect(consignPayload.cost.toFixed(2)).toBe("-20.00");
    expect(consignPayload.profit.toFixed(2)).toBe("20.00");
    expect(state.adjustSupplierBalance).toHaveBeenCalledOnce();
    const [, cIdArg, deltaArg] = state.adjustSupplierBalance.mock
      .calls[0] as unknown as [
      unknown,
      number,
      { toFixed: (n: number) => string },
    ];
    expect(cIdArg).toBe(77);
    expect(deltaArg.toFixed(2)).toBe("-20.00");
  });
});

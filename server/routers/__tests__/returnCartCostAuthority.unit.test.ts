import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../context";
const state = vi.hoisted(() => ({ rows: [] as unknown[][], period: vi.fn() }));
vi.mock("../../services/tx", () => ({
  withTx: async (run: (tx: unknown) => Promise<unknown>) => {
    let offset = 0;
    const tx = {
      select: () => {
        const rows = state.rows[offset++] ?? [];
        const query = {
          from: () => query,
          where: () => query,
          for: () => query,
          limit: async () => rows,
        };
        return query;
      },
    };
    return run(tx);
  },
}));
vi.mock("../../services/periodLockService", () => ({
  assertPeriodOpen: state.period,
}));
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
beforeEach(() => state.period.mockReset());
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
});

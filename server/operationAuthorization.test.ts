import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { TrpcContext } from "./context";
import { assertOperationAuthorized } from "./operationAuthorization";
import { getOperationPermission, legacyOperationPolicy, operationPolicySchema, type OperationPolicy } from "@shared/operationPermissions";
import { resolvePermissions, type PermissionMap, type RoleKey } from "@shared/permissions";

vi.mock("./services/auditService", () => ({
  withMutationAuditScope: async (run: () => Promise<unknown>) => ({ value: await run(), specializedAuditWritten: true }),
  logAudit: vi.fn(), automaticActorForProcedure: vi.fn(), buildAutomaticAuditData: vi.fn(),
}));
vi.mock("./realtime/financialRefresh", () => ({ scheduleFinancialRefresh: vi.fn() }));
import {
  router, salesCashierProcedure, salesManagerProcedure, deliveryCashierProcedure,
  returnsProcedure, adminProcedure, publicProcedure, salesReadProcedure,
  directPrintBridgeProcedure, invoiceViewProcedure, requireAtomicPermission, canViewReports,
  digitalCardsPosProcedure, receptionDuplicateReadProcedure,
  customerReadAllowed, customerReceptionCreateAllowed,
  workordersCashierProcedure,
} from "./trpc";

function context(grants: Record<string, boolean>, overrides: Record<string, unknown> = {}): TrpcContext {
  const policy: OperationPolicy = { version: 1, grants };
  return {
    req: {}, res: {}, sessionId: null, nativeClientId: null, platformAdmin: null,
    user: { id: 17, role: "warehouse", branchId: 2, isOwner: false,
      permissionsOverride: { sales: "NONE", store: "NONE", workorders: "NONE", pos: "NONE" },
      operationPolicyEnabled: true, resolvedOperationPolicy: policy,
      resolvedAtomicPermissions: { "pos.invoice.create": false, "pos.return.create": false },
      ...overrides,
    },
  } as unknown as TrpcContext;
}

const receptionCheckoutProcedure = workordersCashierProcedure
  .input(z.object({ delivery: z.unknown().nullish(), regularSale: z.unknown().nullish(), printSale: z.unknown().nullish() }).optional())
  .mutation(({ ctx }) => ctx.user.id);

const api = router({
  sales: router({
    create: salesCashierProcedure.input(z.object({ delivery: z.unknown().optional() }).optional()).mutation(({ ctx }) => ctx.user.id),
    correct: salesManagerProcedure.mutation(() => "correct"),
    list: salesReadProcedure.query(({ ctx }) => ({ branch: ctx.scopedBranchId, owner: ctx.scopedOwnerId })),
    unregistered: salesCashierProcedure.mutation(() => "unclassified"),
  }),
  delivery: router({ dispatchInvoice: deliveryCashierProcedure.mutation(() => "assigned") }),
  returns: router({ create: returnsProcedure.mutation(() => "returned"), executePurchaseReturnCart: salesManagerProcedure.mutation(() => "purchase-returned") }),
  invoicePrinting: router({
    authorizeBridge: directPrintBridgeProcedure.query(() => true),
    requestPrint: invoiceViewProcedure.use(requireAtomicPermission("pos.invoice.print")).mutation(() => true),
    requestReprint: invoiceViewProcedure.use(requireAtomicPermission("pos.invoice.reprint")).mutation(() => true),
  }),
  digitalCards: router({ sales: router({ prepare: digitalCardsPosProcedure.mutation(() => "prepared"), finalize: digitalCardsPosProcedure.mutation(() => "finalized") }) }),
  workOrders: router({ receptionCheckout: receptionCheckoutProcedure }),
  reception: router({
    duplicateOrders: receptionDuplicateReadProcedure.query(() => "checked"),
    draftCommit: receptionCheckoutProcedure,
  }),
  roles: router({ create: adminProcedure.mutation(() => "reserved") }),
  auth: router({ login: publicProcedure.mutation(() => "public") }),
});

describe("actual procedure delegation", () => {
  it.each([true, false])("retired purchase keys preserve old cashier print policies without opening company finance: %s", async (oldGrant) => {
    const saved = operationPolicySchema.parse({
      version: 1, grants: {
        "operation.purchases.pay": oldGrant,
        "operation.purchaseReturns.create": oldGrant,
        "operation.invoicePrinting.requestPrint": true,
      },
      recordScopes: { "operation.purchases.pay": "BRANCH" },
      dataVisibility: { purchaseCost: false, profitMargin: false },
    });
    expect(saved.grants).toEqual({ "operation.invoicePrinting.requestPrint": true });
    expect(saved.recordScopes).toEqual({});
    expect(saved.dataVisibility).toEqual({ purchaseCost: false, profitMargin: false });
    for (const path of ["purchases.pay", "purchaseReturns.create"]) {
      expect(getOperationPermission(path)).toMatchObject({ delegable: false, reservedKind: "RETIRED" });
    }
    await expect(api.createCaller(context(saved.grants, { role: "cashier" })).invoicePrinting.requestPrint()).resolves.toBe(true);
  });
  it.each(["workOrders.receptionCheckout"] as const)(
    "requires independent delivery authority for %s", async (path) => {
      const caller = api.createCaller(context({
        [`operation.${path}`]: true,
        "operation.delivery.dispatchInvoice": false,
      }, { permissionsOverride: { store: "FULL" } }));
      const checkout = path === "workOrders.receptionCheckout"
        ? caller.workOrders.receptionCheckout : caller.reception.draftCommit;
      await expect(checkout({ delivery: { partyId: 4 }, regularSale: { lines: [{}] } }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );
  it.each(["workOrders.receptionCheckout", "reception.draftCommit"] as const)(
    "does not mistake work-order delivery metadata for invoice dispatch on %s", async (path) => {
      const caller = api.createCaller(context({ [`operation.${path}`]: true, "operation.delivery.dispatchInvoice": false }));
      const checkout = path === "workOrders.receptionCheckout" ? caller.workOrders.receptionCheckout : caller.reception.draftCommit;
      await expect(checkout({ delivery: { partyId: 4 } })).resolves.toBe(17);
    },
  );
  it("requires cost visibility on the purchase-return mutation, independently of its grant", async () => {
    expect(getOperationPermission("returns.executePurchaseReturnCart")?.requiresCostVisibility).toBe(true);
    await expect(api.createCaller(context({ "operation.returns.executePurchaseReturnCart": true })).returns.executePurchaseReturnCart())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const ctx = context({ "operation.returns.executePurchaseReturnCart": true });
    ctx.user!.resolvedOperationPolicy!.dataVisibility = { purchaseCost: true, profitMargin: true };
    await expect(api.createCaller(ctx).returns.executePurchaseReturnCart()).resolves.toBe("purchase-returned");
  });
  it.each(["workOrders.receptionCheckout", "reception.draftCommit"] as const)(
    "permits independently granted delivery on %s", async (path) => {
      const caller = api.createCaller(context({
        [`operation.${path}`]: true,
        "operation.delivery.dispatchInvoice": true,
      }));
      const checkout = path === "workOrders.receptionCheckout"
        ? caller.workOrders.receptionCheckout : caller.reception.draftCommit;
      await expect(checkout({ delivery: { partyId: 4 } })).resolves.toBe(17);
    },
  );
  it.each(["workOrders.receptionCheckout", "reception.draftCommit"] as const)(
    "does not require delivery authority for null or absent delivery on %s", async (path) => {
      const caller = api.createCaller(context({
        [`operation.${path}`]: true,
        "operation.delivery.dispatchInvoice": false,
      }));
      const checkout = path === "workOrders.receptionCheckout"
        ? caller.workOrders.receptionCheckout : caller.reception.draftCommit;
      await expect(checkout({ delivery: null })).resolves.toBe(17);
      await expect(checkout({})).resolves.toBe(17);
      await expect(checkout()).resolves.toBe(17);
    },
  );
  it.each(["workOrders.receptionCheckout", "reception.draftCommit"] as const)(
    "preserves legacy checkout and owner authority on %s", async (path) => {
      for (const ctx of [
        context({}, { role: "cashier", operationPolicyEnabled: false,
          resolvedOperationPolicy: null, permissionsOverride: { workorders: "FULL", store: "NONE" } }),
        context({}, { role: "admin", isOwner: true }),
      ]) {
        const caller = api.createCaller(ctx);
        const checkout = path === "workOrders.receptionCheckout"
          ? caller.workOrders.receptionCheckout : caller.reception.draftCommit;
        await expect(checkout({ delivery: { partyId: 4 } })).resolves.toBe(17);
      }
    },
  );
  it("does not derive financial payload access from a compatibility module summary", () => {
    expect(canViewReports(context({ "operation.shifts.current": true }, { role: "cashier", permissionsOverride: { reports: "FULL" } }).user!)).toBe(false);
    expect(canViewReports(context({ "operation.reports.treasurySummary": true }).user!)).toBe(true);
    expect(canViewReports(context({ "operation.reports.dashboardMetrics": true }).user!)).toBe(true);
  });
  it("canonical reception printing bypasses obsolete atomic denials only for selected print actions", async () => {
    const caller = api.createCaller(context({
      "operation.invoicePrinting.requestPrint": true,
      "operation.invoicePrinting.requestReprint": true,
      "operation.invoicePrinting.authorizeBridge": true,
    }, { role: "cashier", resolvedAtomicPermissions: { "pos.invoice.print": false, "pos.invoice.reprint": false } }));
    await expect(caller.invoicePrinting.requestPrint()).resolves.toBe(true);
    await expect(caller.invoicePrinting.requestReprint()).resolves.toBe(true);
    await expect(caller.invoicePrinting.authorizeBridge()).resolves.toBe(true);
    await expect(api.createCaller(context({})).invoicePrinting.requestPrint()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each([
    ["manager", { customers: "NONE" }], ["cashier", { customers: "NONE", crm: "NONE", sales: "NONE", pos: "NONE", workorders: "FULL" }],
    ["warehouse", { customers: "FULL", crm: "NONE", workorders: "NONE" }], ["warehouse", { crm: "NONE", workorders: "READ" }],
    ["print_operator", { crm: "NONE", pos: "NONE", workorders: "FULL" }],
  ] as const)("preserves customer-read and reception-resolution alternatives for %s %j", (role, override) => {
    const modules = resolvePermissions(role as RoleKey, override);
    const snapshot = legacyOperationPolicy(role, modules, override);
    expect(snapshot.grants["operation.customers.get"]).toBe(customerReadAllowed({ role, permissionsOverride: override }));
    expect(snapshot.grants["operation.customers.receptionResolveByPhone"]).toBe(customerReceptionCreateAllowed({ role, permissionsOverride: override }));
  });
  it("delegates digital preparation and duplicate advice without reopening obsolete selling modules", async () => {
    const caller = api.createCaller(context({ "operation.digitalCards.sales.prepare": true, "operation.reception.duplicateOrders": true }));
    expect(await caller.digitalCards.sales.prepare()).toBe("prepared");
    expect(await caller.reception.duplicateOrders()).toBe("checked");
    await expect(caller.digitalCards.sales.finalize()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.createCaller(context({ "operation.reception.duplicateOrders": true }, { branchId: null })).reception.duplicateOrders()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("keeps the legacy digital selling-station prerequisite in migration snapshots", () => {
    const modules: PermissionMap = { digital_cards: "READ", sales: "NONE", workorders: "NONE", pos: "FULL" };
    expect(legacyOperationPolicy("warehouse", modules, modules).grants["operation.digitalCards.sales.prepare"]).toBe(false);
    modules.workorders = "FULL";
    expect(legacyOperationPolicy("warehouse", modules, modules).grants["operation.digitalCards.sales.prepare"]).toBe(true);
  });
  it.each([
    [{ workorders: "READ" }, false],
    [{ workorders: "FULL" }, true],
    [{ sales: "READ" }, true],
    [{ pos: "READ" }, false],
    [{ pos: "FULL" }, true],
  ] as const)("preserves invoice alternatives and their distinct levels: %j", (selected, allowed) => {
    const modules: PermissionMap = { sales: "NONE", workorders: "NONE", pos: "NONE", ...selected };
    const snapshot = legacyOperationPolicy("warehouse", modules, modules);
    for (const path of ["sales.get", "invoicePrinting.requestPrint", "invoicePrinting.requestReprint"]) {
      expect(snapshot.grants[`operation.${path}`], path).toBe(allowed);
    }
  });
  it.each([
    [{ products: "READ" }, false, false],
    [{ sales: "FULL" }, false, true],
    [{ workorders: "FULL" }, false, false],
    [{ sales: "FULL", products: "READ" }, true, true],
    [{ workorders: "FULL", products: "READ" }, true, true],
  ] as const)("preserves correction conjunctions: %j", (selected, editing, comparison) => {
    const modules: PermissionMap = { sales: "NONE", workorders: "NONE", products: "NONE", ...selected };
    const snapshot = legacyOperationPolicy("warehouse", modules, modules);
    expect(snapshot.grants["operation.sales.lookupForCorrection"]).toBe(editing);
    expect(snapshot.grants["operation.sales.reissue"]).toBe(editing);
    expect(snapshot.grants["operation.salesControl.correctionCatalog"]).toBe(comparison);
  });
  it("preserves the legacy bridge exception without granting couriers", () => {
    const modules: PermissionMap = { sales: "NONE" };
    expect(legacyOperationPolicy("warehouse", modules, modules).grants["operation.invoicePrinting.authorizeBridge"]).toBe(true);
    expect(legacyOperationPolicy("courier", { sales: "FULL" }, { sales: "FULL" }).grants["operation.invoicePrinting.authorizeBridge"]).toBe(false);
  });
  it("enforces the same independent hardware bridge gate for canonical and legacy sessions", async () => {
    expect(await api.createCaller(context({ "operation.invoicePrinting.authorizeBridge": true }, { role: "courier" })).invoicePrinting.authorizeBridge()).toBe(true);
    await expect(api.createCaller(context({ "operation.invoicePrinting.authorizeBridge": false })).invoicePrinting.authorizeBridge()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.createCaller(context({}, { role: "courier", operationPolicyEnabled: false, resolvedOperationPolicy: null })).invoicePrinting.authorizeBridge()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await api.createCaller(context({}, { role: "warehouse", operationPolicyEnabled: false, resolvedOperationPolicy: null })).invoicePrinting.authorizeBridge()).toBe(true);
  });
  it("protects raw digital sale cost and profit independently of the detail read grant", () => {
    const ctx = context({ "operation.digitalCards.sales.saleDetails": true });
    expect(() => assertOperationAuthorized(ctx.user!, "digitalCards.sales.saleDetails")).toThrow();
    ctx.user!.resolvedOperationPolicy!.dataVisibility = { purchaseCost: true, profitMargin: true };
    expect(() => assertOperationAuthorized(ctx.user!, "digitalCards.sales.saleDetails")).not.toThrow();
  });
  it("executes only a selected operation across obsolete role, module and atomic gates", async () => {
    const caller = api.createCaller(context({ "operation.sales.create": true }));
    expect(await caller.sales.create()).toBe(17);
    await expect(caller.sales.correct()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.delivery.dispatchInvoice()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("delivery assignment and sales return are separately delegated", async () => {
    const caller = api.createCaller(context({ "operation.delivery.dispatchInvoice": true, "operation.returns.create": true }));
    expect(await caller.delivery.dispatchInvoice()).toBe("assigned");
    expect(await caller.returns.create()).toBe("returned");
    await expect(caller.sales.create()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("requires a separate delivery assignment grant when a sale composes that operation", async () => {
    const caller = api.createCaller(context({ "operation.sales.create": true }));
    await expect(caller.sales.create({ delivery: { partyId: 4 } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const delegated = api.createCaller(context({ "operation.sales.create": true, "operation.delivery.dispatchInvoice": true }));
    expect(await delegated.sales.create({ delivery: { partyId: 4 } })).toBe(17);
  });
  it("explicit canonical denial still blocks an admin operational action", async () => {
    await expect(api.createCaller(context({ "operation.sales.create": false }, { role: "admin" })).sales.create())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("honors an ordinary admin's selected OWN scope while retaining owner rescue authority", async () => {
    const caller = api.createCaller(context({ "operation.sales.list": true }, { role: "admin" }));
    expect(await caller.sales.list()).toEqual({ branch: null, owner: 17 });
    const owner = api.createCaller(context({}, { role: "admin", isOwner: true }));
    expect(await owner.sales.list()).toEqual({ branch: null, owner: null });
  });
  it("does not drop the assigned-branch prerequisite", async () => {
    await expect(api.createCaller(context({ "operation.delivery.dispatchInvoice": true }, { branchId: null })).delivery.dispatchInvoice())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("fails closed for newly added paths until their operation is inventoried", async () => {
    await expect(api.createCaller(context({})).sales.unregistered()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("preserves identity administration, owner authority and public authentication", async () => {
    const caller = api.createCaller(context({ "operation.roles.create": true }));
    await expect(caller.roles.create()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await caller.auth.login()).toBe("public");
    expect(() => assertOperationAuthorized(context({}).user! as never, "sales.create")).toThrow();
    expect(() => assertOperationAuthorized({ role: "admin", isOwner: true, operationPolicyEnabled: true }, "sales.create")).not.toThrow();
  });
  it("preserves existing users until a canonical policy is saved", async () => {
    const caller = api.createCaller(context({}, { role: "cashier", operationPolicyEnabled: false, resolvedOperationPolicy: null, permissionsOverride: null }));
    expect(await caller.sales.create()).toBe(17);
  });
  it("applies independent supported owner/branch record scopes", async () => {
    expect(getOperationPermission("sales.list")?.supportsRecordScope).toBe(true);
    const ownCtx = context({ "operation.sales.list": true });
    expect(await api.createCaller(ownCtx).sales.list()).toEqual({ branch: 2, owner: 17 });
    ownCtx.user!.resolvedOperationPolicy!.recordScopes = { "operation.sales.list": "BRANCH" };
    expect(await api.createCaller(ownCtx).sales.list()).toEqual({ branch: 2, owner: null });
  });
  it("enforces role-level atomic revocations on custom roles based on user or print_operator", async () => {
    const customRoleRevokedCtx = context(
      {},
      {
        role: "user",
        customRoleKey: "custom_print_station",
        customRoleId: 9,
        operationPolicyEnabled: false,
        resolvedOperationPolicy: null,
        permissionsOverride: { pos: "FULL" },
        atomicPermissions: null,
        resolvedAtomicPermissions: {
          "pos.return.create": false,
          "pos.invoice.void": false,
        },
      },
    );
    await expect(api.createCaller(customRoleRevokedCtx).returns.create()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});


import { randomUUID } from "node:crypto";
import { DECISION_REGISTRY } from "@shared/decisionRegistry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import {
  DECISION_SOURCES,
  decideDecision,
  listDecisionInbox,
} from "../decisions";
import { sourceOperationPaths } from "../decisions/authority";
import { notifyApprovalPendingByReceipt } from "../approvalEventNotifier";
import { voucherSource } from "../decisions/sources/treasury";
import { pageCursorSchema, MAX_DELIVERED_KEYS } from "../decisions/paging";
import { createPurchaseOrder } from "../purchase/order";
import { requestPurchaseOrderControl } from "../purchase/controls";
import { createVoucher } from "../voucher/create";
const db = () => getDb()!;
const owner = {
  userId: 1,
  role: "admin",
  isOwner: true,
  branchId: 1,
  crossBranch: true,
  permissionsOverride: null,
};
const policy = (allowed: boolean) => ({
  version: 1 as const,
  grants: {
    "operation.purchases.decideControl": allowed,
    "operation.decisions.decide": true,
    "operation.decisions.inbox": true,
  },
});
const reviewer = (allowed: boolean, purchases: "NONE" | "FULL" = "FULL") => ({
  userId: 2,
  role: "manager",
  isOwner: false,
  branchId: 1,
  crossBranch: false,
  permissionsOverride: { purchases },
  operationPolicy: policy(allowed),
});
function caller(actor: ReturnType<typeof reviewer>) {
  return appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user: {
      ...actor,
      id: actor.userId,
      isActive: true,
      resolvedOperationPolicy: actor.operationPolicy,
      operationPolicyEnabled: true,
    },
  } as never);
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Synthetic main", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Synthetic branch", code: "SECOND", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "remediation-owner",
        role: "admin",
        branchId: 1,
        isOwner: true,
        loginMethod: "local",
      },
      {
        id: 2,
        openId: "remediation-reviewer",
        role: "manager",
        branchId: 1,
        isOwner: false,
        loginMethod: "local",
        permissionsOverride: { purchases: "FULL" },
        operationPolicy: policy(false),
      },
      {
        id: 3,
        openId: "remediation-maker",
        role: "manager",
        branchId: 1,
        isOwner: false,
        loginMethod: "local",
        permissionsOverride: { purchases: "FULL" },
      },
    ]);
});
async function pendingPurchase() {
  await db().insert(s.suppliers).values({ id: 1, name: "Synthetic supplier" });
  await db()
    .insert(s.purchaseControlSettings)
    .values({
      branchId: 1,
      requireRequisition: true,
      allowEmergencyOrder: true,
      requireEmergencyApproval: true,
    });
  await db().insert(s.products).values({ id: 1, name: "Synthetic item" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "REMEDIATION-1", costPrice: "100.00" });
  await db()
    .insert(s.productUnits)
    .values({
      id: 1,
      variantId: 1,
      unitName: "unit",
      conversionFactor: "1",
      isBaseUnit: true,
    });
  const maker = { userId: 3, branchId: 1, role: "manager" };
  const po = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      clientRequestId: randomUUID(),
      revisionReason: "Synthetic review",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
    },
    maker,
  );
  const request = await requestPurchaseOrderControl(
    {
      purchaseOrderId: po.purchaseOrderId,
      revisionId: po.revisionId,
      expectedVersion: po.version,
      kind: "EMERGENCY_ORDER",
      requestKey: randomUUID(),
      reason: "Synthetic emergency",
    },
    maker,
  );
  return request.requestId;
}
async function seedVouchers(count: number) {
  await db()
    .insert(s.receipts)
    .values(
      Array.from({ length: count }, (_, index) => ({
        branchId: 1,
        direction: "OUT" as const,
        amount: "10.00",
        paymentMethod: "TRANSFER" as const,
        status: "PENDING" as const,
        approvalStatus: "PENDING_APPROVAL" as const,
        voucherNumber: `REMEDIATION-V-${index}`,
        partyType: "OTHER" as const,
        createdBy: 3,
      })),
    );
}
describe("decisions remediation", () => {
  it("retains owner sales review fallback and original operation-only delegated proof", async () => {
    await db().insert(s.invoices).values({ id: 1, invoiceNumber: "FIX2-SALE", sourceType: "POS", branchId: 1,
      subtotal: "10.00", total: "10.00", paidAmount: "0.00", status: "PENDING", createdBy: 3 });
    const inserted = await db().insert(s.salesControlRequests).values({ requestKey: "fix2-sale", invoiceId: 1,
      branchId: 1, requestType: "SALES_DUE_DATE_CHANGE", payload: { dueDate: "2026-12-01" },
      payloadHash: "a".repeat(64), invoiceSnapshot: {}, snapshotHash: "b".repeat(64), reason: "Synthetic review", requestedBy: 3 });
    const id = Number(inserted[0].insertId);
    const input = { kind: "sales.control.approve", branchId: 1 };
    const ownerRows = await listDecisionInbox(owner, input);
    expect(ownerRows.failedSources).toEqual([]);
    expect(ownerRows.rows.map(row => row.id)).toContain(id);
    const operationPolicy = { version: 1 as const, grants: { "operation.salesControl.approve": true,
      "operation.salesControl.reject": false, "operation.decisions.inbox": true, "operation.decisions.decide": true } };
    await db().update(s.users).set({ operationPolicy, permissionsOverride: { sales: "NONE" } }).where(eq(s.users.id, 2));
    const delegated = await listDecisionInbox(reviewer(true), input);
    expect(delegated.failedSources).toEqual([]);
    expect(delegated.rows).toContainEqual(expect.objectContaining({ id, allowedActions: ["APPROVE"] }));
    await expect(decideDecision({ kind: input.kind, id, action: "REJECT", reason: "Synthetic denied review", clientRequestId: randomUUID() }, reviewer(true)))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.users).set({ operationPolicy: { ...operationPolicy, grants: { ...operationPolicy.grants, "operation.salesControl.approve": false } } }).where(eq(s.users.id, 2));
    expect((await listDecisionInbox(reviewer(true), input)).rows).toEqual([]);
  });
  it("delivers every still-pending voucher with limit200 after an earlier concurrent rejection", async () => {
    await seedVouchers(203);
    await db().update(s.receipts).set({ createdAt: new Date("2026-01-01T00:00:00Z") });
    const originalIds = (await db().select({ id: s.receipts.id }).from(s.receipts)).map(row => row.id);
    const input = { kind: "treasury.voucher.approve", branchId: 1, limit: 200 };
    const first = await listDecisionInbox(owner, input);
    expect(first.rows).toHaveLength(200);
    expect(first.nextPageCursor).toBeDefined();
    expect(first.truncatedSources[0]?.cursor).toBeUndefined();
    await decideDecision({ kind: input.kind, id: first.rows[0]!.id, action: "REJECT", reason: "Synthetic concurrent rejection", clientRequestId: randomUUID() }, owner);
    const second = await listDecisionInbox(owner, { ...input, pageCursor: first.nextPageCursor! });
    expect(second.nextPageCursor).toBeNull();
    const delivered = [...first.rows, ...second.rows];
    const sourceCursor = second.truncatedSources[0]?.cursor;
    expect(sourceCursor).toBeDefined();
    await expect(listDecisionInbox(owner, { ...input, sourceCursor, pageCursor: first.nextPageCursor! })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    if (sourceCursor) delivered.push(...(await listDecisionInbox(owner, { ...input, sourceCursor })).rows);
    expect(new Set(delivered.map(row => row.id)).size).toBe(delivered.length);
    expect(delivered.map(row => row.id).sort((a, b) => a - b)).toEqual(originalIds.sort((a, b) => a - b));
  });
  it("continues beyond 201 self-created controls through decisions authority alone", async () => {
    const originalId = await pendingPurchase();
    const original = (await db().select().from(s.purchaseOrderControlRequests).where(eq(s.purchaseOrderControlRequests.id, originalId)))[0]!;
    await db().update(s.purchaseOrderControlRequests).set({ requestedBy: 2 }).where(eq(s.purchaseOrderControlRequests.id, originalId));
    const { id: _id, ...template } = original;
    await db().insert(s.purchaseOrderControlRequests).values(Array.from({ length: 200 }, (_, i) => ({
      ...template, requestKey: `scan-self-${i}`, pendingGuard: `scan-self-${i}`, requestedBy: 2,
    })));
    const inserted = await db().insert(s.purchaseOrderControlRequests).values({ ...template, requestKey: "scan-eligible", pendingGuard: "scan-eligible", requestedBy: 3 });
    const eligibleId = Number(inserted[0].insertId);
    const operationPolicy = { ...policy(true), grants: { ...policy(true).grants, "operation.purchases.pendingControls": false } };
    await db().update(s.users).set({ operationPolicy, permissionsOverride: { purchases: "NONE" } }).where(eq(s.users.id, 2));
    const api = caller({ ...reviewer(true, "NONE"), operationPolicy });
    await expect(api.purchases.pendingControls({ limit: 200 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const first = await api.decisions.inbox({ kind: "purchase.order.control", branchId: 1 });
    expect(first.rows).toEqual([]);
    const cursor = first.truncatedSources[0]?.cursor;
    expect(cursor).toBeDefined();
    const withoutBranch = await api.decisions.inbox({ kind: "purchase.order.control" });
    await db().update(s.users).set({ branchId: 2 }).where(eq(s.users.id, 2));
    await expect(api.decisions.inbox({ kind: "purchase.order.control", sourceCursor: withoutBranch.truncatedSources[0]!.cursor })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.users).set({ branchId: 1 }).where(eq(s.users.id, 2));
    const next = await api.decisions.inbox({ kind: "purchase.order.control", branchId: 1, sourceCursor: cursor });
    expect(next.rows.map(row => row.id)).toContain(eligibleId);
    expect(next.rows.every(row => row.requestedBy !== 2)).toBe(true);
    await expect(api.decisions.inbox({ branchId: 2, sourceCursor: cursor })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.users).set({ operationPolicy: policy(false) }).where(eq(s.users.id, 2));
    await expect(api.decisions.inbox({ branchId: 1, sourceCursor: cursor })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("maps each wired source and executable action to original authority", () => {
    for (const source of DECISION_SOURCES) {
      expect(sourceOperationPaths(source).length, source.key).toBeGreaterThan(
        0,
      );
      for (const action of source.supportedActions)
        expect(
          sourceOperationPaths(source, action),
          `${source.key}:${action}`,
        ).toHaveLength(1);
    }
  });
  it("advances branch partitions independently without replaying completed branches", async () => {
    await db().insert(s.purchaseIntegrityCases).values(Array.from({ length: 203 }, (_, index) => ({
      caseNumber: `SCAN-INTEGRITY-${index}`, caseKey: `scan-integrity-${index}`,
      branchId: index === 0 ? 2 : 1, code: "OTHER" as const, status: "PENDING_RESOLUTION" as const,
      title: "Synthetic integrity", description: "Synthetic", evidenceSnapshot: "{}", evidenceHash: "a".repeat(64),
      openedBy: 3, resolutionRequestKey: `scan-resolution-${index}`, resolutionRequestHash: "b".repeat(64),
      pendingResolutionGuard: `scan-resolution-${index}`, resolutionReason: "Synthetic evidence reviewed",
      resolutionRequestedBy: 3, resolutionRequestedAt: new Date("2026-01-01T00:00:00Z"),
      detectedAt: new Date("2026-01-01T00:00:00Z"),
    })));
    const input = { kind: "purchase.integrity.resolution", limit: 500 };
    const first = await listDecisionInbox(owner, input);
    expect(first.failedSources).toEqual([]);
    expect(first.rows).toHaveLength(201);
    const cursor = first.truncatedSources[0]!.cursor!;
    expect(cursor.positions["2"]).toBeNull();
    const next = await listDecisionInbox(owner, { ...input, sourceCursor: cursor });
    expect(next.failedSources).toEqual([]);
    expect(next.rows).toHaveLength(2);
    expect(next.rows.every(row => row.branchId === 1 && !first.rows.some(old => old.id === row.id))).toBe(true);
    expect(next.hasMore).toBe(false);
  });
  it("continues real voucher timestamp pages without skipping after an earlier decision", async () => {
    await seedVouchers(203);
    await db().update(s.receipts).set({ createdAt: new Date("2026-01-01T00:00:00Z") });
    await db().update(s.receipts).set({ createdAt: new Date("2026-01-03T00:00:00Z") }).where(eq(s.receipts.voucherNumber, "REMEDIATION-V-0"));
    const first = await listDecisionInbox(owner, { kind: "treasury.voucher.approve", limit: 500 });
    expect(first.rows).toHaveLength(201);
    const cursor = first.truncatedSources[0]!.cursor!;
    expect(cursor.positions.all?.at).toBe("2026-01-01T00:00:00.000Z");
    await decideDecision({ kind: "treasury.voucher.approve", id: first.rows[0]!.id,
      action: "REJECT", clientRequestId: randomUUID(), reason: "Synthetic earlier rejection" }, owner);
    const next = await listDecisionInbox(owner, { kind: "treasury.voucher.approve", limit: 500, sourceCursor: cursor });
    expect(next.failedSources).toEqual([]);
    expect(next.rows).toHaveLength(2);
    expect(next.rows.every(row => !first.rows.some(previous => previous.id === row.id))).toBe(true);
    expect(next.rows[0]!.requestedAt < next.rows[1]!.requestedAt).toBe(true);
    expect(next.hasMore).toBe(false);
    expect(next.scanPage).toBe(true);
    expect(next.totalIsExact).toBe(false); // Earlier pending rows and other sources are outside this scan page.
    await expect(listDecisionInbox(owner, { kind: "treasury.voucher.approve", sourceCursor: {
      ...cursor, positions: { all: { id: cursor.positions.all!.id } },
    } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("continues the actual 500-row inventory adapter after an empty eligible page", async () => {
    await pendingPurchase();
    await db().update(s.users).set({ operationPolicy: { version: 1, grants: { "operation.inventory.approveAdjustment": true } } }).where(eq(s.users.id, 2));
    await db().insert(s.stockAdjustmentRequests).values(Array.from({ length: 501 }, (_, index) => ({
      variantId: 1, branchId: 1, targetQuantity: 1, expectedQuantity: 0, createdBy: index < 500 ? 2 : 3,
    })));
    const input = { kind: "inventory.adjustment.approve", branchId: 1, limit: 500 };
    const first = await listDecisionInbox(reviewer(true), input);
    expect(first.rows).toEqual([]);
    expect(first.truncatedSources[0]?.cursor).toBeDefined();
    const next = await listDecisionInbox(reviewer(true), { ...input, sourceCursor: first.truncatedSources[0]!.cursor });
    expect(next.failedSources).toEqual([]);
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]!.requestedBy).toBe(3);
    expect(next.hasMore).toBe(false);
  });
  it("preserves month-close timestamp ordering and equal-time ID continuation", async () => {
    await db().insert(s.monthCloseRequests).values(Array.from({ length: 102 }, (_, index) => ({
      month: "2026-01", readinessSnapshot: "{}", requestedBy: 3,
      requestedAt: new Date(index === 0 ? "2026-01-03T00:00:00Z" : "2026-01-01T00:00:00Z"),
    })));
    const input = { kind: "closing.monthClose.approve", limit: 500 };
    const first = await listDecisionInbox(owner, input);
    expect(first.rows).toHaveLength(100);
    const next = await listDecisionInbox(owner, { ...input, sourceCursor: first.truncatedSources[0]!.cursor });
    expect(next.failedSources).toEqual([]);
    expect(next.rows).toHaveLength(2);
    expect(next.rows.every(row => !first.rows.some(previous => previous.id === row.id))).toBe(true);
    expect(next.rows[0]!.requestedAt < next.rows[1]!.requestedAt).toBe(true);
    expect(next.hasMore).toBe(false);
  });
  it("denies underlying purchase operation despite generic decision permission", async () => {
    const id = await pendingPurchase();
    await expect(
      caller(reviewer(false)).decisions.decide({
        kind: "purchase.order.control",
        id,
        action: "APPROVE",
        clientRequestId: randomUUID(),
        reason: "Synthetic review",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (
        await db()
          .select()
          .from(s.purchaseOrderControlRequests)
          .where(eq(s.purchaseOrderControlRequests.id, id))
      )[0]?.status,
    ).toBe("PENDING");
  });
  it("discovers and decides a specifically delegated operation with legacy module NONE", async () => {
    const id = await pendingPurchase();
    await db()
      .update(s.users)
      .set({
        operationPolicy: policy(true),
        permissionsOverride: { purchases: "NONE" },
      })
      .where(eq(s.users.id, 2));
    expect(
      (await caller(reviewer(true, "NONE")).decisions.inbox()).rows.some(
        (r) => r.kind === "purchase.order.control" && r.id === id,
      ),
    ).toBe(true);
    await expect(
      caller(reviewer(true, "NONE")).decisions.decide({
        kind: "purchase.order.control",
        id,
        action: "APPROVE",
        clientRequestId: randomUUID(),
        reason: "Synthetic review",
      }),
    ).resolves.toMatchObject({ outcome: "EXECUTED" });
    expect(
      (
        await db()
          .select()
          .from(s.purchaseOrderControlRequests)
          .where(eq(s.purchaseOrderControlRequests.id, id))
      )[0]?.status,
    ).toBe("APPROVED");
  });
  it("includes ordinary invoice-linked refund and excludes a domain-owned component refund", async () => {
    await db()
      .insert(s.customers)
      .values({ id: 1, name: "Synthetic customer" });
    await db()
      .insert(s.invoices)
      .values({
        id: 1,
        invoiceNumber: "REMEDIATION-INV",
        sourceType: "POS",
        branchId: 1,
        customerId: 1,
        subtotal: "10.00",
        total: "10.00",
        paidAmount: "10.00",
        status: "PAID",
      });
    await seedVouchers(2);
    await db()
      .update(s.receipts)
      .set({ invoiceId: 1 })
      .where(eq(s.receipts.voucherNumber, "REMEDIATION-V-0"));
    await db()
      .update(s.receipts)
      .set({ invoiceId: 1, internalNote: "COMPONENT_REFUND_PENDING:synthetic" })
      .where(eq(s.receipts.voucherNumber, "REMEDIATION-V-1"));
    const rows = await voucherSource.list(owner, {
      branchIds: null,
      now: new Date(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("treasury.voucher.approve");
    const domain = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.voucherNumber, "REMEDIATION-V-1"))
    )[0]!;
    await notifyApprovalPendingByReceipt(domain.id);
    expect(
      await db()
        .select()
        .from(s.appNotifications)
        .where(eq(s.appNotifications.entityId, domain.id)),
    ).toContainEqual(expect.objectContaining({ route: "/my-work" }));
  });
  it("never presents 201 eligible vouchers as a complete total of 200", async () => {
    await seedVouchers(201);
    const result = await listDecisionInbox(owner, { limit: 500 });
    expect(result.failedSources).toEqual([]);
    expect(
      result.total > 200 || ("totalIsExact" in result && !result.totalIsExact),
    ).toBe(true);
    expect(result.totalIsExact).toBe(false);
    expect(result.truncatedSources).toContainEqual(
      expect.objectContaining({
        key: "treasury.voucher",
        href: "/treasury?tab=vouchers",
      }),
    );
  });
  it("paginates the eligible sample without losing sorting, kind, or branch filters", async () => {
    await seedVouchers(201);
    const first = await listDecisionInbox(owner, {
      kind: "treasury.voucher.approve",
      branchId: 1,
      limit: 200,
    });
    expect(first.rows).toHaveLength(200);
    expect(first.nextPageCursor).toBeDefined();
    const pageCursor = first.nextPageCursor!;
    await expect(listDecisionInbox(reviewer(true), { kind: "treasury.voucher.approve", branchId: 1, pageCursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(listDecisionInbox(owner, { kind: "treasury.voucher.approve", branchId: 2, pageCursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(listDecisionInbox(owner, { kind: "expense.approve", branchId: 1, pageCursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(listDecisionInbox(owner, { kind: "treasury.voucher.approve", branchId: 1, minAgeHours: 1, pageCursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(listDecisionInbox(owner, { kind: "treasury.voucher.approve", branchId: 1, pageCursor: { ...pageCursor, crossBranch: false } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(pageCursorSchema.safeParse({ ...pageCursor, delivered: [pageCursor.delivered[0], pageCursor.delivered[0]] }).success).toBe(false);
    expect(pageCursorSchema.safeParse({ ...pageCursor, delivered: [["treasury.voucher.approve", -1]] }).success).toBe(false);
    expect(pageCursorSchema.safeParse({ ...pageCursor, delivered: Array.from({ length: MAX_DELIVERED_KEYS + 1 }, (_, id) => ["treasury.voucher.approve", id + 1]) }).success).toBe(false);
    await expect(caller(reviewer(true)).decisions.inbox({ offset: 200 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const next = await listDecisionInbox(owner, {
      kind: "treasury.voucher.approve",
      branchId: 1,
      limit: 200,
      pageCursor: first.nextPageCursor!,
    });
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]!.id).not.toBe(first.rows.at(-1)!.id);
    expect(next.rows[0]!.branchId).toBe(1);
    expect((await listDecisionInbox(owner, { branchId: 2 })).rows).toEqual([]);
  });
  it("drains a500-row loaded inventory window before exposing its native raw boundary", async () => {
    await pendingPurchase();
    await db().insert(s.stockAdjustmentRequests).values(Array.from({ length: 501 }, () => ({
      variantId: 1, branchId: 1, targetQuantity: 1, expectedQuantity: 0, createdBy: 3,
    })));
    const input = { kind: "inventory.adjustment.approve", branchId: 1, limit: 200 };
    const first = await listDecisionInbox(owner, input);
    expect(first.rows).toHaveLength(200);
    expect(first.truncatedSources[0]?.cursor).toBeUndefined();
    const second = await listDecisionInbox(owner, { ...input, pageCursor: first.nextPageCursor! });
    expect(second.rows).toHaveLength(200);
    expect(second.truncatedSources[0]?.cursor).toBeUndefined();
    const third = await listDecisionInbox(owner, { ...input, pageCursor: second.nextPageCursor! });
    expect(third.rows).toHaveLength(100);
    expect(third.nextPageCursor).toBeNull();
    const last = await listDecisionInbox(owner, { ...input, sourceCursor: third.truncatedSources[0]!.cursor });
    expect(last.rows).toHaveLength(1);
    expect(last.hasMore).toBe(false);
    const rows = [...first.rows, ...second.rows, ...third.rows, ...last.rows];
    expect(new Set(rows.map(row => row.id)).size).toBe(501);
  });
  it("bounds delivered progress below the HTTP body limit and fails overflow visibly", async () => {
    await seedVouchers(1);
    const template = (await listDecisionInbox(owner, { kind: "treasury.voucher.approve" })).rows[0]!;
    const rows = Array.from({ length: MAX_DELIVERED_KEYS + 2 }, (_, index) => ({ ...template, id: index + 1 }));
    const spy = vi.spyOn(voucherSource, "list").mockResolvedValue(rows);
    try {
      const first = await listDecisionInbox(owner, { kind: "treasury.voucher.approve", limit: 500 });
      const pageCursor = { ...first.nextPageCursor!, delivered: rows.slice(0, MAX_DELIVERED_KEYS).map(row => [row.kind, row.id] as [string, number]) };
      expect(pageCursorSchema.safeParse(pageCursor).success).toBe(true);
      await expect(listDecisionInbox(owner, { kind: "treasury.voucher.approve", limit: 1, pageCursor }))
        .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const longestKind = Object.keys(DECISION_REGISTRY).sort((a, b) => b.length - a.length)[0]!;
      const worstPage = { ...pageCursor, delivered: rows.slice(0, MAX_DELIVERED_KEYS).map((_, id) => [longestKind, Number.MAX_SAFE_INTEGER - id]) };
      const sourceCursor = { source: "purchase.integrity.resolution", userId: Number.MAX_SAFE_INTEGER,
        actorBranchId: Number.MAX_SAFE_INTEGER, crossBranch: true, branchId: null, kind: longestKind, minAgeHours: 8760,
        positions: Object.fromEntries(Array.from({ length: 1000 }, (_, id) => [String(999999999999999 - id),
          { id: Number.MAX_SAFE_INTEGER, at: "2026-01-01T00:00:00.000Z" }])) };
      // All cursor fields are JSON primitives: superjson adds no per-value metadata.
      expect(Buffer.byteLength(JSON.stringify({ "0": { json: { pageCursor: worstPage, sourceCursor } } })))
        .toBeLessThan(900_000); // Existing general express.json limit is 1MiB; no transport cap increase.
    } finally { spy.mockRestore(); }
  });
  it("reports source clipping even when later eligibility removes every sampled row", async () => {
    const spy = vi
      .spyOn(voucherSource, "list")
      .mockImplementationOnce(async (_actor, scope) => {
        scope.reportLimit?.(200, 200);
        return [];
      });
    try {
      const result = await listDecisionInbox(owner, {
        kind: "treasury.voucher.approve",
      });
      expect(result.rows).toEqual([]);
      expect(result.totalIsExact).toBe(false);
      expect(result.hasMore).toBe(true);
      expect(result.truncatedSources[0]?.href).toBe("/treasury?tab=vouchers");
    } finally {
      spy.mockRestore();
    }
  });
  it("keeps source failures visible and never calls their partial total authoritative", async () => {
    const spy = vi
      .spyOn(voucherSource, "list")
      .mockRejectedValueOnce(new Error("Synthetic source outage"));
    try {
      const result = await listDecisionInbox(owner, {
        kind: "treasury.voucher.approve",
      });
      expect(result.failedSources).toEqual([
        { key: "treasury.voucher", message: "Synthetic source outage" },
      ]);
      expect(result.totalIsExact).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it("reveals the exact pending voucher from its notification and keeps a single decision row", async () => {
    await db()
      .insert(s.customers)
      .values({ id: 1, name: "Synthetic customer" });
    await db()
      .insert(s.invoices)
      .values({
        id: 1,
        invoiceNumber: "REMEDIATION-LIFECYCLE",
        sourceType: "POS",
        branchId: 1,
        customerId: 1,
        subtotal: "10.00",
        total: "10.00",
        paidAmount: "10.00",
        status: "PAID",
      });
    const created = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "10.00",
        paymentMethod: "TRANSFER",
        partyType: "CUSTOMER",
        partyId: 1,
        invoiceId: 1,
        description: "Synthetic refund request",
        referenceNumber: "SYNTHETIC-REFUND",
        clientRequestId: randomUUID(),
      },
      { userId: 3, branchId: 1, role: "manager" },
    );
    expect(created.approvalStatus).toBe("PENDING_APPROVAL");
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, created.receiptId))
    )[0]!;
    const notices = await db()
      .select()
      .from(s.appNotifications)
      .where(eq(s.appNotifications.userId, 1));
    expect(notices).toContainEqual(
      expect.objectContaining({
        route: `/treasury?tab=vouchers&voucherId=${receipt.id}`,
        entityId: receipt.id,
      }),
    );
    const inbox = await listDecisionInbox(owner);
    expect(
      inbox.rows.filter(
        (row) =>
          row.id === receipt.id && row.kind.startsWith("treasury.voucher."),
      ),
    ).toHaveLength(1);
    await expect(
      decideDecision(
        {
          kind: "treasury.voucher.approve",
          id: receipt.id,
          action: "REJECT",
          clientRequestId: randomUUID(),
          reason: "Synthetic rejection",
        },
        owner,
      ),
    ).resolves.toMatchObject({ outcome: "REJECTED" });
    expect(
      (await listDecisionInbox(owner)).rows.some(
        (row) =>
          row.kind.startsWith("treasury.voucher.") && row.id === receipt.id,
      ),
    ).toBe(false);
  });
  it("uses current owner identity rather than a forged or stale actor claim", async () => {
    await seedVouchers(1);
    const receipt = (await db().select().from(s.receipts))[0]!;
    await db()
      .update(s.users)
      .set({
        operationPolicy: {
          version: 1,
          grants: { "operation.vouchers.approve": true },
        },
      })
      .where(eq(s.users.id, 2));
    await expect(
      decideDecision(
        {
          kind: "treasury.voucher.approve",
          id: receipt.id,
          action: "APPROVE",
          clientRequestId: randomUUID(),
        },
        { ...reviewer(true), isOwner: true },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("preserves maker-checker, branch isolation, and stale decision outcomes", async () => {
    const id = await pendingPurchase();
    await db()
      .update(s.users)
      .set({ operationPolicy: policy(true) })
      .where(eq(s.users.id, 3));
    const maker = { ...reviewer(true), userId: 3 };
    expect(
      (await listDecisionInbox(maker)).rows.some(
        (row) => row.kind === "purchase.order.control" && row.id === id,
      ),
    ).toBe(false);
    await expect(
      decideDecision(
        {
          kind: "purchase.order.control",
          id,
          action: "APPROVE",
          clientRequestId: randomUUID(),
          reason: "Synthetic review",
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db()
      .update(s.users)
      .set({ operationPolicy: policy(true), branchId: 2 })
      .where(eq(s.users.id, 2));
    expect(
      (await listDecisionInbox(reviewer(true))).rows.some(
        (row) => row.kind === "purchase.order.control" && row.id === id,
      ),
    ).toBe(false);
    await expect(
      listDecisionInbox(reviewer(true), { branchId: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      decideDecision(
        {
          kind: "purchase.order.control",
          id,
          action: "APPROVE",
          clientRequestId: randomUUID(),
          reason: "Synthetic owner review",
        },
        owner,
      ),
    ).resolves.toMatchObject({ outcome: "EXECUTED" });
    await expect(
      decideDecision(
        {
          kind: "purchase.order.control",
          id,
          action: "APPROVE",
          clientRequestId: randomUUID(),
          reason: "Synthetic review",
        },
        owner,
      ),
    ).resolves.toMatchObject({ outcome: "STALE" });
  });
});

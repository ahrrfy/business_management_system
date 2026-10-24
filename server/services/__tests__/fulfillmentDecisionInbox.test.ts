import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { FULFILLMENT_SOURCES } from "../decisions/sources/fulfillment";
import type { DecisionActor } from "../decisions/types";

const owner: DecisionActor = {
  userId: 2,
  branchId: 1,
  role: "admin",
  isOwner: true,
  permissionsOverride: null,
  crossBranch: true,
};
const scope = { branchIds: [1], now: new Date("2026-10-24T10:00:00Z") };
function db() {
  const value = getDb();
  if (!value) throw Error("isolated test database required");
  return value;
}
function getSource(key: string) {
  const value = FULFILLMENT_SOURCES.find(
    (item) => item.key === `delivery.fulfillment.${key}`,
  );
  if (!value) throw Error("missing decision source");
  return value;
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Other", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "work-maker",
        name: "Maker",
        branchId: 1,
        role: "cashier",
      },
      {
        id: 2,
        openId: "work-owner",
        name: "Reviewer",
        branchId: 1,
        role: "admin",
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.invoices)
    .values({
      id: 1,
      invoiceNumber: "INV-WORK",
      branchId: 1,
      subtotal: "1000",
      total: "1000",
      paidAmount: "1000",
      status: "PAID",
    });
  await db()
    .insert(s.aftercareCases)
    .values([
      {
        id: 1,
        branchId: 1,
        invoiceId: 1,
        caseNumber: "AC-REVIEW",
        createdBy: 1,
        status: "DRAFT",
        reason: "missing",
        evidence: "source evidence",
        clientRequestId: "INBOX-CASE-ONE",
        sourceHash: "a".repeat(64),
      },
      {
        id: 2,
        branchId: 1,
        invoiceId: 1,
        caseNumber: "AC-OWN",
        createdBy: 2,
        status: "DRAFT",
        reason: "missing",
        evidence: "source evidence",
        clientRequestId: "INBOX-CASE-TWO",
        sourceHash: "b".repeat(64),
      },
      {
        id: 3,
        branchId: 2,
        invoiceId: 1,
        caseNumber: "AC-OTHER",
        createdBy: 1,
        status: "DRAFT",
        reason: "missing",
        evidence: "source evidence",
        clientRequestId: "INBOX-CASE-THREE",
        sourceHash: "c".repeat(64),
      },
    ]);
});
describe("fulfillment work appears in the existing inbox", () => {
  it("shows independent branch-scoped review with a direct same-station link and no blind approve action", async () => {
    const source = getSource("review");
    const rows = await source.list(owner, scope);
    expect(rows.map((row) => row.id)).toEqual([1]);
    expect(rows[0].href).toContain(
      "/reception/workflow?section=aftercare&caseId=1",
    );
    expect(rows[0].allowedActions).toEqual([]);
    expect(source.supportedActions).toEqual([]);
    await db()
      .update(s.aftercareCases)
      .set({ status: "APPROVED", approvedBy: 2, approvedAt: new Date() })
      .where(eq(s.aftercareCases.id, 1));
    expect(await source.freshness(1)).toBe("DECIDED");
    expect(await source.list(owner, scope)).toHaveLength(0);
    expect(
      (await getSource("followup").list(owner, scope)).map((row) => row.id),
    ).toEqual([1]);
  });
  it("rechecks current authority rather than trusting a stale owner actor", async () => {
    await db()
      .update(s.users)
      .set({ role: "cashier", isOwner: false })
      .where(eq(s.users.id, 2));
    expect(await getSource("review").list(owner, scope)).toEqual([]);
  });
});

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import {
  nextConsignmentNumber,
  nextRemittanceNumber,
} from "../delivery/numbering";
import { toDateStr } from "../money";
import { withTx } from "../tx";

function db() {
  const database = getDb();
  if (!database) throw new Error("Test database is unavailable");
  return database;
}

const actor = { userId: 81, branchId: 81, role: "admin" };
const day = () => toDateStr().replace(/-/g, "");
const prefix = (kind: "CN" | "DR", branch = 81) =>
  `${kind}-${branch}-${day()}-`;
const key = (kind: "consignment" | "remittance", branch = 81) =>
  `${kind}_${branch}_${day()}`;
let fixtureId = 1000;

beforeEach(async () => {
  fixtureId = 1000;
  await db()
    .insert(schema.branches)
    .values([
      { id: 81, name: "Counter test MAIN", code: "CT81", type: "MAIN" },
      { id: 82, name: "Counter test SALES", code: "CT82", type: "SALES" },
    ]);
  await db()
    .insert(schema.users)
    .values({
      id: 81,
      openId: "counter-test-admin",
      name: "Counter test admin",
      role: "admin",
      branchId: 81,
      loginMethod: "local",
    });
  await db()
    .insert(schema.customers)
    .values({
      id: 81,
      name: "Counter test customer",
      currentBalance: "1000.00",
    });
  await db()
    .insert(schema.deliveryParties)
    .values([
      {
        id: 81,
        name: "Counter test courier",
        partyType: "INDIVIDUAL",
        branchId: 81,
      },
      {
        id: 82,
        name: "Counter test courier 2",
        partyType: "INDIVIDUAL",
        branchId: 82,
      },
    ]);
  await db()
    .insert(schema.invoices)
    .values({
      id: 81,
      invoiceNumber: "LEGACY-INVOICE-81",
      sourceType: "POS",
      sourceId: "counter-test-current",
      branchId: 81,
      customerId: 81,
      subtotal: "1000.00",
      total: "1000.00",
      paidAmount: "0.00",
      status: "PENDING",
      createdBy: 81,
    });
});

async function legacyConsignment(sequence: number, branch = 81) {
  const id = fixtureId++;
  await db()
    .insert(schema.invoices)
    .values({
      id,
      invoiceNumber: `LEGACY-FIXTURE-${id}`,
      sourceType: "POS",
      sourceId: `counter-test-${id}`,
      branchId: branch,
      subtotal: "0.00",
      total: "0.00",
      status: "CANCELLED",
      createdBy: 81,
    });
  await db()
    .insert(schema.deliveryConsignments)
    .values({
      consignmentNumber:
        prefix("CN", branch) + String(sequence).padStart(5, "0"),
      branchId: branch,
      partyId: branch,
      invoiceId: id,
      sourceType: "INVOICE",
      sourceId: id,
      codAmount: "0.00",
      status: "CANCELLED",
      parcelStatus: "CANCELLED",
      moneyStatus: "CANCELLED",
      dispatchedBy: 81,
    });
}

async function legacyRemittance(sequence: number) {
  await db()
    .insert(schema.deliveryRemittances)
    .values({
      remittanceNumber: prefix("DR") + String(sequence).padStart(5, "0"),
      branchId: 81,
      partyId: 81,
      collectedTotal: "0.00",
      feesTotal: "0.00",
      netRemitted: "0.00",
      status: "BALANCED",
      receivedBy: 81,
    });
}

async function snapshot() {
  return Promise.all([
    db().select().from(schema.documentCounters),
    db().select().from(schema.deliveryConsignments),
    db().select().from(schema.deliveryLedgerEntries),
    db().select().from(schema.deliveryEvents),
    db().select().from(schema.invoices),
    db().select().from(schema.customers),
    db().select().from(schema.deliveryParties),
    db().select().from(schema.receipts),
    db().select().from(schema.accountingEntries),
    db().select().from(schema.idempotencyKeys),
  ]);
}

describe("delivery numbering after adopting documentCounters", () => {
  it("starts an empty branch/day at one", async () => {
    expect(await withTx((tx) => nextConsignmentNumber(tx, 81))).toBe(
      prefix("CN") + "00001",
    );
    expect(await withTx((tx) => nextRemittanceNumber(tx, 81))).toBe(
      prefix("DR") + "00001",
    );
  });

  it("resumes above cancelled legacy numbers when the new counter is absent", async () => {
    await legacyConsignment(9);
    await legacyConsignment(2); // Latest row ID is deliberately not the largest suffix.
    await legacyConsignment(800, 82);
    expect(await withTx((tx) => nextConsignmentNumber(tx, 81))).toBe(
      prefix("CN") + "00010",
    );
  });

  it("uses a numeric maximum across the five-digit boundary", async () => {
    await legacyConsignment(99999);
    await legacyConsignment(100000);
    expect(await withTx((tx) => nextConsignmentNumber(tx, 81))).toBe(
      prefix("CN") + "100001",
    );
  });

  it("repairs a counter behind history and preserves an advanced counter", async () => {
    await legacyConsignment(12);
    await db()
      .insert(schema.documentCounters)
      .values({ counterKey: key("consignment"), lastValue: 1 });
    expect(await withTx((tx) => nextConsignmentNumber(tx, 81))).toBe(
      prefix("CN") + "00013",
    );
    await db()
      .update(schema.documentCounters)
      .set({ lastValue: 90 })
      .where(eq(schema.documentCounters.counterKey, key("consignment")));
    expect(await withTx((tx) => nextConsignmentNumber(tx, 81))).toBe(
      prefix("CN") + "00091",
    );
  });

  it("also resumes remittances above historical DR numbers", async () => {
    await legacyRemittance(15);
    await legacyRemittance(3);
    expect(await withTx((tx) => nextRemittanceNumber(tx, 81))).toBe(
      prefix("DR") + "00016",
    );
  });

  it("serializes eight first allocations against a missing legacy counter", async () => {
    await legacyConsignment(21);
    const allocations = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        withTx((tx) => nextConsignmentNumber(tx, 81)),
      ),
    );
    expect(allocations.every((result) => result.status === "fulfilled")).toBe(
      true,
    );
    const numbers = allocations.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(new Set(numbers).size).toBe(8);
    expect(
      numbers
        .map((number) => Number(number.slice(prefix("CN").length)))
        .sort((a, b) => a - b),
    ).toEqual([22, 23, 24, 25, 26, 27, 28, 29]);
  });

  it("honors a committed counter even when history is read from an older snapshot", async () => {
    await legacyConsignment(9);
    const result = await withTx(async (tx) => {
      await tx
        .select({ id: schema.deliveryConsignments.id })
        .from(schema.deliveryConsignments);
      const other = await withTx((writer) => nextConsignmentNumber(writer, 81));
      const current = await nextConsignmentNumber(tx, 81);
      return [other, current];
    });
    expect(result).toEqual([prefix("CN") + "00010", prefix("CN") + "00011"]);
  });

  it("dispatches an actual legacy invoice once and replays without another trail", async () => {
    await legacyConsignment(1);
    const input = {
      invoiceId: 81,
      partyId: 81,
      deliveryFee: "0.00",
      clientRequestId: "counter-test-dispatch",
    };
    const result = await dispatchInvoiceToDelivery(input, actor);
    expect(result.consignmentNumber).toBe(prefix("CN") + "00002");
    const beforeReplay = await snapshot();
    const replay = await dispatchInvoiceToDelivery(input, actor);
    expect(replay.consignmentId).toBe(result.consignmentId);
    expect(await snapshot()).toEqual(beforeReplay);
    const assigned = await db()
      .select()
      .from(schema.deliveryLedgerEntries)
      .where(
        eq(schema.deliveryLedgerEntries.consignmentId, result.consignmentId),
      );
    expect(
      assigned.map((row) => ({ entryType: row.entryType, amount: row.amount })),
    ).toEqual([{ entryType: "COD_ASSIGNED", amount: "1000.00" }]);
    expect(await db().select().from(schema.receipts)).toEqual([]);
    expect(await db().select().from(schema.accountingEntries)).toEqual([]);
  });

  it("rolls back the allocation and all dispatch effects on a later float-limit rejection", async () => {
    await legacyConsignment(1);
    await db()
      .update(schema.deliveryParties)
      .set({ floatLimit: "100.00" })
      .where(eq(schema.deliveryParties.id, 81));
    const before = await snapshot();
    await expect(
      dispatchInvoiceToDelivery(
        {
          invoiceId: 81,
          partyId: 81,
          clientRequestId: "counter-test-rejected",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("يتجاوز السقف المضبوط"),
    });
    expect(await snapshot()).toEqual(before);
    await db()
      .update(schema.deliveryParties)
      .set({ floatLimit: null })
      .where(eq(schema.deliveryParties.id, 81));
    const retried = await dispatchInvoiceToDelivery(
      { invoiceId: 81, partyId: 81, clientRequestId: "counter-test-rejected" },
      actor,
    );
    expect(retried.consignmentNumber).toBe(prefix("CN") + "00002");
  });
});

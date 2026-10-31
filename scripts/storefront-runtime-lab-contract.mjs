import { eq } from "drizzle-orm";

/** Pure evidence contract: transport failures never prove an idempotency conflict. */
export function changedPayloadConflictProved(response, before, after, original) {
  return response?.ok === false && response.status === 409 && response.error === "CONFLICT" &&
    before?.orders?.length === 1 && after?.orders?.length === 1 &&
    before.orders[0].clientRequestId === original.clientRequestId &&
    before.orders[0].shippingAddress === original.addressText &&
    JSON.stringify(before) === JSON.stringify(after);
}

export const financialEffectTables = Object.freeze(["invoices", "receipts", "inventoryMovements", "accountingEntries", "journalEntries"]);

export function seedRuntimeStoreSettings(db, table) {
  const settings = { fulfillmentBranchId: 1, isOpen: true };
  return db.insert(table).values({ id: 1, ...settings }).onDuplicateKeyUpdate({ set: settings });
}

/** Synthetic browser identity: signing and all authenticated transports share it. */
export function runtimeLabHeaders(cookie, authenticated = false) {
  return {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    ...(authenticated ? { cookie, "user-agent": "erp-runtime-lab-synthetic-staff/1" } : {}),
  };
}

/** Drizzle maps status to its real physical orderStatus column. Read-only. */
export function runtimeLabOrderReadback(db, table, key) {
  return db.select({ id: table.id, status: table.status, clientRequestId: table.clientRequestId })
    .from(table).where(eq(table.clientRequestId, key));
}

export function pendingRuntimeLabOrder(rows, key) {
  return rows.length === 1 && rows[0].status === "PENDING" && rows[0].clientRequestId === key;
}

export async function runtimeLabStaffPreflight(ports, call, record) {
  for (const port of ports) {
    const result = await call(port);
    record({ port, ...result });
    if (!result.ok || result.status !== 200)
      throw new Error(`Staff preflight failed on ${port}: ${result.status} ${result.error ?? "invalid response"}`);
  }
}

/** Error duration is preserved as evidence, never counted as successful latency. */
export function runtimeLabSampleSummary(rows) {
  const successful = rows.filter(row => row.ok);
  const times = successful.map(row => row.ms).sort((a, b) => a - b);
  const percentile = p => times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)] : null;
  return {
    total: rows.length,
    ok: successful.length,
    errors: rows.filter(row => !row.ok).map(row => ({ status: row.status, error: row.error })),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

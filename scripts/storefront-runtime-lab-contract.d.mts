import type { MySql2Database } from "drizzle-orm/mysql2";
import type { storeSettings, onlineOrders } from "../drizzle/schema";

export type RuntimeLabResponse = { ok: boolean; status: number; error?: string };
export type RuntimeLabSample = RuntimeLabResponse & { ms: number };
export type RuntimeLabSnapshot = {
  orders?: ReadonlyArray<{ clientRequestId?: string | null; shippingAddress?: string | null }>;
  [key: string]: unknown;
};
export function changedPayloadConflictProved(
  response: RuntimeLabResponse | null | undefined,
  before: RuntimeLabSnapshot | null | undefined,
  after: RuntimeLabSnapshot | null | undefined,
  original: { clientRequestId: string; addressText: string },
): boolean;
export const financialEffectTables: readonly ["invoices", "receipts", "inventoryMovements", "accountingEntries", "journalEntries"];
export type RuntimeLabQuery<T> = PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } };
export function seedRuntimeStoreSettings(db: MySql2Database, table: typeof storeSettings): RuntimeLabQuery<unknown>;
export function runtimeLabHeaders(cookie: string, authenticated?: boolean): {
  "content-type": string;
  "sec-fetch-site": string;
  cookie?: string;
  "user-agent"?: string;
};
export type RuntimeLabOrder = { id: number; status: string; clientRequestId: string | null };
export function runtimeLabOrderReadback(db: MySql2Database, table: typeof onlineOrders, key: string): RuntimeLabQuery<RuntimeLabOrder[]>;
export function pendingRuntimeLabOrder(rows: readonly RuntimeLabOrder[], key: string): boolean;
export function runtimeLabStaffPreflight<T extends RuntimeLabResponse>(
  ports: readonly number[],
  call: (port: number) => Promise<T>,
  record: (row: T & { port: number }) => void,
): Promise<void>;
export function runtimeLabSampleSummary(rows: readonly RuntimeLabSample[]): {
  total: number;
  ok: number;
  errors: Array<{ status: number; error: string | undefined }>;
  p95Ms: number | null;
  p99Ms: number | null;
};

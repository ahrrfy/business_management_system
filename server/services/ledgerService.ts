import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { accountingEntries, customers, suppliers } from "../../drizzle/schema";
import type { Tx } from "../db";
import { money, toDbMoney } from "./money";

export type EntryType = "SALE" | "PURCHASE" | "PAYMENT_IN" | "PAYMENT_OUT" | "RETURN" | "ADJUST";

export interface EntryInput {
  entryType: EntryType;
  branchId?: number | null;
  invoiceId?: number | null;
  purchaseOrderId?: number | null;
  receiptId?: number | null;
  customerId?: number | null;
  supplierId?: number | null;
  revenue?: Decimal;
  cost?: Decimal;
  profit?: Decimal;
  taxAmount?: Decimal;
  amount?: Decimal;
  entryDate?: Date;
  notes?: string;
}

/** Insert one ledger entry. RETURN entries carry negative values by convention. */
export async function postEntry(tx: Tx, e: EntryInput): Promise<void> {
  await tx.insert(accountingEntries).values({
    entryType: e.entryType,
    branchId: e.branchId ?? null,
    invoiceId: e.invoiceId ?? null,
    purchaseOrderId: e.purchaseOrderId ?? null,
    receiptId: e.receiptId ?? null,
    customerId: e.customerId ?? null,
    supplierId: e.supplierId ?? null,
    revenue: toDbMoney(e.revenue ?? 0),
    cost: toDbMoney(e.cost ?? 0),
    profit: toDbMoney(e.profit ?? 0),
    taxAmount: toDbMoney(e.taxAmount ?? 0),
    amount: toDbMoney(e.amount ?? 0),
    entryDate: e.entryDate ?? new Date(),
    notes: e.notes,
  });
}

/** AR: positive = customer owes us. Applied atomically via SQL increment. */
export async function adjustCustomerBalance(tx: Tx, customerId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(customers)
    .set({ currentBalance: sql`${customers.currentBalance} + ${toDbMoney(delta)}` })
    .where(eq(customers.id, customerId));
}

/** AP: positive = we owe the supplier. */
export async function adjustSupplierBalance(tx: Tx, supplierId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(suppliers)
    .set({ currentBalance: sql`${suppliers.currentBalance} + ${toDbMoney(delta)}` })
    .where(eq(suppliers.id, supplierId));
}

export function computeInvoiceStatus(total: string, paid: string): "PENDING" | "PARTIALLY_PAID" | "PAID" {
  const t = money(total);
  const p = money(paid);
  if (p.lte(0)) return "PENDING";
  if (p.gte(t)) return "PAID";
  return "PARTIALLY_PAID";
}

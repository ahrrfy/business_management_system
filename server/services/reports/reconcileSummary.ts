import {
  reconcileCustomerBalances,
  reconcileDeliveryFloat,
  reconcileInventory,
  reconcileLedgerProfit,
  reconcileSupplierBalances,
  type ReconcileResult,
} from "../reconcileService";

export interface FinancialReconciliationDetails {
  customers: ReconcileResult[];
  suppliers: ReconcileResult[];
  delivery: ReconcileResult[];
  inventory: ReconcileResult[];
  ledger: ReconcileResult[];
  runAt: string;
}

export type FinancialReconciliationSectionKey =
  | "customers"
  | "suppliers"
  | "delivery"
  | "inventory"
  | "ledger";

export interface FinancialReconciliationSummarySection {
  issueCount: number;
  balanced: boolean;
}

export interface FinancialReconciliationSummary {
  runAt: string;
  totalIssueCount: number;
  balanced: boolean;
  sections: Record<FinancialReconciliationSectionKey, FinancialReconciliationSummarySection>;
}

/** Runs the same five authoritative checks used by the detailed desktop reconciliation screen. */
export async function getFinancialReconciliationDetails(): Promise<FinancialReconciliationDetails> {
  const [customers, suppliers, delivery, inventory, ledger] = await Promise.all([
    reconcileCustomerBalances(),
    reconcileSupplierBalances(),
    reconcileDeliveryFloat(),
    reconcileInventory(),
    reconcileLedgerProfit(),
  ]);
  return { customers, suppliers, delivery, inventory, ledger, runAt: new Date().toISOString() };
}

/**
 * Produces the mobile-safe projection. It never copies a row body, entity id, balance or note into
 * the returned graph, so serialization cannot expose detailed company reconciliation records.
 */
export function toFinancialReconciliationSummary(
  details: FinancialReconciliationDetails,
): FinancialReconciliationSummary {
  const sections = {
    customers: section(details.customers),
    suppliers: section(details.suppliers),
    delivery: section(details.delivery),
    inventory: section(details.inventory),
    ledger: section(details.ledger),
  } satisfies FinancialReconciliationSummary["sections"];
  const totalIssueCount = Object.values(sections).reduce((sum, value) => sum + value.issueCount, 0);
  return {
    runAt: details.runAt,
    totalIssueCount,
    balanced: totalIssueCount === 0,
    sections,
  };
}

function section(rows: readonly unknown[]): FinancialReconciliationSummarySection {
  return { issueCount: rows.length, balanced: rows.length === 0 };
}

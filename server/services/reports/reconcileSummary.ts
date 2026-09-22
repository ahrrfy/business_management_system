import {
  reconcileCustomerBalances,
  reconcileDeliveryFloat,
  reconcileInventory,
  reconcileLedgerProfit,
  reconcileOnlineOrderConsignmentSync,
  reconcileOrphanJournalLines,
  reconcileSupplierBalances,
  reconcileUnbilledGoodsReceipts,
  type ReconcileResult,
} from "../reconcileService";

export interface FinancialReconciliationDetails {
  customers: ReconcileResult[];
  suppliers: ReconcileResult[];
  delivery: ReconcileResult[];
  inventory: ReconcileResult[];
  ledger: ReconcileResult[];
  /** Tier-2 #4 (٢٦/٨): سلامة الربط بين طلب المتجر والإرسالية — أربع حالاتٍ حاكمة. */
  onlineOrders: ReconcileResult[];
  /** Tier-3 #5 (٢٧/٨): أيتام journalLines بلا accountId — خرقُ عقد الكاتب بعد Tier-3 #2/#4. */
  journalOrphans: ReconcileResult[];
  /** أذونات استلام مخزني مرحّلة بانتظار فاتورة مورد مرحّلة ومطابقة (GRNI). */
  unbilledGoodsReceipts: ReconcileResult[];
  runAt: string;
}

export type FinancialReconciliationSectionKey =
  | "customers"
  | "suppliers"
  | "delivery"
  | "inventory"
  | "ledger"
  | "onlineOrders"
  | "journalOrphans";

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

/** Runs the authoritative checks used by desktop & mobile reconciliation screens. */
export async function getFinancialReconciliationDetails(): Promise<FinancialReconciliationDetails> {
  const [
    customers,
    suppliers,
    delivery,
    inventory,
    ledger,
    onlineOrders,
    journalOrphans,
    unbilledGoodsReceipts,
  ] = await Promise.all([
    reconcileCustomerBalances(),
    reconcileSupplierBalances(),
    reconcileDeliveryFloat(),
    reconcileInventory(),
    reconcileLedgerProfit(),
    reconcileOnlineOrderConsignmentSync(),
    reconcileOrphanJournalLines(),
    reconcileUnbilledGoodsReceipts(),
  ]);
  return {
    customers,
    suppliers,
    delivery,
    inventory,
    ledger,
    onlineOrders,
    journalOrphans,
    unbilledGoodsReceipts,
    runAt: new Date().toISOString(),
  };
}

/**
 * Produces the mobile-safe projection. It never copies a row body, entity id, balance or note into
 * the returned graph, so serialization cannot expose detailed company reconciliation records.
 *
 * ملاحظة معمارية: تطبيق Android يحصر محاور المطابقة في ٧ محاور صارمة (AccountingControlsRepository.kt).
 * أذونات الاستلام غير المفوترة (GRNI) تُضمّ إلى محور suppliers في هذا الإسقاط الموجز، لضمان استمرار عمل
 * تطبيق Android بلا انهيار مع رصد أي خلل غير مفوتر في إجمالي الانحرافات.
 */
export function toFinancialReconciliationSummary(
  details: FinancialReconciliationDetails,
): FinancialReconciliationSummary {
  const sections = {
    customers: section(details.customers),
    suppliers: section([
      ...details.suppliers,
      ...(details.unbilledGoodsReceipts ?? []),
    ]),
    delivery: section(details.delivery),
    inventory: section(details.inventory),
    ledger: section(details.ledger),
    onlineOrders: section(details.onlineOrders),
    journalOrphans: section(details.journalOrphans),
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

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  decimal,
  foreignKey,
  index,
  int,
  mysqlTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  invoiceItemBundleComponents,
  invoiceItems,
  invoices,
  inventoryMovements,
  receipts,
  users,
} from "./schema";
import { aftercareSettlements } from "./fulfillmentSchema";

/** Commercial credit and physical component receipt are distinct from whole bundle returns. */
export const componentRightsAdjustments = mysqlTable(
  "componentRightsAdjustments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    settlementId: bigint("settlementId", { mode: "number" }).notNull(),
    rightIndex: int("rightIndex").notNull(),
    invoiceId: bigint("invoiceId", { mode: "number" }).notNull(),
    invoiceItemId: bigint("invoiceItemId", { mode: "number" }).notNull(),
    originalBundleComponentId: bigint("originalBundleComponentId", {
      mode: "number",
    }),
    originalMovementId: bigint("originalMovementId", {
      mode: "number",
    }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    normalReturnedBaseQuantity: int("normalReturnedBaseQuantity").notNull(),
    usableBaseQuantity: int("usableBaseQuantity").notNull(),
    commercialAmount: decimal("commercialAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    revenueAmount: decimal("revenueAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).notNull(),
    originalIssueValue: decimal("originalIssueValue", {
      precision: 15,
      scale: 2,
    }).notNull(),
    restoredValue: decimal("restoredValue", {
      precision: 15,
      scale: 2,
    }).notNull(),
    priorRestoredValue: decimal("priorRestoredValue", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    subsequentRestoredValue: decimal("subsequentRestoredValue", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    costEvidence: text("costEvidence").notNull(),
    costEvidenceReference: varchar("costEvidenceReference", {
      length: 500,
    }).notNull(),
    refundReceiptId: bigint("refundReceiptId", { mode: "number" }),
    refundRequiredAmount: decimal("refundRequiredAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    clientRequestId: varchar("clientRequestId", { length: 80 }).notNull(),
    sourceHash: varchar("sourceHash", { length: 64 }).notNull(),
    createdBy: int("createdBy").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    settlementRight: unique("uq_component_rights_adjustment_settlement_right").on(
      t.settlementId,
      t.rightIndex,
    ),
    request: unique("uq_component_rights_adjustment_request").on(t.clientRequestId),
    item: index("idx_component_rights_adjustment_item").on(t.invoiceItemId),
    settlementFk: foreignKey({
      name: "fk_component_rights_adjustment_settlement",
      columns: [t.settlementId],
      foreignColumns: [aftercareSettlements.id],
    }),
    invoiceFk: foreignKey({
      name: "fk_component_rights_adjustment_invoice",
      columns: [t.invoiceId],
      foreignColumns: [invoices.id],
    }),
    itemFk: foreignKey({
      name: "fk_component_rights_adjustment_item",
      columns: [t.invoiceItemId],
      foreignColumns: [invoiceItems.id],
    }),
    componentFk: foreignKey({
      name: "fk_component_rights_adjustment_component",
      columns: [t.originalBundleComponentId],
      foreignColumns: [invoiceItemBundleComponents.id],
    }),
    movementFk: foreignKey({
      name: "fk_component_rights_adjustment_movement",
      columns: [t.originalMovementId],
      foreignColumns: [inventoryMovements.id],
    }),
    receiptFk: foreignKey({
      name: "fk_component_rights_adjustment_receipt",
      columns: [t.refundReceiptId],
      foreignColumns: [receipts.id],
    }),
    actorFk: foreignKey({
      name: "fk_component_rights_adjustment_actor",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    values: check(
      "chk_component_rights_adjustment_values",
      sql`${t.rightIndex} >= 0 AND ${t.normalReturnedBaseQuantity} >= 0 AND ${t.baseQuantity} > 0 AND ${t.usableBaseQuantity} >= 0 AND ${t.usableBaseQuantity} <= ${t.baseQuantity} AND ${t.commercialAmount} > 0 AND ${t.revenueAmount} >= 0 AND ${t.taxAmount} >= 0 AND ${t.revenueAmount} + ${t.taxAmount} = ${t.commercialAmount} AND ${t.originalIssueValue} >= 0 AND ${t.restoredValue} >= 0 AND ${t.restoredValue} <= ${t.originalIssueValue}`,
    ),
  }),
);

/** Every original refund allocation has its own real receipt and external confirmation. */
export const componentRightsRefunds = mysqlTable(
  "componentRightsRefunds",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    adjustmentId: bigint("adjustmentId", { mode: "number" }).notNull(),
    receiptId: bigint("receiptId", { mode: "number" }).notNull(),
    providerReference: varchar("providerReference", { length: 191 }),
  },
  (t) => ({
    receipt: unique("uq_component_rights_refund_receipt").on(t.receiptId),
    provider: unique("uq_component_rights_refund_provider").on(t.providerReference),
    adjustmentIdx: index("idx_component_rights_refund_adjustment").on(t.adjustmentId),
    adjustmentFk: foreignKey({
      name: "fk_component_rights_refund_adjustment",
      columns: [t.adjustmentId],
      foreignColumns: [componentRightsAdjustments.id],
    }),
    receiptFk: foreignKey({
      name: "fk_component_rights_refund_receipt",
      columns: [t.receiptId],
      foreignColumns: [receipts.id],
    }),
  }),
);

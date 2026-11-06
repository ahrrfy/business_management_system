import { sql } from "drizzle-orm";
import { bigint, check, decimal, foreignKey, index, int, json, mysqlEnum, mysqlTable, timestamp, unique, varchar } from "drizzle-orm/mysql-core";
import { branches, customers, digitalSaleDetails, digitalSaleIntents, digitalSaleReviewResolutions, externalPaymentAttempts, invoices, receipts, users } from "./schema";

/** External evidence survives a failed financial commit; cash rows are completed with their payout. */
export const digitalRefundPayments = mysqlTable("digitalRefundPayments", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  branchId: bigint("branchId", { mode: "number" }).notNull(),
  invoiceId: bigint("invoiceId", { mode: "number" }),
  intentId: bigint("intentId", { mode: "number" }),
  originalAttemptId: bigint("originalAttemptId", { mode: "number" }),
  operationKey: varchar("operationKey", { length: 160 }).notNull(),
  originalMethod: mysqlEnum("originalMethod", ["CASH", "CARD", "CREDIT"]).notNull(),
  method: mysqlEnum("refundMethod", ["CASH", "CARD"]).notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  normalizedReference: varchar("normalizedReference", { length: 100 }),
  status: mysqlEnum("refundStatus", ["RESERVED", "EVIDENCED", "COMPLETED"]).notNull(),
  detailIds: json("detailIds").$type<number[]>().notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  requestedBy: int("requestedBy").notNull(),
  reservationToken: varchar("reservationToken", { length: 64 }),
  reservationExpiresAt: timestamp("reservationExpiresAt"),
  confirmedBy: int("confirmedBy"),
  confirmedAt: timestamp("confirmedAt"),
  receiptId: bigint("receiptId", { mode: "number" }),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  operationUq: unique("uq_drefund_operation").on(t.operationKey),
  referenceUq: unique("uq_drefund_reference").on(t.normalizedReference),
  receiptUq: unique("uq_drefund_receipt").on(t.receiptId),
  invoiceIdx: index("idx_drefund_invoice").on(t.invoiceId, t.status),
  intentIdx: index("idx_drefund_intent").on(t.intentId, t.status),
  branchFk: foreignKey({ columns: [t.branchId], foreignColumns: [branches.id], name: "fk_drefund_branch" }),
  invoiceFk: foreignKey({ columns: [t.invoiceId], foreignColumns: [invoices.id], name: "fk_drefund_invoice" }),
  intentFk: foreignKey({ columns: [t.intentId], foreignColumns: [digitalSaleIntents.id], name: "fk_drefund_intent" }),
  attemptFk: foreignKey({ columns: [t.originalAttemptId], foreignColumns: [externalPaymentAttempts.id], name: "fk_drefund_attempt" }),
  receiptFk: foreignKey({ columns: [t.receiptId], foreignColumns: [receipts.id], name: "fk_drefund_receipt" }),
  confirmerFk: foreignKey({ columns: [t.confirmedBy], foreignColumns: [users.id], name: "fk_drefund_confirmer" }),
  requesterFk: foreignKey({ columns: [t.requestedBy], foreignColumns: [users.id], name: "fk_drefund_requester" }),
  amountCheck: check("chk_drefund_positive", sql`${t.amount} > 0`),
  methodCheck: check("chk_drefund_method", sql`(${t.method} = 'CASH' AND ${t.normalizedReference} IS NULL) OR (${t.originalMethod} = 'CARD' AND (${t.status} = 'RESERVED' OR (${t.normalizedReference} IS NOT NULL AND CHAR_LENGTH(${t.normalizedReference}) > 0)))`),
  completionCheck: check("chk_drefund_complete", sql`(${t.status} = 'RESERVED' AND ${t.method} = 'CARD' AND ${t.reservationToken} IS NOT NULL AND ${t.reservationExpiresAt} IS NOT NULL AND ${t.normalizedReference} IS NULL AND ${t.confirmedBy} IS NULL AND ${t.confirmedAt} IS NULL AND ${t.receiptId} IS NULL AND ${t.completedAt} IS NULL) OR (${t.status} = 'EVIDENCED' AND ${t.confirmedBy} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL AND ${t.receiptId} IS NULL AND ${t.completedAt} IS NULL) OR (${t.status} = 'COMPLETED' AND ${t.confirmedBy} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL AND ${t.receiptId} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`),
}));

/** One immutable refund allocation for each issued digital invoice line. */
export const digitalRefundItems = mysqlTable("digitalRefundItems", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  refundId: bigint("refundId", { mode: "number" }),
  detailId: bigint("detailId", { mode: "number" }).notNull(),
  outcome: mysqlEnum("refundOutcome", ["REVERSAL", "LOSS_REFUND"]).notNull(),
  revenue: decimal("revenue", { precision: 15, scale: 2 }).notNull(),
  cost: decimal("cost", { precision: 15, scale: 2 }).notNull(),
  // NULL reserves a line for confirmed external refund evidence; completion stamps the event.
  occurredAt: timestamp("occurredAt"),
}, (t) => ({
  detailUq: unique("uq_drefunditem_detail").on(t.detailId),
  dateIdx: index("idx_drefunditem_date").on(t.occurredAt),
  refundFk: foreignKey({ columns: [t.refundId], foreignColumns: [digitalRefundPayments.id], name: "fk_drefunditem_refund" }),
  detailFk: foreignKey({ columns: [t.detailId], foreignColumns: [digitalSaleDetails.id], name: "fk_drefunditem_detail" }),
}));

/** Original capture is immutable; allocation and refund reconcile it without a second collection. */
export const digitalIntentSettlements = mysqlTable("digitalIntentSettlements", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  intentId: bigint("intentId", { mode: "number" }).notNull(),
  resolutionId: bigint("resolutionId", { mode: "number" }).notNull(),
  customerId: bigint("customerId", { mode: "number" }),
  capturedAmount: decimal("capturedAmount", { precision: 15, scale: 2 }).notNull(),
  saleAmount: decimal("saleAmount", { precision: 15, scale: 2 }).notNull(),
  refundAmount: decimal("refundAmount", { precision: 15, scale: 2 }).notNull(),
  refundMethod: mysqlEnum("refundMethod", ["CASH", "CARD"]).notNull(),
  regularDisposition: mysqlEnum("regularDisposition", ["SELL", "RELEASE"]).notNull(),
  issuedItemIds: json("issuedItemIds").$type<number[]>().notNull(),
  collectionReceiptId: bigint("collectionReceiptId", { mode: "number" }),
  refundPaymentId: bigint("refundPaymentId", { mode: "number" }),
  invoiceId: bigint("invoiceId", { mode: "number" }),
  status: mysqlEnum("settlementStatus", ["REQUESTED", "COMPLETED"]).notNull(),
  createdBy: int("createdBy").notNull(),
  approvedBy: int("approvedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
}, (t) => ({
  intentUq: unique("uq_dsettlement_intent").on(t.intentId),
  collectionUq: unique("uq_dsettlement_collection").on(t.collectionReceiptId),
  intentFk: foreignKey({ columns: [t.intentId], foreignColumns: [digitalSaleIntents.id], name: "fk_dsettlement_intent" }),
  resolutionFk: foreignKey({ columns: [t.resolutionId], foreignColumns: [digitalSaleReviewResolutions.id], name: "fk_dsettlement_resolution" }),
  customerFk: foreignKey({ columns: [t.customerId], foreignColumns: [customers.id], name: "fk_dsettlement_customer" }),
  collectionFk: foreignKey({ columns: [t.collectionReceiptId], foreignColumns: [receipts.id], name: "fk_dsettlement_collection" }),
  refundFk: foreignKey({ columns: [t.refundPaymentId], foreignColumns: [digitalRefundPayments.id], name: "fk_dsettlement_refund" }),
  invoiceFk: foreignKey({ columns: [t.invoiceId], foreignColumns: [invoices.id], name: "fk_dsettlement_invoice" }),
  creatorFk: foreignKey({ columns: [t.createdBy], foreignColumns: [users.id], name: "fk_dsettlement_creator" }),
  approverFk: foreignKey({ columns: [t.approvedBy], foreignColumns: [users.id], name: "fk_dsettlement_approver" }),
  allocationCheck: check("chk_dsettlement_sum", sql`${t.capturedAmount} >= 0 AND ${t.saleAmount} >= 0 AND ${t.refundAmount} >= 0 AND ${t.capturedAmount} = ${t.saleAmount} + ${t.refundAmount}`),
  completionCheck: check("chk_dsettlement_complete", sql`${t.status} <> 'COMPLETED' OR (${t.collectionReceiptId} IS NOT NULL AND ${t.approvedBy} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`),
}));

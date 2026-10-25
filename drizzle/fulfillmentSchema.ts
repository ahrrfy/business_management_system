import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  decimal,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  unique,
  varchar,
  type MySqlTableExtraConfig,
} from "drizzle-orm/mysql-core";
// All base references are evaluated in table callbacks, after root initialization.
import {
  branches,
  customers,
  deliveryConsignments,
  deliveryParties,
  invoiceItemBundleComponents,
  invoiceItems,
  invoices,
  inventoryMovements,
  productVariants,
  receipts,
  shifts,
  suppliers,
  users,
  workOrders,
} from "./schema";
import {
  AFTERCARE_CASE_STATUSES,
  AFTERCARE_DISPOSITIONS,
  AFTERCARE_EXECUTION_STATUSES,
  FULFILLMENT_CHARGE_CATEGORIES,
  FULFILLMENT_CHARGE_STATUSES,
  FULFILLMENT_REQUEST_STATUSES,
} from "../shared/fulfillment";
import type {
  AftercareSettlementDecision,
  AftercareSettlementSourceRight,
} from "../shared/fulfillment";

const id = (name: string) => bigint(name, { mode: "number" });
const amount = (name: string) => decimal(name, { precision: 15, scale: 2 });
const identity = () => ({
  clientRequestId: varchar("clientRequestId", { length: 80 }).notNull(),
  sourceHash: char("sourceHash", { length: 64 }).notNull(),
  version: int("version").default(1).notNull(),
});
const dates = () => ({
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const fulfillmentRequests = mysqlTable(
  "fulfillmentRequests",
  {
    id: id("id").autoincrement().primaryKey(),
    branchId: id("branchId").notNull(),
    customerId: id("customerId"),
    requestNumber: varchar("requestNumber", { length: 60 }).notNull(),
    status: mysqlEnum("status", FULFILLMENT_REQUEST_STATUSES)
      .default("DRAFT")
      .notNull(),
    recipientName: varchar("recipientName", { length: 255 }).notNull(),
    recipientPhone: varchar("recipientPhone", { length: 24 }).notNull(),
    deliveryAddress: text("deliveryAddress").notNull(),
    partyId: id("partyId"),
    deliveryFee: amount("deliveryFee").default("0").notNull(),
    feeCollection: mysqlEnum("feeCollection", ["COURIER", "COUNTER", "SHOP"])
      .default("COURIER")
      .notNull(),
    partialReleaseAllowed: boolean("partialReleaseAllowed")
      .default(false)
      .notNull(),
    futureFeeDecision: text("futureFeeDecision"),
    notes: text("notes"),
    createdBy: int("createdBy").notNull(),
    releasedBy: int("releasedBy"),
    releasedAt: timestamp("releasedAt"),
    cancelledBy: int("cancelledBy"),
    cancelledAt: timestamp("cancelledAt"),
    cancellationReason: text("cancellationReason"),
    ...identity(),
    ...dates(),
  },
  (t): MySqlTableExtraConfig => ({
    numberUq: unique("uq_fr_number").on(t.requestNumber),
    requestUq: unique("uq_fr_key").on(t.branchId, t.clientRequestId),
    scopeIdx: index("idx_fr_scope").on(t.branchId, t.status, t.createdAt),
    customerIdx: index("idx_fr_customer").on(t.customerId),
    phoneIdx: index("idx_fr_phone").on(t.recipientPhone),
    branchFk: foreignKey({
      name: "fk_fr_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    customerFk: foreignKey({
      name: "fk_fr_customer",
      columns: [t.customerId],
      foreignColumns: [customers.id],
    }),
    partyFk: foreignKey({
      name: "fk_fr_party",
      columns: [t.partyId],
      foreignColumns: [deliveryParties.id],
    }),
    creatorFk: foreignKey({
      name: "fk_fr_creator",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    releaseFk: foreignKey({
      name: "fk_fr_release",
      columns: [t.releasedBy],
      foreignColumns: [users.id],
    }),
    cancelFk: foreignKey({
      name: "fk_fr_cancel",
      columns: [t.cancelledBy],
      foreignColumns: [users.id],
    }),
    moneyCheck: check("chk_fr_money", sql`${t.deliveryFee} >= 0`),
    versionCheck: check("chk_fr_version", sql`${t.version} > 0`),
  }),
);

export const fulfillmentRequestItems = mysqlTable(
  "fulfillmentRequestItems",
  {
    id: id("id").autoincrement().primaryKey(),
    requestId: id("requestId").notNull(),
    invoiceId: id("invoiceId"),
    workOrderId: id("workOrderId"),
    materializedInvoiceId: id("materializedInvoiceId"),
    isActive: boolean("isActive").default(true).notNull(),
    status: mysqlEnum("status", ["WAITING", "READY", "RELEASED", "CANCELLED"])
      .default("WAITING")
      .notNull(),
    activeInvoiceId: id("activeInvoiceId").generatedAlwaysAs(
      sql`(CASE WHEN isActive = 1 THEN COALESCE(invoiceId, materializedInvoiceId) ELSE NULL END)`,
      { mode: "stored" },
    ),
    activeWorkOrderId: id("activeWorkOrderId").generatedAlwaysAs(
      sql`(CASE WHEN isActive = 1 THEN workOrderId ELSE NULL END)`,
      { mode: "stored" },
    ),
    consignmentId: id("consignmentId"),
    checkedBy: int("checkedBy"),
    checkedAt: timestamp("checkedAt"),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t): MySqlTableExtraConfig => ({
    requestIdx: index("idx_fri_request").on(t.requestId),
    invoiceUq: unique("uq_fri_active_invoice").on(t.activeInvoiceId),
    orderUq: unique("uq_fri_active_order").on(t.activeWorkOrderId),
    sourceInvoiceUq: unique("uq_fri_request_invoice").on(
      t.requestId,
      t.invoiceId,
    ),
    sourceOrderUq: unique("uq_fri_request_order").on(
      t.requestId,
      t.workOrderId,
    ),
    requestFk: foreignKey({
      name: "fk_fri_request",
      columns: [t.requestId],
      foreignColumns: [fulfillmentRequests.id],
    }),
    invoiceFk: foreignKey({
      name: "fk_fri_invoice",
      columns: [t.invoiceId],
      foreignColumns: [invoices.id],
    }),
    orderFk: foreignKey({
      name: "fk_fri_order",
      columns: [t.workOrderId],
      foreignColumns: [workOrders.id],
    }),
    materializedFk: foreignKey({
      name: "fk_fri_materialized",
      columns: [t.materializedInvoiceId],
      foreignColumns: [invoices.id],
    }),
    consignmentFk: foreignKey({
      name: "fk_fri_consignment",
      columns: [t.consignmentId],
      foreignColumns: [deliveryConsignments.id],
    }),
    checkerFk: foreignKey({
      name: "fk_fri_checker",
      columns: [t.checkedBy],
      foreignColumns: [users.id],
    }),
    sourceCheck: check(
      "chk_fri_source",
      sql`(${t.invoiceId} IS NOT NULL) + (${t.workOrderId} IS NOT NULL) = 1`,
    ),
    activeCheck: check(
      "chk_fri_active",
      sql`(${t.isActive} = 1 AND ${t.status} IN ('WAITING','READY','RELEASED')) OR (${t.isActive} = 0 AND ${t.status} IN ('RELEASED','CANCELLED'))`,
    ),
  }),
);

export const fulfillmentCharges = mysqlTable(
  "fulfillmentCharges",
  {
    id: id("id").autoincrement().primaryKey(),
    branchId: id("branchId").notNull(),
    requestId: id("requestId"),
    customerId: id("customerId"),
    category: mysqlEnum("category", FULFILLMENT_CHARGE_CATEGORIES).notNull(),
    status: mysqlEnum("status", FULFILLMENT_CHARGE_STATUSES)
      .default("DRAFT")
      .notNull(),
    description: text("description").notNull(),
    amount: amount("amount").notNull(),
    externalCost: amount("externalCost").default("0").notNull(),
    paidAmount: amount("paidAmount").default("0").notNull(),
    refundedAmount: amount("refundedAmount").default("0").notNull(),
    payeePaidAmount: amount("payeePaidAmount").default("0").notNull(),
    payeeSupplierId: id("payeeSupplierId"),
    payeePartyId: id("payeePartyId"),
    payeeUserId: int("payeeUserId"),
    payeeName: varchar("payeeName", { length: 255 }),
    payeePhone: varchar("payeePhone", { length: 24 }),
    createdBy: int("createdBy").notNull(),
    approvedBy: int("approvedBy"),
    approvedAt: timestamp("approvedAt"),
    completedBy: int("completedBy"),
    completedAt: timestamp("completedAt"),
    completionEvidence: text("completionEvidence"),
    /** Cut-over marker: approval already posted revenue/cost under the pre-0405 contract. */
    legacyPostedAt: timestamp("legacyPostedAt"),
    cancelledBy: int("cancelledBy"),
    cancelledAt: timestamp("cancelledAt"),
    reason: text("reason"),
    ...identity(),
    ...dates(),
  },
  (t): MySqlTableExtraConfig => ({
    requestUq: unique("uq_fc_key").on(t.branchId, t.clientRequestId),
    scopeIdx: index("idx_fc_scope").on(t.branchId, t.status, t.createdAt),
    requestIdx: index("idx_fc_request").on(t.requestId),
    customerIdx: index("idx_fc_customer").on(t.customerId),
    branchFk: foreignKey({
      name: "fk_fc_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    requestFk: foreignKey({
      name: "fk_fc_request",
      columns: [t.requestId],
      foreignColumns: [fulfillmentRequests.id],
    }),
    customerFk: foreignKey({
      name: "fk_fc_customer",
      columns: [t.customerId],
      foreignColumns: [customers.id],
    }),
    supplierFk: foreignKey({
      name: "fk_fc_supplier",
      columns: [t.payeeSupplierId],
      foreignColumns: [suppliers.id],
    }),
    partyFk: foreignKey({
      name: "fk_fc_party",
      columns: [t.payeePartyId],
      foreignColumns: [deliveryParties.id],
    }),
    userFk: foreignKey({
      name: "fk_fc_payee_user",
      columns: [t.payeeUserId],
      foreignColumns: [users.id],
    }),
    creatorFk: foreignKey({
      name: "fk_fc_creator",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    approverFk: foreignKey({
      name: "fk_fc_approver",
      columns: [t.approvedBy],
      foreignColumns: [users.id],
    }),
    completerFk: foreignKey({
      name: "fk_fc_completer",
      columns: [t.completedBy],
      foreignColumns: [users.id],
    }),
    cancelFk: foreignKey({
      name: "fk_fc_cancel",
      columns: [t.cancelledBy],
      foreignColumns: [users.id],
    }),
    moneyCheck: check(
      "chk_fc_money",
      sql`${t.amount} >= 0 AND ${t.externalCost} >= 0 AND ${t.paidAmount} >= 0 AND ${t.paidAmount} <= ${t.amount} AND ${t.refundedAmount} >= 0 AND ${t.refundedAmount} <= ${t.paidAmount} AND ${t.payeePaidAmount} >= 0 AND ${t.payeePaidAmount} <= ${t.externalCost}`,
    ),
    categoryCheck: check(
      "chk_fc_category",
      sql`(${t.category} = 'SHOP_EXPENSE' AND ${t.amount} = 0 AND ${t.externalCost} > 0) OR (${t.category} = 'PASS_THROUGH' AND ${t.amount} > 0 AND ${t.externalCost} = ${t.amount}) OR (${t.category} IN ('SERVICE','OUTSOURCED') AND ${t.amount} > 0)`,
    ),
    customerCheck: check(
      "chk_fc_customer",
      sql`${t.amount} = 0 OR ${t.customerId} IS NOT NULL OR (${t.category} = 'SERVICE' AND ${t.status} IN ('APPROVED','COMPLETED') AND ${t.externalCost} = 0 AND ${t.paidAmount} = ${t.amount} AND ${t.payeeSupplierId} IS NULL AND ${t.payeePartyId} IS NULL AND ${t.payeeUserId} IS NULL AND ${t.payeeName} IS NULL)`,
    ),
    payeeCheck: check(
      "chk_fc_payee",
      sql`${t.externalCost} = 0 OR ((${t.payeeSupplierId} IS NOT NULL) + (${t.payeePartyId} IS NOT NULL) + (${t.payeeUserId} IS NOT NULL) + (${t.payeeName} IS NOT NULL AND CHAR_LENGTH(TRIM(${t.payeeName})) > 0) = 1)`,
    ),
    versionCheck: check("chk_fc_version", sql`${t.version} > 0`),
    lifecycleCheck: check(
      "chk_fc_lifecycle",
      sql`(${t.status} = 'DRAFT' AND ${t.approvedBy} IS NULL AND ${t.approvedAt} IS NULL AND ${t.completedBy} IS NULL AND ${t.completedAt} IS NULL)
        OR (${t.status} = 'APPROVED' AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.completedBy} IS NULL AND ${t.completedAt} IS NULL)
        OR (${t.status} = 'COMPLETED' AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.completedBy} IS NOT NULL AND ${t.completedAt} IS NOT NULL AND ${t.completionEvidence} IS NOT NULL)
        OR (${t.status} = 'CANCELLED')`,
    ),
  }),
);

/** Allocations point to real receipts. Courier custody is not a second receipt. */
export const fulfillmentChargePayments = mysqlTable(
  "fulfillmentChargePayments",
  {
    id: id("id").autoincrement().primaryKey(),
    chargeId: id("chargeId").notNull(),
    branchId: id("branchId").notNull(),
    receiptId: id("receiptId"),
    kind: mysqlEnum("kind", [
      "COLLECTION",
      "REFUND",
      "PAYEE_PAYMENT",
      "COURIER_COLLECTION",
      "COURIER_REMITTANCE",
    ]).notNull(),
    amount: amount("amount").notNull(),
    originalPaymentId: id("originalPaymentId"),
    consignmentId: id("consignmentId"),
    partyId: id("partyId"),
    createdBy: int("createdBy").notNull(),
    clientRequestId: varchar("clientRequestId", { length: 80 }).notNull(),
    sourceHash: char("sourceHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t): MySqlTableExtraConfig => ({
    requestUq: unique("uq_fcp_key").on(t.chargeId, t.kind, t.clientRequestId),
    receiptUq: unique("uq_fcp_allocation").on(t.chargeId, t.kind, t.receiptId),
    chargeIdx: index("idx_fcp_charge").on(t.chargeId),
    chargeFk: foreignKey({
      name: "fk_fcp_charge",
      columns: [t.chargeId],
      foreignColumns: [fulfillmentCharges.id],
    }),
    branchFk: foreignKey({
      name: "fk_fcp_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    receiptFk: foreignKey({
      name: "fk_fcp_receipt",
      columns: [t.receiptId],
      foreignColumns: [receipts.id],
    }),
    originalFk: foreignKey({
      name: "fk_fcp_original",
      columns: [t.originalPaymentId],
      foreignColumns: [t.id],
    }),
    consignmentFk: foreignKey({
      name: "fk_fcp_consignment",
      columns: [t.consignmentId],
      foreignColumns: [deliveryConsignments.id],
    }),
    partyFk: foreignKey({
      name: "fk_fcp_party",
      columns: [t.partyId],
      foreignColumns: [deliveryParties.id],
    }),
    actorFk: foreignKey({
      name: "fk_fcp_actor",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    amountCheck: check("chk_fcp_amount", sql`${t.amount} > 0`),
    receiptCheck: check(
      "chk_fcp_receipt",
      sql`(${t.kind} = 'COURIER_COLLECTION' AND ${t.receiptId} IS NULL AND ${t.consignmentId} IS NOT NULL AND ${t.partyId} IS NOT NULL) OR (${t.kind} <> 'COURIER_COLLECTION' AND ${t.receiptId} IS NOT NULL)`,
    ),
    refundCheck: check(
      "chk_fcp_refund",
      sql`${t.kind} <> 'REFUND' OR ${t.originalPaymentId} IS NOT NULL`,
    ),
  }),
);

export const aftercareCases = mysqlTable(
  "aftercareCases",
  {
    id: id("id").autoincrement().primaryKey(),
    branchId: id("branchId").notNull(),
    customerId: id("customerId"),
    invoiceId: id("invoiceId"),
    workOrderId: id("workOrderId"),
    originalConsignmentId: id("originalConsignmentId"),
    caseNumber: varchar("caseNumber", { length: 60 }).notNull(),
    status: mysqlEnum("status", AFTERCARE_CASE_STATUSES)
      .default("DRAFT")
      .notNull(),
    reason: text("reason").notNull(),
    evidence: text("evidence").notNull(),
    resolution: text("resolution"),
    createdBy: int("createdBy").notNull(),
    approvedBy: int("approvedBy"),
    approvedAt: timestamp("approvedAt"),
    resolvedBy: int("resolvedBy"),
    resolvedAt: timestamp("resolvedAt"),
    cancelledBy: int("cancelledBy"),
    cancelledAt: timestamp("cancelledAt"),
    cancellationReason: text("cancellationReason"),
    ...identity(),
    ...dates(),
  },
  (t): MySqlTableExtraConfig => ({
    numberUq: unique("uq_ac_number").on(t.caseNumber),
    requestUq: unique("uq_ac_key").on(t.branchId, t.clientRequestId),
    scopeIdx: index("idx_ac_scope").on(t.branchId, t.status, t.createdAt),
    invoiceIdx: index("idx_ac_invoice").on(t.invoiceId),
    orderIdx: index("idx_ac_order").on(t.workOrderId),
    customerIdx: index("idx_ac_customer").on(t.customerId),
    branchFk: foreignKey({
      name: "fk_ac_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    customerFk: foreignKey({
      name: "fk_ac_customer",
      columns: [t.customerId],
      foreignColumns: [customers.id],
    }),
    invoiceFk: foreignKey({
      name: "fk_ac_invoice",
      columns: [t.invoiceId],
      foreignColumns: [invoices.id],
    }),
    orderFk: foreignKey({
      name: "fk_ac_order",
      columns: [t.workOrderId],
      foreignColumns: [workOrders.id],
    }),
    consignmentFk: foreignKey({
      name: "fk_ac_consignment",
      columns: [t.originalConsignmentId],
      foreignColumns: [deliveryConsignments.id],
    }),
    creatorFk: foreignKey({
      name: "fk_ac_creator",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    approverFk: foreignKey({
      name: "fk_ac_approver",
      columns: [t.approvedBy],
      foreignColumns: [users.id],
    }),
    resolverFk: foreignKey({
      name: "fk_ac_resolver",
      columns: [t.resolvedBy],
      foreignColumns: [users.id],
    }),
    cancelFk: foreignKey({
      name: "fk_ac_cancel",
      columns: [t.cancelledBy],
      foreignColumns: [users.id],
    }),
    sourceCheck: check(
      "chk_ac_source",
      sql`(${t.invoiceId} IS NOT NULL) + (${t.workOrderId} IS NOT NULL) = 1`,
    ),
    versionCheck: check("chk_ac_version", sql`${t.version} > 0`),
  }),
);

export const aftercareLines = mysqlTable(
  "aftercareLines",
  {
    id: id("id").autoincrement().primaryKey(),
    caseId: id("caseId").notNull(),
    originalInvoiceItemId: id("originalInvoiceItemId"),
    sourceWorkOrderId: id("sourceWorkOrderId"),
    originalBundleComponentId: id("originalBundleComponentId"),
    componentVariantId: id("componentVariantId"),
    disposition: mysqlEnum("disposition", AFTERCARE_DISPOSITIONS).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    executedBaseQuantity: int("executedBaseQuantity").default(0).notNull(),
    deliveredBaseQuantity: int("deliveredBaseQuantity").default(0).notNull(),
    settledBaseQuantity: int("settledBaseQuantity").default(0).notNull(),
    originalMovementId: id("originalMovementId"),
    heldConfirmedBy: int("heldConfirmedBy"),
    heldConfirmedAt: timestamp("heldConfirmedAt"),
    evidence: text("evidence").notNull(),
    notes: text("notes"),
  },
  (t): MySqlTableExtraConfig => ({
    caseIdx: index("idx_acl_case").on(t.caseId),
    sourceIdx: index("idx_acl_source").on(
      t.originalInvoiceItemId,
      t.componentVariantId,
    ),
    sourceOrderIdx: index("idx_acl_source_wo").on(t.sourceWorkOrderId),
    caseFk: foreignKey({
      name: "fk_acl_case",
      columns: [t.caseId],
      foreignColumns: [aftercareCases.id],
    }),
    itemFk: foreignKey({
      name: "fk_acl_item",
      columns: [t.originalInvoiceItemId],
      foreignColumns: [invoiceItems.id],
    }),
    sourceOrderFk: foreignKey({
      name: "fk_acl_source_wo",
      columns: [t.sourceWorkOrderId],
      foreignColumns: [workOrders.id],
    }),
    snapshotFk: foreignKey({
      name: "fk_acl_snapshot",
      columns: [t.originalBundleComponentId],
      foreignColumns: [invoiceItemBundleComponents.id],
    }),
    variantFk: foreignKey({
      name: "fk_acl_variant",
      columns: [t.componentVariantId],
      foreignColumns: [productVariants.id],
    }),
    movementFk: foreignKey({
      name: "fk_acl_movement",
      columns: [t.originalMovementId],
      foreignColumns: [inventoryMovements.id],
    }),
    checkerFk: foreignKey({
      name: "fk_acl_checker",
      columns: [t.heldConfirmedBy],
      foreignColumns: [users.id],
    }),
    qtyCheck: check(
      "chk_acl_qty",
      sql`${t.baseQuantity} > 0 AND ${t.executedBaseQuantity} >= 0 AND ${t.executedBaseQuantity} <= ${t.baseQuantity} AND ${t.deliveredBaseQuantity} >= 0 AND ${t.deliveredBaseQuantity} <= ${t.executedBaseQuantity} AND ${t.settledBaseQuantity} >= 0 AND ${t.deliveredBaseQuantity} + ${t.settledBaseQuantity} <= ${t.baseQuantity}`,
    ),
    sourceCheck: check(
      "chk_acl_source",
      sql`(${t.originalInvoiceItemId} IS NOT NULL) + (${t.sourceWorkOrderId} IS NOT NULL) = 1`,
    ),
    serviceCheck: check(
      "chk_acl_service",
      sql`(${t.sourceWorkOrderId} IS NULL AND ${t.componentVariantId} IS NOT NULL)
        OR (${t.sourceWorkOrderId} IS NOT NULL AND ${t.disposition} = 'REPRINT'
          AND ${t.componentVariantId} IS NULL AND ${t.originalBundleComponentId} IS NULL
          AND ${t.originalMovementId} IS NULL AND ${t.heldConfirmedBy} IS NULL AND ${t.heldConfirmedAt} IS NULL)`,
    ),
    heldCheck: check(
      "chk_acl_held",
      sql`${t.disposition} <> 'MISSING_HELD' OR (${t.originalMovementId} IS NOT NULL AND ${t.heldConfirmedBy} IS NOT NULL AND ${t.heldConfirmedAt} IS NOT NULL)`,
    ),
  }),
);

export const aftercareExecutions = mysqlTable(
  "aftercareExecutions",
  {
    id: id("id").autoincrement().primaryKey(),
    caseId: id("caseId").notNull(),
    branchId: id("branchId").notNull(),
    status: mysqlEnum("status", AFTERCARE_EXECUTION_STATUSES)
      .default("PREPARED")
      .notNull(),
    partyId: id("partyId"),
    consignmentId: id("consignmentId"),
    deliveryFee: amount("deliveryFee").default("0").notNull(),
    feeCollection: mysqlEnum("feeCollection", ["SHOP"])
      .default("SHOP")
      .notNull(),
    codAmount: amount("codAmount").default("0").notNull(),
    feePaidAmount: amount("feePaidAmount").default("0").notNull(),
    feeReceiptId: id("feeReceiptId"),
    recipientName: varchar("recipientName", { length: 255 }).notNull(),
    recipientPhone: varchar("recipientPhone", { length: 24 }).notNull(),
    deliveryAddress: text("deliveryAddress").notNull(),
    totalCost: amount("totalCost").default("0").notNull(),
    preparedBy: int("preparedBy").notNull(),
    checkedBy: int("checkedBy"),
    checkedAt: timestamp("checkedAt"),
    dispatchedBy: int("dispatchedBy"),
    dispatchedAt: timestamp("dispatchedAt"),
    deliveredBy: int("deliveredBy"),
    deliveredAt: timestamp("deliveredAt"),
    returnedAt: timestamp("returnedAt"),
    deliveryProof: text("deliveryProof"),
    returnEvidence: text("returnEvidence"),
    notes: text("notes"),
    ...identity(),
    ...dates(),
  },
  (t): MySqlTableExtraConfig => ({
    requestUq: unique("uq_ae_key").on(t.branchId, t.clientRequestId),
    consignmentUq: unique("uq_ae_consignment").on(t.consignmentId),
    caseIdx: index("idx_ae_case").on(t.caseId, t.status),
    scopeIdx: index("idx_ae_scope").on(t.branchId, t.status),
    caseFk: foreignKey({
      name: "fk_ae_case",
      columns: [t.caseId],
      foreignColumns: [aftercareCases.id],
    }),
    branchFk: foreignKey({
      name: "fk_ae_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    partyFk: foreignKey({
      name: "fk_ae_party",
      columns: [t.partyId],
      foreignColumns: [deliveryParties.id],
    }),
    consignmentFk: foreignKey({
      name: "fk_ae_consignment",
      columns: [t.consignmentId],
      foreignColumns: [deliveryConsignments.id],
    }),
    receiptFk: foreignKey({
      name: "fk_ae_receipt",
      columns: [t.feeReceiptId],
      foreignColumns: [receipts.id],
    }),
    preparerFk: foreignKey({
      name: "fk_ae_preparer",
      columns: [t.preparedBy],
      foreignColumns: [users.id],
    }),
    checkerFk: foreignKey({
      name: "fk_ae_checker",
      columns: [t.checkedBy],
      foreignColumns: [users.id],
    }),
    dispatchFk: foreignKey({
      name: "fk_ae_dispatch",
      columns: [t.dispatchedBy],
      foreignColumns: [users.id],
    }),
    deliverFk: foreignKey({
      name: "fk_ae_deliver",
      columns: [t.deliveredBy],
      foreignColumns: [users.id],
    }),
    moneyCheck: check(
      "chk_ae_money",
      sql`${t.codAmount} = 0 AND ${t.deliveryFee} >= 0 AND ${t.feePaidAmount} >= 0 AND ${t.feePaidAmount} <= ${t.deliveryFee} AND ${t.totalCost} >= 0`,
    ),
    versionCheck: check("chk_ae_version", sql`${t.version} > 0`),
  }),
);

/** REPRINT rows identify actual new material variants; quantities are base units. */
export const aftercareExecutionLines = mysqlTable(
  "aftercareExecutionLines",
  {
    id: id("id").autoincrement().primaryKey(),
    executionId: id("executionId").notNull(),
    aftercareLineId: id("aftercareLineId").notNull(),
    variantId: id("variantId"),
    kind: mysqlEnum("kind", ["OUTPUT", "MATERIAL"]).default("OUTPUT").notNull(),
    outputLineId: id("outputLineId").generatedAlwaysAs(
      sql`(CASE WHEN kind = 'OUTPUT' THEN aftercareLineId ELSE NULL END)`,
      { mode: "stored" },
    ),
    baseQuantity: int("baseQuantity").notNull(),
    fulfilledBaseQuantity: int("fulfilledBaseQuantity").notNull(),
    custodyBaseQuantity: int("custodyBaseQuantity").default(0).notNull(),
    deliveredBaseQuantity: int("deliveredBaseQuantity").default(0).notNull(),
    returnedBaseQuantity: int("returnedBaseQuantity").default(0).notNull(),
    settledBaseQuantity: int("settledBaseQuantity").default(0).notNull(),
    movementId: id("movementId"),
    reusedFromLineId: id("reusedFromLineId"),
    unitCost: amount("unitCost").default("0").notNull(),
    lineCost: amount("lineCost").default("0").notNull(),
    notes: text("notes"),
  },
  (t): MySqlTableExtraConfig => ({
    executionIdx: index("idx_ael_execution").on(t.executionId),
    sourceIdx: index("idx_ael_source").on(t.aftercareLineId),
    movementUq: unique("uq_ael_movement").on(t.movementId),
    reuseUq: unique("uq_ael_reused_from").on(t.reusedFromLineId),
    reuseFk: foreignKey({
      name: "fk_ael_reused_from",
      columns: [t.reusedFromLineId],
      foreignColumns: [t.id],
    }),
    outputUq: unique("uq_ael_output").on(t.executionId, t.outputLineId),
    executionFk: foreignKey({
      name: "fk_ael_execution",
      columns: [t.executionId],
      foreignColumns: [aftercareExecutions.id],
    }),
    lineFk: foreignKey({
      name: "fk_ael_line",
      columns: [t.aftercareLineId],
      foreignColumns: [aftercareLines.id],
    }),
    variantFk: foreignKey({
      name: "fk_ael_variant",
      columns: [t.variantId],
      foreignColumns: [productVariants.id],
    }),
    movementFk: foreignKey({
      name: "fk_ael_movement",
      columns: [t.movementId],
      foreignColumns: [inventoryMovements.id],
    }),
    qtyCheck: check(
      "chk_ael_qty",
      sql`${t.baseQuantity} > 0 AND ${t.fulfilledBaseQuantity} >= 0 AND ${t.custodyBaseQuantity} >= 0 AND ${t.deliveredBaseQuantity} >= 0 AND ${t.returnedBaseQuantity} >= 0 AND ${t.settledBaseQuantity} >= 0 AND ${t.settledBaseQuantity} + ${t.deliveredBaseQuantity} <= ${t.baseQuantity} AND ${t.custodyBaseQuantity} + ${t.deliveredBaseQuantity} + ${t.returnedBaseQuantity} <= ${t.fulfilledBaseQuantity}`,
    ),
    kindCheck: check(
      "chk_ael_kind",
      sql`(${t.kind} = 'OUTPUT' AND ${t.fulfilledBaseQuantity} = ${t.baseQuantity}) OR (${t.kind} = 'MATERIAL' AND ${t.fulfilledBaseQuantity} = 0 AND ${t.custodyBaseQuantity} = 0 AND ${t.deliveredBaseQuantity} = 0 AND ${t.returnedBaseQuantity} = 0 AND ${t.movementId} IS NOT NULL)`,
    ),
    variantCheck: check(
      "chk_ael_variant",
      sql`${t.variantId} IS NOT NULL OR (${t.kind} = 'OUTPUT'
        AND ${t.movementId} IS NULL AND ${t.unitCost} = 0 AND ${t.lineCost} = 0)`,
    ),
    costCheck: check(
      "chk_ael_cost",
      sql`${t.unitCost} >= 0 AND ${t.lineCost} >= 0`,
    ),
    reuseCheck: check(
      "chk_ael_reuse",
      sql`${t.reusedFromLineId} IS NULL OR (${t.kind} = 'OUTPUT' AND ${t.movementId} IS NULL AND ${t.unitCost} = 0 AND ${t.lineCost} = 0)`,
    ),
  }),
);

/** One final controlled stop per case; source rights remain open until real sale return/refund. */
export const aftercareSettlements = mysqlTable(
  "aftercareSettlements",
  {
    id: id("id").autoincrement().primaryKey(),
    caseId: id("caseId").notNull(),
    branchId: id("branchId").notNull(),
    status: mysqlEnum("status", [
      "REQUESTED",
      "APPROVED",
      "POSTED",
      "WITHDRAWN",
    ])
      .default("REQUESTED")
      .notNull(),
    activeCaseId: id("activeCaseId").generatedAlwaysAs(
      sql`(CASE WHEN status <> 'WITHDRAWN' THEN caseId ELSE NULL END)`,
      { mode: "stored" },
    ),
    caseVersion: int("caseVersion").notNull(),
    previewHash: char("previewHash", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    evidence: text("evidence").notNull(),
    decisions: json("decisions")
      .$type<AftercareSettlementDecision[]>()
      .notNull(),
    sourceRights: json("sourceRights")
      .$type<AftercareSettlementSourceRight[]>()
      .notNull(),
    restoredValue: amount("restoredValue").default("0").notNull(),
    createdBy: int("createdBy").notNull(),
    approvedBy: int("approvedBy"),
    approvedAt: timestamp("approvedAt"),
    postedBy: int("postedBy"),
    postedAt: timestamp("postedAt"),
    ...identity(),
    ...dates(),
  },
  (t): MySqlTableExtraConfig => ({
    caseUq: unique("uq_acs_case").on(t.activeCaseId),
    caseIdx: index("idx_acs_case").on(t.caseId),
    keyUq: unique("uq_acs_key").on(t.branchId, t.clientRequestId),
    scopeIdx: index("idx_acs_scope").on(t.branchId, t.status),
    caseFk: foreignKey({
      name: "fk_acs_case",
      columns: [t.caseId],
      foreignColumns: [aftercareCases.id],
    }),
    branchFk: foreignKey({
      name: "fk_acs_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    makerFk: foreignKey({
      name: "fk_acs_maker",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    checkerFk: foreignKey({
      name: "fk_acs_checker",
      columns: [t.approvedBy],
      foreignColumns: [users.id],
    }),
    posterFk: foreignKey({
      name: "fk_acs_poster",
      columns: [t.postedBy],
      foreignColumns: [users.id],
    }),
    valueCheck: check(
      "chk_acs_value",
      sql`${t.restoredValue} >= 0 AND ${t.version} > 0 AND ${t.caseVersion} > 0`,
    ),
    sodCheck: check(
      "chk_acs_sod",
      sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.createdBy}`,
    ),
    stateCheck: check(
      "chk_acs_state",
      sql`(${t.status} = 'WITHDRAWN' AND ${t.postedBy} IS NULL) OR (${t.status} = 'REQUESTED' AND ${t.approvedBy} IS NULL AND ${t.postedBy} IS NULL) OR (${t.status} = 'APPROVED' AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.postedBy} IS NULL) OR (${t.status} = 'POSTED' AND ${t.approvedBy} IS NOT NULL AND ${t.postedBy} IS NOT NULL AND ${t.postedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * Physical custody is independent from the commercial invoice, customer debt and
 * carrier settlement.  Quantities are kept in exclusive buckets so partial
 * delivery/return/inspection never has to overload `deliveryConsignments.status`.
 */
export const deliveryCustodyItems = mysqlTable(
  "deliveryCustodyItems",
  {
    id: id("id").autoincrement().primaryKey(),
    consignmentId: id("consignmentId").notNull(),
    leaderConsignmentId: id("leaderConsignmentId").notNull(),
    branchId: id("branchId").notNull(),
    sourceType: mysqlEnum("sourceType", [
      "INVOICE",
      "WORK_ORDER",
      "ONLINE_ORDER",
      "FULFILLMENT_REQUEST",
      "AFTERCARE_EXECUTION",
    ]).notNull(),
    sourceId: id("sourceId").notNull(),
    sourceLineKey: varchar("sourceLineKey", { length: 120 }).notNull(),
    itemKind: mysqlEnum("itemKind", [
      "STOCKED_ITEM",
      "BUNDLE_COMPONENT",
      "WORK_ORDER_OUTPUT",
      "AFTERCARE_OUTPUT",
    ]).notNull(),
    invoiceItemId: id("invoiceItemId"),
    bundleComponentId: id("bundleComponentId"),
    variantId: id("variantId"),
    originalMovementId: id("originalMovementId"),
    baseQuantity: int("baseQuantity").notNull(),
    originalIssueUnitCost: amount("originalIssueUnitCost"),
    originalIssueValue: amount("originalIssueValue"),
    preparedHeldBaseQuantity: int("preparedHeldBaseQuantity")
      .default(0)
      .notNull(),
    carrierCustodyBaseQuantity: int("carrierCustodyBaseQuantity")
      .default(0)
      .notNull(),
    customerDeliveredBaseQuantity: int("customerDeliveredBaseQuantity")
      .default(0)
      .notNull(),
    returnedPendingInspectionBaseQuantity: int(
      "returnedPendingInspectionBaseQuantity",
    )
      .default(0)
      .notNull(),
    customerOwnedHeldBaseQuantity: int("customerOwnedHeldBaseQuantity")
      .default(0)
      .notNull(),
    reworkWipBaseQuantity: int("reworkWipBaseQuantity").default(0).notNull(),
    restockedClosedBaseQuantity: int("restockedClosedBaseQuantity")
      .default(0)
      .notNull(),
    damagedClosedBaseQuantity: int("damagedClosedBaseQuantity")
      .default(0)
      .notNull(),
    reviewStatus: mysqlEnum("reviewStatus", [
      "VERIFIED",
      "REVIEW_REQUIRED",
      "RESOLVED",
    ])
      .default("VERIFIED")
      .notNull(),
    reviewReason: text("reviewReason"),
    version: int("version").default(1).notNull(),
    /** Null only for the read-only cut-over backfill; native commands always stamp an actor. */
    createdBy: int("createdBy"),
    updatedBy: int("updatedBy"),
    closedAt: timestamp("closedAt"),
    ...dates(),
  },
  (t): MySqlTableExtraConfig => ({
    lineUq: unique("uq_dci_source_line").on(t.consignmentId, t.sourceLineKey),
    shipmentIdx: index("idx_dci_shipment").on(
      t.leaderConsignmentId,
      t.reviewStatus,
    ),
    sourceIdx: index("idx_dci_source").on(t.sourceType, t.sourceId),
    variantIdx: index("idx_dci_variant").on(t.variantId),
    movementIdx: index("idx_dci_movement").on(t.originalMovementId),
    consignmentFk: foreignKey({
      name: "fk_dci_consignment",
      columns: [t.consignmentId],
      foreignColumns: [deliveryConsignments.id],
    }),
    leaderFk: foreignKey({
      name: "fk_dci_leader",
      columns: [t.leaderConsignmentId],
      foreignColumns: [deliveryConsignments.id],
    }),
    branchFk: foreignKey({
      name: "fk_dci_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    invoiceItemFk: foreignKey({
      name: "fk_dci_invoice_item",
      columns: [t.invoiceItemId],
      foreignColumns: [invoiceItems.id],
    }),
    componentFk: foreignKey({
      name: "fk_dci_bundle_component",
      columns: [t.bundleComponentId],
      foreignColumns: [invoiceItemBundleComponents.id],
    }),
    variantFk: foreignKey({
      name: "fk_dci_variant",
      columns: [t.variantId],
      foreignColumns: [productVariants.id],
    }),
    movementFk: foreignKey({
      name: "fk_dci_movement",
      columns: [t.originalMovementId],
      foreignColumns: [inventoryMovements.id],
    }),
    creatorFk: foreignKey({
      name: "fk_dci_creator",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    updaterFk: foreignKey({
      name: "fk_dci_updater",
      columns: [t.updatedBy],
      foreignColumns: [users.id],
    }),
    quantityCheck: check(
      "chk_dci_quantity_conservation",
      sql`${t.baseQuantity} > 0
        AND ${t.preparedHeldBaseQuantity} >= 0
        AND ${t.carrierCustodyBaseQuantity} >= 0
        AND ${t.customerDeliveredBaseQuantity} >= 0
        AND ${t.returnedPendingInspectionBaseQuantity} >= 0
        AND ${t.customerOwnedHeldBaseQuantity} >= 0
        AND ${t.reworkWipBaseQuantity} >= 0
        AND ${t.restockedClosedBaseQuantity} >= 0
        AND ${t.damagedClosedBaseQuantity} >= 0
        AND ${t.preparedHeldBaseQuantity}
          + ${t.carrierCustodyBaseQuantity}
          + ${t.customerDeliveredBaseQuantity}
          + ${t.returnedPendingInspectionBaseQuantity}
          + ${t.customerOwnedHeldBaseQuantity}
          + ${t.reworkWipBaseQuantity}
          + ${t.restockedClosedBaseQuantity}
          + ${t.damagedClosedBaseQuantity} = ${t.baseQuantity}`,
    ),
    valueCheck: check(
      "chk_dci_historical_value",
      sql`(${t.originalIssueUnitCost} IS NULL AND ${t.originalIssueValue} IS NULL)
        OR (${t.originalIssueUnitCost} >= 0 AND ${t.originalIssueValue} >= 0)`,
    ),
    reviewCheck: check(
      "chk_dci_review_reason",
      sql`${t.reviewStatus} <> 'REVIEW_REQUIRED'
        OR (${t.reviewReason} IS NOT NULL AND CHAR_LENGTH(TRIM(${t.reviewReason})) >= 3)`,
    ),
    shapeCheck: check(
      "chk_dci_item_shape",
      sql`(${t.itemKind} = 'STOCKED_ITEM' AND ${t.invoiceItemId} IS NOT NULL AND ${t.bundleComponentId} IS NULL AND ${t.variantId} IS NOT NULL)
        OR (${t.itemKind} = 'BUNDLE_COMPONENT' AND ${t.invoiceItemId} IS NOT NULL AND ${t.bundleComponentId} IS NOT NULL AND ${t.variantId} IS NOT NULL)
        OR (${t.itemKind} = 'WORK_ORDER_OUTPUT' AND ${t.bundleComponentId} IS NULL AND ${t.variantId} IS NULL AND ${t.originalMovementId} IS NULL)
        OR (${t.itemKind} = 'AFTERCARE_OUTPUT' AND ${t.bundleComponentId} IS NULL)`,
    ),
    versionCheck: check("chk_dci_version", sql`${t.version} > 0`),
  }),
);

export type DeliveryCustodyItem = typeof deliveryCustodyItems.$inferSelect;
export type InsertDeliveryCustodyItem =
  typeof deliveryCustodyItems.$inferInsert;

export const DELIVERY_CUSTODY_STATES = [
  "PREPARED_HELD",
  "CARRIER_CUSTODY",
  "CUSTOMER_DELIVERED",
  "RETURNED_PENDING_INSPECTION",
  "CUSTOMER_OWNED_HELD",
  "REWORK_WIP",
  "RESTOCKED_CLOSED",
  "DAMAGED_CLOSED",
] as const;

/** Append-only evidence for each quantity transition. */
export const deliveryCustodyEvents = mysqlTable(
  "deliveryCustodyEvents",
  {
    id: id("id").autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 160 }).notNull(),
    custodyItemId: id("custodyItemId").notNull(),
    consignmentId: id("consignmentId").notNull(),
    operationId: varchar("operationId", { length: 100 }).notNull(),
    eventType: varchar("eventType", { length: 60 }).notNull(),
    fromState: mysqlEnum("fromState", DELIVERY_CUSTODY_STATES),
    toState: mysqlEnum("toState", DELIVERY_CUSTODY_STATES).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    evidence: json("evidence").notNull(),
    /** Null only for MIGRATED_OPEN events produced by migration 0405. */
    actorUserId: int("actorUserId"),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (t): MySqlTableExtraConfig => ({
    eventUq: unique("uq_dce_event_key").on(t.eventKey),
    itemTimeIdx: index("idx_dce_item_time").on(t.custodyItemId, t.occurredAt),
    consignmentIdx: index("idx_dce_consignment").on(t.consignmentId),
    itemFk: foreignKey({
      name: "fk_dce_item",
      columns: [t.custodyItemId],
      foreignColumns: [deliveryCustodyItems.id],
    }),
    consignmentFk: foreignKey({
      name: "fk_dce_consignment",
      columns: [t.consignmentId],
      foreignColumns: [deliveryConsignments.id],
    }),
    actorFk: foreignKey({
      name: "fk_dce_actor",
      columns: [t.actorUserId],
      foreignColumns: [users.id],
    }),
    quantityCheck: check("chk_dce_quantity", sql`${t.baseQuantity} > 0`),
    transitionCheck: check(
      "chk_dce_transition",
      sql`${t.fromState} IS NULL OR ${t.fromState} <> ${t.toState}`,
    ),
  }),
);

export type DeliveryCustodyEvent = typeof deliveryCustodyEvents.$inferSelect;

/** Immutable event payload used by original printing and every later reprint. */
export const deliveryDocumentSnapshots = mysqlTable(
  "deliveryDocumentSnapshots",
  {
    id: id("id").autoincrement().primaryKey(),
    documentNumber: varchar("documentNumber", { length: 80 }).notNull(),
    documentType: mysqlEnum("documentType", [
      "INVOICE",
      "SHIPPING_LABEL",
      "DISPATCH_SLIP",
      "DELIVERY_MANIFEST",
      "REMITTANCE_RECEIPT",
      "PARTY_SETTLEMENT",
      "PHYSICAL_RETURN_RECEIPT",
      "SALE_RETURN_RECEIPT",
      "SHORTFALL_VOUCHER",
      "OVERAGE_REFUND",
      "DELIVERY_FEE_REFUND",
      "DELIVERY_FEE_PAYMENT",
      "AFTERCARE_SETTLEMENT",
      "AFTERCARE_WAYBILL",
    ]).notNull(),
    layout: mysqlEnum("layout", [
      "A4_12MM",
      "THERMAL_80_CONTENT_72",
      "LABEL_80X120_SAFE_3",
      "LABEL_100X150_SAFE_3",
      "MULTIPAGE_PACK",
    ]).notNull(),
    sourceType: mysqlEnum("sourceType", [
      "INVOICE",
      "CONSIGNMENT",
      "SHIPMENT",
      "REMITTANCE",
      "RETURN_RECEIPT",
      "AFTERCARE_EXECUTION",
      "AFTERCARE_SETTLEMENT",
      "PARTY_SETTLEMENT",
    ]).notNull(),
    sourceId: id("sourceId").notNull(),
    sourceVersion: varchar("sourceVersion", { length: 128 }).notNull(),
    branchId: id("branchId").notNull(),
    shiftId: id("shiftId"),
    eventKey: varchar("eventKey", { length: 160 }).notNull(),
    eventOccurredAt: timestamp("eventOccurredAt").notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    createdBy: int("createdBy").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t): MySqlTableExtraConfig => ({
    numberUq: unique("uq_dds_number").on(t.documentNumber),
    eventUq: unique("uq_dds_event_document").on(t.eventKey, t.documentType),
    sourceIdx: index("idx_dds_source").on(
      t.sourceType,
      t.sourceId,
      t.documentType,
    ),
    branchTimeIdx: index("idx_dds_branch_time").on(t.branchId, t.createdAt),
    branchFk: foreignKey({
      name: "fk_dds_branch",
      columns: [t.branchId],
      foreignColumns: [branches.id],
    }),
    shiftFk: foreignKey({
      name: "fk_dds_shift",
      columns: [t.shiftId],
      foreignColumns: [shifts.id],
    }),
    actorFk: foreignKey({
      name: "fk_dds_actor",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
  }),
);

export type DeliveryDocumentSnapshot =
  typeof deliveryDocumentSnapshots.$inferSelect;

/** Printing is an operational side effect only; it never posts money or stock. */
export const deliveryDocumentPrints = mysqlTable(
  "deliveryDocumentPrints",
  {
    id: id("id").autoincrement().primaryKey(),
    snapshotId: id("snapshotId").notNull(),
    clientRequestId: varchar("clientRequestId", { length: 80 }).notNull(),
    requestHash: char("requestHash", { length: 64 }).notNull(),
    copyType: mysqlEnum("copyType", ["ORIGINAL", "REPRINT"])
      .default("ORIGINAL")
      .notNull(),
    reason: varchar("reason", { length: 500 }),
    printerKey: varchar("printerKey", { length: 120 }),
    status: mysqlEnum("status", ["REQUESTED", "SENT", "FAILED", "CANCELLED"])
      .default("REQUESTED")
      .notNull(),
    requestedBy: int("requestedBy").notNull(),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
    errorMessage: varchar("errorMessage", { length: 500 }),
  },
  (t): MySqlTableExtraConfig => ({
    requestUq: unique("uq_ddp_request").on(t.clientRequestId),
    snapshotIdx: index("idx_ddp_snapshot").on(t.snapshotId, t.requestedAt),
    snapshotFk: foreignKey({
      name: "fk_ddp_snapshot",
      columns: [t.snapshotId],
      foreignColumns: [deliveryDocumentSnapshots.id],
    }),
    actorFk: foreignKey({
      name: "fk_ddp_actor",
      columns: [t.requestedBy],
      foreignColumns: [users.id],
    }),
    copyCheck: check(
      "chk_ddp_copy_reason",
      sql`(${t.copyType} = 'ORIGINAL') OR (${t.copyType} = 'REPRINT' AND ${t.reason} IS NOT NULL AND CHAR_LENGTH(TRIM(${t.reason})) >= 3)`,
    ),
    resultCheck: check(
      "chk_ddp_result",
      sql`(${t.status} = 'FAILED' AND ${t.errorMessage} IS NOT NULL)
        OR (${t.status} <> 'FAILED' AND ${t.errorMessage} IS NULL)`,
    ),
  }),
);

export type DeliveryDocumentPrint = typeof deliveryDocumentPrints.$inferSelect;

export const aftercareSettlementLines = mysqlTable(
  "aftercareSettlementLines",
  {
    id: id("id").autoincrement().primaryKey(),
    settlementId: id("settlementId").notNull(),
    executionLineId: id("executionLineId").notNull(),
    originalIssueLineId: id("originalIssueLineId"),
    originalMovementId: id("originalMovementId"),
    returnMovementId: id("returnMovementId"),
    usableBaseQuantity: int("usableBaseQuantity").notNull(),
    consumedBaseQuantity: int("consumedBaseQuantity").notNull(),
    damagedBaseQuantity: int("damagedBaseQuantity").notNull(),
    restoredValue: amount("restoredValue").default("0").notNull(),
    evidence: text("evidence").notNull(),
  },
  (t): MySqlTableExtraConfig => ({
    lineUq: unique("uq_acsl_line").on(t.executionLineId),
    movementUq: unique("uq_acsl_movement").on(t.returnMovementId),
    settlementFk: foreignKey({
      name: "fk_acsl_settlement",
      columns: [t.settlementId],
      foreignColumns: [aftercareSettlements.id],
    }),
    lineFk: foreignKey({
      name: "fk_acsl_line",
      columns: [t.executionLineId],
      foreignColumns: [aftercareExecutionLines.id],
    }),
    issueFk: foreignKey({
      name: "fk_acsl_issue",
      columns: [t.originalIssueLineId],
      foreignColumns: [aftercareExecutionLines.id],
    }),
    originalFk: foreignKey({
      name: "fk_acsl_original",
      columns: [t.originalMovementId],
      foreignColumns: [inventoryMovements.id],
    }),
    returnFk: foreignKey({
      name: "fk_acsl_return",
      columns: [t.returnMovementId],
      foreignColumns: [inventoryMovements.id],
    }),
    qtyCheck: check(
      "chk_acsl_qty",
      sql`${t.usableBaseQuantity} >= 0 AND ${t.consumedBaseQuantity} >= 0 AND ${t.damagedBaseQuantity} >= 0 AND ${t.usableBaseQuantity} + ${t.consumedBaseQuantity} + ${t.damagedBaseQuantity} > 0 AND ${t.restoredValue} >= 0`,
    ),
    returnCheck: check(
      "chk_acsl_return",
      sql`${t.returnMovementId} IS NULL OR (${t.usableBaseQuantity} > 0 AND ${t.originalMovementId} IS NOT NULL AND ${t.originalIssueLineId} IS NOT NULL)`,
    ),
  }),
);

export type FulfillmentRequest = typeof fulfillmentRequests.$inferSelect;
export type FulfillmentRequestItem =
  typeof fulfillmentRequestItems.$inferSelect;
export type FulfillmentCharge = typeof fulfillmentCharges.$inferSelect;
export type FulfillmentChargePayment =
  typeof fulfillmentChargePayments.$inferSelect;
export type AftercareCase = typeof aftercareCases.$inferSelect;
export type AftercareLine = typeof aftercareLines.$inferSelect;
export type AftercareExecution = typeof aftercareExecutions.$inferSelect;
export type AftercareExecutionLine =
  typeof aftercareExecutionLines.$inferSelect;

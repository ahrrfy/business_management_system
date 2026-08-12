#!/usr/bin/env node

/**
 * Read-only preflight verifier for the digital-cards subsystem.
 *
 * Safety contract:
 * - The target must be supplied through DIGITAL_CARDS_VERIFY_DATABASE_URL.
 * - Port 3306 and non-loopback hosts are rejected unless
 *   DIGITAL_CARDS_VERIFY_ALLOW_REMOTE=1 is explicitly set.
 * - Audit SQL is a static SELECT-only catalogue, executed inside a READ ONLY
 *   transaction with multiple statements disabled.
 * - Samples contain identifiers, states, counts, and monetary values only.
 *
 * Usage:
 *   node scripts/verify-digital-cards-integrity.mjs --selftest
 *   DIGITAL_CARDS_VERIFY_DATABASE_URL=mysql://...:3307/db \
 *     node scripts/verify-digital-cards-integrity.mjs
 */

import assert from "node:assert/strict";

const URL_ENV = "DIGITAL_CARDS_VERIFY_DATABASE_URL";
const REMOTE_ENV = "DIGITAL_CARDS_VERIFY_ALLOW_REMOTE";
const SAMPLE_LIMIT = 5;
const QUERY_TIMEOUT_MS = 30_000;

const FORBIDDEN_SQL = /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE|RENAME|CALL|DO|HANDLER|LOAD|LOCK|UNLOCK|SET|GRANT|REVOKE|ANALYZE|OPTIMIZE|REPAIR)\b|\bINTO\s+(?:OUTFILE|DUMPFILE)\b|\bFOR\s+UPDATE\b/i;
const SENSITIVE_SAMPLE_COLUMN = /(?:name|phone|address|email|reference|notes|reason|description|password|token|secret|hash|customerId|userId|createdBy|approvedBy|reportedBy|reviewedBy|countedBy)/i;

/** @typedef {{ id: string, label: string, sql: string, sampleColumns: string[] }} Audit */

/** @type {Audit[]} */
const AUDITS = [
  {
    id: "price_version_identity_math",
    label: "هوية نسخ الأسعار ومعادلاتها",
    sampleColumns: [
      "priceVersionId", "batchId", "versionBranchId", "batchBranchId",
      "offeringId", "batchProviderId", "offeringProviderId",
    ],
    sql: `
      SELECT
        pv.id AS priceVersionId,
        pv.batchId AS batchId,
        pv.branchId AS versionBranchId,
        b.branchId AS batchBranchId,
        pv.offeringId AS offeringId,
        b.providerId AS batchProviderId,
        o.providerId AS offeringProviderId
      FROM digitalPriceVersions pv
      LEFT JOIN digitalPriceBatches b ON b.id = pv.batchId
      LEFT JOIN digitalOfferings o ON o.id = pv.offeringId
      LEFT JOIN digitalOfferingBranches ob
        ON ob.offeringId = pv.offeringId AND ob.branchId = pv.branchId
      WHERE b.id IS NULL OR o.id IS NULL OR ob.offeringId IS NULL
         OR pv.branchId <> b.branchId
         OR o.providerId <> b.providerId
         OR pv.providerShare < 0
         OR pv.sellPrice < pv.providerShare
         OR pv.marginAmount <> pv.sellPrice - pv.providerShare
         OR (pv.validUntil IS NOT NULL AND pv.validUntil <= pv.validFrom)
    `,
  },
  {
    id: "current_price_pointer",
    label: "مؤشر السعر الحالي المنشور والساري",
    sampleColumns: [
      "currentBranchId", "currentOfferingId", "priceVersionId",
      "versionBranchId", "versionOfferingId", "batchId", "batchStatus",
    ],
    sql: `
      SELECT
        cp.branchId AS currentBranchId,
        cp.offeringId AS currentOfferingId,
        cp.priceVersionId AS priceVersionId,
        pv.branchId AS versionBranchId,
        pv.offeringId AS versionOfferingId,
        b.id AS batchId,
        b.status AS batchStatus
      FROM digitalCurrentPrices cp
      LEFT JOIN digitalPriceVersions pv ON pv.id = cp.priceVersionId
      LEFT JOIN digitalPriceBatches b ON b.id = pv.batchId
      WHERE pv.id IS NULL OR b.id IS NULL
         OR pv.branchId <> cp.branchId
         OR pv.offeringId <> cp.offeringId
         OR b.branchId <> cp.branchId
         OR b.status <> 'PUBLISHED'
         OR pv.validFrom > CURRENT_TIMESTAMP
         OR (pv.validUntil IS NOT NULL AND pv.validUntil <= CURRENT_TIMESTAMP)
    `,
  },
  {
    id: "price_batch_state",
    label: "ختم النشر واعتماد التغيير الكبير",
    sampleColumns: ["batchId", "branchId", "providerId", "batchStatus"],
    sql: `
      SELECT
        id AS batchId,
        branchId AS branchId,
        providerId AS providerId,
        status AS batchStatus,
        createdBy AS createdBy,
        bigChangeApprovedBy AS approvedBy
      FROM digitalPriceBatches
      WHERE (status IN ('PUBLISHED', 'SUPERSEDED')
             AND (publishedBy IS NULL OR publishedAt IS NULL))
         OR (status IN ('DRAFT', 'CANCELLED')
             AND (publishedBy IS NOT NULL OR publishedAt IS NOT NULL))
         OR ((bigChangeApprovedBy IS NULL) <> (bigChangeApprovedAt IS NULL))
         OR (bigChangeApprovedBy IS NOT NULL AND bigChangeApprovedBy = createdBy)
    `,
  },
  {
    id: "offering_wallet_scope",
    label: "ربط العرض بمحفظة المزوّد والفرع الصحيحين",
    sampleColumns: [
      "offeringId", "offeringBranchId", "walletId", "walletBranchId",
      "offeringProviderId", "walletProviderId",
    ],
    sql: `
      SELECT
        ob.offeringId AS offeringId,
        ob.branchId AS offeringBranchId,
        ob.walletId AS walletId,
        w.branchId AS walletBranchId,
        o.providerId AS offeringProviderId,
        w.providerId AS walletProviderId
      FROM digitalOfferingBranches ob
      LEFT JOIN digitalOfferings o ON o.id = ob.offeringId
      LEFT JOIN digitalWallets w ON w.id = ob.walletId
      WHERE o.id IS NULL
         OR (ob.walletId IS NOT NULL AND w.id IS NULL)
         OR (w.id IS NOT NULL AND
             (w.branchId <> ob.branchId OR w.providerId <> o.providerId))
    `,
  },
  {
    id: "wallet_stored_balances",
    label: "حدود أرصدة المحافظ المخزّنة",
    sampleColumns: ["walletId", "branchId", "providerId", "currentBalance", "reservedBalance"],
    sql: `
      SELECT
        id AS walletId,
        branchId AS branchId,
        providerId AS providerId,
        currentBalance AS currentBalance,
        reservedBalance AS reservedBalance
      FROM digitalWallets
      WHERE currentBalance < 0
         OR reservedBalance < 0
         OR reservedBalance > currentBalance
    `,
  },
  {
    id: "wallet_transaction_shape",
    label: "نطاق حركات المحفظة واتجاهها واعتمادها",
    sampleColumns: [
      "transactionId", "walletId", "transactionBranchId", "walletBranchId",
      "transactionType", "direction", "transactionStatus",
    ],
    sql: `
      SELECT
        t.id AS transactionId,
        t.walletId AS walletId,
        t.branchId AS transactionBranchId,
        w.branchId AS walletBranchId,
        t.type AS transactionType,
        t.direction AS direction,
        t.status AS transactionStatus,
        t.createdBy AS createdBy,
        t.approvedBy AS approvedBy
      FROM digitalWalletTransactions t
      LEFT JOIN digitalWallets w ON w.id = t.walletId
      WHERE w.id IS NULL
         OR t.branchId <> w.branchId
         OR t.amount <= 0
         OR t.balanceAfter < 0
         OR NOT (
              (t.type IN ('OPENING', 'DEPOSIT', 'SALE_REVERSAL') AND t.direction = 'IN')
           OR (t.type IN ('SALE_CONSUMPTION', 'WITHDRAWAL', 'WRITEOFF') AND t.direction = 'OUT')
           OR t.type = 'ADJUSTMENT'
         )
         OR (t.status = 'PENDING_APPROVAL' AND
             (t.type <> 'ADJUSTMENT' OR t.approvedBy IS NOT NULL OR t.approvedAt IS NOT NULL))
         OR (t.status = 'ACTIVE' AND t.type = 'ADJUSTMENT' AND
             (t.approvedBy IS NULL OR t.approvedAt IS NULL OR t.approvedBy = t.createdBy))
         OR (t.status = 'ACTIVE' AND t.type <> 'ADJUSTMENT' AND
             (t.approvedBy IS NOT NULL OR t.approvedAt IS NOT NULL))
         OR (t.status = 'REVERSED' AND
             (t.type <> 'ADJUSTMENT' OR t.approvedBy IS NULL OR t.approvedAt IS NULL))
    `,
  },
  {
    id: "wallet_ledger_balance",
    label: "الرصيد المخزّن مقابل دفتر الحركات الفعّالة",
    sampleColumns: ["walletId", "currentBalance", "ledgerBalance"],
    sql: `
      SELECT
        w.id AS walletId,
        w.currentBalance AS currentBalance,
        COALESCE(SUM(
          CASE WHEN t.status = 'ACTIVE'
               THEN IF(t.direction = 'IN', t.amount, -t.amount)
               ELSE 0 END
        ), 0) AS ledgerBalance
      FROM digitalWallets w
      LEFT JOIN digitalWalletTransactions t ON t.walletId = w.id
      GROUP BY w.id, w.currentBalance
      HAVING w.currentBalance <> ledgerBalance
    `,
  },
  {
    id: "wallet_reserved_balance",
    label: "الرصيد المحجوز مقابل الحجوزات الفعّالة",
    sampleColumns: ["walletId", "reservedBalance", "calculatedReservedBalance"],
    sql: `
      SELECT
        w.id AS walletId,
        w.reservedBalance AS reservedBalance,
        COALESCE(SUM(
          CASE WHEN r.status = 'ACTIVE' THEN r.amount ELSE 0 END
        ), 0) AS calculatedReservedBalance
      FROM digitalWallets w
      LEFT JOIN digitalWalletReservations r ON r.walletId = w.id
      GROUP BY w.id, w.reservedBalance
      HAVING w.reservedBalance <> calculatedReservedBalance
    `,
  },
  {
    id: "wallet_reservation_shape",
    label: "هوية الحجوزات ومبالغها وحالاتها",
    sampleColumns: [
      "reservationId", "walletId", "intentId", "walletBranchId",
      "intentBranchId", "reservationStatus", "amount",
    ],
    sql: `
      SELECT
        r.id AS reservationId,
        r.walletId AS walletId,
        r.intentId AS intentId,
        w.branchId AS walletBranchId,
        i.branchId AS intentBranchId,
        r.status AS reservationStatus,
        r.amount AS amount
      FROM digitalWalletReservations r
      LEFT JOIN digitalWallets w ON w.id = r.walletId
      LEFT JOIN digitalSaleIntents i ON i.id = r.intentId
      WHERE w.id IS NULL OR i.id IS NULL
         OR w.branchId <> i.branchId
         OR r.amount <= 0
         OR (r.status = 'ACTIVE' AND
             (r.consumedAt IS NOT NULL OR r.releasedAt IS NOT NULL))
         OR (r.status = 'CONSUMED' AND
             (r.consumedAt IS NULL OR r.releasedAt IS NOT NULL))
         OR (r.status = 'RELEASED' AND
             (r.releasedAt IS NULL OR r.consumedAt IS NOT NULL))
    `,
  },
  {
    id: "wallet_accounting_scope",
    label: "نطاق قيود دفتر المحفظة",
    sampleColumns: [
      "entryId", "entryType", "entryBranchId", "walletId", "walletBranchId",
      "amount", "revenue", "cost", "profit",
    ],
    sql: `
      SELECT
        e.id AS entryId,
        e.entryType AS entryType,
        e.branchId AS entryBranchId,
        e.digitalWalletId AS walletId,
        w.branchId AS walletBranchId,
        e.amount AS amount,
        e.revenue AS revenue,
        e.cost AS cost,
        e.profit AS profit
      FROM accountingEntries e
      LEFT JOIN digitalWallets w ON w.id = e.digitalWalletId
      WHERE (e.entryType IN (
               'DIGITAL_WALLET_DEPOSIT', 'DIGITAL_WALLET_WITHDRAWAL',
               'DIGITAL_WALLET_CONSUMPTION', 'DIGITAL_WALLET_REVERSAL',
               'DIGITAL_WALLET_ADJUSTMENT'
             ) AND (
               e.digitalWalletId IS NULL OR w.id IS NULL OR e.branchId <> w.branchId
               OR e.amount < 0 OR e.revenue <> 0 OR e.cost <> 0 OR e.profit <> 0
             ))
         OR (e.entryType NOT IN (
               'DIGITAL_WALLET_DEPOSIT', 'DIGITAL_WALLET_WITHDRAWAL',
               'DIGITAL_WALLET_CONSUMPTION', 'DIGITAL_WALLET_REVERSAL',
               'DIGITAL_WALLET_ADJUSTMENT'
             ) AND e.digitalWalletId IS NOT NULL)
    `,
  },
  {
    id: "intent_header_identity_math",
    label: "هوية نيّة البيع وإجماليها",
    sampleColumns: [
      "intentId", "intentStatus", "intentBranchId", "shiftBranchId",
      "invoiceId", "invoiceBranchId", "expectedTotal", "itemsTotal", "itemCount",
    ],
    sql: `
      SELECT
        i.id AS intentId,
        i.status AS intentStatus,
        i.branchId AS intentBranchId,
        s.branchId AS shiftBranchId,
        i.invoiceId AS invoiceId,
        inv.branchId AS invoiceBranchId,
        i.expectedTotal AS expectedTotal,
        COALESCE(x.itemsTotal, 0) AS itemsTotal,
        COALESCE(x.itemCount, 0) AS itemCount
      FROM digitalSaleIntents i
      LEFT JOIN shifts s ON s.id = i.shiftId
      LEFT JOIN invoices inv ON inv.id = i.invoiceId
      LEFT JOIN (
        SELECT intentId, SUM(sellPriceSnapshot) AS itemsTotal, COUNT(*) AS itemCount
        FROM digitalSaleIntentItems
        GROUP BY intentId
      ) x ON x.intentId = i.id
      WHERE s.id IS NULL OR s.branchId <> i.branchId
         OR i.expectedTotal < 0
         OR COALESCE(x.itemCount, 0) = 0
         OR i.expectedTotal <> COALESCE(x.itemsTotal, 0)
         OR (i.status = 'FINALIZED' AND
             (i.invoiceId IS NULL OR inv.id IS NULL OR inv.branchId <> i.branchId))
         OR (i.status <> 'FINALIZED' AND i.invoiceId IS NOT NULL)
         OR (i.status = 'WRITEOFF_PENDING' AND
             (i.writeoffRequestedBy IS NULL OR i.writeoffRequestedAt IS NULL
              OR NULLIF(TRIM(i.writeoffReason), '') IS NULL
              OR i.writeoffApprovedBy IS NOT NULL OR i.writeoffApprovedAt IS NOT NULL))
         OR (i.status = 'WRITTEN_OFF' AND
             (i.writeoffRequestedBy IS NULL OR i.writeoffRequestedAt IS NULL
              OR NULLIF(TRIM(i.writeoffReason), '') IS NULL
              OR i.writeoffApprovedBy IS NULL OR i.writeoffApprovedAt IS NULL
              OR i.writeoffRequestedBy = i.writeoffApprovedBy))
         OR (i.status NOT IN ('WRITEOFF_PENDING', 'WRITTEN_OFF') AND
             (i.writeoffRequestedBy IS NOT NULL OR i.writeoffRequestedAt IS NOT NULL
              OR i.writeoffReason IS NOT NULL OR i.writeoffApprovedBy IS NOT NULL
              OR i.writeoffApprovedAt IS NOT NULL))
    `,
  },
  {
    id: "intent_item_identity_math",
    label: "هوية بند التنفيذ ولقطة سعره",
    sampleColumns: [
      "intentItemId", "intentId", "intentBranchId", "offeringId",
      "storedProviderId", "offeringProviderId", "priceVersionId",
      "versionBranchId", "versionOfferingId", "fulfillmentStatus",
    ],
    sql: `
      SELECT
        item.id AS intentItemId,
        item.intentId AS intentId,
        intent.branchId AS intentBranchId,
        item.offeringId AS offeringId,
        item.providerId AS storedProviderId,
        o.providerId AS offeringProviderId,
        item.priceVersionId AS priceVersionId,
        pv.branchId AS versionBranchId,
        pv.offeringId AS versionOfferingId,
        item.fulfillmentStatus AS fulfillmentStatus
      FROM digitalSaleIntentItems item
      LEFT JOIN digitalSaleIntents intent ON intent.id = item.intentId
      LEFT JOIN digitalOfferings o ON o.id = item.offeringId
      LEFT JOIN digitalProviders p ON p.id = o.providerId
      LEFT JOIN digitalPriceVersions pv ON pv.id = item.priceVersionId
      WHERE intent.id IS NULL OR o.id IS NULL OR p.id IS NULL OR pv.id IS NULL
         OR item.providerId = 0
         OR item.providerId <> o.providerId
         OR pv.offeringId <> item.offeringId
         OR pv.branchId <> intent.branchId
         OR item.sellPriceSnapshot < 0
         OR item.providerShareSnapshot < 0
         OR item.marginSnapshot <> item.sellPriceSnapshot - item.providerShareSnapshot
         OR item.sellPriceSnapshot <> pv.sellPrice
         OR item.providerShareSnapshot <> pv.providerShare
         OR item.marginSnapshot <> pv.marginAmount
         OR (item.fulfillmentStatus = 'PENDING' AND
             (item.confirmedBy IS NOT NULL OR item.confirmedAt IS NOT NULL))
         OR (item.fulfillmentStatus <> 'PENDING' AND
             (item.confirmedBy IS NULL OR item.confirmedAt IS NULL))
         OR (item.fulfillmentStatus = 'SUCCESS' AND p.referencePolicy = 'REQUIRED'
             AND NULLIF(TRIM(item.providerReference), '') IS NULL)
         OR (p.referencePolicy = 'NONE'
             AND NULLIF(TRIM(item.providerReference), '') IS NOT NULL)
    `,
  },
  {
    id: "provider_claim_duplicates",
    label: "تكرار مرجع التنفيذ بعد التطبيع",
    sampleColumns: ["providerId", "firstIntentItemId", "duplicateCount"],
    sql: `
      SELECT
        o.providerId AS providerId,
        MIN(item.id) AS firstIntentItemId,
        COUNT(*) AS duplicateCount
      FROM digitalSaleIntentItems item
      JOIN digitalOfferings o ON o.id = item.offeringId
      WHERE NULLIF(TRIM(item.providerReference), '') IS NOT NULL
      GROUP BY o.providerId, UPPER(TRIM(item.providerReference))
      HAVING COUNT(*) > 1
    `,
  },
  {
    id: "execution_claim_state",
    label: "تطابق قفل إصدار البطاقة مع حالة البند والعملية",
    sampleColumns: [
      "intentItemId", "intentId", "fulfillmentStatus", "claimState", "intentStatus",
    ],
    sql: `
      SELECT
        c.intentItemId AS intentItemId,
        item.intentId AS intentId,
        item.fulfillmentStatus AS fulfillmentStatus,
        CASE WHEN c.completedAt IS NULL THEN 'OPEN' ELSE 'COMPLETED' END AS claimState,
        intent.status AS intentStatus
      FROM digitalSaleExecutionClaims c
      LEFT JOIN digitalSaleIntentItems item ON item.id = c.intentItemId
      LEFT JOIN digitalSaleIntents intent ON intent.id = item.intentId
      WHERE item.id IS NULL OR intent.id IS NULL
         OR c.claimedAt >= c.expiresAt
         OR (c.completedAt IS NULL AND item.fulfillmentStatus <> 'PENDING')
         OR (c.completedAt IS NOT NULL AND item.fulfillmentStatus = 'PENDING')
         OR (c.completedAt IS NULL AND intent.status NOT IN ('EXECUTING', 'NEEDS_REVIEW'))
    `,
  },
  {
    id: "sale_detail_identity_math",
    label: "هوية تفاصيل البيع ومعادلاتها",
    sampleColumns: [
      "saleDetailId", "invoiceId", "invoiceItemId", "invoiceItemInvoiceId",
      "intentItemId", "intentInvoiceId", "offeringId", "providerId", "priceVersionId",
    ],
    sql: `
      SELECT
        d.id AS saleDetailId,
        d.invoiceId AS invoiceId,
        d.invoiceItemId AS invoiceItemId,
        ii.invoiceId AS invoiceItemInvoiceId,
        d.intentItemId AS intentItemId,
        intent.invoiceId AS intentInvoiceId,
        d.offeringId AS offeringId,
        d.providerId AS providerId,
        d.priceVersionId AS priceVersionId
      FROM digitalSaleDetails d
      LEFT JOIN invoiceItems ii ON ii.id = d.invoiceItemId
      LEFT JOIN invoices inv ON inv.id = d.invoiceId
      LEFT JOIN digitalSaleIntentItems item ON item.id = d.intentItemId
      LEFT JOIN digitalSaleIntents intent ON intent.id = item.intentId
      LEFT JOIN digitalOfferings o ON o.id = d.offeringId
      LEFT JOIN digitalPriceVersions pv ON pv.id = d.priceVersionId
      WHERE ii.id IS NULL OR inv.id IS NULL OR item.id IS NULL
         OR intent.id IS NULL OR o.id IS NULL OR pv.id IS NULL
         OR ii.invoiceId <> d.invoiceId
         OR intent.invoiceId IS NULL OR intent.invoiceId <> d.invoiceId
         OR item.offeringId <> d.offeringId
         OR item.priceVersionId <> d.priceVersionId
         OR o.providerId <> d.providerId
         OR pv.offeringId <> d.offeringId
         OR pv.branchId <> inv.branchId
         OR d.sellPriceSnapshot < 0
         OR d.providerShareSnapshot < 0
         OR d.profitSnapshot <> d.sellPriceSnapshot - d.providerShareSnapshot
         OR d.sellPriceSnapshot <> item.sellPriceSnapshot
         OR d.providerShareSnapshot <> item.providerShareSnapshot
         OR d.profitSnapshot <> item.marginSnapshot
         OR NOT (d.providerReference <=> item.providerReference)
         OR (d.fulfillmentStatus = 'LOSS_REFUND_PENDING' AND
             (d.lossRefundRequestedBy IS NULL OR d.lossRefundRequestedAt IS NULL
              OR NULLIF(TRIM(d.lossRefundReason), '') IS NULL
              OR d.lossRefundApprovedBy IS NOT NULL OR d.lossRefundApprovedAt IS NOT NULL))
         OR (d.fulfillmentStatus = 'LOSS_REFUND' AND
             (d.lossRefundRequestedBy IS NULL OR d.lossRefundRequestedAt IS NULL
              OR NULLIF(TRIM(d.lossRefundReason), '') IS NULL
              OR d.lossRefundApprovedBy IS NULL OR d.lossRefundApprovedAt IS NULL
              OR d.lossRefundRequestedBy = d.lossRefundApprovedBy))
         OR (d.fulfillmentStatus NOT IN ('LOSS_REFUND_PENDING', 'LOSS_REFUND') AND
             (d.lossRefundRequestedBy IS NOT NULL OR d.lossRefundRequestedAt IS NOT NULL
              OR d.lossRefundReason IS NOT NULL OR d.lossRefundApprovedBy IS NOT NULL
              OR d.lossRefundApprovedAt IS NOT NULL))
    `,
  },
  {
    id: "sale_wallet_link",
    label: "ربط البيع مسبق الدفع بحركة المحفظة",
    sampleColumns: [
      "saleDetailId", "settlementMode", "invoiceId", "providerId",
      "walletTransactionId", "transactionType", "transactionStatus", "walletProviderId",
    ],
    sql: `
      SELECT
        d.id AS saleDetailId,
        d.settlementModeSnapshot AS settlementMode,
        d.invoiceId AS invoiceId,
        d.providerId AS providerId,
        d.walletTransactionId AS walletTransactionId,
        t.type AS transactionType,
        t.status AS transactionStatus,
        w.providerId AS walletProviderId
      FROM digitalSaleDetails d
      LEFT JOIN invoices inv ON inv.id = d.invoiceId
      LEFT JOIN digitalWalletTransactions t ON t.id = d.walletTransactionId
      LEFT JOIN digitalWallets w ON w.id = t.walletId
      WHERE (d.settlementModeSnapshot = 'PREPAID' AND (
              t.id IS NULL OR w.id IS NULL
              OR t.type <> 'SALE_CONSUMPTION'
              OR t.direction <> 'OUT'
              OR t.status <> 'ACTIVE'
              OR t.invoiceId <> d.invoiceId
              OR t.branchId <> inv.branchId
              OR w.providerId <> d.providerId
            ))
         OR (d.settlementModeSnapshot = 'POSTPAID' AND d.walletTransactionId IS NOT NULL)
    `,
  },
  {
    id: "sale_wallet_amount",
    label: "مبلغ استهلاك المحفظة مقابل حصص تفاصيل البيع",
    sampleColumns: ["walletTransactionId", "transactionAmount", "detailsProviderShare", "linkedDetailCount"],
    sql: `
      SELECT
        t.id AS walletTransactionId,
        t.amount AS transactionAmount,
        COALESCE(SUM(d.providerShareSnapshot), 0) AS detailsProviderShare,
        COUNT(d.id) AS linkedDetailCount
      FROM digitalWalletTransactions t
      LEFT JOIN digitalSaleDetails d ON d.walletTransactionId = t.id
      WHERE t.type = 'SALE_CONSUMPTION'
      GROUP BY t.id, t.amount
      HAVING linkedDetailCount = 0 OR t.amount <> detailsProviderShare
    `,
  },
  {
    id: "subscription_source_math",
    label: "مصدر عقد الاشتراك ومدته وحالته",
    sampleColumns: [
      "contractId", "offeringId", "branchId", "invoiceId", "invoiceItemId",
      "contractStatus", "saleStatus", "durationDays",
    ],
    sql: `
      SELECT
        c.id AS contractId,
        c.offeringId AS offeringId,
        c.branchId AS branchId,
        c.invoiceId AS invoiceId,
        c.invoiceItemId AS invoiceItemId,
        c.studentCustomerId AS studentCustomerId,
        c.status AS contractStatus,
        d.fulfillmentStatus AS saleStatus,
        c.durationDays AS durationDays
      FROM digitalSubscriptionContracts c
      LEFT JOIN digitalSaleDetails d ON d.invoiceItemId = c.invoiceItemId
      LEFT JOIN invoices inv ON inv.id = c.invoiceId
      LEFT JOIN digitalOfferings o ON o.id = c.offeringId
      WHERE d.id IS NULL OR inv.id IS NULL OR o.id IS NULL
         OR d.invoiceId <> c.invoiceId
         OR d.offeringId <> c.offeringId
         OR NOT (d.studentCustomerId <=> c.studentCustomerId)
         OR inv.branchId <> c.branchId
         OR o.offeringType <> 'EDUCATIONAL_SUBSCRIPTION'
         OR c.durationDays <= 0
         OR c.expiresAt <= c.startsAt
         OR TIMESTAMPDIFF(SECOND, c.startsAt, c.expiresAt) <> c.durationDays * 86400
         OR (c.status = 'ACTIVE' AND d.fulfillmentStatus IN ('REVERSED', 'LOSS_REFUND'))
         OR (c.status = 'CANCELLED' AND d.fulfillmentStatus = 'ISSUED')
    `,
  },
  {
    id: "subscription_chain",
    label: "سلسلة تجديد عقود الاشتراك",
    sampleColumns: [
      "contractId", "previousContractId", "offeringId", "previousOfferingId",
    ],
    sql: `
      SELECT
        c.id AS contractId,
        c.previousContractId AS previousContractId,
        c.studentCustomerId AS studentCustomerId,
        c.offeringId AS offeringId,
        p.studentCustomerId AS previousStudentCustomerId,
        p.offeringId AS previousOfferingId
      FROM digitalSubscriptionContracts c
      LEFT JOIN digitalSubscriptionContracts p ON p.id = c.previousContractId
      WHERE c.previousContractId IS NOT NULL
        AND (p.id IS NULL
          OR p.studentCustomerId <> c.studentCustomerId
          OR p.offeringId <> c.offeringId
          OR p.id = c.id)
    `,
  },
  {
    id: "subscription_duplicate_parent",
    label: "تجديدات متعددة للعقد السابق نفسه",
    sampleColumns: ["previousContractId", "firstContractId", "duplicateCount"],
    sql: `
      SELECT
        previousContractId AS previousContractId,
        MIN(id) AS firstContractId,
        COUNT(*) AS duplicateCount
      FROM digitalSubscriptionContracts
      WHERE previousContractId IS NOT NULL
      GROUP BY previousContractId
      HAVING COUNT(*) > 1
    `,
  },
  {
    id: "subscription_duplicate_root",
    label: "جذور اشتراك متعددة للطالب والعرض",
    sampleColumns: ["offeringId", "firstContractId", "duplicateCount"],
    sql: `
      SELECT
        studentCustomerId AS studentCustomerId,
        offeringId AS offeringId,
        MIN(id) AS firstContractId,
        COUNT(*) AS duplicateCount
      FROM digitalSubscriptionContracts
      WHERE previousContractId IS NULL
      GROUP BY studentCustomerId, offeringId
      HAVING COUNT(*) > 1
    `,
  },
  {
    id: "wallet_reconciliation",
    label: "معادلة المطابقة وحالتها ونطاق الفرع",
    sampleColumns: [
      "reconciliationId", "walletId", "reconciliationBranchId", "walletBranchId",
      "expectedBalance", "actualBalance", "variance", "reconciliationStatus",
    ],
    sql: `
      SELECT
        r.id AS reconciliationId,
        r.walletId AS walletId,
        r.branchId AS reconciliationBranchId,
        w.branchId AS walletBranchId,
        r.expectedBalance AS expectedBalance,
        r.actualBalance AS actualBalance,
        r.variance AS variance,
        r.status AS reconciliationStatus
      FROM digitalWalletReconciliations r
      LEFT JOIN digitalWallets w ON w.id = r.walletId
      WHERE w.id IS NULL OR r.branchId <> w.branchId
         OR r.expectedBalance < 0 OR r.actualBalance < 0
         OR r.variance <> r.actualBalance - r.expectedBalance
         OR (r.status = 'MATCHED' AND
             (r.variance <> 0 OR r.reviewedBy IS NOT NULL OR r.reviewedAt IS NOT NULL))
         OR (r.status = 'VARIANCE_OPEN' AND
             (r.variance = 0 OR r.reviewedBy IS NOT NULL OR r.reviewedAt IS NOT NULL))
         OR (r.status = 'RESOLVED' AND
             (r.variance = 0 OR r.reviewedBy IS NULL OR r.reviewedAt IS NULL
              OR r.reviewedBy = r.countedBy))
    `,
  },
];

function normalizeHost(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  if (host === "localhost" || host === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((n) => n >= 0 && n <= 255) && octets[0] === 127;
}

function parseAndGuardTarget(rawUrl, allowRemote) {
  if (!rawUrl) {
    throw new Error(`المتغيّر ${URL_ENV} مطلوب صراحةً؛ لن يُستخدم DATABASE_URL.`);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${URL_ENV} ليس رابط MySQL صالحاً.`);
  }

  if (parsed.protocol !== "mysql:") {
    throw new Error(`${URL_ENV} يجب أن يبدأ بـ mysql://.`);
  }
  if (!parsed.hostname) throw new Error("رابط التحقق لا يحتوي اسم مضيف.");
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) {
    throw new Error("يجب تحديد قاعدة واحدة صراحةً في مسار رابط التحقق.");
  }

  const port = parsed.port ? Number(parsed.port) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("منفذ قاعدة التحقق غير صالح.");
  }

  const loopback = isLoopbackHost(parsed.hostname);
  if (!allowRemote && port === 3306) {
    throw new Error(`رُفض المنفذ 3306 افتراضياً؛ اضبط ${REMOTE_ENV}=1 بعد مراجعة الهدف.`);
  }
  if (!allowRemote && !loopback) {
    throw new Error(`رُفض مضيف غير loopback افتراضياً؛ اضبط ${REMOTE_ENV}=1 بعد مراجعة الهدف.`);
  }

  // Return only non-secret metadata. The original URL remains private to main().
  return { database, port, loopback };
}

function normalizeSql(sql) {
  return sql.trim().replace(/\s+$/g, "");
}

function assertSelectOnly(sql, context) {
  const normalized = normalizeSql(sql);
  if (!/^SELECT\b/i.test(normalized)) {
    throw new Error(`${context}: الاستعلام لا يبدأ بـ SELECT.`);
  }
  if (normalized.includes(";")) {
    throw new Error(`${context}: الفاصلة المنقوطة ممنوعة.`);
  }
  if (normalized.includes("--") || normalized.includes("/*") || normalized.includes("#")) {
    throw new Error(`${context}: تعليقات SQL ممنوعة في كتالوج التدقيق.`);
  }
  if (FORBIDDEN_SQL.test(normalized)) {
    throw new Error(`${context}: اكتُشفت كلمة SQL غير مسموحة.`);
  }
  return normalized;
}

function assertAuditCatalog(audits) {
  assert.ok(Array.isArray(audits) && audits.length > 0, "audit catalogue is empty");
  const ids = new Set();
  for (const audit of audits) {
    assert.match(audit.id, /^[a-z][a-z0-9_]+$/, `invalid audit id: ${audit.id}`);
    assert.ok(!ids.has(audit.id), `duplicate audit id: ${audit.id}`);
    ids.add(audit.id);
    assert.ok(audit.label.trim(), `${audit.id}: empty label`);
    assertSelectOnly(audit.sql, audit.id);
    assert.ok(Array.isArray(audit.sampleColumns) && audit.sampleColumns.length > 0,
      `${audit.id}: no safe sample columns`);
    assert.equal(new Set(audit.sampleColumns).size, audit.sampleColumns.length,
      `${audit.id}: duplicate sample columns`);
    for (const column of audit.sampleColumns) {
      assert.match(column, /^[A-Za-z][A-Za-z0-9]*$/, `${audit.id}: invalid sample column`);
      assert.ok(!SENSITIVE_SAMPLE_COLUMN.test(column),
        `${audit.id}: sensitive sample column is forbidden: ${column}`);
    }
  }
}

function countSql(audit) {
  const sql = assertSelectOnly(audit.sql, audit.id);
  return `SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ COUNT(*) AS violationCount FROM (${sql}) AS violations`;
}

function sampleSql(audit, limit = SAMPLE_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("sample limit must be an integer between 1 and 20");
  }
  const sql = assertSelectOnly(audit.sql, audit.id);
  return `SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ * FROM (${sql}) AS violations LIMIT ${limit}`;
}

function safeSample(row, columns) {
  const output = {};
  for (const column of columns) {
    const value = row[column];
    if (value instanceof Date) output[column] = value.toISOString();
    else if (typeof value === "bigint") output[column] = value.toString();
    else if (typeof value === "string") output[column] = value.slice(0, 80);
    else if (value === null || ["number", "boolean"].includes(typeof value)) output[column] = value;
    else output[column] = String(value).slice(0, 80);
  }
  return output;
}

function runSelfTest() {
  assertAuditCatalog(AUDITS);
  assert.ok(AUDITS.length >= 15, "critical audit coverage unexpectedly shrank");

  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.99.4.7"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("192.168.1.5"), false);
  assert.equal(isLoopbackHost("db.example.com"), false);

  assert.throws(() => parseAndGuardTarget("", false), new RegExp(URL_ENV));
  assert.throws(() => parseAndGuardTarget("postgres://u:p@localhost:5432/db", false), /mysql:\/\//);
  assert.throws(() => parseAndGuardTarget("mysql://u:p@localhost:3306/db", false), /3306/);
  assert.throws(() => parseAndGuardTarget("mysql://u:p@db.example.com:3307/db", false), /loopback/);
  assert.throws(() => parseAndGuardTarget("mysql://u:p@localhost:3307/", false), /قاعدة واحدة/);
  assert.deepEqual(
    parseAndGuardTarget("mysql://u:p@127.0.0.1:3307/verify_db", false),
    { database: "verify_db", port: 3307, loopback: true },
  );
  assert.deepEqual(
    parseAndGuardTarget("mysql://u:p@db.example.com:3306/prod_clone", true),
    { database: "prod_clone", port: 3306, loopback: false },
  );

  assert.equal(assertSelectOnly("SELECT 1", "safe"), "SELECT 1");
  for (const unsafe of [
    "UPDATE t SET x = 1",
    "DELETE FROM t",
    "SELECT 1; DROP TABLE t",
    "SELECT * FROM t FOR UPDATE",
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "SELECT 1 -- hidden",
  ]) {
    assert.throws(() => assertSelectOnly(unsafe, "unsafe"));
  }
  assert.match(countSql(AUDITS[0]), /^SELECT \/\*\+ MAX_EXECUTION_TIME/);
  assert.match(sampleSql(AUDITS[0], 3), /LIMIT 3$/);
  assert.throws(() => sampleSql(AUDITS[0], 0));

  const projected = safeSample(
    { id: 4, status: "OPEN", studentPhone: "07700000000", extra: "hidden" },
    ["id", "status"],
  );
  assert.deepEqual(projected, { id: 4, status: "OPEN" });

  console.log(`✓ selftest: حارس الاتصال وكتالوج ${AUDITS.length} تدقيقاً للقراءة فقط سليم.`);
}

async function runVerifier() {
  assertAuditCatalog(AUDITS);

  const rawUrl = process.env[URL_ENV];
  const allowRemote = process.env[REMOTE_ENV] === "1";
  const target = parseAndGuardTarget(rawUrl, allowRemote);
  console.log(
    `→ هدف التحقق مقبول: ${target.loopback ? "loopback" : "remote مصرح"}` +
      `، المنفذ ${target.port}، قاعدة محددة صراحةً.`,
  );
  console.log(`→ بدء ${AUDITS.length} تدقيقاً داخل معاملة READ ONLY؛ حد العينة ${SAMPLE_LIMIT}.`);

  const { createConnection } = await import("mysql2/promise");
  const connection = await createConnection({
    uri: rawUrl,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    connectTimeout: 10_000,
  });

  let transactionStarted = false;
  let violationAudits = 0;
  let violationRows = 0n;
  try {
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    transactionStarted = true;

    for (const audit of AUDITS) {
      const [countRows] = await connection.query({
        sql: countSql(audit),
        timeout: QUERY_TIMEOUT_MS,
      });
      const countText = String(countRows[0]?.violationCount ?? "0");
      const count = BigInt(countText);
      if (count === 0n) {
        console.log(`✓ ${audit.id}: 0 — ${audit.label}`);
        continue;
      }

      violationAudits += 1;
      violationRows += count;
      console.error(`✗ ${audit.id}: ${countText} — ${audit.label}`);
      const [sampleRows] = await connection.query({
        sql: sampleSql(audit),
        timeout: QUERY_TIMEOUT_MS,
      });
      for (const row of sampleRows) {
        console.error(`  sample ${JSON.stringify(safeSample(row, audit.sampleColumns))}`);
      }
    }

    await connection.query("ROLLBACK");
    transactionStarted = false;
  } finally {
    if (transactionStarted) await connection.query("ROLLBACK").catch(() => {});
    await connection.end().catch(() => {});
  }

  if (violationAudits > 0) {
    console.error(
      `⛔ فشل تحقق البطاقات الرقمية: ${violationAudits} تدقيقات مخالفة، ` +
        `${violationRows.toString()} صف/مجموعة مخالفة. لم تُعدّل القاعدة.`,
    );
    process.exitCode = 2;
    return;
  }

  console.log("✓ سلامة البطاقات الرقمية: كل التدقيقات صفرية، ولم تُعدّل القاعدة.");
}

async function main() {
  if (process.argv.includes("--selftest")) {
    runSelfTest();
    return;
  }
  await runVerifier();
}

main().catch((error) => {
  // Avoid stacks and connection URLs: driver errors can contain SQL text, and
  // this verifier should never echo credentials or full target details.
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  const message = typeof error?.sqlMessage === "string"
    ? error.sqlMessage
    : error instanceof Error ? error.message : String(error);
  console.error(`⛔ تعذّر تحقق البطاقات الرقمية${code}: ${message}`);
  process.exitCode = 1;
});

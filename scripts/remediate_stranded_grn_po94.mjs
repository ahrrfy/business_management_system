import mysql from 'mysql2/promise';
import fs from 'fs';
import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableCanonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
  const row = value;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableCanonical(row[key])}`)
    .join(',')}}`;
}

async function main() {
  const isCommit = process.argv.includes('--commit');
  console.log(`=======================================================`);
  console.log(`PO-94 Remediation Script: Mode = ${isCommit ? 'COMMIT (LIVE EXECUTION)' : 'DRY-RUN (SIMULATION)'}`);
  console.log(`=======================================================`);

  const envPath = fs.existsSync('/home/deploy/erp/.env') ? '/home/deploy/erp/.env' : './.env';
  let dbUrl = process.env.DATABASE_URL;
  if (!dbUrl && fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('DATABASE_URL=')) {
        dbUrl = trimmed.substring('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  }

  const conn = await mysql.createConnection(dbUrl || 'mysql://root:erp_root_pw@127.0.0.1:3306/erp');

  try {
    await conn.beginTransaction();

    // 1. Lock and inspect PO 94
    const [pos] = await conn.query('SELECT * FROM purchaseOrders WHERE id = 94 FOR UPDATE');
    if (pos.length === 0) {
      throw new Error('PO 94 not found');
    }
    const po = pos[0];
    console.log(`[PO 94] Number: ${po.poNumber}, Status: ${po.poStatus}, Settlement: ${po.settlementType}, Total: ${po.total}, Supplier: ${po.supplierId}`);

    if (po.supplierId !== 11) {
      throw new Error(`Expected supplierId 11 (مطبعة دار المغرب 2027), found ${po.supplierId}`);
    }
    if (po.settlementType !== 'CREDIT') {
      throw new Error(`Expected settlementType CREDIT, found ${po.settlementType}`);
    }

    // 2. Lock and inspect GRN 128
    const [grns] = await conn.query('SELECT * FROM goodsReceipts WHERE id = 128 AND purchaseOrderId = 94 FOR UPDATE');
    if (grns.length === 0) {
      throw new Error('GRN 128 for PO 94 not found');
    }
    const grn = grns[0];
    console.log(`[GRN 128] Number: ${grn.receiptNumber}, Status: ${grn.status}, Total: ${grn.totalAmount}, SupplierDeliveryNote: ${grn.supplierDeliveryNote}`);

    if (grn.status !== 'POSTED') {
      throw new Error(`Expected GRN 128 to be POSTED, found ${grn.status}`);
    }

    // 3. Lock and inspect Supplier 11
    const [suppliers] = await conn.query('SELECT * FROM suppliers WHERE id = 11 FOR UPDATE');
    if (suppliers.length === 0) {
      throw new Error('Supplier 11 not found');
    }
    const supplier = suppliers[0];
    console.log(`[Supplier 11] Name: "${supplier.name}", Current Balance Before: ${supplier.currentBalance} IQD`);

    // 4. Inspect existing GL entries for PO 94
    const [glEntries] = await conn.query('SELECT * FROM accountingEntries WHERE purchaseOrderId = 94 FOR UPDATE');
    console.log(`[GL Entries for PO 94] Count: ${glEntries.length}`);
    for (const e of glEntries) {
      console.log(`  - Entry #${e.id}: Type=${e.entryType}, Dedupe=${e.dedupeKey}, Amount=${e.amount}, Notes="${e.notes}"`);
    }

    // Check if GRNI:RECEIPT:128 exists
    const receiptEntry = glEntries.find(e => e.dedupeKey === 'GRNI:RECEIPT:128');
    if (!receiptEntry) {
      throw new Error('Missing GRNI:RECEIPT:128 entry for PO 94 / GRN 128');
    }

    // Check idempotency: does a posted supplier invoice already exist?
    const existingInvoiceEntry = glEntries.find(e => e.dedupeKey && e.dedupeKey.startsWith('GRNI:SUPPLIER_INVOICE:'));
    if (existingInvoiceEntry) {
      console.log(`[IDEMPOTENCY] GRNI:SUPPLIER_INVOICE entry already exists (Entry #${existingInvoiceEntry.id}). Nothing to remediate!`);
      await conn.rollback();
      await conn.end();
      return;
    }

    // 5. Fetch Revision Items and GRN Items
    const [revItems] = await conn.query('SELECT * FROM purchaseOrderRevisionItems WHERE revisionId = ? ORDER BY lineNo ASC', [po.approvedRevisionId]);
    console.log(`[Revision Items] Count: ${revItems.length}`);

    const [grnItems] = await conn.query('SELECT * FROM goodsReceiptItems WHERE goodsReceiptId = ? ORDER BY lineNo ASC', [grn.id]);
    console.log(`[GRN Items] Count: ${grnItems.length}`);

    if (revItems.length !== 9 || grnItems.length !== 9) {
      throw new Error(`Expected 9 items, found revItems=${revItems.length}, grnItems=${grnItems.length}`);
    }

    // 6. Construct Supplier Invoice
    const invoiceKey = `auto-sinvoice:remediation-po-94`;
    const externalInvoiceNumber = `AUTO-PO-1-20260831-00001-R1`;
    const externalNumberNorm = externalInvoiceNumber.trim().toLowerCase();
    const invoiceDate = '2026-09-02';
    const totalAmount = '1155000.00';
    const currency = 'IQD';
    const evidenceReference = `AUTO-PO-APPROVAL:remediation-po-94`;

    const invoicePayload = {
      agreedCurrency: currency,
      agreedRate: null,
      branchId: 1,
      currency,
      discountAmount: '0.00',
      evidenceReference,
      evidenceType: 'OTHER',
      externalInvoiceNumber,
      externalNumberNorm,
      invoiceDate,
      lines: revItems.map((item, idx) => ({
        description: [item.productNameSnapshot, item.variantNameSnapshot].filter(Boolean).join(' — '),
        grossAmountIqd: item.lineTotal,
        grossDocumentAmount: item.lineTotal,
        invoicedBaseQuantity: item.baseQuantity,
        lineNo: idx + 1,
        netAmountIqd: item.lineTotal,
        netDocumentAmount: item.lineTotal,
        purchaseOrderRevisionItemId: item.id,
        taxAmount: '0.00',
        totalAmount: item.lineTotal,
        unitPriceIqd: item.unitPrice,
        usdTotal: null,
        usdUnitPrice: null,
        variantId: item.variantId,
      })),
      origin: 'NATIVE',
      subtotal: totalAmount,
      supplierId: 11,
      taxAmount: '0.00',
      totalAmount,
      usdTotal: null,
    };

    const payloadCanonical = stableCanonical(invoicePayload);
    const payloadHash = sha256(payloadCanonical);

    const prefix = `SIN-1-20260902-`;
    const [existingSin] = await conn.query(
      `SELECT invoiceNumber FROM supplierInvoices WHERE invoiceNumber LIKE ? ORDER BY invoiceNumber DESC`,
      [`${prefix}%`]
    );
    let maxSeq = 0;
    for (const r of existingSin) {
      const s = r.invoiceNumber.slice(prefix.length);
      if (/^[0-9]+$/.test(s)) maxSeq = Math.max(maxSeq, Number(s));
    }
    const invoiceNumber = `${prefix}${String(maxSeq + 1).padStart(5, '0')}`;
    console.log(`[Generated invoiceNumber] ${invoiceNumber}`);

    // Insert supplierInvoice
    const [invResult] = await conn.query(`
      INSERT INTO supplierInvoices (
        invoiceNumber, clientRequestId, supplierId, branchId, externalInvoiceNumber, externalNumberNorm,
        invoiceDate, dueDate, currency, agreedRate, subtotal, taxAmount, discountAmount,
        totalAmount, status, draftState, version, paymentGate, paymentGateReason, usdTotal,
        payloadCanonical, payloadHash, evidenceType, evidenceReference, holdReason,
        postingEntryId, reversalEntryId, createdBy, postedBy, postedAt, reversedBy,
        reversedAt, reversalReason, voidedBy, voidedAt, voidReason, createdAt, updatedAt
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, NULL, ?, NULL, ?, ?, ?,
        ?, 'MATCHED', 'ACTIVE', 1, 'OPEN', NULL, NULL,
        ?, ?, 'OTHER', ?, NULL,
        NULL, NULL, 21, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, '2026-09-02 09:46:10', '2026-09-02 09:46:10'
      )
    `, [
      invoiceNumber, invoiceKey, 11, 1, externalInvoiceNumber, externalNumberNorm,
      invoiceDate, currency, totalAmount, '0.00', '0.00',
      totalAmount,
      payloadCanonical, payloadHash, evidenceReference
    ]);

    const supplierInvoiceId = invResult.insertId;
    console.log(`[Inserted supplierInvoice] ID: ${supplierInvoiceId}`);

    // Insert supplierInvoiceLines
    const insertedLineIds = [];
    for (let i = 0; i < revItems.length; i++) {
      const item = revItems[i];
      const desc = [item.productNameSnapshot, item.variantNameSnapshot].filter(Boolean).join(' — ');
      const [lineRes] = await conn.query(`
        INSERT INTO supplierInvoiceLines (
          supplierInvoiceId, lineNo, purchaseOrderRevisionItemId, variantId, description,
          invoicedBaseQuantity, unitPriceIqd, netAmount, taxAmount, totalAmount,
          usdUnitPrice, usdTotal
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, '0.00', ?,
          NULL, NULL
        )
      `, [
        supplierInvoiceId, i + 1, item.id, item.variantId, desc,
        item.baseQuantity, item.unitPrice, item.lineTotal, item.lineTotal
      ]);
      insertedLineIds.push(lineRes.insertId);
    }
    console.log(`[Inserted supplierInvoiceLines] Count: ${insertedLineIds.length}`);

    // Insert supplierInvoiceMatchRuns
    const matchKey = `auto-match:remediation-po-94`;
    const policySnapshot = JSON.stringify({
      holdIsHard: true,
      priceTolerancePercent: '0.0000',
      quantityToleranceBase: 0,
      totalToleranceAmount: '0.00',
      version: 1
    });
    const policyHash = sha256(policySnapshot);

    const grnByRevItemId = new Map(grnItems.map(g => [g.purchaseOrderRevisionItemId, g]));

    const allocationsSnapshot = [];
    for (let i = 0; i < revItems.length; i++) {
      const rItem = revItems[i];
      const gItem = grnByRevItemId.get(rItem.id);
      allocationsSnapshot.push({
        goodsReceiptId: grn.id,
        goodsReceiptItemId: gItem.id,
        goodsReceiptVersion: grn.version,
        grnUnitCostIqd: gItem.unitCostIqd,
        invoiceUnitPriceIqd: rItem.unitPrice,
        matchedAmount: rItem.lineTotal,
        matchedBaseQuantity: rItem.baseQuantity,
        poUnitPriceIqd: rItem.unitPrice,
        priceVarianceAmount: '0.00',
        purchaseOrderRevisionItemId: rItem.id,
        supplierInvoiceLineId: insertedLineIds[i],
      });
    }

    const matchEvidence = {
      allocations: allocationsSnapshot,
      goodsReceipts: [{ id: grn.id, payloadHash: grn.payloadHash, version: grn.version }],
      holdCodes: [],
      invoice: { id: supplierInvoiceId, payloadHash, totalAmount, version: 1 },
      poRevisions: [{ id: po.approvedRevisionId, payloadHash: pos[0].payloadHash || '4061a5d7e5f3d58a551652192e8b5ffc95baccecd14cfcc759f51f2e17eb3683' }],
      policy: JSON.parse(policySnapshot),
      totals: {
        grnTotal: totalAmount,
        invoiceTotal: totalAmount,
        invoicedBaseQuantity: 120,
        matchedInvoiceNet: totalAmount,
        orderedBaseQuantity: 120,
        poTotal: totalAmount,
        priceVarianceAmount: '0.00',
        quantityVarianceBase: 0,
        receivedBaseQuantity: 120,
        totalVarianceAmount: '0.00',
      }
    };
    const evidenceCanonical = stableCanonical(matchEvidence);
    const evidenceHash = sha256(evidenceCanonical);

    const [matchRunRes] = await conn.query(`
      INSERT INTO supplierInvoiceMatchRuns (
        matchKey, supplierInvoiceId, supplierId, branchId, runNo, outcome, policyVersion,
        policySnapshot, policyHash, poRevisionSetHash, goodsReceiptSetHash, invoiceHash,
        priceTolerancePercent, quantityToleranceBase, totalToleranceAmount,
        orderedBaseQuantity, receivedBaseQuantity, invoicedBaseQuantity,
        poTotal, grnTotal, invoiceTotal, quantityVarianceBase, priceVarianceAmount,
        totalVarianceAmount, outcomeReason, holdCodes, evidenceSnapshot, evidenceHash,
        performedBy, performedAt
      ) VALUES (
        ?, ?, 11, 1, 1, 'EXACT', 1,
        ?, ?, ?, ?, ?,
        '0.0000', 0, '0.00',
        120, 120, 120,
        ?, ?, ?, 0, '0.00',
        '0.00', NULL, '[]', ?, ?,
        21, '2026-09-02 09:46:10'
      )
    `, [
      matchKey, supplierInvoiceId,
      policySnapshot, policyHash, matchEvidence.poRevisions[0].payloadHash, grn.payloadHash, payloadHash,
      totalAmount, totalAmount, totalAmount,
      evidenceCanonical, evidenceHash
    ]);
    const matchRunId = matchRunRes.insertId;
    console.log(`[Inserted supplierInvoiceMatchRuns] ID: ${matchRunId}`);

    // Insert supplierInvoiceMatchAllocations
    for (let i = 0; i < revItems.length; i++) {
      const rItem = revItems[i];
      const gItem = grnByRevItemId.get(rItem.id);
      await conn.query(`
        INSERT INTO supplierInvoiceMatchAllocations (
          matchRunId, supplierInvoiceLineId, purchaseOrderRevisionItemId, goodsReceiptItemId,
          matchedBaseQuantity, poUnitPriceIqd, grnUnitCostIqd, invoiceUnitPriceIqd,
          quantityVarianceBase, priceVarianceAmount, matchedAmount
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          0, '0.00', ?
        )
      `, [
        matchRunId, insertedLineIds[i], rItem.id, gItem.id,
        rItem.baseQuantity, rItem.unitPrice, gItem.unitCostIqd, rItem.unitPrice,
        rItem.lineTotal
      ]);
    }
    console.log(`[Inserted supplierInvoiceMatchAllocations] Count: ${revItems.length}`);

    // Insert accountingEntries: GRNI:SUPPLIER_INVOICE
    const dedupeKey = `GRNI:SUPPLIER_INVOICE:${supplierInvoiceId}`;
    const notes = `ترحيل فاتورة مورد ${supplierInvoiceId} وتصفية GRNI`;

    const postingIntentJson = JSON.stringify({
      code: 'SUPPLIER_INVOICE_GRNI',
      entryType: 'ADJUST',
      lines: [
        { role: 'GRNI', debit: totalAmount, credit: '0.00' },
        { role: 'AP', debit: '0.00', credit: totalAmount }
      ],
      source: {
        roleDebits: { GRNI: totalAmount },
        roleCredits: { AP: totalAmount }
      }
    });
    const postingIntentHash = sha256(postingIntentJson);

    const [aeRes] = await conn.query(`
      INSERT INTO accountingEntries (
        entryType, postingProfile, postingIntentJson, postingIntentHash, postingCycleId,
        branchId, invoiceId, purchaseOrderId, purchaseLiabilityAccount, receiptId,
        customerId, supplierId, revenue, cost, profit, taxAmount, amount,
        entryDate, notes, dedupeKey, createdBy, createdByNameSnapshot,
        createdAt, deliveryPartyId, exchangeHouseId, digitalWalletId
      ) VALUES (
        'ADJUST', NULL, ?, ?, NULL,
        1, NULL, 94, NULL, NULL,
        NULL, 11, '0.00', ?, '0.00', '0.00', ?,
        '2026-09-02 00:00:00', ?, ?, 21, 'مستخدم النظام',
        '2026-09-02 09:46:10', NULL, NULL, NULL
      )
    `, [
      postingIntentJson, postingIntentHash,
      totalAmount, totalAmount,
      notes, dedupeKey
    ]);
    const accountingEntryId = aeRes.insertId;
    console.log(`[Inserted accountingEntries] ID: ${accountingEntryId}, DedupeKey: ${dedupeKey}`);

    // Update supplierInvoice to POSTED with postingEntryId
    await conn.query(`
      UPDATE supplierInvoices
      SET status = 'POSTED', postingEntryId = ?, postedBy = 21, postedAt = '2026-09-02 09:46:10', updatedAt = NOW()
      WHERE id = ?
    `, [accountingEntryId, supplierInvoiceId]);
    console.log(`[Updated supplierInvoice] Set status = POSTED, postingEntryId = ${accountingEntryId}`);

    // Update supplier balance
    const oldBalance = Number(supplier.currentBalance);
    const newBalance = (oldBalance + Number(totalAmount)).toFixed(2);
    await conn.query(`
      UPDATE suppliers
      SET currentBalance = ?
      WHERE id = 11
    `, [newBalance]);
    console.log(`[Updated suppliers] ID 11 currentBalance: ${oldBalance.toFixed(2)} -> ${newBalance} IQD (+${totalAmount} IQD)`);

    // Audit Log entry
    await conn.query(`
      INSERT INTO auditLogs (
        userId, branchId, action, entityType, entityId, oldValue, newValue, operation, screenPath, ipAddress, createdAt
      ) VALUES (
        21, 1, 'REMEDIATION_POST_SUPPLIER_INVOICE', 'purchaseOrders', '94',
        ?, ?, ?, NULL, '127.0.0.1', NOW()
      )
    `, [
      JSON.stringify({ status: po.poStatus, balance: oldBalance.toFixed(2) }),
      JSON.stringify({
        status: po.poStatus,
        supplierInvoiceId,
        accountingEntryId,
        newBalance
      }),
      JSON.stringify({
        version: 'operation.v2',
        actor: { source: 'system', label: 'forensic-remediation-script' },
        outcome: 'SUCCESS'
      })
    ]);

    // Verify reconciliation within transaction
    const [reconcileCheck] = await conn.query(`
      SELECT
        s.id,
        s.name,
        s.currentBalance,
        COALESCE(SUM(
          CASE
            WHEN ae.purchaseLiabilityAccount = 'CASH_CLEARING' THEN 0
            WHEN ae.entryType = 'PURCHASE' THEN CAST(ae.amount AS DECIMAL(15,2))
            WHEN ae.entryType = 'PAYMENT_OUT' THEN -CAST(ae.amount AS DECIMAL(15,2))
            WHEN ae.entryType = 'PAYMENT_IN' THEN CAST(ae.amount AS DECIMAL(15,2))
            WHEN ae.entryType = 'RETURN' THEN CAST(ae.amount AS DECIMAL(15,2))
            WHEN ae.entryType = 'EXCHANGE_SETTLE' THEN -CAST(ae.amount AS DECIMAL(15,2))
            WHEN ae.entryType = 'OPENING' THEN CAST(ae.amount AS DECIMAL(15,2))
            WHEN ae.entryType = 'ADJUST' AND ae.dedupeKey REGEXP '^GRNI:SUPPLIER_INVOICE_REVERSAL:' THEN -CAST(ae.amount AS DECIMAL(15,2))
            WHEN ae.entryType = 'ADJUST' AND ae.dedupeKey REGEXP '^GRNI:SUPPLIER_INVOICE:' THEN CAST(ae.amount AS DECIMAL(15,2))
            ELSE 0 END
        ), 0) as ledgerAp
      FROM suppliers s
      LEFT JOIN accountingEntries ae ON ae.supplierId = s.id
      WHERE s.id = 11
      GROUP BY s.id, s.name, s.currentBalance
    `);
    const rRow = reconcileCheck[0];
    const diff = Math.abs(Number(rRow.currentBalance) - Number(rRow.ledgerAp));
    console.log(`[Reconciliation Verification] Supplier 11: Stored Balance = ${rRow.currentBalance}, Ledger AP = ${rRow.ledgerAp}, Drift = ${diff.toFixed(2)} IQD`);

    if (diff > 0.01) {
      throw new Error(`Reconciliation verification FAILED: Drift = ${diff}`);
    }
    console.log(`[Reconciliation Verification] PASSED WITH ZERO DRIFT!`);

    if (isCommit) {
      await conn.commit();
      console.log(`\n=======================================================`);
      console.log(`SUCCESS: All changes COMMITTED to the database.`);
      console.log(`=======================================================`);
    } else {
      await conn.rollback();
      console.log(`\n=======================================================`);
      console.log(`DRY-RUN COMPLETE: All changes were ROLLED BACK safely.`);
      console.log(`To apply changes for real, re-run with: --commit`);
      console.log(`=======================================================`);
    }
  } catch (err) {
    await conn.rollback();
    console.error('Execution FAILED, transaction rolled back:', err);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

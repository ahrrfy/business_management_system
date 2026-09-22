import "dotenv/config";
import mysql from "mysql2/promise";

async function main() {
  const isApply = process.argv.includes("--apply");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL environment variable is missing.");
  }

  console.log(`\n======================================================`);
  console.log(`--- ATOMIC FORENSIC REMEDIATION: ALL COST ANOMALIES ---`);
  console.log(
    `Mode: ${isApply ? "🚀 APPLY (LIVE COMMIT)" : "🔍 DRY-RUN (SIMULATION ONLY)"}`
  );
  console.log(`======================================================\n`);

  const conn = await mysql.createConnection(dbUrl);

  try {
    await conn.beginTransaction();

    // ------------------------------------------------------------------
    // STEP 1: Remediate Invoice 7391 Item 29899 (Root Cause of -156M Profit)
    // ------------------------------------------------------------------
    console.log("--> Step 1: Remediating Invoice Item #29899...");
    const [items] = await conn.query(
      "SELECT id, invoiceId, variantId, quantity, baseQuantity, unitPrice, unitCost, lineCost, total FROM invoiceItems WHERE id = 29899 FOR UPDATE"
    );
    if (!items.length) {
      throw new Error("Invoice item #29899 not found!");
    }
    const item29899 = items[0];
    console.log("Current item 29899:", item29899);

    const [invoices7391] = await conn.query(
      "SELECT id, invoiceNumber, subtotal, total, costTotal, invoiceStatus FROM invoices WHERE id = 7391 FOR UPDATE"
    );
    const inv7391 = invoices7391[0];

    const [entries16786] = await conn.query(
      "SELECT id, invoiceId, entryType, amount, revenue, cost, profit, dedupeKey FROM accountingEntries WHERE id = 16786 FOR UPDATE"
    );
    const entry16786 = entries16786[0];

    const [variants5275] = await conn.query(
      "SELECT id, productId, sku, costPrice FROM productVariants WHERE id = 5275 FOR UPDATE"
    );
    const var5275 = variants5275[0];

    const targetUnitCost = "230.00";
    const targetLineCost = "230000.00";
    const targetInvCostTotal = "248878.90";
    const targetProfit = "132121.10"; // 381,000 - 248,878.90

    console.log(`   Applying item #29899: unitCost: '${item29899.unitCost}' -> '${targetUnitCost}', lineCost: '${item29899.lineCost}' -> '${targetLineCost}'`);
    await conn.query(
      "UPDATE invoiceItems SET unitCost = ?, lineCost = ? WHERE id = 29899",
      [targetUnitCost, targetLineCost]
    );

    console.log(`   Applying invoice #7391: costTotal: '${inv7391.costTotal}' -> '${targetInvCostTotal}'`);
    await conn.query(
      "UPDATE invoices SET costTotal = ? WHERE id = 7391",
      [targetInvCostTotal]
    );

    if (entry16786) {
      console.log(`   Applying accountingEntry #16786: cost: '${entry16786.cost}' -> '${targetInvCostTotal}', profit: '${entry16786.profit}' -> '${targetProfit}'`);
      await conn.query(
        "UPDATE accountingEntries SET cost = ?, profit = ? WHERE id = 16786",
        [targetInvCostTotal, targetProfit]
      );
    }

    if (var5275) {
      console.log(`   Applying productVariant #5275: costPrice: '${var5275.costPrice}' -> '${targetUnitCost}'`);
      await conn.query(
        "UPDATE productVariants SET costPrice = ? WHERE id = 5275",
        [targetUnitCost]
      );
    }

    // ------------------------------------------------------------------
    // STEP 2: Remediate zero-lineCost items where unitCost > 0
    // ------------------------------------------------------------------
    console.log("\n--> Step 2: Remediating items with zero lineCost but positive unitCost...");
    const [zeroItems] = await conn.query(`
      SELECT ii.id, ii.invoiceId, ii.variantId, ii.baseQuantity, ii.unitCost, ii.lineCost,
             ROUND(ii.unitCost * ii.baseQuantity, 2) as expectedCost
      FROM invoiceItems ii
      JOIN invoices i ON ii.invoiceId = i.id
      WHERE (ii.lineCost = 0 OR ii.lineCost IS NULL)
        AND ii.unitCost > 0 AND ii.baseQuantity > 0
        AND i.invoiceDate >= '2026-09-01 00:00:00'
        AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      FOR UPDATE
    `);
    console.log(`Found ${zeroItems.length} items with zero lineCost to remediate.`);

    for (const z of zeroItems) {
      console.log(`   Fixing item #${z.id} (inv #${z.invoiceId}): lineCost: 0 -> ${z.expectedCost}`);
      await conn.query(
        "UPDATE invoiceItems SET lineCost = ? WHERE id = ?",
        [z.expectedCost, z.id]
      );
    }

    // Sync invoices costTotal for those zero items
    const affectedInvIds = [...new Set(zeroItems.map(z => z.invoiceId))];
    if (affectedInvIds.length > 0) {
      console.log(`   Recalculating costTotal for ${affectedInvIds.length} affected invoices...`);
      for (const invId of affectedInvIds) {
        const [sumRes] = await conn.query(
          "SELECT COALESCE(SUM(lineCost), 0) as newCostTotal FROM invoiceItems WHERE invoiceId = ?",
          [invId]
        );
        const newTotal = sumRes[0].newCostTotal;
        await conn.query(
          "UPDATE invoices SET costTotal = ? WHERE id = ?",
          [newTotal, invId]
        );
        await conn.query(
          "UPDATE accountingEntries SET cost = ?, profit = revenue - ? WHERE invoiceId = ? AND entryType = 'SALE'",
          [newTotal, newTotal, invId]
        );
      }
    }

    // ------------------------------------------------------------------
    // STEP 3: Audit Logging
    // ------------------------------------------------------------------
    console.log("\n--> Step 3: Writing audit log...");
    const auditOp = JSON.stringify({
      protocol: "Sub-Agents Network Deep Atomic Remediation",
      fixedInvoiceItem29899: true,
      fixedZeroCostItemsCount: zeroItems.length,
      timestamp: new Date().toISOString(),
    });

    await conn.query(
      `INSERT INTO auditLogs (userId, branchId, action, entityType, entityId, oldValue, newValue, operation, screenPath, createdAt)
       VALUES (1, 1, 'forensic.remediation.atomic_all', 'system', '0', ?, ?, ?, '/reports/profitability', NOW())`,
      [
        JSON.stringify({ item29899_old_lineCost: item29899.lineCost }),
        JSON.stringify({ item29899_new_lineCost: targetLineCost }),
        auditOp,
      ]
    );

    // ------------------------------------------------------------------
    // STEP 4: Verification Queries within Transaction
    // ------------------------------------------------------------------
    console.log("\n--> Step 4: Verification of post-remediation metrics...");
    const [sepSummary] = await conn.query(`
      SELECT 
        SUM(ii.total) as totalRevenue,
        SUM(ii.lineCost) as totalLineCost,
        SUM(ii.total) - SUM(ii.lineCost) as totalGrossProfit,
        ROUND((SUM(ii.total) - SUM(ii.lineCost)) / SUM(ii.total) * 100, 2) as marginPct
      FROM invoiceItems ii
      JOIN invoices i ON ii.invoiceId = i.id
      WHERE i.invoiceDate >= '2026-09-01 00:00:00' AND i.invoiceDate <= '2026-09-22 23:59:59'
        AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
    `);
    console.log("Verified September 2026 Summary:", sepSummary[0]);

    const [product4576Summary] = await conn.query(`
      SELECT 
        p.id as productId,
        p.name as productName,
        SUM(ii.baseQuantity) as totalQty,
        SUM(ii.total) as totalRevenue,
        SUM(ii.lineCost) as totalLineCost,
        SUM(ii.total) - SUM(ii.lineCost) as totalProfit,
        ROUND((SUM(ii.total) - SUM(ii.lineCost)) / SUM(ii.total) * 100, 2) as marginPct
      FROM invoiceItems ii
      JOIN productVariants pv ON ii.variantId = pv.id
      JOIN products p ON pv.productId = p.id
      JOIN invoices i ON ii.invoiceId = i.id
      WHERE p.id = 4576
        AND i.invoiceDate >= '2026-09-01 00:00:00' AND i.invoiceDate <= '2026-09-22 23:59:59'
        AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      GROUP BY p.id, p.name
    `);
    console.log("Verified Product 4576 Summary:", product4576Summary[0]);

    if (isApply) {
      await conn.commit();
      console.log("\n✅ [APPLY] Transaction committed successfully to database.");
    } else {
      await conn.rollback();
      console.log("\n🔍 [DRY-RUN] Verification complete. Transaction rolled back safely.");
    }
  } catch (err) {
    await conn.rollback();
    console.error("\n❌ Remediation aborted with error, rolled back:", err);
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

import "dotenv/config";
import mysql from "mysql2/promise";

async function main() {
  const isApply = process.argv.includes("--apply");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL environment variable is missing.");
  }

  console.log(`\n======================================================`);
  console.log(`--- FORENSIC REMEDIATION: INVOICE 7391 & PRODUCT 4576 ---`);
  console.log(
    `Mode: ${isApply ? "🚀 APPLY (LIVE COMMIT)" : "🔍 DRY-RUN (SIMULATION ONLY)"}`,
  );
  console.log(`======================================================\n`);

  const conn = await mysql.createConnection(dbUrl);

  try {
    await conn.beginTransaction();

    // 1. Verify and lock invoice item 29899
    const [items] = await conn.query(
      "SELECT id, invoiceId, variantId, quantity, baseQuantity, unitPrice, unitCost, total FROM invoiceItems WHERE id = 29899 FOR UPDATE",
    );
    if (!items.length) {
      throw new Error("Invoice item 29899 not found!");
    }
    const item = items[0];
    console.log("Current invoice item 29899:", item);

    if (Number(item.invoiceId) !== 7391) {
      throw new Error(
        `Invoice item 29899 belongs to invoice ${item.invoiceId}, expected 7391!`,
      );
    }

    // 2. Verify and lock invoice 7391
    const [invoices] = await conn.query(
      "SELECT id, invoiceNumber, subtotal, total, costTotal, invoiceStatus FROM invoices WHERE id = 7391 FOR UPDATE",
    );
    if (!invoices.length) {
      throw new Error("Invoice 7391 not found!");
    }
    const invoice = invoices[0];
    console.log("Current invoice 7391:", invoice);

    // 3. Verify and lock accounting entry 16786
    const [entries] = await conn.query(
      "SELECT id, invoiceId, entryType, amount, revenue, cost, profit, dedupeKey FROM accountingEntries WHERE id = 16786 FOR UPDATE",
    );
    if (!entries.length) {
      throw new Error("Accounting entry 16786 not found!");
    }
    const entry = entries[0];
    console.log("Current accounting entry 16786:", entry);

    // 4. Verify and lock product variant 5275
    const [variants] = await conn.query(
      "SELECT id, productId, sku, costPrice FROM productVariants WHERE id = 5275 FOR UPDATE",
    );
    if (!variants.length) {
      throw new Error("Product variant 5275 not found!");
    }
    const variant = variants[0];
    console.log("Current variant 5275:", variant);

    // Compute verified new totals
    const newUnitCost = "230.00";
    const newInvoiceCostTotal = "248878.90";
    const newProfit = "132121.10"; // 381,000.00 - 248,878.90

    console.log("\n--- PLANNED SURGICAL UPDATES ---");
    console.log(
      `1. invoiceItems #29899: unitCost: '${item.unitCost}' -> '${newUnitCost}'`,
    );
    console.log(
      `2. invoices #7391: costTotal: '${invoice.costTotal}' -> '${newInvoiceCostTotal}'`,
    );
    console.log(
      `3. accountingEntries #16786: cost: '${entry.cost}' -> '${newInvoiceCostTotal}', profit: '${entry.profit}' -> '${newProfit}'`,
    );
    console.log(
      `4. productVariants #5275: costPrice: '${variant.costPrice}' -> '${newUnitCost}'`,
    );

    // Perform updates
    await conn.query("UPDATE invoiceItems SET unitCost = ? WHERE id = 29899", [
      newUnitCost,
    ]);
    await conn.query("UPDATE invoices SET costTotal = ? WHERE id = 7391", [
      newInvoiceCostTotal,
    ]);
    await conn.query(
      "UPDATE accountingEntries SET cost = ?, profit = ? WHERE id = 16786",
      [newInvoiceCostTotal, newProfit],
    );
    await conn.query(
      "UPDATE productVariants SET costPrice = ? WHERE id = 5275",
      [newUnitCost],
    );

    // Insert audit log
    const auditOldValue = JSON.stringify({
      invoiceItemId: 29899,
      oldUnitCost: item.unitCost,
      oldCostTotal: invoice.costTotal,
      oldProfit: entry.profit,
      oldVariantCostPrice: variant.costPrice,
    });
    const auditNewValue = JSON.stringify({
      invoiceItemId: 29899,
      newUnitCost: newUnitCost,
      newCostTotal: newInvoiceCostTotal,
      newProfit: newProfit,
      newVariantCostPrice: newUnitCost,
    });
    const auditOp = JSON.stringify({
      reason:
        "Deep atomic forensic audit remediation: batch cost 230,000 erroneously recorded as single piece cost",
      protocol: "Sub-Agents Network Forensic Remediation",
      timestamp: new Date().toISOString(),
    });

    await conn.query(
      `
      INSERT INTO auditLogs (userId, branchId, action, entityType, entityId, oldValue, newValue, operation, screenPath, createdAt)
      VALUES (1, 1, 'forensic.remediation.cost_fix', 'invoice', '7391', ?, ?, ?, '/reports/profitability', NOW())
    `,
      [auditOldValue, auditNewValue, auditOp],
    );

    if (!isApply) {
      console.log(
        "\n🔍 [DRY-RUN] Verification successful. Rolling back transaction.",
      );
      await conn.rollback();
      console.log("✓ Rollback complete. No live data was modified.");
    } else {
      console.log("\n🚀 [APPLY] Committing transaction to database...");
      await conn.commit();
      console.log(
        "✓ TRANSACTION COMMITTED SUCCESSFULLY! Data is permanently remediated.",
      );
    }
  } catch (err) {
    console.error("\n❌ ERROR during remediation, rolling back:", err);
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

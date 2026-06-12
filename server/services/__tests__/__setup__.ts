/**
 * يُشغَّل قبل كل ملف اختبار (setupFiles في vitest.config.ts).
 * يُنظّف كل الجداول لمنع تلوّث الحالة بين ملفات الاختبار.
 * ضروري لأن بعض الملفات لا تُنظّف جداولها بعد الانتهاء.
 */
import { sql } from "drizzle-orm";
import { beforeAll } from "vitest";
import { getDb } from "../../db";

const TABLES = [
  "auditLogs",
  "sessions",
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
  "saleReturnItems",
  "saleReturns",
  "purchaseReturnItems",
  "purchaseReturns",
  "quotationItems",
  "quotations",
  "workOrderItems",
  "workOrders",
  "transferItems",
  "transfers",
  "expenses",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "productCategories",
  "customers",
  "customerGroups",
  "suppliers",
  "branches",
  "users",
];

beforeAll(async () => {
  const db = getDb();
  if (!db) return;
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    await db.execute(sql.raw(`TRUNCATE TABLE \`${t}\``)).catch(() => {});
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
});

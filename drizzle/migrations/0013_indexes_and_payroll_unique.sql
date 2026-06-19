-- G11+G12 (١٩/٦/٢٦): فهارس حرجة لتقارير الإنتاج + إصلاح UNIQUE على payrollRuns.
-- مصدر التشخيص: تدقيق المرحلة ٤ (اعتمادية وضغط).
--
-- ملاحظة بنيوية: drizzle migrator يفصل الـchunks بفاصل التَّقسيم القياسي ويستخدم
-- mysql2 بـmultipleStatements:false ⇒ كل chunk = جملة SQL واحدة. لذا كل خطوة idempotency
-- مقسومة إلى ٥ chunks (SET @x، SET @s، PREPARE، EXECUTE، DEALLOCATE).
-- أيضاً: أسماء أعمدة SQL ≠ أسماء JS — `status` في schema.ts = `receiptStatus`/`invoiceStatus`/`poStatus` في DB.

-- ١. idx_receipt_shift — Z-report
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_shift');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_receipt_shift` ON `receipts` (`shiftId`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٢. idx_receipt_bucket_status — العمود receiptStatus (لا status)
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_bucket_status');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_receipt_bucket_status` ON `receipts` (`bucketId`, `receiptStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٣. idx_entry_branch — GL/P&L/ميزانية
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND INDEX_NAME = 'idx_entry_branch');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_entry_branch` ON `accountingEntries` (`branchId`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٤. idx_invoice_status_customer — العمود invoiceStatus (لا status)
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_status_customer');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_invoice_status_customer` ON `invoices` (`invoiceStatus`, `customerId`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٥. idx_invoice_branch_date — Daily Sales
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_branch_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_invoice_branch_date` ON `invoices` (`branchId`, `invoiceDate`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٦. idx_po_supplier_status — العمود poStatus (لا status)
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchaseOrders' AND INDEX_NAME = 'idx_po_supplier_status');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_po_supplier_status` ON `purchaseOrders` (`supplierId`, `poStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٧. payrollRuns: UNIQUE(period) → UNIQUE(period, branchId)
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollRuns' AND INDEX_NAME = 'uq_payroll_period');
--> statement-breakpoint
SET @s := IF(@x > 0, 'ALTER TABLE `payrollRuns` DROP INDEX `uq_payroll_period`', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollRuns' AND INDEX_NAME = 'uq_payroll_period_branch');
--> statement-breakpoint
SET @s := IF(@x = 0, 'ALTER TABLE `payrollRuns` ADD CONSTRAINT `uq_payroll_period_branch` UNIQUE (`period`, `branchId`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

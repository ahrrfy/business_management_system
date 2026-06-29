-- 0031 (٢٩/٦/٢٦): فهارس مركّبة للاستيعاب عند ١٠٠× — تُضيف الناقص فقط (القائمة تأكَّدت من INFORMATION_SCHEMA).
-- المصدر: تدقيق عدائي للفهرسة (محور المخطط) — الجداول العالية الحجم: invoices/accountingEntries/
-- inventoryMovements/receipts/branchStock/auditLogs/invoiceItems/stocktakeCounts.
-- لماذا مركّبة: تقارير GL/P&L/أعمار الذمم/Z-report تُرشِّح وتُرتّب على (فرع + نوع/حالة + تاريخ) ⇒
-- بلا فهرس مركّب = full scan على الملايين. (الفهارس الجزئية WHERE غير مدعومة في MySQL — مستبعَدة.)
-- نمط idempotency مطابق 0013: كل فهرس = ٥ chunks مفصولة بفاصل التقسيم (mysql2 multipleStatements:false).
-- أسماء أعمدة DB لا JS (invoiceStatus/receiptStatus/entryType/movementType…). MySQL 8 InnoDB:
-- إضافة فهرس ثانوي INPLACE/LOCK=NONE — تافهة الآن (البيانات صغيرة)، مكلفة بعد ١٠٠× ⇒ تُطبَّق الآن.

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_branch_status_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_invoice_branch_status_date` ON `invoices` (`branchId`, `invoiceStatus`, `invoiceDate`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_customer_due');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_invoice_customer_due` ON `invoices` (`customerId`, `dueDate`, `invoiceStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND INDEX_NAME = 'idx_entry_branch_type_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_entry_branch_type_date` ON `accountingEntries` (`branchId`, `entryType`, `entryDate`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND INDEX_NAME = 'idx_entry_customer_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_entry_customer_date` ON `accountingEntries` (`customerId`, `entryDate`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND INDEX_NAME = 'idx_entry_supplier_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_entry_supplier_date` ON `accountingEntries` (`supplierId`, `entryDate`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventoryMovements' AND INDEX_NAME = 'idx_move_branch_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_move_branch_date` ON `inventoryMovements` (`branchId`, `createdAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventoryMovements' AND INDEX_NAME = 'idx_move_branch_variant_type');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_move_branch_variant_type` ON `inventoryMovements` (`branchId`, `variantId`, `movementType`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_shift_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_receipt_shift_date` ON `receipts` (`shiftId`, `createdAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_bucket_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_receipt_bucket_date` ON `receipts` (`cashBucket`, `createdAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_invoice_status');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_receipt_invoice_status` ON `receipts` (`invoiceId`, `receiptStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_branch_bucket_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_receipt_branch_bucket_date` ON `receipts` (`branchId`, `cashBucket`, `createdAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branchStock' AND INDEX_NAME = 'idx_stock_branch_qty');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_stock_branch_qty` ON `branchStock` (`branchId`, `quantity`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branchStock' AND INDEX_NAME = 'idx_stock_branch_counted');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_stock_branch_counted` ON `branchStock` (`branchId`, `lastCountedAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auditLogs' AND INDEX_NAME = 'idx_audit_user_action_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_audit_user_action_date` ON `auditLogs` (`userId`, `action`, `createdAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auditLogs' AND INDEX_NAME = 'idx_audit_entity');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_audit_entity` ON `auditLogs` (`entityType`, `entityId`, `createdAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoiceItems' AND INDEX_NAME = 'idx_item_variant_invoice');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_item_variant_invoice` ON `invoiceItems` (`variantId`, `invoiceId`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeCounts' AND INDEX_NAME = 'idx_stkcount_session_kind_date');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_stkcount_session_kind_date` ON `stocktakeCounts` (`sessionId`, `kind`, `countedAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

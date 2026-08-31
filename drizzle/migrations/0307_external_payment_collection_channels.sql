-- 0307 — إثبات الدفع الخارجي لكل تحصيل مبيعات، لا للبيع الأول في POS فقط.
-- receiptId يبقى أحادي الاستهلاك؛ invoiceId يصبح فهرساً غير فريد لدعم الدفعات الجزئية.

ALTER TABLE `externalPaymentAttempts`
  MODIFY COLUMN `externalPaymentChannel` ENUM('POS','PRINT_POS','SALES_COLLECTION') NOT NULL;
--> statement-breakpoint

SET @has_extpay_invoice_uq := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'externalPaymentAttempts'
    AND index_name = 'uq_extpay_invoice'
);
SET @sql := IF(
  @has_extpay_invoice_uq > 0,
  'ALTER TABLE `externalPaymentAttempts` DROP INDEX `uq_extpay_invoice`',
  'SELECT ''uq_extpay_invoice absent'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_extpay_invoice_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'externalPaymentAttempts'
    AND index_name = 'idx_extpay_invoice'
);
SET @sql := IF(
  @has_extpay_invoice_idx = 0,
  'ALTER TABLE `externalPaymentAttempts` ADD INDEX `idx_extpay_invoice` (`invoiceId`)',
  'SELECT ''idx_extpay_invoice exists'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

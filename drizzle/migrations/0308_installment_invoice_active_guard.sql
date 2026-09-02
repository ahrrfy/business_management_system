-- 0308 — خطة أقساط نشطة واحدة لكل فاتورة مرتبطة.
-- مرحلة expansion متوافقة مع العمال القديمة: ACTIVE بلا invoiceId يبقى legacy قابلاً للكتابة
-- مؤقتاً وحارسه NULL؛ الكاتب الجديد يفرض invoiceId في الخدمة. تشديد NOT NULL/رفض legacy
-- لهجرة cutover مستقلة بعد خروج جميع عمال الإصدار السابق.

SET @has_inst_active_guard := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'installmentPlans'
    AND column_name = 'activeInvoiceGuard'
);
SET @sql := IF(
  @has_inst_active_guard = 0,
  'ALTER TABLE `installmentPlans` ADD COLUMN `activeInvoiceGuard` BIGINT NULL AFTER `planStatus`',
  'SELECT ''installmentPlans.activeInvoiceGuard exists'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

UPDATE `installmentPlans`
SET `activeInvoiceGuard` = CASE
  WHEN `planStatus` = 'ACTIVE' AND `invoiceId` IS NOT NULL THEN `invoiceId`
  ELSE NULL
END;
--> statement-breakpoint

SET @has_inst_active_uq := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'installmentPlans'
    AND index_name = 'uq_instplan_active_invoice'
);
SET @sql := IF(
  @has_inst_active_uq = 0,
  'ALTER TABLE `installmentPlans` ADD UNIQUE INDEX `uq_instplan_active_invoice` (`activeInvoiceGuard`)',
  'SELECT ''uq_instplan_active_invoice exists'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_installment_plans_active_bi`;
--> statement-breakpoint

CREATE TRIGGER `trg_installment_plans_active_bi`
BEFORE INSERT ON `installmentPlans`
FOR EACH ROW
BEGIN
  SET NEW.`activeInvoiceGuard` = IF(
    NEW.`planStatus` = 'ACTIVE' AND NEW.`invoiceId` IS NOT NULL,
    NEW.`invoiceId`,
    NULL
  );
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_installment_plans_active_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_installment_plans_active_bu`
BEFORE UPDATE ON `installmentPlans`
FOR EACH ROW
BEGIN
  SET NEW.`activeInvoiceGuard` = IF(
    NEW.`planStatus` = 'ACTIVE' AND NEW.`invoiceId` IS NOT NULL,
    NEW.`invoiceId`,
    NULL
  );
END;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0131 — priceSanity L3.1: جدول أثرٍ متخصّص لتغييرات التكلفة/السعر (٣٠/٧/٢٦).
--
-- **الغاية:** جدول `auditLog` عام (يلتقط كل عمليات النظام) لا يخدم تقارير الأسعار الدائمة —
-- استعلاماته على JSON فيه ثقيلة والحبيبة موحَّدة.
-- `priceAnomalyLog` جدولٌ متخصّصٌ يُملأ من مصدرَين:
--   (١) Trigger BEFORE UPDATE على productVariants — يلتقط أيّ تغييرٍ في `costPrice` (حتى من db:push
--       أو الاستيراد المباشر أو الإدارة اليدوية)، بذكاء تصنيفيّ حسب النسبة (info/warning/blocker/catastrophic).
--   (٢) لاحقاً: قد نضيف تريجرات مماثلة على productPrices.price للتقاط تلاعب أسعار البيع.
--
-- الجدول idempotent وقابل للاستعلام السريع بفهرس (variantId, createdAt DESC) للوحة الاستعادة.
-- `severity` عمود مولَّد STORED — يُقرَأ ولا يُكتَب، يحسبه Trigger على الإدراج.
-- ═══════════════════════════════════════════════════════════════════════════════

SET @tbl_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'priceAnomalyLog');
SET @sql := IF(@tbl_exists = 0,
  'CREATE TABLE `priceAnomalyLog` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `variantId` BIGINT NOT NULL,
    `changeKind` VARCHAR(20) NOT NULL,
    `oldValue` DECIMAL(15,2) NULL,
    `newValue` DECIMAL(15,2) NULL,
    `severity` VARCHAR(20) NOT NULL,
    `reason` TEXT NULL,
    `actorUserId` INT NULL,
    `reverted` BOOLEAN NOT NULL DEFAULT FALSE,
    `revertedAt` TIMESTAMP NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT `fk_price_anomaly_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE CASCADE,
    CONSTRAINT `chk_price_anomaly_kind` CHECK (`changeKind` IN (''cost'',''retail'',''wholesale'',''government'')),
    CONSTRAINT `chk_price_anomaly_severity` CHECK (`severity` IN (''info'',''warning'',''blocker'',''catastrophic'')),
    INDEX `idx_price_anomaly_variant_time` (`variantId`, `createdAt` DESC),
    INDEX `idx_price_anomaly_severity_time` (`severity`, `createdAt` DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- (٢) Trigger BEFORE UPDATE على productVariants — يلتقط تغيّر costPrice ويصنّف حدّتَه.
--     يُنشأ idempotently: نُسقطه أوّلاً إن وُجد (DROP IF EXISTS مسموحٌ في MySQL 8).
DROP TRIGGER IF EXISTS trg_variant_cost_audit;
--> statement-breakpoint

CREATE TRIGGER trg_variant_cost_audit
BEFORE UPDATE ON productVariants
FOR EACH ROW
BEGIN
  DECLARE ratio DECIMAL(20,4);
  DECLARE sev VARCHAR(20);
  IF (NEW.costPrice IS NOT NULL AND OLD.costPrice IS NOT NULL AND NEW.costPrice <> OLD.costPrice AND OLD.costPrice > 0) THEN
    SET ratio = NEW.costPrice / OLD.costPrice;
    SET sev = CASE
      WHEN ratio >= 10.0 OR ratio <= 0.1 THEN 'catastrophic'
      WHEN ratio >= 5.0 OR ratio <= 0.2 THEN 'blocker'
      WHEN ratio >= 3.0 OR ratio <= 0.33 THEN 'warning'
      ELSE 'info'
    END;
    INSERT INTO priceAnomalyLog (variantId, changeKind, oldValue, newValue, severity, actorUserId)
    VALUES (NEW.id, 'cost', OLD.costPrice, NEW.costPrice, sev, @app_user_id);
  END IF;
END;

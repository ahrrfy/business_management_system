-- ═══════════════════════════════════════════════════════════════════════════════
-- 0130 — priceSanity L2.2: جدول استثناءات لوحة تدقيق الكتالوج (٣٠/٧/٢٦).
--
-- **الغاية:** كل عنقود شذوذٍ في `/reports/catalog-anomalies` قابلٌ لثلاثة إجراءات:
--   (١) إصلاح: deep-link إلى ProductEdit — لا سجلّ استثناء (يُصلَح الأصل).
--   (٢) قصديّ: يُعلَّم `kind='INTENTIONAL'` مع تبرير + مدّة استثناء اختيارية (مذكّرة قديمة تُصفّى).
--   (٣) تجاهل نهائيّاً: `kind='IGNORED'` بلا مدّة — whitelist دائم بتبرير.
--
-- الفهرس الفريد `(variantId, code)` يضمن ألا يُسجَّل استثناءان لنفس (متغيّر × عدسة) — التحديث يستبدل.
-- excludeUntil NULL = دائم (للـIGNORED)؛ تاريخ = مؤقّت (للـINTENTIONAL بمدّة).
-- ═══════════════════════════════════════════════════════════════════════════════

SET @tbl_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalogAnomalyOverrides');
SET @sql := IF(@tbl_exists = 0,
  'CREATE TABLE `catalogAnomalyOverrides` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `variantId` BIGINT NOT NULL,
    `code` VARCHAR(4) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `justification` TEXT NOT NULL,
    `excludeUntil` DATE NULL,
    `createdBy` INT NOT NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT `uq_anomaly_override` UNIQUE (`variantId`, `code`),
    CONSTRAINT `fk_anomaly_override_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_anomaly_override_user` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
    CONSTRAINT `chk_anomaly_override_code` CHECK (`code` IN (''L1'',''L2'',''L3'',''L4'',''L5'',''L6'')),
    CONSTRAINT `chk_anomaly_override_kind` CHECK (`kind` IN (''INTENTIONAL'',''IGNORED'')),
    INDEX `idx_anomaly_override_variant` (`variantId`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

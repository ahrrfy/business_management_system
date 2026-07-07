-- gstack M6 (٧/٧/٢٦): قيود CHECK للـبكج/اللقطة — drizzle-kit db:push لا يبني CHECK دائماً بشكل موثوق
-- على MySQL 8. هذا snippet يطبّقها idempotently عبر INFORMATION_SCHEMA (safe لتكرار التطبيق).
-- يُنفَّذ في CI عبر scripts/ci-apply-extra-migrations.mjs بعد db:push.

-- 0057: CHECK على componentBaseQuantity في bundleComponents.
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bundleComponents' AND CONSTRAINT_NAME = 'chk_bundle_component_qty');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `bundleComponents` ADD CONSTRAINT `chk_bundle_component_qty` CHECK (`componentBaseQuantity` > 0)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 0060: CHECK على componentBaseQuantity في invoiceItemBundleComponents (لقطة المرتجع).
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoiceItemBundleComponents' AND CONSTRAINT_NAME = 'chk_iibc_qty');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `invoiceItemBundleComponents` ADD CONSTRAINT `chk_iibc_qty` CHECK (`componentBaseQuantity` > 0)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 0059: CHECK على priceUpdateWaves.changeValue > 0 + قيد النطاق للنسب.
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'priceUpdateWaves' AND CONSTRAINT_NAME = 'chk_wave_value_positive');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `priceUpdateWaves` ADD CONSTRAINT `chk_wave_value_positive` CHECK (`changeValue` > 0)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 0059: CHECK على priceChangeLog.newPrice > 0.
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'priceChangeLog' AND CONSTRAINT_NAME = 'chk_price_log_new_positive');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `priceChangeLog` ADD CONSTRAINT `chk_price_log_new_positive` CHECK (`newPrice` > 0)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- لقطة مرجع السعر الفعّال ونيّة التجاوز في بند عرض السعر.
-- يبقى العمودان NULL للأسطر التاريخية عمداً: لا يمكن استنتاج العقد القديم من unitPrice/
-- catalogUnitPrice بلا التباس، لذلك يعاملها العميل legacy fail-safe ويحافظ على السعر الظاهر.

SET @needs_quote_reference_unit_price := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'quotationItems' AND column_name = 'referenceUnitPrice'
);
SET @sql := IF(@needs_quote_reference_unit_price,
  "ALTER TABLE `quotationItems` ADD COLUMN `referenceUnitPrice` DECIMAL(15,2) NULL AFTER `catalogUnitPrice`",
  "SELECT 'quotationItems.referenceUnitPrice exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @needs_quote_price_source := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'quotationItems' AND column_name = 'priceSource'
);
SET @sql := IF(@needs_quote_price_source,
  "ALTER TABLE `quotationItems` ADD COLUMN `priceSource` ENUM('TIER','CONTRACT','MANUAL') NULL AFTER `referenceUnitPrice`",
  "SELECT 'quotationItems.priceSource exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

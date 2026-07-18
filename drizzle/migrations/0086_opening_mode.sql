-- 0086: «الافتتاح التدريجي» — أساس وضع الافتتاح (١٨/٧).
-- (أ) جدول openingModeSettings (صفّ singleton، نمط taxSettings): تفعيل مؤقّت للبيع النقدي بالسالب
--     للأصناف غير المُفتتَحة، بشرط endsAt إلزامي (≤ ٦٠ يوماً) وسقف كمية للسطر.
-- (ب) عمود branchStock.openedAt: متى ثُبِّت الرصيد الافتتاحي لكل (صنف×فرع) — NULL = غير مُفتتَح.
-- (ج) backfill (مراجعة عدائية ١٨/٧ — «الأساس الراسخ = مُفتتَح»): صنفٌ له حركة رصيد افتتاحي
--     (referenceType='OPENING') أو جردٌ معتمد (lastCountedAt) أو استلام شراء فعلي (IN/PURCHASE_ORDER)
--     يُختَم مُفتتَحاً من اليوم الأول — وإلا انفتح البيع بالسالب على أصناف حيّة موثوقة الأساس.
-- ملاحظة MySQL 8: لا يدعم ADD COLUMN IF NOT EXISTS — الهجرة تُطبَّق مرة واحدة عبر drizzle migrator.
CREATE TABLE IF NOT EXISTS `openingModeSettings` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `enabled` BOOLEAN NOT NULL DEFAULT FALSE,
  `endsAt` TIMESTAMP NULL DEFAULT NULL,
  `maxNegativeQtyPerLine` INT NOT NULL DEFAULT 100,
  `updatedBy` INT DEFAULT NULL,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_openingmode_updater` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
ALTER TABLE `branchStock` ADD COLUMN `openedAt` TIMESTAMP NULL DEFAULT NULL AFTER `lastCountedAt`;
--> statement-breakpoint
UPDATE `branchStock` bs
JOIN (
  SELECT DISTINCT `variantId`, `branchId` FROM `inventoryMovements` WHERE `referenceType` = 'OPENING'
) m ON m.`variantId` = bs.`variantId` AND m.`branchId` = bs.`branchId`
SET bs.`openedAt` = bs.`createdAt`
WHERE bs.`openedAt` IS NULL;
--> statement-breakpoint
UPDATE `branchStock`
SET `openedAt` = `lastCountedAt`
WHERE `openedAt` IS NULL AND `lastCountedAt` IS NOT NULL;
--> statement-breakpoint
UPDATE `branchStock` bs
JOIN (
  SELECT `variantId`, `branchId`, MIN(`createdAt`) AS firstIn
  FROM `inventoryMovements`
  WHERE `movementType` = 'IN' AND `referenceType` = 'PURCHASE_ORDER'
  GROUP BY `variantId`, `branchId`
) p ON p.`variantId` = bs.`variantId` AND p.`branchId` = bs.`branchId`
SET bs.`openedAt` = p.firstIn
WHERE bs.`openedAt` IS NULL;

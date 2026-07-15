-- 0077: قمع تحويل يومي مجمّع للمتجر. لا توجد IPs أو جلسات أو IDs للعملاء/الطلبات.
-- سياسة الاحتفاظ: العدادات المجمّعة فقط حتى 13 شهراً؛ مهمة الصيانة الدورية تحذف ما قبل ذلك.
-- كل الأوامر محروسة كي تكون آمنة بعد db:push وإعادة النشر.

CREATE TABLE IF NOT EXISTS `storeConversionDailyMetrics` (
  `branchId` BIGINT NOT NULL,
  `metricDate` DATE NOT NULL,
  `productViews` INT NOT NULL DEFAULT 0,
  `cartAdds` INT NOT NULL DEFAULT 0,
  `checkoutStarts` INT NOT NULL DEFAULT 0,
  `completedOrders` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`branchId`, `metricDate`),
  KEY `idx_store_conversion_date` (`metricDate`),
  CONSTRAINT `fk_store_conversion_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeConversionDailyMetrics' AND CONSTRAINT_NAME = 'fk_store_conversion_branch');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `storeConversionDailyMetrics` ADD CONSTRAINT `fk_store_conversion_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

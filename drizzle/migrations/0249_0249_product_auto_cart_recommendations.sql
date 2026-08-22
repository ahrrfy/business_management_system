-- 0249: مفتاح تحكم توصيات «أكمل تجهيزك» الآلية حسب التصنيف.
-- true يحافظ على fallback الحالي؛ false يسمح بالعلاقات اليدوية فقط لهذا المنتج.
-- idempotent: آمن عند إعادة التشغيل أو عند وجود العمود مسبقاً.

SET @c1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'allowAutoCartRecommendations');
SET @s1 := IF(@c1 = 0,
  'ALTER TABLE `products` ADD `allowAutoCartRecommendations` tinyint(1) NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE st1 FROM @s1; EXECUTE st1; DEALLOCATE PREPARE st1;

UPDATE `products`
SET `allowAutoCartRecommendations` = 1
WHERE `allowAutoCartRecommendations` IS NULL;

ALTER TABLE `products`
  MODIFY COLUMN `allowAutoCartRecommendations` tinyint(1) NOT NULL DEFAULT 1;
--> statement-breakpoint

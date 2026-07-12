-- 0072: حقول عرض المتجر على المنتج (لوحة hPanel، ١٢/٧): isFeatured (يتصدّر «الأكثر مبيعاً»/التمييز)
-- + showInStore (إظهار/إخفاء المنتج من واجهة الزبون). افتراضيّ يُبقي السلوك (كل المنتجات ظاهرة). idempotent.

SET @c1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'isFeatured');
SET @s1 := IF(@c1 = 0, 'ALTER TABLE `products` ADD `isFeatured` tinyint(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st1 FROM @s1; EXECUTE st1; DEALLOCATE PREPARE st1;
--> statement-breakpoint
SET @c2 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'showInStore');
SET @s2 := IF(@c2 = 0, 'ALTER TABLE `products` ADD `showInStore` tinyint(1) NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE st2 FROM @s2; EXECUTE st2; DEALLOCATE PREPARE st2;

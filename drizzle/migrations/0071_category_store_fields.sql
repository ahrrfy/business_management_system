-- 0071: حقول المتجر على الفئات (لوحة hPanel، ١٢/٧): sortOrder (ترتيب العرض) + showInStore (إظهار
-- القسم في واجهة الزبون). افتراضيّ يُبقي السلوك القائم (كل الفئات ظاهرة، ترتيب 0). idempotent.

SET @c1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'sortOrder');
SET @s1 := IF(@c1 = 0, 'ALTER TABLE `categories` ADD `sortOrder` int NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st1 FROM @s1; EXECUTE st1; DEALLOCATE PREPARE st1;
--> statement-breakpoint
SET @c2 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'showInStore');
SET @s2 := IF(@c2 = 0, 'ALTER TABLE `categories` ADD `showInStore` tinyint(1) NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE st2 FROM @s2; EXECUTE st2; DEALLOCATE PREPARE st2;

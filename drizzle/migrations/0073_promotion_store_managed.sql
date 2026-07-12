-- 0073: علامة قناة العرض (١٣/٧): isStoreManaged يميّز عرض المتجر الإلكتروني (يُنشأ من لوحة hPanel)
-- عن عرض الكاشير/الإدارة. العرض المتجريّ = **أونلاين فقط** (يُستثنى من تسعير الكاشير resolvePromotionForLine
-- افتراضياً)، ويظهر في المتجر عبر applyStorefrontPromotions (includeStoreManaged=true). idempotent.

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'isStoreManaged');
SET @s := IF(@c = 0, 'ALTER TABLE `promotions` ADD `isStoreManaged` tinyint(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

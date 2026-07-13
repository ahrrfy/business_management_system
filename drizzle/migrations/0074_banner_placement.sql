-- 0074: موضع البنر (١٣/٧): placement يحدّد أين يظهر البنر في المتجر —
-- HERO (الكاروسيل الرئيسي أعلى المتجر، السلوك القائم = الافتراضي للصفوف الموجودة)،
-- SIDE (بنر طولي في جوانب الشاشات العريضة الفارغة)، INLINE (فاصل عرضي بين صفوف المنتجات).
-- idempotent (نمط 0071-0073).

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND COLUMN_NAME = 'placement');
SET @s := IF(@c = 0, "ALTER TABLE `storeBanners` ADD `placement` enum('HERO','SIDE','INLINE') NOT NULL DEFAULT 'HERO'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

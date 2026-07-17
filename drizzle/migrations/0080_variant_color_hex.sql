-- 0080: بنك الألوان — لون العرض الحقيقي «#RRGGBB» لكل متغيّر.
-- اختيار صريح من المستخدم (منتقي اللون)؛ إن null يُستنتَج تلقائياً من اسم اللون عبر @shared/colorBank.
-- عمود إضافيّ nullable بلا افتراضيّ ⇒ الصفوف الحالية تبقى null (تُعرَض بلونها المُستنتَج) بلا هجرة بيانات.
ALTER TABLE `productVariants` ADD COLUMN `colorHex` varchar(9) NULL AFTER `color`;

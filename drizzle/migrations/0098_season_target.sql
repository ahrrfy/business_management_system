-- 0098: تخطيط موسم المدارس — هدف مخزون الموسم لكل متغيّر (بالوحدة الأساس، عبر كل الفروع).
-- seasonTarget > 0 يَسِم المتغيّر كصنفٍ موسميّ (مدرسيّ) لتجهيز ذروة أيلول؛ 0 = غير موسميّ.
-- عمود إضافيّ بافتراضيّ 0 ⇒ الصفوف الحالية غير موسمية بلا هجرة بيانات (نمط reorderPoint/minStock، هجرة 0080).
ALTER TABLE `productVariants` ADD COLUMN `seasonTarget` int DEFAULT 0 AFTER `reorderPoint`;

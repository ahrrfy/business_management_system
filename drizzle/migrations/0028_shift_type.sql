-- 0028 (٢٦/٦/٢٦): نوع الوردية — shifts.shiftType (RETAIL|RECEPTION).
-- خدمة الزبائن تعمل بوردية RECEPTION مستقلّة (درج + رصيد افتتاحي + عرابين + Z-report خاصّ) عن
-- كاشير المبيعات RETAIL. النوع يدخل في openGuard ⇒ وردية مفتوحة واحدة لكل (موظّف×فرع×نوع)، فيُمكن
-- لموظّفٍ حملُ وردية تجزئة ووردية استقبال معاً.
--
-- DEFAULT 'RETAIL' ⇒ كل الورديات القائمة تجزئة (backfill ضمنيّ، INSTANT DDL في MySQL 8 ⇒ صفر downtime).
-- ثم نُحدّث صيغة حارس الفتح للورديات المفتوحة (u:b ⇒ u:b:RETAIL) لتطابق الصيغة الجديدة التي يكتبها
-- التطبيق؛ القيد UNIQUE(openGuard) يبقى كما هو (لا تغيير على العمود) فالقيم تظلّ فريدة.

ALTER TABLE `shifts` ADD `shiftType` enum('RETAIL','RECEPTION') NOT NULL DEFAULT 'RETAIL';
--> statement-breakpoint
-- ملاحظة: عمود الحالة في DB اسمه `shiftStatus` (mysqlEnum أول معامل = اسم العمود) لا `status`.
UPDATE `shifts` SET `openGuard` = CONCAT(`openGuard`, ':RETAIL') WHERE `shiftStatus` = 'OPEN' AND `openGuard` IS NOT NULL;

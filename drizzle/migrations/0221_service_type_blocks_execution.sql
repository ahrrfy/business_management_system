-- ش٢ من المرحلة ٢ (١٩/٨): موافقة التصميم مهمّةٌ **حاجزة**.
--
-- عمودٌ واحد على جدولٍ مرجعيّ من خمسة صفوف. وهو قرارُ سياسةٍ بشريّ محض لا تحمله أيّ بيانات:
-- «هل هذا النوع من المهام يحجز تنفيذ أمر الشغل؟» — والبديلان مرفوضان:
--   (أ) قيمةُ enum جديدة على `workOrders.status`: تُبطل صلاحية **كل حارسٍ يقارن الحالة** (سبعة
--       حرّاسِ مالٍ ومخزون)، وتلزمها هجرةُ enum على جدولٍ حيّ، وتوسيعُ قواميس العرض.
--   (ب) الاصطلاح الصامت «أيّ مهمّة مرتبطة تحجز»: بلا عمود، لكنّه يجعل **مهمّةَ متابعةٍ بريئة
--       توقف الإنتاج** بلا أن يفهم أحدٌ لماذا.
--
-- الافتراضيّ `false` ⇒ **صفر تغيّرٍ سلوكيّ قبل بذر النوع الحاجز**. ومفتاحُ الإيقاف الفوريّ بلا
-- نشرٍ محفوظ: `UPDATE serviceTypes SET blocksExecution = 0`.
--
-- idempotent صراحةً (درس ١٣/٨): محروسٌ بـinformation_schema فلا يفشل على إعادة التطبيق.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'serviceTypes' AND COLUMN_NAME = 'blocksExecution'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `serviceTypes` ADD COLUMN `blocksExecution` boolean NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- بذرُ النوع الحاجز الوحيد. `uq_service_type_name` يجعل الإدراج آمناً بالتكرار، ولا نلمس
-- صفّاً قائماً بنفس الاسم (قد يكون المالك ضبط مهلته يدوياً).
INSERT INTO `serviceTypes` (`name`, `defaultKind`, `defaultPriority`, `slaHours`, `isActive`, `blocksExecution`)
SELECT 'موافقة تصميم', 'SERVICE_REQUEST', 'HIGH', 24, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM `serviceTypes` WHERE `name` = 'موافقة تصميم');

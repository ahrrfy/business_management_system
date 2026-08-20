-- ش٢ من المرحلة ٢ (١٩/٨): نسخةُ ملفّ التصميم.
--
-- «أيّ مجموعةِ صورٍ وافق عليها العميل» حقيقةٌ عن **فعل تحريرٍ** لا تُستردّ من الصفوف:
-- `url`/`caption`/`sortOrder` لا تحمل الانتماء، و`createdAt` لا يفرّق دفعتين أُدرجتا في
-- المعاملة نفسها أو الثانية نفسها ⇒ أيّ اشتقاقٍ منه يخطئ **صامتاً** في المستند الذي
-- يُحتجّ به عند النزاع مع الزبون.
--
-- وبهذا العمود وحده تُشتقّ البقيّة، فلا أعمدةَ أخرى:
--   · «الحاليّ» = `revision = MAX(revision)`   · «المُبطَل» = ما دونه
--   · «عدد التعديلات» = `MAX(revision) − 1`   · «آخر تعديل» = `MAX(createdAt)` للنسخة العليا
-- ولا `supersededBy` ولا `approvedAt/By`: الموافقة كلّها في `tasks`/`taskEvents` بطرفها
-- وزمنها وسجلّها.
--
-- الصفوف القائمة تصير كلّها النسخة ١ بحكم الافتراضيّ ⇒ صفر تغيّرٍ سلوكيّ.
-- والجدول له **مُدرِجٌ وحيد** (`workOrder/create.ts`) وقارئان ⇒ التوسعة لا تكسر قارئاً.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrderImages' AND COLUMN_NAME = 'revision'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `workOrderImages` ADD COLUMN `revision` int NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- فهرسٌ مركّب: كل قراءةٍ تسأل «النسخة العليا لهذا الأمر» — والاستعلام الأثقل هو مصغّرة
-- البطاقة في قائمة أوامر الشغل (صفٌّ لكل أمر).
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrderImages' AND INDEX_NAME = 'idx_woimg_wo_revision'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `idx_woimg_wo_revision` ON `workOrderImages` (`workOrderId`, `revision`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

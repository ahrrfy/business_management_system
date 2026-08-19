-- ش٥ من المرحلة ٢ (١٩/٨): جاهزيّةُ الطلب لا جاهزيّةُ السطر.
--
-- الزبون يرى **طلباً واحداً**؛ والنظام يشحن نصفه صامتاً بينما نصفه الآخر لم يبدأ — لأنّ
-- أوامر السلّة الواحدة **لا يعرف بعضُها بعضاً**.
--
-- ولا كيانَ «طلب» جديد: المسوّدة **هي** الطلب ولها `draftNumber` وبنودٌ ومالٌ محتجَز؛ ينقصها
-- عمودُ ربطٍ واحد.
--
-- **ولماذا `draftId` لا اشتقاقٌ من `clientRequestId`:** الاشتقاق ممكنٌ في **اتجاهٍ واحدٍ فقط**
-- — أمرُ الشغل لا يحمل `clientRequestId` إطلاقاً، والربط يعيش في `idempotencyKeys` بمفتاح
-- `{crid}-wo-{index}`، وفريدُ ذلك الجدول `(operation, clientRequestId)` و**`refId` بلا فهرس**
-- ⇒ السؤال العمليّ («ما إخوةُ هذا الأمر؟») مسحٌ كاملٌ لجدولٍ ينمو بلا حدّ، وهو الاتجاه الذي
-- يطلبه القبول ⑧ بالذات. و`draftId` أصدقُ دلالةً: مفتاحٌ أجنبيّ حقيقيّ لا اصطلاحُ idempotency
-- مُعادُ استعمالُه لعلاقةٍ دائمة.
--
-- الصفوف القائمة تبقى NULL ⇒ صفر تغيّرٍ سلوكيّ. idempotent محروسٌ بـinformation_schema.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'draftId'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `draftId` bigint NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders'
    AND CONSTRAINT_NAME = 'fk_wo_draft' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `workOrders` ADD CONSTRAINT `fk_wo_draft` FOREIGN KEY (`draftId`) REFERENCES `receptionDrafts`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- الفهرس هو جوهر الفائدة: «ما إخوةُ هذا الأمر؟» استعلامٌ واحدٌ مفهرس بدل مسحٍ كامل.
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND INDEX_NAME = 'idx_wo_draft'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `idx_wo_draft` ON `workOrders` (`draftId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 0212 — إلغاء مهمة الاستوديو: حالةٌ نهائية صريحة بدل الطريق المسدود.
--
-- كان `createStudioCampaignBacklog` يستطيع توليد آلاف المهام في نداءٍ واحد (٤٢٨٥ في الإنتاج)
-- ولا يوجد في الراوتر أيّ إجراء إلغاءٍ أو حذف، ولا `transitionStudioCampaign` يمسّ المهام حين
-- تُلغى حملتها. فتوليدٌ مخطئ الهدف كان **دائماً**: تبقى مهامه في الطابور وفي المؤشّرات وفي
-- إشعارات التأخّر إلى الأبد، ويبقى `activeSlot=1` محتجزاً فلا يقبل المنتج مهمةً صحيحة بديلة
-- (القيد الفريد `uq_pijob_product_active`).
--
-- لماذا حالةٌ جديدة لا إعادة استعمال `FAILED`: القيمة `FAILED` معروضة في المرشّحات ولا يكتبها
-- أيّ مسار، وإسنادُ معنى «أُلغيت» إليها يكرّر بالضبط عطبَ تحميل القيمة الواحدة معنيين الذي
-- جعل `ASSIGNED` تصف الطابور والعمل المسنَد معاً فكذبت اللوحة.
--
-- ولماذا أعمدةُ أثرٍ مستقلّة لا `rejectionReason`: «أعِدها للتعديل» ≠ «لن تُنفَّذ». خلطُهما
-- يجعل سجلّ الرفض غير قابلٍ للقراءة ويُفسد أيّ تقريرٍ لأسباب الإعادة.
--
-- إضافةٌ محروسة فقط: لا مسّ لأيّ صفٍّ قائم، ولا تغيير لأيّ قيمةٍ محفوظة.
SET NAMES utf8mb4;
--> statement-breakpoint

-- توسيع قائمة الحالات. ALTER ... MODIFY يعيد كتابة تعريف العمود كاملاً، فتُذكر القيم
-- القديمة كلّها كما هي؛ الصفوف القائمة لا تتأثّر. محروسٌ بأن التوسيع لم يُطبَّق سلفاً.
SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'productImageJobs'
        AND COLUMN_NAME = 'status'
        AND COLUMN_TYPE LIKE '%CANCELLED%'
    ),
    'SELECT 1',
    'ALTER TABLE `productImageJobs` MODIFY COLUMN `status` ENUM(''ASSIGNED'',''IN_PROGRESS'',''PENDING_REVIEW'',''APPROVED'',''REJECTED'',''FAILED'',''REVERTED'',''CANCELLED'') NOT NULL DEFAULT ''PENDING_REVIEW'''
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImageJobs' AND COLUMN_NAME = 'cancellationReason'
    ),
    'SELECT 1',
    'ALTER TABLE `productImageJobs` ADD COLUMN `cancellationReason` VARCHAR(500) NULL'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImageJobs' AND COLUMN_NAME = 'cancelledBy'
    ),
    'SELECT 1',
    'ALTER TABLE `productImageJobs` ADD COLUMN `cancelledBy` INT NULL'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImageJobs' AND COLUMN_NAME = 'cancelledAt'
    ),
    'SELECT 1',
    'ALTER TABLE `productImageJobs` ADD COLUMN `cancelledAt` TIMESTAMP NULL'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

-- المفتاح الأجنبيّ لـcancelledBy. اسمٌ صريح قصير: التسمية التلقائية تتجاوز ٦٤ محرفاً على
-- MySQL 8.4 فتُفشل الإنشاء (انظر docs/local-test-db.md).
SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImageJobs' AND CONSTRAINT_NAME = 'fk_pijob_cancelled_by'
    ),
    'SELECT 1',
    'ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_cancelled_by` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`)'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- ش١ من المرحلة ٢ (١٩/٨): من المحادثة إلى الطلب.
--
-- ① `channelHandle`: المسوّدة تحمل `channel` **بلا معرّفٍ مقابل** ⇒ طلبٌ حُفظ مسوّدةً ثمّ
--    ثُبِّت يفقد رقم الواتساب/اسم الحساب كلّياً، فلا سبيل للرجوع إلى الزبون من الأمر —
--    بينما `workOrders.channelHandle` قائمٌ وينتظر قيمة.
-- ② `conversationId`: يجعل ربط المحادثة بأمر الشغل يقع **داخل معاملة التثبيت** بدل ظنٍّ
--    لاحق، فإمّا (أمر شغل + محادثة مربوطة) وإمّا لا شيء.
--
-- idempotent صراحةً (درس ١٣/٨): يُحرَس بـinformation_schema فلا يفشل على إعادة التطبيق.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receptionDrafts' AND COLUMN_NAME = 'channelHandle'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `receptionDrafts` ADD COLUMN `channelHandle` varchar(120) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receptionDrafts' AND COLUMN_NAME = 'conversationId'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `receptionDrafts` ADD COLUMN `conversationId` bigint NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receptionDrafts'
    AND CONSTRAINT_NAME = 'fk_draft_conversation' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
-- ON DELETE SET NULL: حذفُ محادثةٍ لا يُسقط مسوّدةً — الطلب أثقل من خيط رسائله.
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `receptionDrafts` ADD CONSTRAINT `fk_draft_conversation` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receptionDrafts' AND INDEX_NAME = 'idx_draft_conversation'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `idx_draft_conversation` ON `receptionDrafts` (`conversationId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

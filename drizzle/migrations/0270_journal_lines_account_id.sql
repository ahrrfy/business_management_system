-- 0270_journal_lines_account_id: FK صريحة من journalLines إلى accounts + backfill من role → systemRole
--
-- الغرض (Tier-2 #5، ٢٦/٨): `journalLines.role` (VARCHAR 40) يربط الحساب soft-link عبر
-- `accounts.systemRole` (UNIQUE). الأثر السلبيّ:
--   1) لا FK — لا حراسة قاعديّة لسلامة الربط.
--   2) لا يدعم حساباً بلا `systemRole` (حسابات مخصّصة يُنشئها المحاسب لاحقاً).
--   3) التقارير تصنع JOIN على varchar بدلاً من FK — أبطأ وأهشّ.
--   4) إعادة تسمية `systemRole` تكسر السجلاّت التاريخيّة بلا إشارة.
--
-- الحلّ: عمود `accountId` bigint nullable + FK إلى `accounts.id` + backfill من role→systemRole.
--   • Nullable مقصود: يسمح بـSHADOW القديم (بلا accountId) بالبقاء صحيحاً، والكاتبُ الجديد
--     في `postingEngine` يملأه دائماً.
--   • FK بحماية `ON DELETE RESTRICT`: حسابٌ استُعمل في يوميّة **لا يُحذَف** — قرارٌ محاسبيّ.
--   • حالياً `doubleEntrySettings.mode='OFF'` افتراضياً و`journalLines` قد يكون فارغاً في الإنتاج
--     فالbackfill بلا مخاطر عمليّة، لكنّنا نجعله idempotent احتياطاً للـSHADOW.
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+).

SET @account_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND COLUMN_NAME = 'accountId'
);

SET @account_ddl := IF(
  @account_col = 0,
  'ALTER TABLE `journalLines` ADD COLUMN `accountId` BIGINT NULL AFTER `role`',
  'SELECT 1'
);

PREPARE stmt FROM @account_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Backfill: role → accounts.systemRole → accounts.id. صفوف بلا مطابق تبقى NULL (خرقٌ سابقٌ في المخطّطات
-- لا يُداوى بالهجرة — يُلقى للتصحيح اليدويّ إن ظهر).
UPDATE `journalLines` jl
JOIN `accounts` a ON a.`systemRole` = jl.`role`
SET jl.`accountId` = a.`id`
WHERE jl.`accountId` IS NULL;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND CONSTRAINT_NAME = 'journalLines_accountId_accounts_id_fk'
);

SET @fk_ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE `journalLines` ADD CONSTRAINT `journalLines_accountId_accounts_id_fk` FOREIGN KEY (`accountId`) REFERENCES `accounts` (`id`) ON DELETE RESTRICT',
  'SELECT 1'
);

PREPARE stmt FROM @fk_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND INDEX_NAME = 'idx_journal_line_account'
);

SET @idx_ddl := IF(
  @idx_exists = 0,
  'CREATE INDEX `idx_journal_line_account` ON `journalLines` (`accountId`)',
  'SELECT 1'
);

PREPARE stmt FROM @idx_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

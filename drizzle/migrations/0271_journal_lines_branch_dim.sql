-- 0271_journal_lines_branch_dim: بعدٌ تحليليّ (branchId) على journalLines + backfill من الرأس
--
-- الغرض (Tier-2 #6، ٢٦/٨): إضافة `branchId` على مستوى **السطر** لدعم تقارير P&L بالفرع.
-- `journalEntries.branchId` قائمٌ على مستوى **الرأس**، لكن قيداً واحداً قد يشمل حركاتٍ من
-- فروعٍ مختلفة (تحويل بين فروع، تسويةٌ متعدّدة الفروع). البعدُ التحليليّ على السطر يمكّن:
--   • ميزان مراجعةٍ بالفرع دون الحاجة لتفكيك الرأس.
--   • P&L بالفرع أدقّ من رأسٍ واحد لكل قيد.
--   • تقارير حصّةٍ لكل فرعٍ من مصروفاتٍ مشتركة (يُقسَم القيد على أسطرٍ بفروعٍ مختلفة).
--
-- الحلّ:
--   • عمود `branchId` bigint nullable **بلا FK** (مطابقةً لنمط `journalEntries.branchId`).
--   • Nullable مقصود: الأسطر التاريخية بلا بيانات فرعية على السطر تبقى صحيحة.
--   • Backfill يأخذ `branchId` من رأس القيد (`journalEntries.branchId`) — هي السلوك القائم.
--   • Index يُسرّع GROUP BY branchId في تقارير P&L.
--
-- **لماذا بلا FK**: `journalEntries.branchId` نفسها بلا FK. إضافة FK هنا تُنشئ تعارضاً في
-- الأسلوب داخل نفس نظام الدفتر المزدوج، ويلزمها backfill منسّق على المستويَين معاً — أُجّل
-- ذلك إلى PR حوكميّ منفصل. البعد التحليليّ يعمل بلا FK (الاستعلامات تجمّع صراحةً).
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+).

SET @branch_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND COLUMN_NAME = 'branchId'
);

SET @branch_ddl := IF(
  @branch_col = 0,
  'ALTER TABLE `journalLines` ADD COLUMN `branchId` BIGINT NULL AFTER `accountId`',
  'SELECT 1'
);

PREPARE stmt FROM @branch_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Backfill: خذ branchId من رأس القيد (السلوك الحاليّ فعلياً — القيد كلّه بفرعٍ واحد).
UPDATE `journalLines` jl
JOIN `journalEntries` je ON je.`id` = jl.`journalId`
SET jl.`branchId` = je.`branchId`
WHERE jl.`branchId` IS NULL
  AND je.`branchId` IS NOT NULL;
--> statement-breakpoint

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND INDEX_NAME = 'idx_journal_line_branch'
);

SET @idx_ddl := IF(
  @idx_exists = 0,
  'CREATE INDEX `idx_journal_line_branch` ON `journalLines` (`branchId`)',
  'SELECT 1'
);

PREPARE stmt FROM @idx_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

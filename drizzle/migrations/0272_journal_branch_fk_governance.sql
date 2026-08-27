-- 0272_journal_branch_fk_governance: FK صريحة على journalEntries.branchId + journalLines.branchId
--
-- الغرض (Tier-3 #1، ٢٧/٨): PR #828 (Tier-2 #6) أضاف `journalLines.branchId` **بلا FK**
-- مطابقةً لنمط `journalEntries.branchId` القائم (بلا FK). تعليقٌ صريحٌ في الكود قال:
--   «إضافة FK هنا تُنشئ تعارضاً في الأسلوب داخل نفس نظام الدفتر المزدوج، ويلزمها
--    backfill منسّق على المستويَين معاً — أُجّل ذلك إلى PR حوكميّ منفصل.»
-- هذه الهجرة هي ذلك PR: تُضيف FK على **العمودَين معاً** حسمياً — دفاعٌ في العمق يمسك
-- أيّ writeJournal بـbranchId خاطئ لحظة الإدراج بدل انكشافه في تقريرٍ متأخّر.
--
-- **لماذا آمنٌ الآن:** `accountingEntries.branchId` FK'd بالفعل، و`journalEntries` مشتقّة
-- منها (branchId المُمَرَّر يأتي من entry بـFK نظيف)، و`journalLines.branchId` مُعبَّأ من
-- `journalEntries.branchId` (backfill هجرة 0271). فسلسلة الاشتقاق نظيفة ⇒ صفر أيتام.
-- ولو ظهرت رتلٌ يتيمة في اختبار ما، الهجرة تفشل بوضوحٍ وتشير للسبب.
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+).

-- FK #1: journalEntries.branchId
SET @je_fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalEntries'
    AND CONSTRAINT_NAME = 'journalEntries_branchId_branches_id_fk'
);

SET @je_fk_ddl := IF(
  @je_fk_exists = 0,
  'ALTER TABLE `journalEntries` ADD CONSTRAINT `journalEntries_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE RESTRICT',
  'SELECT 1'
);

PREPARE stmt FROM @je_fk_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- FK #2: journalLines.branchId
SET @jl_fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND CONSTRAINT_NAME = 'journalLines_branchId_branches_id_fk'
);

SET @jl_fk_ddl := IF(
  @jl_fk_exists = 0,
  'ALTER TABLE `journalLines` ADD CONSTRAINT `journalLines_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE RESTRICT',
  'SELECT 1'
);

PREPARE stmt FROM @jl_fk_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

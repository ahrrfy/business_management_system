-- 0273_journal_lines_party_dims: أبعاد تحليليّة للطرف على journalLines (عميل/مورّد/جهة توصيل)
--
-- الغرض (Tier-3 #2، ٢٧/٨): بعد إضافة `accountId` (0270) و`branchId` (0271) و`FK حوكميّة` (0272)،
-- المرحلة الطبيعيّة التالية: أبعاد **الطرف** (customer/supplier/deliveryParty). مرآةٌ لنمط
-- `accountingEntries` نفسه (customerId FK + supplierId FK + deliveryPartyId بلا FK). الأثر:
--   • ميزان حساب العميل (per-customer P&L) دون مطابقة يدوية بالفاتورة/الإيصال.
--   • تحليل مصروف المورّد (per-supplier expense) بلا سنداتٍ متفرّقة.
--   • تعرّض مباشرٌ لعهدة كل مندوب على مستوى القيد المزدوج (COD attribution).
--
-- **الحلّ:** ٣ أعمدة nullable + FK حيث يوجد جدولٌ أمّ + backfill من رأس القيد المصدريّ.
--   • Nullable: كل سطرٍ يحمل بعداً واحداً في معظم الحالات (AR customerId، AP supplierId).
--   • Backfill: SET من `accountingEntries` عبر `journalEntries.entryId` — نفس مصدر الحقيقة.
--     الأسطر بلا مصدر (SHADOW_OPENING) تبقى NULL — لا فرضَ افتراضٍ خاطئ.
--   • RESTRICT للحماية: عميل/مورّد استُعمل في قيدٍ لا يُحذَف.
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+).

-- عمود customerId
SET @c_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND COLUMN_NAME = 'customerId'
);

SET @c_ddl := IF(
  @c_col = 0,
  'ALTER TABLE `journalLines` ADD COLUMN `customerId` BIGINT NULL AFTER `branchId`',
  'SELECT 1'
);

PREPARE stmt FROM @c_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- عمود supplierId
SET @s_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND COLUMN_NAME = 'supplierId'
);

SET @s_ddl := IF(
  @s_col = 0,
  'ALTER TABLE `journalLines` ADD COLUMN `supplierId` BIGINT NULL AFTER `customerId`',
  'SELECT 1'
);

PREPARE stmt FROM @s_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- عمود deliveryPartyId (بلا FK — نظير accountingEntries: طرف التوصيل قد يكون خارج جدولٍ أمّ)
SET @d_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND COLUMN_NAME = 'deliveryPartyId'
);

SET @d_ddl := IF(
  @d_col = 0,
  'ALTER TABLE `journalLines` ADD COLUMN `deliveryPartyId` BIGINT NULL AFTER `supplierId`',
  'SELECT 1'
);

PREPARE stmt FROM @d_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Backfill: خذ الأبعاد من رأس القيد المصدريّ `accountingEntries` عبر `journalEntries.entryId`.
UPDATE `journalLines` jl
JOIN `journalEntries` je ON je.`id` = jl.`journalId`
JOIN `accountingEntries` ae ON ae.`id` = je.`entryId`
SET
  jl.`customerId` = ae.`customerId`,
  jl.`supplierId` = ae.`supplierId`,
  jl.`deliveryPartyId` = ae.`deliveryPartyId`
WHERE jl.`customerId` IS NULL AND jl.`supplierId` IS NULL AND jl.`deliveryPartyId` IS NULL
  AND (ae.`customerId` IS NOT NULL OR ae.`supplierId` IS NOT NULL OR ae.`deliveryPartyId` IS NOT NULL);
--> statement-breakpoint

-- FK #1: customerId
SET @fk_c_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND CONSTRAINT_NAME = 'journalLines_customerId_customers_id_fk'
);

SET @fk_c_ddl := IF(
  @fk_c_exists = 0,
  'ALTER TABLE `journalLines` ADD CONSTRAINT `journalLines_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers` (`id`) ON DELETE RESTRICT',
  'SELECT 1'
);

PREPARE stmt FROM @fk_c_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- FK #2: supplierId
SET @fk_s_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND CONSTRAINT_NAME = 'journalLines_supplierId_suppliers_id_fk'
);

SET @fk_s_ddl := IF(
  @fk_s_exists = 0,
  'ALTER TABLE `journalLines` ADD CONSTRAINT `journalLines_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`) ON DELETE RESTRICT',
  'SELECT 1'
);

PREPARE stmt FROM @fk_s_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Indexes للتقارير التحليليّة (GROUP BY customerId/supplierId/deliveryPartyId).
SET @idx_c := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND INDEX_NAME = 'idx_journal_line_customer'
);
SET @idx_c_ddl := IF(@idx_c = 0, 'CREATE INDEX `idx_journal_line_customer` ON `journalLines` (`customerId`)', 'SELECT 1');
PREPARE stmt FROM @idx_c_ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_s := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND INDEX_NAME = 'idx_journal_line_supplier'
);
SET @idx_s_ddl := IF(@idx_s = 0, 'CREATE INDEX `idx_journal_line_supplier` ON `journalLines` (`supplierId`)', 'SELECT 1');
PREPARE stmt FROM @idx_s_ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_d := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND INDEX_NAME = 'idx_journal_line_delivery_party'
);
SET @idx_d_ddl := IF(@idx_d = 0, 'CREATE INDEX `idx_journal_line_delivery_party` ON `journalLines` (`deliveryPartyId`)', 'SELECT 1');
PREPARE stmt FROM @idx_d_ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

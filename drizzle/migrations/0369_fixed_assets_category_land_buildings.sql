-- 0369_fixed_assets_category_land_buildings.sql
-- توسيع تصنيفات الأصول الثابتة لدعم الأراضي والمباني وفق معيار IAS 16 والنظام المحاسبي الموحد
-- وتحديث قيد فحص تصنيفات السندات لدعم سلف القروض وأموال التشغيل (تثبيت هجرة commit 48932517)

ALTER TABLE `fixedAssets` 
MODIFY COLUMN `assetCategory` enum('computers','display','furniture','vehicles','printing','devices','land','buildings') NOT NULL;
--> statement-breakpoint

SET @has_chk := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'voucherCategories'
    AND constraint_name = 'chk_vchcat_posting_role'
);
SET @sql := IF(@has_chk > 0,
  'ALTER TABLE `voucherCategories` DROP CHECK `chk_vchcat_posting_role`',
  'SELECT ''chk_vchcat_posting_role absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

ALTER TABLE `voucherCategories` ADD CONSTRAINT `chk_vchcat_posting_role` CHECK (
  (`postingRole` IS NULL) OR 
  ((`voucherCategoryDirection` = 'IN') AND (`postingRole` IN ('OTHER_REVENUE','CAPITAL','OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY','LOAN_RECEIVABLE','INVESTMENT_PAYABLE'))) OR 
  ((`voucherCategoryDirection` = 'OUT') AND (`postingRole` IN ('OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY','SALARIES','RENT','UTILITIES','OPERATING_EXPENSE','DELIVERY_EXPENSE','GIFTS_PROMO','LOSSES','OTHER_EXPENSE','LOAN_RECEIVABLE','INVESTMENT_PAYABLE'))) OR 
  ((`voucherCategoryDirection` = 'BOTH') AND (`postingRole` IN ('OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY','LOAN_RECEIVABLE','INVESTMENT_PAYABLE')))
);

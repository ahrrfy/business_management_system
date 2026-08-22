-- 0190: classified counter-account for free-form OTHER vouchers.
-- Pending rows remain zero-effect; approval materializes only a configured role.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `voucherCategories`
  ADD COLUMN `postingRole` varchar(64) NULL AFTER `voucherCategoryDirection`;
--> statement-breakpoint
-- Only objectively classified Iraqi defaults are mapped automatically. Ambiguous
-- categories remain NULL and therefore block use/ACTIVE until an owner classifies
-- or disables them from the traditional category-management screen.
UPDATE `voucherCategories`
SET `postingRole` = CASE `name`
  WHEN 'إيجار' THEN 'RENT'
  WHEN 'رواتب' THEN 'SALARIES'
  WHEN 'خدمات (ماء/كهرباء/إنترنت)' THEN 'UTILITIES'
  WHEN 'صيانة وإصلاح' THEN 'OPERATING_EXPENSE'
  WHEN 'مواصلات ووقود' THEN 'OPERATING_EXPENSE'
  WHEN 'قرطاسية ونثريات' THEN 'OPERATING_EXPENSE'
  WHEN 'إعلانات وتسويق' THEN 'OPERATING_EXPENSE'
  WHEN 'تبرّعات ومساعدات' THEN 'OTHER_EXPENSE'
  WHEN 'سحب شخصي/مالك' THEN 'OWNER_CURRENT'
  WHEN 'عُمولات وأتعاب' THEN 'OPERATING_EXPENSE'
  WHEN 'مصاريف بنكية' THEN 'OPERATING_EXPENSE'
  WHEN 'إيرادات متفرّقة' THEN 'OTHER_REVENUE'
  WHEN 'فوائد بنكية' THEN 'OTHER_REVENUE'
  ELSE `postingRole`
END
WHERE `postingRole` IS NULL;
--> statement-breakpoint
ALTER TABLE `voucherCategories`
  ADD CONSTRAINT `chk_vchcat_posting_role` CHECK (
    `postingRole` IS NULL OR (
      (`voucherCategoryDirection` = 'IN' AND `postingRole` IN ('OTHER_REVENUE','CAPITAL','OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY'))
      OR (`voucherCategoryDirection` = 'OUT' AND `postingRole` IN ('OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY','SALARIES','RENT','UTILITIES','OPERATING_EXPENSE','DELIVERY_EXPENSE','GIFTS_PROMO','LOSSES','OTHER_EXPENSE'))
      OR (`voucherCategoryDirection` = 'BOTH' AND `postingRole` IN ('OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY'))
    )
  );

-- 0370_fixed_assets_opening_depreciation.sql
-- إضافة عمود الإهلاك الافتتاحي السابق للأصول الثابتة لفصله عن إهلاك النظام الدوري وفق معيار IAS 16

ALTER TABLE `fixedAssets` ADD COLUMN `openingDepreciation` decimal(15,2) NOT NULL DEFAULT '0.00';

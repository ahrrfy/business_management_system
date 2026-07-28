ALTER TABLE `productUnits`
  ADD COLUMN `isStoreSaleUnit` boolean NOT NULL DEFAULT false AFTER `isBaseUnit`;

-- توافق خلفي: ما كان يظهر سابقاً (وحدة الأساس) يبقى ظاهراً حتى يختار المدير وحدات المتجر صراحةً.
UPDATE `productUnits`
SET `isStoreSaleUnit` = true
WHERE `isBaseUnit` = true;

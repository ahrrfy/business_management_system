-- 0274_journal_lines_secondary_dims: أبعاد ثانويّة على journalLines (exchangeHouse + digitalWallet)
--
-- الغرض (Tier-3 #4، ٢٧/٨): إكمالُ مرآة `accountingEntries` بإضافة البُعدَين الثانويَّين:
--   • `exchangeHouseId` FK إلى exchangeHouses — لقيود EXCHANGE_* (DEPOSIT/WITHDRAW/FX_BUY/SETTLE/FEE/FX_DIFF).
--   • `digitalWalletId` بلا FK — نظير accountingEntries: قد يكون محفظةً خارجية.
-- بهذين نُغلق فجوةَ الأبعاد بين `accountingEntries` (رأسٌ) و`journalLines` (سطرٌ) —
-- تقارير التحليل تعمل بـGROUP BY صريحٍ بلا JOIN إلى الرأس.
--
-- **Nullable + Backfill من الرأس المصدريّ** — نفس نمط Tier-3 #2 (0273).
-- **FK exchangeHouseId RESTRICT** — صيرفةٌ استُعملت في قيدٍ لا تُحذَف.
-- **بلا FK لـdigitalWalletId** — مرآةٌ لـaccountingEntries.
--
-- Idempotency: احرس بـinformation_schema.

-- عمود exchangeHouseId
SET @xh_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND COLUMN_NAME = 'exchangeHouseId'
);

SET @xh_ddl := IF(
  @xh_col = 0,
  'ALTER TABLE `journalLines` ADD COLUMN `exchangeHouseId` BIGINT NULL AFTER `deliveryPartyId`',
  'SELECT 1'
);

PREPARE stmt FROM @xh_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- عمود digitalWalletId
SET @dw_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND COLUMN_NAME = 'digitalWalletId'
);

SET @dw_ddl := IF(
  @dw_col = 0,
  'ALTER TABLE `journalLines` ADD COLUMN `digitalWalletId` BIGINT NULL AFTER `exchangeHouseId`',
  'SELECT 1'
);

PREPARE stmt FROM @dw_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Backfill من رأس القيد المصدريّ.
UPDATE `journalLines` jl
JOIN `journalEntries` je ON je.`id` = jl.`journalId`
JOIN `accountingEntries` ae ON ae.`id` = je.`entryId`
SET
  jl.`exchangeHouseId` = ae.`exchangeHouseId`,
  jl.`digitalWalletId` = ae.`digitalWalletId`
WHERE jl.`exchangeHouseId` IS NULL AND jl.`digitalWalletId` IS NULL
  AND (ae.`exchangeHouseId` IS NOT NULL OR ae.`digitalWalletId` IS NOT NULL);
--> statement-breakpoint

-- FK لـexchangeHouseId
SET @fk_xh_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND CONSTRAINT_NAME = 'journalLines_exchangeHouseId_exchangeHouses_id_fk'
);

SET @fk_xh_ddl := IF(
  @fk_xh_exists = 0,
  'ALTER TABLE `journalLines` ADD CONSTRAINT `journalLines_exchangeHouseId_exchangeHouses_id_fk` FOREIGN KEY (`exchangeHouseId`) REFERENCES `exchangeHouses` (`id`) ON DELETE RESTRICT',
  'SELECT 1'
);

PREPARE stmt FROM @fk_xh_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Indexes للتقارير التحليليّة.
SET @idx_xh := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND INDEX_NAME = 'idx_journal_line_exchange_house'
);
SET @idx_xh_ddl := IF(@idx_xh = 0, 'CREATE INDEX `idx_journal_line_exchange_house` ON `journalLines` (`exchangeHouseId`)', 'SELECT 1');
PREPARE stmt FROM @idx_xh_ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_dw := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'journalLines'
    AND INDEX_NAME = 'idx_journal_line_digital_wallet'
);
SET @idx_dw_ddl := IF(@idx_dw = 0, 'CREATE INDEX `idx_journal_line_digital_wallet` ON `journalLines` (`digitalWalletId`)', 'SELECT 1');
PREPARE stmt FROM @idx_dw_ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

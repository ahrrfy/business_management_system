-- 0189: authoritative signed USD carrying and gross exchange-house classification.
-- The legacy EXCHANGE_WALLET_* roles become zero-balance operational clearing;
-- receivables/payables are presented gross per counterparty and currency.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `exchangeHouses`
  ADD COLUMN `balanceUsdCarryingIqd` decimal(15,2) NOT NULL DEFAULT 0 AFTER `balanceUsd`;
--> statement-breakpoint
-- One-time migration from the previously persisted display WAVG. All writes after
-- this migration maintain the cent carrying directly and never reconstruct it.
UPDATE `exchangeHouses`
SET `balanceUsdCarryingIqd` = ROUND(`balanceUsd` * `usdCostRate`, 2);
--> statement-breakpoint
-- Legacy FX_BUY already persisted iqdAmount, while direct USD WITHDRAW and an
-- approved DEPOSIT historically left it at zero.  Backfill only from the
-- transaction's own saved source rate; a missing branch/rate/quantity is never
-- inferred from the current house WAVG or another transaction.  db:verify
-- reports and blocks any unresolved row, negative (house,branch) custody, or a
-- zero-quantity group with a non-zero carrying residual before app reload.
UPDATE `exchangeTransactions`
SET `iqdAmount` = ROUND(`usdAmount` * `exchangeRate`, 2)
WHERE `exchangeTxnStatus` = 'ACTIVE'
  AND `exchangeTxnCurrency` = 'USD'
  AND `exchangeTxnType` IN ('FX_BUY','WITHDRAW','DEPOSIT')
  AND `iqdAmount` = 0
  AND `branchId` IS NOT NULL
  AND `usdAmount` > 0
  AND `exchangeRate` > 0;
--> statement-breakpoint
ALTER TABLE `exchangeHouses`
  ADD CONSTRAINT `chk_exchange_usd_carrying_sign` CHECK (
    (`balanceUsd` = 0 AND `balanceUsdCarryingIqd` = 0) OR
    (`balanceUsd` > 0 AND `balanceUsdCarryingIqd` > 0) OR
    (`balanceUsd` < 0 AND `balanceUsdCarryingIqd` < 0)
  );
--> statement-breakpoint
CREATE INDEX `idx_exchange_custody_scope`
  ON `exchangeTransactions` (`exchangeHouseId`,`branchId`,`exchangeTxnStatus`,`exchangeTxnCurrency`,`exchangeTxnType`,`id`);
--> statement-breakpoint
INSERT INTO `accounts` (`code`,`name`,`type`,`parentId`,`systemRole`,`sortOrder`) VALUES
('1171','ذمم صيرفات مدينة — دينار عراقي','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'EXCHANGE_RECEIVABLE_IQD',1171),
('1181','ذمم صيرفات مدينة — دولار بالقيمة الدفترية','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'EXCHANGE_RECEIVABLE_USD',1181),
('2170','ذمم صيرفات دائنة — دينار عراقي','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'EXCHANGE_PAYABLE_IQD',217),
('2180','ذمم صيرفات دائنة — دولار بالقيمة الدفترية','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'EXCHANGE_PAYABLE_USD',218);

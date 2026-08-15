-- 0187 P2/Sh2 — explicit posting profiles, restart-safe SHADOW cycles, and the
-- production chart roles required by the 32 accounting entry types.
-- Existing simplified entries are untouched; mode remains OFF/SHADOW unless
-- the separately enforced activation gate authorizes ACTIVE.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `accountingEntries`
  ADD COLUMN `postingProfile` varchar(64) NULL AFTER `entryType`,
  ADD COLUMN `postingIntentJson` json NULL AFTER `postingProfile`,
  ADD COLUMN `postingIntentHash` char(64) NULL AFTER `postingIntentJson`,
  ADD COLUMN `postingCycleId` varchar(36) NULL AFTER `postingIntentHash`;
--> statement-breakpoint
CREATE INDEX `idx_entry_posting_cycle` ON `accountingEntries` (`postingCycleId`);
--> statement-breakpoint
ALTER TABLE `journalEntries`
  MODIFY COLUMN `entryId` bigint NULL,
  ADD COLUMN `sourceType` enum('ACCOUNTING_ENTRY','SHADOW_OPENING') NOT NULL DEFAULT 'ACCOUNTING_ENTRY' AFTER `entryId`,
  ADD COLUMN `sourceKey` varchar(120) NULL AFTER `sourceType`,
  ADD COLUMN `postingProfile` varchar(64) NULL AFTER `sourceKey`,
  ADD COLUMN `cycleId` varchar(36) NULL AFTER `postingProfile`,
  MODIFY COLUMN `status` enum('POSTED','UNMAPPED','MEMO') NOT NULL DEFAULT 'POSTED';
--> statement-breakpoint
ALTER TABLE `journalEntries`
  ADD CONSTRAINT `uq_journal_source_key` UNIQUE (`sourceKey`);
--> statement-breakpoint
CREATE INDEX `idx_journal_cycle_date` ON `journalEntries` (`cycleId`,`entryDate`);
--> statement-breakpoint
ALTER TABLE `doubleEntrySettings`
  ADD COLUMN `shadowCycleId` varchar(36) NULL AFTER `shadowStartedAt`,
  ADD COLUMN `shadowOpeningHash` varchar(64) NULL AFTER `shadowCycleId`,
  ADD COLUMN `policyApprovalReference` varchar(255) NULL AFTER `shadowOpeningHash`,
  ADD COLUMN `policyApprovalPolicyHash` char(64) NULL AFTER `policyApprovalReference`,
  ADD COLUMN `policyApprovalCycleId` varchar(36) NULL AFTER `policyApprovalPolicyHash`,
  ADD COLUMN `policyApprovalOpeningHash` char(64) NULL AFTER `policyApprovalCycleId`,
  ADD COLUMN `policyAccountantName` varchar(150) NULL AFTER `policyApprovalOpeningHash`,
  ADD COLUMN `policyApprovedAt` timestamp NULL AFTER `policyAccountantName`,
  ADD COLUMN `policyApprovedBy` int NULL AFTER `policyApprovedAt`;
--> statement-breakpoint
ALTER TABLE `doubleEntrySettings`
  ADD CONSTRAINT `fk_de_settings_policy_user`
    FOREIGN KEY (`policyApprovedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Reference data is intentionally strict: no INSERT IGNORE and no duplicate
-- swallowing. A conflicting code/role aborts deployment for human review.
-- IDs are allocated by MySQL; only stable codes and system roles are contracts.
INSERT INTO `accounts` (`code`,`name`,`type`,`parentId`,`systemRole`,`sortOrder`) VALUES
('4700','أرباح استبعاد الأصول الثابتة','REVENUE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='4000'),'ASSET_DISPOSAL_GAIN',470),
('5660','خسائر استبعاد الأصول الثابتة','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'ASSET_DISPOSAL_LOSS',566),
('1185','نقد أجنبي — دولار بالقيمة الدفترية','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'FOREIGN_CASH_USD',1185),
('1130','شيكات قيد التحصيل','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'CHECKS_RECEIVABLE',113),
('1140','محافظ الدفع والتحصيل','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'PAYMENT_WALLET',114),
('1145','رصيد اتصالات محصل','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'TELECOM_BALANCE',1145),
('5670','فروقات كلفة مرتجعات المشتريات','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'PURCHASE_PRICE_VARIANCE',567),
('1250','إنتاج تحت التشغيل','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'WORK_IN_PROGRESS',125);
--> statement-breakpoint
INSERT INTO `accounts` (`code`,`name`,`type`,`parentId`,`systemRole`,`sortOrder`) VALUES
('1110','الخزينة','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'TREASURY_CASH',111),
('1120','نقد في الطريق','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'CASH_IN_TRANSIT',112),
('1160','عهدة جهات التوصيل','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'DELIVERY_FLOAT',116),
('1170','محفظة الصيرفة — دينار عراقي','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'EXCHANGE_WALLET_IQD',117),
('1180','محفظة الصيرفة — دولار بالقيمة الدفترية','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'EXCHANGE_WALLET_USD',118),
('1190','أرصدة المحافظ الرقمية','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'DIGITAL_WALLET',119),
('1590','مجمع استهلاك الأصول الثابتة','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'ACCUMULATED_DEPRECIATION',159),
('2400','مستحقات جهات التوصيل','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'COURIER_PAYABLE',240),
('2500','ضرائب ورسوم مستحقة','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'TAX_PAYABLE',250),
('2600','قروض مستحقة','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'LOAN_PAYABLE',260),
('3300','جاري المالك','EQUITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='3000'),'OWNER_CURRENT',330),
('4600','أرباح فروقات الصرف','REVENUE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='4000'),'FX_GAIN',460),
('5610','أجور التوصيل','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'DELIVERY_EXPENSE',561),
('5620','هدايا وترويج','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'GIFTS_PROMO',562),
('5630','استهلاك الأصول الثابتة','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'DEPRECIATION_EXPENSE',563),
('5640','خسائر فروقات الصرف','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'FX_LOSS',564),
('5650','فروقات التقريب النقدي','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'ROUNDING_DIFF',565);

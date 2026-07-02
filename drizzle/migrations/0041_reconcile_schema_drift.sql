-- 0041 — مصالحة انحراف مخطّط الإنتاج (٢/٧/٢٦)
-- ===============================================================
-- **السبب:** الـsnapshot مُجمَّد عند 0034، فـdb:verify لا يفحص كائنات الهجرات 0035-0040 ⇒ نقطة عمياء.
-- طريقة قديمة (drizzle-kit migrate) سجّلت 0036/0037/… «مُطبَّقة» دون تنفيذ SQL فعلاً ⇒ انحراف صامت
-- (جدول exchangeHouses/عمود receiptApprovalStatus… مفقودة على الإنتاج) كشفه فشل نشر 0040.
--
-- **هذه الهجرة idempotent محصّنة بالكامل:** تُعيد إنشاء أيّ كائن مفقود من 0035-0040 (جداول/أعمدة/
-- مولَّدة/فهارس/FK/enum) وتكون no-op إن كان موجوداً — تُصلح الانحراف نهائياً بأمان على أي حالة قاعدة.
-- ملاحظة أداء: تعديل enum على accountingEntries محروس (يُعاد بناء الجدول فقط عند الانحراف الفعليّ).
-- تكملة: تحديث db:verify ليفحص هذه الكائنات صراحةً (سدّ النقطة العمياء).
--> statement-breakpoint

-- 0035 reconcile — عمود مولَّد STORED `searchNorm` على products + فهرس B-tree
-- (idempotent محصّن لقاعدة إنتاج منحرفة: يُعيد إنشاء أيّ كائن مفقود، no-op إن كان موجوداً)
-- ملاحظة: جدول products أساسيّ (منشأ منذ 0000) — لا يُنشأ هنا.

-- (١) لو العمود مَوجود لكن ليس GENERATED ⇒ احذفه (كي نُعيد إنشاءه بَصيغة GENERATED).
SET @col_is_generated = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'searchNorm'
);
SET @col_is_generated = IFNULL(@col_is_generated, 0);
SET @sql = IF(@col_is_generated = 0 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'searchNorm'
) = 1,
  'ALTER TABLE products DROP COLUMN searchNorm',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- (٢) لو العمود غير مَوجود (إمّا أصلاً، أو لأنّا حذفناه أعلاه) ⇒ أَنشئه كَGENERATED STORED.
SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'searchNorm'
);
SET @sql = IF(@col_exists = 0,
  CONCAT(
    'ALTER TABLE products ADD COLUMN searchNorm VARCHAR(512) ',
    'GENERATED ALWAYS AS (',
    '  LOWER(',
    '    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(',
    '      COALESCE(name, ''''),',
    '      ''أ'', ''ا''),',
    '      ''إ'', ''ا''),',
    '      ''آ'', ''ا''),',
    '      ''ٱ'', ''ا''),',
    '      ''ة'', ''ه''),',
    '      ''ى'', ''ي''),',
    '      ''ؤ'', ''و''),',
    '      ''ئ'', ''ي''),',
    '      ''ـ'', '''')',
    '  )',
    ') STORED'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- (٣) فهرس B-tree على العمود المولَّد — يَستفيد LIKE 'prefix%' من O(log n).
SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_product_search_norm'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX idx_product_search_norm ON products(searchNorm)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ==================== مصالحة 0036 (vouchers-pro) — كائنات جدول voucherCategories + أعمدة/فهارس/FK على receipts ====================
-- كل كتلة idempotent: تُعيد إنشاء الكائن المفقود وتكون no-op إن كان موجوداً (لقاعدة إنتاج منحرفة).

-- ──────────────────── جدول فئات السندات ────────────────────
CREATE TABLE IF NOT EXISTS voucherCategories (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  voucherCategoryDirection ENUM('IN','OUT','BOTH') NOT NULL DEFAULT 'BOTH',
  description VARCHAR(300) NULL,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  sortOrder INT NOT NULL DEFAULT 0,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vchcat_name (name),
  KEY idx_vchcat_active (isActive),
  KEY idx_vchcat_dir (voucherCategoryDirection)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- بَذر فئات افتراضية عراقية شائعة (بدون تَكرار إن أُعيد التَطبيق).
INSERT IGNORE INTO voucherCategories (name, voucherCategoryDirection, sortOrder) VALUES
  ('إيجار', 'OUT', 10),
  ('رواتب', 'OUT', 20),
  ('خدمات (ماء/كهرباء/إنترنت)', 'OUT', 30),
  ('صيانة وإصلاح', 'OUT', 40),
  ('مواصلات ووقود', 'OUT', 50),
  ('قرطاسية ونثريات', 'OUT', 60),
  ('إعلانات وتسويق', 'OUT', 70),
  ('تبرّعات ومساعدات', 'OUT', 80),
  ('ضرائب ورسوم حكومية', 'OUT', 90),
  ('سحب شخصي/مالك', 'OUT', 100),
  ('عُمولات وأتعاب', 'OUT', 110),
  ('مصاريف بنكية', 'OUT', 120),
  ('إيداع نقدي بنكي', 'IN', 130),
  ('إيرادات متفرّقة', 'IN', 140),
  ('فوائد بنكية', 'IN', 150),
  ('ردّ مَردودات/استرداد', 'IN', 160),
  ('أخرى', 'BOTH', 999);
--> statement-breakpoint

-- ──────────────────── أعمدة receipts الجديدة (idempotent) ────────────────────
-- voucherCategoryId (FK لـvoucherCategories)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'voucherCategoryId') = 0,
  'ALTER TABLE receipts ADD COLUMN voucherCategoryId BIGINT NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- FK لـvoucherCategoryId (لا يَكسر سندات قديمة — NULL مَسموح). محروس أيضاً بوجود الجدول المرجعي voucherCategories (قد يَغيب على قاعدة منحرفة).
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'voucherCategories') = 1
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'voucherCategoryId') = 1
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts'
   AND COLUMN_NAME = 'voucherCategoryId' AND REFERENCED_TABLE_NAME = 'voucherCategories') = 0,
  'ALTER TABLE receipts ADD CONSTRAINT fk_receipts_vchcat FOREIGN KEY (voucherCategoryId) REFERENCES voucherCategories(id) ON DELETE SET NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- counterpartyName — اسم الطرف الحُرّ للسندات «أخرى» (مَفهرس للبحث/التَجميع)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'counterpartyName') = 0,
  'ALTER TABLE receipts ADD COLUMN counterpartyName VARCHAR(200) NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_counterparty') = 0,
  'CREATE INDEX idx_receipt_counterparty ON receipts(counterpartyName)',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- voucherDate — تاريخ السند الفعلي (قد يَختلف عن createdAt)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'voucherDate') = 0,
  'ALTER TABLE receipts ADD COLUMN voucherDate DATE NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_voucher_date') = 0,
  'CREATE INDEX idx_receipt_voucher_date ON receipts(voucherDate)',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- attachmentUrl — مَسار/URL مُستند مَرجعي (إيصال إيجار، فاتورة بنزين)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'attachmentUrl') = 0,
  'ALTER TABLE receipts ADD COLUMN attachmentUrl TEXT NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- internalNote — مُلاحظة داخلية للتدقيق (لا تُطبع)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'internalNote') = 0,
  'ALTER TABLE receipts ADD COLUMN internalNote TEXT NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- signatureHash — SHA-256 hex (64 char) لخَتم السند بَعد الإصدار/الاعتماد
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'signatureHash') = 0,
  'ALTER TABLE receipts ADD COLUMN signatureHash VARCHAR(64) NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Maker-Checker: receiptApprovalStatus (قائمة القيم الكاملة من schema.ts)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'receiptApprovalStatus') = 0,
  'ALTER TABLE receipts ADD COLUMN receiptApprovalStatus ENUM(''APPROVED'',''PENDING_APPROVAL'',''REJECTED'') NOT NULL DEFAULT ''APPROVED''',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- إن كان العمود موجوداً لكن بقائمة enum جزئية على قاعدة منحرفة ⇒ اضبطه للحالة الكاملة الصحيحة (idempotent).
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'receiptApprovalStatus') = 1,
  'ALTER TABLE receipts MODIFY COLUMN receiptApprovalStatus ENUM(''APPROVED'',''PENDING_APPROVAL'',''REJECTED'') NOT NULL DEFAULT ''APPROVED''',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'approvedBy') = 0,
  'ALTER TABLE receipts ADD COLUMN approvedBy INT NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'approvedAt') = 0,
  'ALTER TABLE receipts ADD COLUMN approvedAt TIMESTAMP NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- FK approvedBy → users (ON DELETE SET NULL). محروس بوجود الجدول المرجعي users.
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users') = 1
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'approvedBy') = 1
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts'
   AND COLUMN_NAME = 'approvedBy' AND REFERENCED_TABLE_NAME = 'users') = 0,
  'ALTER TABLE receipts ADD CONSTRAINT fk_receipts_approvedby FOREIGN KEY (approvedBy) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- فهرس approvalStatus للفلترة السريعة (السندات المُعلَّقة في لوحة الموافقات)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_approval') = 0,
  'CREATE INDEX idx_receipt_approval ON receipts(receiptApprovalStatus, branchId)',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- فهرس voucherCategoryId للتجميع/التقارير
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_vchcat') = 0,
  'CREATE INDEX idx_receipt_vchcat ON receipts(voucherCategoryId)',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- 0041 — مصالحة كائنات 0037 (وحدة الصيرفة exchange-house) على قاعدة إنتاج منحرفة.
-- كل كتلة idempotent محصّنة: تُنشئ الكائن المفقود، وتكون no-op إن كان موجوداً.
-- الأصل الحرفي: drizzle/migrations/0037_exchange_houses.sql + drizzle/schema.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ══════════════ (١) جدول exchangeHouses (بفهارسه وقيوده inline) ══════════════
CREATE TABLE IF NOT EXISTS `exchangeHouses` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`phone` varchar(20),
	`phone2` varchar(20),
	`balanceIqd` decimal(15,2) NOT NULL DEFAULT '0',
	`balanceUsd` decimal(15,2) NOT NULL DEFAULT '0',
	`usdCostRate` decimal(15,4) NOT NULL DEFAULT '0',
	`legacyCode` varchar(40),
	`notes` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `exchangeHouses_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_exchange_legacy` UNIQUE(`legacyCode`),
	INDEX `idx_exchange_name` (`name`),
	INDEX `idx_exchange_active` (`isActive`)
);
--> statement-breakpoint

-- إن كان الجدول موجوداً مسبقاً لكن أحد فهارسه/قيده الفريد مفقوداً (انحراف) ⇒ حصّنه فرداً فرداً.
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeHouses' AND INDEX_NAME='uq_exchange_legacy');
SET @s := IF(@i=0,'ALTER TABLE `exchangeHouses` ADD CONSTRAINT `uq_exchange_legacy` UNIQUE(`legacyCode`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeHouses' AND INDEX_NAME='idx_exchange_name');
SET @s := IF(@i=0,'CREATE INDEX `idx_exchange_name` ON `exchangeHouses` (`name`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeHouses' AND INDEX_NAME='idx_exchange_active');
SET @s := IF(@i=0,'CREATE INDEX `idx_exchange_active` ON `exchangeHouses` (`isActive`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

-- ══════════════ (٢) جدول exchangeTransactions (بفهارسه inline بلا FKs — تُضاف محصّنة أدناه) ══════════════
-- ملاحظة: FKs مُنشأة كأوامر مستقلّة محصّنة (وليست inline في CREATE) كي تُضاف أيضاً حين
-- يكون الجدول موجوداً مسبقاً على قاعدة منحرفة، ومع حراسة وجود الجدول المرجعيّ.
CREATE TABLE IF NOT EXISTS `exchangeTransactions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`txnNumber` varchar(50) NOT NULL,
	`exchangeHouseId` bigint NOT NULL,
	`branchId` bigint,
	`exchangeTxnType` enum('DEPOSIT','WITHDRAW','FX_BUY','SETTLE','OPENING') NOT NULL,
	`exchangeTxnCurrency` enum('IQD','USD') NOT NULL DEFAULT 'IQD',
	`iqdAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`usdAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`exchangeRate` decimal(15,4) NOT NULL DEFAULT '0',
	`commission` decimal(15,2) NOT NULL DEFAULT '0',
	`commissionIqd` decimal(15,2) NOT NULL DEFAULT '0',
	`fxDiff` decimal(15,2) NOT NULL DEFAULT '0',
	`supplierId` bigint,
	`balanceIqdAfter` decimal(15,2) NOT NULL DEFAULT '0',
	`balanceUsdAfter` decimal(15,2) NOT NULL DEFAULT '0',
	`receiptId` bigint,
	`exchangeTxnStatus` enum('ACTIVE','REVERSED') NOT NULL DEFAULT 'ACTIVE',
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `exchangeTransactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `exchangeTransactions_txnNumber_unique` UNIQUE(`txnNumber`),
	INDEX `idx_exchange_txn_number` (`txnNumber`),
	INDEX `idx_exchange_txn_house` (`exchangeHouseId`,`createdAt`),
	INDEX `idx_exchange_txn_supplier` (`supplierId`),
	INDEX `idx_exchange_txn_type` (`exchangeTxnType`)
);
--> statement-breakpoint

-- فهارس/قيد فريد exchangeTransactions — حراسة إفرادية للانحراف حين وُجد الجدول مسبقاً.
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND INDEX_NAME='exchangeTransactions_txnNumber_unique');
SET @s := IF(@i=0,'ALTER TABLE `exchangeTransactions` ADD CONSTRAINT `exchangeTransactions_txnNumber_unique` UNIQUE(`txnNumber`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND INDEX_NAME='idx_exchange_txn_number');
SET @s := IF(@i=0,'CREATE INDEX `idx_exchange_txn_number` ON `exchangeTransactions` (`txnNumber`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND INDEX_NAME='idx_exchange_txn_house');
SET @s := IF(@i=0,'CREATE INDEX `idx_exchange_txn_house` ON `exchangeTransactions` (`exchangeHouseId`,`createdAt`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND INDEX_NAME='idx_exchange_txn_supplier');
SET @s := IF(@i=0,'CREATE INDEX `idx_exchange_txn_supplier` ON `exchangeTransactions` (`supplierId`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND INDEX_NAME='idx_exchange_txn_type');
SET @s := IF(@i=0,'CREATE INDEX `idx_exchange_txn_type` ON `exchangeTransactions` (`exchangeTxnType`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

-- ══════════════ (٣) مفاتيح exchangeTransactions الأجنبية (محصّنة + حراسة وجود الجدول المرجعيّ) ══════════════
-- fk_extxn_house → exchangeHouses(id)
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='fk_extxn_house');
SET @ref := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeHouses');
SET @s := IF(@fk=0 AND @ref>0,'ALTER TABLE `exchangeTransactions` ADD CONSTRAINT `fk_extxn_house` FOREIGN KEY (`exchangeHouseId`) REFERENCES `exchangeHouses`(`id`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
-- fk_extxn_branch → branches(id)
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='fk_extxn_branch');
SET @ref := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branches');
SET @s := IF(@fk=0 AND @ref>0,'ALTER TABLE `exchangeTransactions` ADD CONSTRAINT `fk_extxn_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
-- fk_extxn_supplier → suppliers(id)
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='fk_extxn_supplier');
SET @ref := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='suppliers');
SET @s := IF(@fk=0 AND @ref>0,'ALTER TABLE `exchangeTransactions` ADD CONSTRAINT `fk_extxn_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
-- fk_extxn_receipt → receipts(id)
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='fk_extxn_receipt');
SET @ref := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='receipts');
SET @s := IF(@fk=0 AND @ref>0,'ALTER TABLE `exchangeTransactions` ADD CONSTRAINT `fk_extxn_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
-- fk_extxn_user → users(id)
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='exchangeTransactions' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='fk_extxn_user');
SET @ref := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users');
SET @s := IF(@fk=0 AND @ref>0,'ALTER TABLE `exchangeTransactions` ADD CONSTRAINT `fk_extxn_user` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

-- ══════════════ (٤) عمود accountingEntries.exchangeHouseId (عاديّ — 0037 لا يُضيف FK؛ الـFK في 0040) ══════════════
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND COLUMN_NAME='exchangeHouseId');
SET @s := IF(@c=0,'ALTER TABLE `accountingEntries` ADD COLUMN `exchangeHouseId` bigint','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

-- ══════════════ (٥) تعديل enum على accountingEntries.entryType (القائمة الكاملة الحالية من schema.ts) ══════════════
-- إعادة تطبيقه idempotent: يضبط الـenum للحالة الصحيحة (٢٢ قيمة).
-- تعديل enum على accountingEntries.entryType — محروس بالأداء: يُعاد بناء الجدول فقط إن كان الـenum ينقص EXCHANGE (انحراف).
SET @need := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND COLUMN_NAME='entryType' AND UPPER(COLUMN_TYPE) NOT LIKE '%EXCHANGE_SETTLE%');
SET @s := IF(@need>0,'ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` enum(''SALE'',''PURCHASE'',''PAYMENT_IN'',''PAYMENT_OUT'',''RETURN'',''ADJUST'',''OPENING'',''INTERNAL_USE'',''WASTAGE'',''CASH_HANDOVER'',''CASH_TRANSFER_OUT'',''CASH_TRANSFER_IN'',''DELIVERY_DISPATCH'',''DELIVERY_REMIT'',''DELIVERY_FEE'',''DELIVERY_WRITEOFF'',''EXCHANGE_DEPOSIT'',''EXCHANGE_WITHDRAW'',''EXCHANGE_FX_BUY'',''EXCHANGE_SETTLE'',''EXCHANGE_FEE'',''EXCHANGE_FX_DIFF'') NOT NULL','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

-- ══════════════ (٦) فهارس accountingEntries للصيرفة ══════════════
SET @x := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND INDEX_NAME='idx_entry_exchange');
SET @s := IF(@x=0,'CREATE INDEX `idx_entry_exchange` ON `accountingEntries` (`exchangeHouseId`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @y := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND INDEX_NAME='idx_entry_exchange_date');
SET @s := IF(@y=0,'CREATE INDEX `idx_entry_exchange_date` ON `accountingEntries` (`exchangeHouseId`, `entryDate`)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

-- 0038_usd_po_reconcile — إعادة إنشاء idempotent محصّنة (لهجرة مصالحة 0041 على قاعدة منحرفة)
-- المصدر: drizzle/migrations/0038_usd_po_reconcile.sql — ٣ أعمدة على جدول purchaseOrders (لا جداول/فهارس/FK/تعديل enum منفصل).
-- poCurrency عمود enum مُضاف عبر ADD ⇒ يُعامَل كإضافة عمود عادي محصّنة بفحص وجود العمود (قيمة enum الكاملة من schema.ts: 'IQD','USD').

-- عمود poCurrency (agreedCurrency) enum('IQD','USD') DEFAULT 'IQD' NOT NULL
SET @c=(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseOrders' AND COLUMN_NAME='poCurrency');
SET @s=IF(@c=0,'ALTER TABLE `purchaseOrders` ADD `poCurrency` enum(''IQD'',''USD'') DEFAULT ''IQD'' NOT NULL','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
-- عمود usdTotal decimal(15,2) NULL
SET @c=(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseOrders' AND COLUMN_NAME='usdTotal');
SET @s=IF(@c=0,'ALTER TABLE `purchaseOrders` ADD `usdTotal` decimal(15,2)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
-- عمود agreedRate decimal(15,4) NULL
SET @c=(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseOrders' AND COLUMN_NAME='agreedRate');
SET @s=IF(@c=0,'ALTER TABLE `purchaseOrders` ADD `agreedRate` decimal(15,4)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

-- ══════════════ 0039 reconcile: customers.searchNorm (GENERATED STORED) ══════════════
-- إصلاح ذاتي idempotent: (١) لو العمود موجود كعادي (varchar) ⇒ احذفه، (٢) لو غير موجود ⇒ أنشئه GENERATED STORED.
SET @col_is_generated = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'searchNorm'
);
SET @col_is_generated = IFNULL(@col_is_generated, 0);
SET @sql = IF(@col_is_generated = 0 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'searchNorm'
) = 1,
  'ALTER TABLE customers DROP COLUMN searchNorm',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'searchNorm'
);
SET @sql = IF(@col_exists = 0,
  CONCAT(
    'ALTER TABLE customers ADD COLUMN searchNorm VARCHAR(512) ',
    'GENERATED ALWAYS AS (',
    '  LOWER(',
    '    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(',
    '      COALESCE(name, ''''),',
    '      ''أ'', ''ا''),',
    '      ''إ'', ''ا''),',
    '      ''آ'', ''ا''),',
    '      ''ٱ'', ''ا''),',
    '      ''ة'', ''ه''),',
    '      ''ى'', ''ي''),',
    '      ''ؤ'', ''و''),',
    '      ''ئ'', ''ي''),',
    '      ''ـ'', '''')',
    '  )',
    ') STORED'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
-- فهرس B-tree على customers.searchNorm — يُنشأ فقط إن كان مفقوداً (idempotent).
SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND INDEX_NAME = 'idx_customer_search_norm'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX idx_customer_search_norm ON customers(searchNorm)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
-- ══════════════ 0039 reconcile: suppliers.searchNorm (GENERATED STORED) ══════════════
SET @col_is_generated2 = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'searchNorm'
);
SET @col_is_generated2 = IFNULL(@col_is_generated2, 0);
SET @sql = IF(@col_is_generated2 = 0 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'searchNorm'
) = 1,
  'ALTER TABLE suppliers DROP COLUMN searchNorm',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @col_exists2 = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'searchNorm'
);
SET @sql = IF(@col_exists2 = 0,
  CONCAT(
    'ALTER TABLE suppliers ADD COLUMN searchNorm VARCHAR(512) ',
    'GENERATED ALWAYS AS (',
    '  LOWER(',
    '    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(',
    '      COALESCE(name, ''''),',
    '      ''أ'', ''ا''),',
    '      ''إ'', ''ا''),',
    '      ''آ'', ''ا''),',
    '      ''ٱ'', ''ا''),',
    '      ''ة'', ''ه''),',
    '      ''ى'', ''ي''),',
    '      ''ؤ'', ''و''),',
    '      ''ئ'', ''ي''),',
    '      ''ـ'', '''')',
    '  )',
    ') STORED'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
-- فهرس B-tree على suppliers.searchNorm — يُنشأ فقط إن كان مفقوداً (idempotent).
SET @idx_exists2 = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND INDEX_NAME = 'idx_supplier_search_norm'
);
SET @sql = IF(@idx_exists2 = 0,
  'CREATE INDEX idx_supplier_search_norm ON suppliers(searchNorm)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ══════════════ مفاتيح accountingEntries الأجنبية (F1/0040 — محروسة: تُضاف الآن بعد توفّر الكائنات) ══════════════
SET @po_ready := ((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND COLUMN_NAME='purchaseOrderId')>0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseOrders')>0);
SET @fk_po := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='accountingEntries_purchaseOrderId_purchaseOrders_id_fk');
SET @s := IF(@po_ready AND @fk_po=0,'ALTER TABLE accountingEntries ADD CONSTRAINT accountingEntries_purchaseOrderId_purchaseOrders_id_fk FOREIGN KEY (purchaseOrderId) REFERENCES purchaseOrders(id)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint
SET @ex_ready := ((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND COLUMN_NAME='exchangeHouseId')>0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exchangeHouses')>0);
SET @fk_ex := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='accountingEntries' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='accountingEntries_exchangeHouseId_exchangeHouses_id_fk');
SET @s := IF(@ex_ready AND @fk_ex=0,'ALTER TABLE accountingEntries ADD CONSTRAINT accountingEntries_exchangeHouseId_exchangeHouses_id_fk FOREIGN KEY (exchangeHouseId) REFERENCES exchangeHouses(id)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

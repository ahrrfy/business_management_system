-- 0036 — تَعزيز السندات (Maker-Checker + تَصنيف + مُرفق + بَصمة + اسم طرف للسندات «أخرى» + تاريخ سند مُستقلّ + مُلاحظة داخلية).
-- يَدوية idempotent (INFORMATION_SCHEMA + PREPARE) — تَتسامح مَع إعادة التَطبيق على قواعد طُبِّقت جُزئياً.
-- لا تَحذف بَيانات — كل إضافات.

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

-- FK لـvoucherCategoryId (لا يَكسر سندات قديمة — NULL مَسموح)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
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

-- voucherDate — تاريخ السند الفعلي (قد يَختلف عن createdAt: مَثلاً دَفع إيجار مايو في ٥ يونيو)
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

-- Maker-Checker (موافقة ثانية للمبالغ الكَبيرة)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'receiptApprovalStatus') = 0,
  'ALTER TABLE receipts ADD COLUMN receiptApprovalStatus ENUM(''APPROVED'',''PENDING_APPROVAL'',''REJECTED'') NOT NULL DEFAULT ''APPROVED''',
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

-- FK approvedBy → users (نَجعله ON DELETE SET NULL ليَبقى السند مُتسقاً لو حُذف المُعتمد)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
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

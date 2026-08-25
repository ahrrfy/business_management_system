-- 0266_inventory_valuation_snapshots: monthly valuation ledger at close time
--
-- الغرض (P1-#2، تقرير المراجعة ٢٥/٨): أصل المخزون في الميزانية يُقرأ **حيّاً** —
-- `SUM(quantity × costPrice)` + الحمل بالطريق. حركةٌ واحدة بعد إقفال الشهر تُغيّر
-- ميزانيةَ الشهر المُقفَل بأثرٍ رجعيّ، فينحرف عن الأرباح المُرحَّلة، ولا يبقى للميزانية
-- المُقفَلة أصلٌ يُعاد إنتاجه.
--
-- الحلّ: `readInventoryValuation` يُلتقط داخل معاملة `approveMonthClose` ويُخزَّن هنا.
-- صفٌّ لكل (فترة × نطاق):
--   - `scopeKey` COMPANY = مجمَّع الشركة (branchId=NULL)
--   - `scopeKey` BRANCH  = فرعٌ بعينه (branchId مُحدَّد)
--
-- ثوابت تصميميّة:
--   - القيمُ ثلاثية: totalValue (يدخل الميزانية) = stockValue + inTransitValue.
--   - `branchesJson` نصّيّ حرّ — يحمل شكل `[{branchId, value, inTransitValue?}]` تاريخياً
--     ولو تغيّرت الحقول لاحقاً يبقى قابلاً للقراءة.
--   - UNIQUE (periodLockId, scopeKey, branchId): صفٌّ واحد لكل (فترة × نطاق). revision
--     جديد يعني periodLockId جديد ⇒ صفٌّ منفصل بلا تعارض.
--
-- ⚠️ لا حذفُ صفٍّ قديم عند إعادة الإقفال (revision جديد) — كلاهما يبقى للسجل التدقيقيّ.
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+).
-- FK: periodLockId → financialPeriods (NULL مسموحٌ للقطات ad-hoc)، capturedBy → users،
-- branchId → branches. ON DELETE SET NULL على الأخيرَين (لا نُفقد اللقطة بحذف الفرع/المستخدم).

SET @tbl_exists := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventoryValuationSnapshots'
);

SET @ddl := IF(
  @tbl_exists = 0,
  'CREATE TABLE `inventoryValuationSnapshots` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `periodLockId` BIGINT NULL,
    `cutoffDate` DATE NOT NULL,
    `capturedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `capturedBy` INT NOT NULL,
    `scopeKey` ENUM(''COMPANY'',''BRANCH'') NOT NULL DEFAULT ''COMPANY'',
    `branchId` BIGINT NULL,
    `totalValue` DECIMAL(15,2) NOT NULL,
    `stockValue` DECIMAL(15,2) NOT NULL,
    `inTransitValue` DECIMAL(15,2) NOT NULL,
    `branchesJson` TEXT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_valuation_period_scope` (`periodLockId`, `scopeKey`, `branchId`),
    KEY `idx_valuation_cutoff` (`cutoffDate`),
    KEY `idx_valuation_period` (`periodLockId`),
    CONSTRAINT `fk_valuation_period` FOREIGN KEY (`periodLockId`) REFERENCES `financialPeriods`(`id`),
    CONSTRAINT `fk_valuation_capturer` FOREIGN KEY (`capturedBy`) REFERENCES `users`(`id`),
    CONSTRAINT `fk_valuation_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

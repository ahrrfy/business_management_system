-- 0280_courier_commission_rules: قواعدُ عمولة جهة التوصيل
--
-- الغرض (Slice 8، ٢٨/٨/٢٦، المحور ٧ من التدقيق): كان تسعير عمولة المندوب/الشركة يجري
-- باجتهاد التسوية اليدويّة (deliveryLedgerEntries) — لا قاعدةٌ صريحةٌ محكومة. الآن
-- جدولٌ مصدرُ الحقيقة لكيفيّة حساب العمولة لكلّ جهة (أو افتراضيّاً بلا partyId ⇒
-- يُطبَّق على كلّ الجهات التي لا قاعدةَ خاصّةً لها).
--
-- ⚠️ **صفر أثرٍ ماليّ في هذه الشريحة** — الأساسُ فقط. الاستهلاك (auto-posting +
-- auto-settlement) يأتي في شريحةٍ لاحقة بعد قرار المالك على نموذج العمولة الأنسب.
--
-- Idempotent: يستعمل INFORMATION_SCHEMA للتحقّق قبل CREATE.

SET @db := DATABASE();
SET @tbl_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='courierCommissionRules');
SET @sql := IF(@tbl_exists = 0, '
CREATE TABLE `courierCommissionRules` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `partyId` bigint DEFAULT NULL,
  `ruleType` varchar(30) NOT NULL,
  `flatAmount` decimal(15,2) DEFAULT NULL,
  `percentValue` decimal(5,2) DEFAULT NULL,
  `minGuarantee` decimal(15,2) DEFAULT NULL,
  `maxCap` decimal(15,2) DEFAULT NULL,
  `isActive` tinyint(1) NOT NULL DEFAULT 1,
  `branchId` bigint DEFAULT NULL,
  `effectiveFrom` timestamp NULL DEFAULT NULL,
  `effectiveTo` timestamp NULL DEFAULT NULL,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_courier_commission_party` (`partyId`,`isActive`),
  CONSTRAINT `ccr_party_fk` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

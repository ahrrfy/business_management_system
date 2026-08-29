-- 0279_delivery_pricing_rules: deliveryZones + deliveryPricingRules — نقلُ التسعير إلى بياناتٍ محكومة
--
-- الغرض (Slice 7، ٢٨/٨/٢٦، المحور ٨ من التدقيق): كان تسعير التوصيل ثابتاً في الكود
-- (`shared/governorates.ts` — ١٨ محافظة)؛ يعدّله المدير عبر deploy جديد. الآن جدولان
-- محكومان يعدَّلان من الشاشة، وبقاء `governorates.ts` كـfallback يضمن عدم كسر السلوك
-- القائم حتى تُملأ الجداول.
--
-- Idempotent: يستعمل INFORMATION_SCHEMA للتحقّق قبل CREATE (نمط 0179/0276/0278).

-- ══ deliveryZones ═══════════════════════════════════════════════════════════════════

SET @db := DATABASE();
SET @tbl_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='deliveryZones');
SET @sql := IF(@tbl_exists = 0, '
CREATE TABLE `deliveryZones` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `code` varchar(60) NOT NULL,
  `name` varchar(120) NOT NULL,
  `preferredBranchId` bigint DEFAULT NULL,
  `isActive` tinyint(1) NOT NULL DEFAULT 1,
  `displayOrder` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `deliveryZones_code_unique` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ══ deliveryPricingRules ═══════════════════════════════════════════════════════════

SET @tbl_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='deliveryPricingRules');
SET @sql := IF(@tbl_exists = 0, '
CREATE TABLE `deliveryPricingRules` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `zoneId` bigint NOT NULL,
  `ruleType` varchar(30) NOT NULL DEFAULT ''FLAT_FEE'',
  `baseFee` decimal(15,2) NOT NULL,
  `perKmFee` decimal(15,2) DEFAULT NULL,
  `perKgFee` decimal(15,2) DEFAULT NULL,
  `minFee` decimal(15,2) DEFAULT NULL,
  `maxFee` decimal(15,2) DEFAULT NULL,
  `isActive` tinyint(1) NOT NULL DEFAULT 1,
  `branchId` bigint DEFAULT NULL,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_delivery_pricing_zone` (`zoneId`,`isActive`),
  CONSTRAINT `dpr_zone_fk` FOREIGN KEY (`zoneId`) REFERENCES `deliveryZones` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ══ Backfill: البذرةُ من `shared/governorates.ts` (١٨ محافظة) ═════════════════════════
-- INSERT IGNORE يبتلع صفوفاً مكرَّرة (idempotent إعادة تشغيل).

INSERT IGNORE INTO `deliveryZones` (`code`, `name`, `displayOrder`) VALUES
  ('baghdad',     'بغداد',                  1),
  ('basra',       'البصرة',                  2),
  ('nineveh',     'نينوى (الموصل)',          3),
  ('erbil',       'أربيل',                   4),
  ('sulaymaniyah','السليمانية',              5),
  ('duhok',       'دهوك',                    6),
  ('kirkuk',      'كركوك',                   7),
  ('diyala',      'ديالى (بعقوبة)',         8),
  ('anbar',       'الأنبار (الرمادي)',      9),
  ('babil',       'بابل (الحلة)',           10),
  ('karbala',     'كربلاء',                 11),
  ('najaf',       'النجف',                  12),
  ('qadisiyah',   'القادسية (الديوانية)',   13),
  ('muthanna',    'المثنى (السماوة)',       14),
  ('thiqar',      'ذي قار (الناصرية)',      15),
  ('maysan',      'ميسان (العمارة)',        16),
  ('wasit',       'واسط (الكوت)',           17),
  ('saladin',     'صلاح الدين (تكريت)',     18);

-- Backfill قواعد التسعير: FLAT_FEE لكلّ منطقة بأجرتها التقديريّة من `governorates.ts`.
INSERT IGNORE INTO `deliveryPricingRules` (`zoneId`, `ruleType`, `baseFee`)
SELECT z.id, 'FLAT_FEE',
  CASE z.code
    WHEN 'baghdad' THEN 5000
    WHEN 'babil' THEN 6000
    WHEN 'diyala' THEN 7000 WHEN 'karbala' THEN 7000 WHEN 'najaf' THEN 7000 WHEN 'qadisiyah' THEN 7000
    WHEN 'wasit' THEN 7000
    ELSE 8000
  END
FROM `deliveryZones` z
WHERE NOT EXISTS (SELECT 1 FROM `deliveryPricingRules` r WHERE r.zoneId = z.id AND r.ruleType = 'FLAT_FEE');

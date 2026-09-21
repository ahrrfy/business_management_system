-- 0357_seed_baghdad_amiriya_zone: إضافة منطقة "بغداد - العامرية" وتسعير التوصيل الخاص بها (2000 د.ع)
-- Idempotent: INSERT IGNORE مع الفهرس الفريد على code، واستعلام فحص لعدم تكرار قاعدة التسعير.

INSERT IGNORE INTO `deliveryZones` (`code`, `name`, `isActive`, `displayOrder`) VALUES
  ('baghdad_amiriya', 'بغداد - العامرية', TRUE, 1);

INSERT INTO `deliveryPricingRules` (`zoneId`, `ruleType`, `baseFee`, `isActive`)
SELECT z.id, 'FLAT_FEE', 2000, TRUE
FROM `deliveryZones` z
WHERE z.code = 'baghdad_amiriya'
  AND NOT EXISTS (
    SELECT 1 FROM `deliveryPricingRules` r WHERE r.zoneId = z.id
  );

-- H4 (٢٩/٨/٢٦) — بذرة مناطق التوصيل الافتراضيّة (المحافظات العراقية الثمانية عشرة).
--
-- المصدر: `shared/governorates.ts` (المستعمَل في Storefront ولحساب الأجرة التقديريّة الحاليّة).
-- بعد هذه البذرة، جدول `deliveryZones` مُعبَّأ بالافتراضات ولكل منطقة قاعدة `FLAT_FEE` واحدة.
-- المدير يعدّل الأجرة أو ينشئ قواعد إضافيّة من شاشة «مناطق التسعير».
--
-- Idempotent: `INSERT IGNORE` مع فهرس `code` الفريد ⇒ إعادةُ التطبيق لا تُنشئ صفوفاً مكرّرة.
-- قواعد التسعير: مرتبطةٌ بـ`zoneId` — نُدخلها بعد بذرة المناطق، ونُقيّدها بـ`zoneId + ruleType`
-- في subquery (لا فهرس UNIQUE عليها، لكنّ الاستعلام يجعل الإدراج idempotent عملياً).

-- المناطق (18 محافظة)
INSERT IGNORE INTO `deliveryZones` (`code`, `name`, `isActive`, `displayOrder`) VALUES
  ('baghdad',      'بغداد',                    TRUE, 1),
  ('basra',        'البصرة',                   TRUE, 2),
  ('nineveh',      'نينوى (الموصل)',           TRUE, 3),
  ('erbil',        'أربيل',                    TRUE, 4),
  ('sulaymaniyah', 'السليمانية',               TRUE, 5),
  ('duhok',        'دهوك',                     TRUE, 6),
  ('kirkuk',       'كركوك',                    TRUE, 7),
  ('diyala',       'ديالى (بعقوبة)',           TRUE, 8),
  ('anbar',        'الأنبار (الرمادي)',        TRUE, 9),
  ('babil',        'بابل (الحلة)',             TRUE, 10),
  ('karbala',      'كربلاء',                   TRUE, 11),
  ('najaf',        'النجف',                    TRUE, 12),
  ('qadisiyah',    'القادسية (الديوانية)',     TRUE, 13),
  ('muthanna',     'المثنى (السماوة)',         TRUE, 14),
  ('dhiqar',       'ذي قار (الناصرية)',        TRUE, 15),
  ('maysan',       'ميسان (العمارة)',          TRUE, 16),
  ('wasit',        'واسط (الكوت)',             TRUE, 17),
  ('saladin',      'صلاح الدين (تكريت)',       TRUE, 18);

-- قاعدة FLAT_FEE واحدة لكل منطقة — تُدخَل فقط إن لم توجد قاعدةٌ لتلك المنطقة سلفاً.
-- الأجور من `shared/governorates.ts` (الافتراضات الحاليّة المُستعمَلة في Storefront).
INSERT INTO `deliveryPricingRules` (`zoneId`, `ruleType`, `baseFee`, `isActive`)
SELECT z.id, 'FLAT_FEE', v.fee, TRUE
FROM `deliveryZones` z
JOIN (
  SELECT 'baghdad'      AS code,  5000 AS fee UNION ALL
  SELECT 'basra',        8000 UNION ALL
  SELECT 'nineveh',      8000 UNION ALL
  SELECT 'erbil',        8000 UNION ALL
  SELECT 'sulaymaniyah', 8000 UNION ALL
  SELECT 'duhok',        8000 UNION ALL
  SELECT 'kirkuk',       8000 UNION ALL
  SELECT 'diyala',       7000 UNION ALL
  SELECT 'anbar',        8000 UNION ALL
  SELECT 'babil',        6000 UNION ALL
  SELECT 'karbala',      7000 UNION ALL
  SELECT 'najaf',        7000 UNION ALL
  SELECT 'qadisiyah',    7000 UNION ALL
  SELECT 'muthanna',     8000 UNION ALL
  SELECT 'dhiqar',       8000 UNION ALL
  SELECT 'maysan',       8000 UNION ALL
  SELECT 'wasit',        7000 UNION ALL
  SELECT 'saladin',      7000
) v ON v.code = z.code
WHERE NOT EXISTS (
  SELECT 1 FROM `deliveryPricingRules` r WHERE r.zoneId = z.id
);

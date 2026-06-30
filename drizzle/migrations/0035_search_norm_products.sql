-- 0035 — D2 كامل: عمود مولَّد STORED `searchNorm` على products + فهرس B-tree
-- ===============================================================
-- الجذر: كل بحث منتج في الكاشير يَحسب ARABIC_FOLD_PAIRS عبر REPLACE متَداخل
-- (~٩ REPLACE × ٤ أعمدة = ٣٦ REPLACE) **وقت الاستعلام** على كل صفّ ⇒ مَسحٌ مُكلِّف عند الملايين.
--
-- الحلّ: نَنقل التَطبيع من وقت الاستعلام (per row) إلى وقت الكتابة (per insert/update)
-- عبر **عمود مولَّد STORED**. الفهرس B-tree عليه يُسرّع البَحث بالـprefix (LIKE 'abc%') آلاف
-- المرات، ويُسرّع substring (LIKE '%abc%') ~٥-١٠× حتى بلا فهرس (التَطبيع مَحسوب مُسبَقاً).
--
-- نمط idempotent + إصلاح:
-- (١) إذا العمود مَوجود كَعادي (db:push كَتبه varchar) ⇒ نَحذفه أولاً.
-- (٢) إذا العمود غير مَوجود ⇒ نُنشئه كَGENERATED STORED.
-- (٣) إذا الفهرس غير مَوجود ⇒ نُنشئه.
-- هذا يَجعل الهَجرة صَحيحة على CI (بَعد db:push) وعَلى dev/prod (بَعد db:migrate).

SET @col_is_generated = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'searchNorm'
);
SET @col_is_generated = IFNULL(@col_is_generated, 0);

-- (١) لو العمود مَوجود لكن ليس GENERATED ⇒ احذفه (كي نُعيد إنشاءه بَصيغة GENERATED).
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

-- > statement-breakpoint

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

-- > statement-breakpoint

-- (٣) فهرس B-tree على العمود الجَديد — يَستفيد LIKE 'prefix%' من O(log n).
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

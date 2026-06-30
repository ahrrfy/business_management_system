-- 0035 — D2 كامل: عمود مولَّد STORED `searchNorm` على products + فهرس B-tree
-- ===============================================================
-- الجذر: كل بحث منتج في الكاشير يَحسب ARABIC_FOLD_PAIRS عبر REPLACE متَداخل
-- (~٩ REPLACE × ٤ أعمدة = ٣٦ REPLACE) **وقت الاستعلام** على كل صفّ ⇒ مَسحٌ مُكلِّف عند الملايين.
--
-- الحلّ: نَنقل التَطبيع من وقت الاستعلام (per row) إلى وقت الكتابة (per insert/update)
-- عبر **عمود مولَّد STORED**. الفهرس B-tree عليه يُسرّع البَحث بالـprefix (LIKE 'abc%') آلاف
-- المرات، ويُسرّع substring (LIKE '%abc%') ~٥-١٠× حتى بلا فهرس (التَطبيع مَحسوب مُسبَقاً).
--
-- نمط idempotent (INFORMATION_SCHEMA + PREPARE) — آمن للتَطبيق المُتَكرّر على CI/erp_test
-- (حيث db:push يَكتب schema.ts ثم هذه الهَجرة تُطبَّق بَعدها لإضافة العمود المولَّد).
-- يَستعمل نفس قائمة ARABIC_FOLD_PAIRS في shared/searchNormalize.ts.

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

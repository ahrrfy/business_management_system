-- 0039 — D2 توسعة: عمود مولَّد STORED `searchNorm` على customers + suppliers + فهارس B-tree
-- ===============================================================
-- نفس نمط 0035 (products.searchNorm) بالضبط، على جدولَي customers/suppliers — انظر
-- docs/d2-fulltext-deferred.md §٥ «توسيع لـcustomers/suppliers: نفس النمط على الجداول
-- الأخرى في hot search paths».
--
-- نمط idempotent + إصلاح (لكل جدول): (١) لو العمود موجود كعادي (db:push كتبه varchar)
-- ⇒ نحذفه أولاً. (٢) لو العمود غير موجود ⇒ ننشئه كـGENERATED STORED. (٣) لو الفهرس
-- غير موجود ⇒ ننشئه.

-- ══════════════ customers ══════════════

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

-- > statement-breakpoint

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

-- > statement-breakpoint

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

-- > statement-breakpoint

-- ══════════════ suppliers ══════════════

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

-- > statement-breakpoint

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

-- > statement-breakpoint

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

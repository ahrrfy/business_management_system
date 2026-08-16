-- 0185 — تفرّد رقم السحب النقديّ CD- (المسار أ من ورقة الإصلاحات ١٦/٨)
-- ===============================================================
-- الجذر: `nextDropNumber` يُولّد الرقم تحت GET_LOCK ثم يُحرّره **قبل COMMIT**، فبين التحرير
-- والالتزام تستطيع معاملةٌ أخرى قراءة نفس «أعلى تسلسل» فتُنتج الرقم نفسه. ولا قيد في القاعدة
-- يمنع ذلك ⇒ رقمان متطابقان ممكنان، وإعادة التشغيل قد تربط عهدة السحب الخطأ.
--
-- ⚠️ لماذا ليس UNIQUE على referenceNumber كما أوصى التدقيق الجنائيّ:
--    رقم السحب الواحد يُكتب **على سندين معاً بالتصميم** — OUT من الدرج وIN للخزينة
--    (cashDropService: سطرا `referenceNumber: dropNumber`). فقيدٌ فريد على العمود وحده كان
--    **سيمنع كل عملية سحبٍ سليمة**. التفرّد الصحيح لكل (رقم × اتجاه).
--
-- ⚠️ ولماذا عمودٌ مولَّد لا فهرس مركّب مباشر:
--    `referenceNumber` حقلٌ حرّ يشترك فيه بقيّة أنواع السندات (مراجع بنكية/سندات يدوية)
--    وتكراره فيها مشروع. فنحصر التفرّد في صفوف `CD-` وحدها عبر عمودٍ يكون NULL لغيرها
--    (وMySQL لا يُصادم NULLات في الفهرس الفريد) ⇒ صفر أثر على أيّ سندٍ آخر.
--
-- تحقّق قبل التطبيق (الإنتاج ١٦/٨): ٣٠ سند CD- وصفر تكرار على (referenceNumber, direction).

-- (٠) نمط 0035: `db:push` يكتب العمود **عادياً** من schema.ts (drizzle لا يُولّد GENERATED)،
--     فلو اكتفينا بفحص الوجود لتخطّينا الإنشاء وبقي عموداً فارغاً بلا أيّ تفرّد — أي **حارسٌ
--     مسرحيّ يمرّ أخضرَ زوراً**. لذا: إن وُجد وليس مولَّداً ⇒ أسقط الفهرس ثمّ العمود وأعِد بناءهما.
SET @col_is_generated = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'cashDropKey'
);
SET @col_is_generated = IFNULL(@col_is_generated, 0);
SET @plain_col = IF(@col_is_generated = 0 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'cashDropKey'
) = 1, 1, 0);

SET @sql = IF(@plain_col = 1 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'uq_receipt_cash_drop'
) > 0, 'DROP INDEX uq_receipt_cash_drop ON receipts', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- > statement-breakpoint

SET @sql = IF(@plain_col = 1, 'ALTER TABLE receipts DROP COLUMN cashDropKey', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- > statement-breakpoint

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'cashDropKey'
);
SET @sql = IF(@col_exists = 0,
  CONCAT(
    'ALTER TABLE receipts ADD COLUMN cashDropKey VARCHAR(110) ',
    'GENERATED ALWAYS AS (',
    -- ليس البادئة وحدها: `referenceNumber` حقلٌ حرّ، وسندٌ عاديّ قد يحمل مرجعاً كـ«CD-BANK-991»
    -- (اختبارات المطابقة تغطّي ذلك صراحةً) فيُحجَز ظلماً ويُرفض ثانٍ مثله. نطابق **شكل** الرقم
    -- المولَّد بالضبط (CD-فرع-تاريخ-تسلسل) **مع** عقد السحب النقديّ (نقد + دلوٌ محدَّد).
    'CASE WHEN referenceNumber REGEXP ''^CD-[0-9]+-[0-9]{8}-[0-9]{4}$'' ',
    'AND paymentMethod = ''CASH'' AND cashBucket IS NOT NULL ',
    'THEN CONCAT(referenceNumber, '':'', direction) ELSE NULL END',
    ') STORED'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- > statement-breakpoint

-- الفهرس الفريد: يفشل الإنشاء إن وُجد تكرارٌ تاريخيّ — وهذا مقصود، فالتكرار يعني
-- عهدتَي سحبٍ برقمٍ واحد ويجب أن يراه الإنسان قبل أن يُفرَض القيد.
SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'uq_receipt_cash_drop'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX uq_receipt_cash_drop ON receipts (cashDropKey)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

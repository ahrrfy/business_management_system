-- deliveryLedgerEntries: توسعةُ enum لسبب العجز في التحصيل (Slice DFP1، ٣٠/٨/٢٦).
--
-- الحاجة (بلاغ المالك ٣٠/٨): «حين يقبض المندوب أقلّ من المطلوب، النظام يقبل الفرق صامتاً بلا
-- تصنيف — الفاتورة تُعلَن مسدّدةً كاملاً، والمبلغ يختفي». مخالفةٌ صريحة لمبدأ CLAUDE.md §٥
-- «لا دينار يضيع بصمت» — العجز مالٌ حقيقيّ يجب أن يُقيَّد ذمّةً على مَن قبض ناقصاً.
--
-- القرار (المالك، مغلَق):
--   • العجز ذمّةٌ فوريّة على المندوب — تُقيَّد بنوع `SHORTFALL_ASSIGNED` في `deliveryLedgerEntries`
--     (نفس دفتر الجهة، ونفس مسار `currentBalance` — رفعٌ بنفس آلية COD_COLLECTED).
--   • سببٌ إلزاميّ من قائمة enum ثابتة (shared/shortfallReason.ts) — لا نصّ حرّ. القائمة تحصر
--     الأسباب الستّة المتّفق عليها: MERCHANT_REFUSED_COMMISSION، CUSTOMER_REQUESTED_DISCOUNT،
--     WRONG_PRICE_QUOTED، PARTIAL_REFUSAL، DAMAGED_ITEM_REJECTION، OTHER.
--   • فاتورةُ العميل تبقى مدفوعةً كاملاً — لا `sales.pay` ناقص، لا `AR` مفتوح. المسؤوليّة
--     صراحةً على المندوب لا على العميل.
--
-- التغييران:
--   ١) توسعةُ `entryType` enum بقيمة `SHORTFALL_ASSIGNED` (لا يمسّ القيم القائمة).
--   ٢) إضافةُ عمود `shortfallReason` varchar(60) nullable — يُملأ فقط للنوع SHORTFALL_ASSIGNED،
--      وإلّا يبقى NULL. varchar(60) يكفي لكل رمز في الـenum (أطولها 27 حرفاً).
--
-- ⚠️ لماذا SHORTFALL_ASSIGNED ولم يُدمَج مع COD_WRITTEN_OFF: WRITTEN_OFF إعفاءٌ نهائيّ (مالٌ
-- خسرناه)، بينما SHORTFALL_ASSIGNED «مالٌ نطلبه من المندوب» — رافعٌ لعهدة الجهة تماماً كـ
-- COD_COLLECTED. الخلطُ بينهما يفقد الفارقَ بين «فاتورة أُعفيت» و«فاتورة على المندوب صراحةً».
--
-- التطبيق idempotent — قراءةُ COLUMN_TYPE من INFORMATION_SCHEMA قبل ALTER.

SET @db := DATABASE();

-- ١) توسعة enum: إضافة SHORTFALL_ASSIGNED إن لم توجد
SET @has_shortfall := (
  SELECT IF(
    LOCATE('SHORTFALL_ASSIGNED', COLUMN_TYPE) > 0,
    1, 0
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'deliveryLedgerEntries'
    AND COLUMN_NAME = 'entryType'
);

SET @sql := IF(
  @has_shortfall = 1,
  'SELECT ''deliveryLedgerEntries.entryType already has SHORTFALL_ASSIGNED''',
  'ALTER TABLE `deliveryLedgerEntries` MODIFY COLUMN `entryType` ENUM(''COD_ASSIGNED'', ''COD_COLLECTED'', ''COD_REMITTED'', ''COD_RELEASED'', ''COD_WRITTEN_OFF'', ''COD_RECOVERED'', ''SHORTFALL_ASSIGNED'', ''FEE_EARNED'', ''FEE_PAID'', ''FEE_OFFSET'', ''FEE_REFUNDED'') NOT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٢) إضافة عمود `shortfallReason` إن لم يوجد
SET @add_reason := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db
        AND TABLE_NAME = 'deliveryLedgerEntries'
        AND COLUMN_NAME = 'shortfallReason'
    ),
    'SELECT ''shortfallReason already present''',
    'ALTER TABLE `deliveryLedgerEntries` ADD COLUMN `shortfallReason` VARCHAR(60) NULL'
  )
);
PREPARE stmt FROM @add_reason;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٣) فهرس بحث سريع على السبب (لتقرير «أسباب العجز الأكثر تكراراً»)
SET @has_reason_idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'deliveryLedgerEntries'
    AND INDEX_NAME = 'idx_delivery_ledger_shortfall_reason'
);

SET @add_reason_idx := IF(
  @has_reason_idx = 0,
  'CREATE INDEX `idx_delivery_ledger_shortfall_reason` ON `deliveryLedgerEntries` (`shortfallReason`)',
  'SELECT ''idx_delivery_ledger_shortfall_reason already exists'''
);
PREPARE stmt FROM @add_reason_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

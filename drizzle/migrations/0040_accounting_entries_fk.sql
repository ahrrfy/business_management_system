-- 0040 — F1 (تدقيق ٢/٧): مفتاحان أجنبيان مفقودان على accountingEntries
-- ===============================================================
-- accountingEntries.purchaseOrderId و accountingEntries.exchangeHouseId كانا بلا FOREIGN KEY.
--
-- **نسخة محصّنة بالكامل (٢/٧، بعد فشل نشر أوّل):** كل قسم يُنفَّذ فقط إن كان العمود المرجعيّ **والجدول**
-- المرجعيّ موجودَين فعلياً. على قاعدة إنتاجٍ منحرفة (مثلاً ميزة الصيرفة/0037 لم تكتمل هجرتها فعلياً
-- فعمود exchangeHouseId أو جدول exchangeHouses غائب رغم تسجيل 0037) يتخطّى القسم بأمان بدل تعطيل النشر.
-- على أي قاعدة سليمة (شامل مسار الإنتاج migrator 0000→0040) يضيف القيدين طبيعياً.
--
-- التقنية: SQL الحسّاس يُبنى كسلسلة داخل IF(جاهز، '<SQL>', 'SELECT 1') ثم PREPARE — فلا يُحلَّل مطلقاً
-- إلّا حين يكون المرجع موجوداً (لا خطأ «جدول/عمود غير موجود»). idempotent (فحص وجود القيد قبل الإضافة).
-- المسار: migrator (multipleStatements) — نمط 0037/0039.

-- ══════════════ purchaseOrderId — تصفير أيتام ══════════════
SET @po_ready = (
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND COLUMN_NAME = 'purchaseOrderId') > 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchaseOrders') > 0
);
SET @sql = IF(@po_ready,
  'UPDATE accountingEntries ae LEFT JOIN purchaseOrders po ON ae.purchaseOrderId = po.id SET ae.purchaseOrderId = NULL WHERE ae.purchaseOrderId IS NOT NULL AND po.id IS NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ══════════════ purchaseOrderId — إضافة القيد (إن لم يوجد) ══════════════
SET @po_ready = (
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND COLUMN_NAME = 'purchaseOrderId') > 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchaseOrders') > 0
);
SET @fk_po = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'accountingEntries_purchaseOrderId_purchaseOrders_id_fk');
SET @sql = IF(@po_ready AND @fk_po = 0,
  'ALTER TABLE accountingEntries ADD CONSTRAINT accountingEntries_purchaseOrderId_purchaseOrders_id_fk FOREIGN KEY (purchaseOrderId) REFERENCES purchaseOrders(id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ══════════════ exchangeHouseId — تصفير أيتام ══════════════
SET @ex_ready = (
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND COLUMN_NAME = 'exchangeHouseId') > 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchangeHouses') > 0
);
SET @sql = IF(@ex_ready,
  'UPDATE accountingEntries ae LEFT JOIN exchangeHouses x ON ae.exchangeHouseId = x.id SET ae.exchangeHouseId = NULL WHERE ae.exchangeHouseId IS NOT NULL AND x.id IS NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ══════════════ exchangeHouseId — إضافة القيد (إن لم يوجد) ══════════════
SET @ex_ready = (
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND COLUMN_NAME = 'exchangeHouseId') > 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchangeHouses') > 0
);
SET @fk_ex = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'accountingEntries_exchangeHouseId_exchangeHouses_id_fk');
SET @sql = IF(@ex_ready AND @fk_ex = 0,
  'ALTER TABLE accountingEntries ADD CONSTRAINT accountingEntries_exchangeHouseId_exchangeHouses_id_fk FOREIGN KEY (exchangeHouseId) REFERENCES exchangeHouses(id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

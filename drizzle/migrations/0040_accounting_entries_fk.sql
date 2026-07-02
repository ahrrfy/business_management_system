-- 0040 — F1 (تدقيق ٢/٧): مفتاحان أجنبيان مفقودان على accountingEntries
-- ===============================================================
-- accountingEntries.purchaseOrderId و accountingEntries.exchangeHouseId كانا بلا FOREIGN KEY
-- (تعليق المخطّط ادّعى «الـFK يُضاف في الهجرة» ولم يُضَف) ⇒ لا حارس تكامل مرجعيّ.
--
-- ذاتيّة الشفاء + idempotent (لكل عمود):
--   (١) تصفير أيّ أيتام أولاً (مرجعٌ لصفٍّ غير موجود = بيانات مكسورة أصلاً؛ قرار المالك الموثّق في
--       docs/audit-followups-2026-07-02.md §F1: صفّرها). يضمن ألّا يتعطّل النشر بفشل ADD CONSTRAINT.
--   (٢) إضافة القيد فقط إن لم يكن موجوداً (فحص information_schema) ⇒ آمن للتطبيق المتكرّر.
-- اسم القيد يطابق اصطلاح drizzle ({table}_{col}_{refTable}_id_fk) ليتّسق مع db:push (مسار CI).
-- المسار الإنتاجي: drizzle-orm migrator (multipleStatements:true). مسار CI: db:push من schema.ts.
--
-- ⚠️ تعديل (٢/٧ مساءً — بعد فشل النشر الإنتاجي عند UPDATE الأيتام): الـUPDATE بـLEFT JOIN
-- على جدول حيّ يكتب فيه الخادم القديم أثناء الهجرة قد يختار المُحسِّن مسحاً كاملاً (إحصاءات
-- باردة بعد ALTER السابق مباشرة) فيُقفل كل صفوف accountingEntries ويتصادم مع حركة التطبيق
-- (قفل/جمود). الحلّ: عدّ الأيتام أولاً بـSELECT خالص (قراءة متّسقة بلا أقفال صفوف)، وتنفيذ
-- الـUPDATE **فقط** إن وُجد أيتام فعلاً — على الإنتاج كلاهما صفر حتماً (exchangeHouseId عمود
-- وليد بالهجرة 0037 كله NULL، وأوامر الشراء لا تُحذف حذفاً صلباً) ⇒ تخطٍّ فوري بلا أي قفل.

-- ══════════════ purchaseOrderId ══════════════

SET @orphans_po = (
  SELECT COUNT(*) FROM accountingEntries ae
  LEFT JOIN purchaseOrders po ON ae.purchaseOrderId = po.id
  WHERE ae.purchaseOrderId IS NOT NULL AND po.id IS NULL
);
SET @sql = IF(@orphans_po > 0,
  'UPDATE accountingEntries ae LEFT JOIN purchaseOrders po ON ae.purchaseOrderId = po.id SET ae.purchaseOrderId = NULL WHERE ae.purchaseOrderId IS NOT NULL AND po.id IS NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_po_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND CONSTRAINT_NAME = 'accountingEntries_purchaseOrderId_purchaseOrders_id_fk'
);
SET @sql = IF(@fk_po_exists = 0,
  'ALTER TABLE accountingEntries ADD CONSTRAINT accountingEntries_purchaseOrderId_purchaseOrders_id_fk FOREIGN KEY (purchaseOrderId) REFERENCES purchaseOrders(id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ══════════════ exchangeHouseId ══════════════

SET @orphans_ex = (
  SELECT COUNT(*) FROM accountingEntries ae
  LEFT JOIN exchangeHouses x ON ae.exchangeHouseId = x.id
  WHERE ae.exchangeHouseId IS NOT NULL AND x.id IS NULL
);
SET @sql = IF(@orphans_ex > 0,
  'UPDATE accountingEntries ae LEFT JOIN exchangeHouses x ON ae.exchangeHouseId = x.id SET ae.exchangeHouseId = NULL WHERE ae.exchangeHouseId IS NOT NULL AND x.id IS NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_ex_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND CONSTRAINT_NAME = 'accountingEntries_exchangeHouseId_exchangeHouses_id_fk'
);
SET @sql = IF(@fk_ex_exists = 0,
  'ALTER TABLE accountingEntries ADD CONSTRAINT accountingEntries_exchangeHouseId_exchangeHouses_id_fk FOREIGN KEY (exchangeHouseId) REFERENCES exchangeHouses(id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

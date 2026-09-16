-- ═══ إسقاطُ قيود maker-checker على ثلاثة جداول حوكمة مشتريات — توسيعُ قرار المالك (٤/٩/٢٦) ═══
--
-- القرار: توسيع «لا اعتماد ثانٍ بعد المالك» (الهجرة 0333، PR #962) ليشمل ثلاثةً من
-- أربعة مسارات حوكمة مشترياتٍ كانت مستثناة عمداً من الحملة الأولى: التماس الشراء
-- الداخليّ (purchase/requisitions.ts)، عكس استلام البضاعة (purchase/goodsReceipts.ts)،
-- واعتماد/عكس فاتورة المورّد (purchase/supplierInvoices.ts). طبقةُ التطبيق
-- (assertApprover/resolveApprovalActor) عُدِّلت في نفس الشريحة لتسمح للمالك النشط
-- باعتماد طلبه الخاص؛ هذه الهجرة تُسقط القيد المقابل على مستوى القاعدة الذي كان سيرفضه
-- بخطأ MySQL خامّ رغم سماح طبقة التطبيق (نفس التناقض الذي عالجته 0333).
--
-- ⛔ الرابع (purchaseOrderControlRequests / chk_po_control_maker_checker،
-- purchase/controls.ts) مؤجَّلٌ عمداً — كان الملف مُدَّعًى بجلسةٍ متزامنة أخرى وقت هذه
-- الشريحة (coord)؛ سيُغلَق بشريحةٍ لاحقة تحمل تعديل طبقة التطبيق والقيد معاً، على نمط
-- هذه الهجرة نفسها.
--
-- كلُّ قيدٍ يُسقَط بحراسة idempotent (information_schema) كي تُعاد الهجرةُ بأمان إن
-- طُبِّقت جزئياً.

SET @has_c1 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'purchaseRequisitionControlRequests'
    AND constraint_name = 'chk_purchase_req_control_maker_checker'
);
SET @sql := IF(@has_c1 > 0,
  'ALTER TABLE `purchaseRequisitionControlRequests` DROP CHECK `chk_purchase_req_control_maker_checker`',
  'SELECT ''chk_purchase_req_control_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c2 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'goodsReceiptReversalRequests'
    AND constraint_name = 'chk_grn_reversal_request_maker_checker'
);
SET @sql := IF(@has_c2 > 0,
  'ALTER TABLE `goodsReceiptReversalRequests` DROP CHECK `chk_grn_reversal_request_maker_checker`',
  'SELECT ''chk_grn_reversal_request_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c3 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'supplierInvoiceApprovalRequests'
    AND constraint_name = 'chk_supplier_invoice_approval_maker_checker'
);
SET @sql := IF(@has_c3 > 0,
  'ALTER TABLE `supplierInvoiceApprovalRequests` DROP CHECK `chk_supplier_invoice_approval_maker_checker`',
  'SELECT ''chk_supplier_invoice_approval_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ═══ إسقاطُ قيود maker-checker على ستّة جداول حوكمة — إتمامُ قرار المالك (٣/٩/٢٦) ═══
--
-- القرار (PR #962، مدموجٌ فعلاً): «لا اعتماد ثانٍ بعد المالك — مالكٌ نشطٌ يعتمد ما أنشأه
-- هو بنفسه». طُبِّق القرار في طبقة التطبيق (`assertApprover`/`resolveApprovalActor` في
-- server/services/approval/ownerGate.ts، ومسارات محلّية مماثلة) على عشرة مواضع — لكن ستّةً
-- من جداول تلك المواضع بقيت تحمل قيد CHECK على مستوى القاعدة يفرض `reviewedBy <> requestedBy`
-- (أو `approvedBy <> createdBy`) **بلا استثناء**، فيرفض المالكُ نفسه بخطأ MySQL خامّ حين
-- يعتمد طلبه الخاص فعلياً — رغم أنّ طبقة التطبيق تسمح له.
--
-- والقيدُ لا يمكن تضييقه بدل إسقاطه (كما فُعل بـ`chk_sales_control_maker_checker` في
-- الهجرة 0326 لاستثناء WITHDRAWN فقط): ذلك الاستثناء كان **بالحالة** (status)، أمّا هذا
-- فاستثناءٌ **بهويّة الفاعل** (isOwner) — وCHECK على جدولٍ واحد لا يقرأ جدول users. طبقةُ
-- التطبيق هي الحارس الوحيد الممكن هنا، وهي مفعَّلةٌ فعلاً؛ فالإسقاطُ يزيل تناقضاً بين
-- طبقتين لا حمايةً حقيقية.
--
-- الجداول الستّة: purchaseReturnRequests · purchaseReturnReversalRequests ·
-- supplierPaymentRequests · supplierPaymentRefundRequests · purchaseChargeControlRequests ·
-- payrollRemittanceRequests. كلُّ قيدٍ يُسقَط بحراسة idempotent (information_schema) كي
-- تُعاد الهجرةُ بأمان إن طُبِّقت جزئياً.

SET @has_c1 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'purchaseReturnRequests'
    AND constraint_name = 'chk_purchase_return_request_maker_checker'
);
SET @sql := IF(@has_c1 > 0,
  'ALTER TABLE `purchaseReturnRequests` DROP CHECK `chk_purchase_return_request_maker_checker`',
  'SELECT ''chk_purchase_return_request_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c2 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'purchaseReturnReversalRequests'
    AND constraint_name = 'chk_purchase_return_reversal_maker_checker'
);
SET @sql := IF(@has_c2 > 0,
  'ALTER TABLE `purchaseReturnReversalRequests` DROP CHECK `chk_purchase_return_reversal_maker_checker`',
  'SELECT ''chk_purchase_return_reversal_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c3 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'supplierPaymentRequests'
    AND constraint_name = 'chk_supplier_payment_request_maker_checker'
);
SET @sql := IF(@has_c3 > 0,
  'ALTER TABLE `supplierPaymentRequests` DROP CHECK `chk_supplier_payment_request_maker_checker`',
  'SELECT ''chk_supplier_payment_request_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c4 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'supplierPaymentRefundRequests'
    AND constraint_name = 'chk_supplier_payment_refund_maker_checker'
);
SET @sql := IF(@has_c4 > 0,
  'ALTER TABLE `supplierPaymentRefundRequests` DROP CHECK `chk_supplier_payment_refund_maker_checker`',
  'SELECT ''chk_supplier_payment_refund_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c5 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'purchaseChargeControlRequests'
    AND constraint_name = 'chk_purchase_charge_control_maker_checker'
);
SET @sql := IF(@has_c5 > 0,
  'ALTER TABLE `purchaseChargeControlRequests` DROP CHECK `chk_purchase_charge_control_maker_checker`',
  'SELECT ''chk_purchase_charge_control_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c6 := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'payrollRemittanceRequests'
    AND constraint_name = 'chk_payroll_remittance_maker_checker'
);
SET @sql := IF(@has_c6 > 0,
  'ALTER TABLE `payrollRemittanceRequests` DROP CHECK `chk_payroll_remittance_maker_checker`',
  'SELECT ''chk_payroll_remittance_maker_checker absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

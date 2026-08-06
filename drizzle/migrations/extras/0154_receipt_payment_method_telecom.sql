-- ش٥ (٦/٨) — قيمة enum جديدة على receipts.paymentMethod: `TELECOM` (رصيد زين).
--
-- لماذا هنا؟ `drizzle-kit push` **لا يوسّع enum قائماً** (يتجاهل تغيير قيم الـenum صامتاً).
-- الإنتاج يمرّ بهجرة 0154 عبر migrator فيحصل على القيمة، أمّا قاعدة الاختبار/CI فتُبنى
-- بـpush ⇒ تبقى بلا القيمة فيسقط كل قبض رصيد اتصال بخطأ بيانات. MODIFY COLUMN تُعيد
-- تعريف العمود كما هو مطلوب ⇒ idempotent بطبيعتها (بلا فحص مسبق). نمط 0150 حرفياً.
-- **تبقى آخر قائمة ci-apply-extra-migrations** (ترتيبٌ أقدم قد يُعاد كتابته فيمحو القيمة).

ALTER TABLE `receipts` MODIFY COLUMN `paymentMethod` ENUM(
  'CASH','CARD','CHECK','TRANSFER','WALLET','EXCHANGE','TELECOM'
) NOT NULL;--> statement-breakpoint
ALTER TABLE `workOrders` MODIFY COLUMN `woPaymentMethod` ENUM(
  'CASH','CARD','TRANSFER','WALLET','TELECOM'
) DEFAULT 'CASH';

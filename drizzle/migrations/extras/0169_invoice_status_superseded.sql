-- تصحيح الفاتورة (١٠/٨) — قيمة enum جديدة على invoices.invoiceStatus: `SUPERSEDED`.
--
-- لماذا هنا؟ `drizzle-kit push` **لا يوسّع enum قائماً** (يتجاهل تغيير قيم الـenum صامتاً).
-- الإنتاج يمرّ بهجرة 0168 عبر migrator فيحصل على القيمة، أمّا قاعدة الاختبار/CI فتُبنى بـpush ⇒
-- تبقى بلا القيمة فيسقط كل تصحيح فاتورة بخطأ بيانات. MODIFY COLUMN تُعيد تعريف العمود كما هو
-- مطلوب ⇒ idempotent بطبيعتها (بلا فحص مسبق). نمط 0150/0157 حرفياً.
-- **تبقى آخر قائمة ci-apply-extra-migrations** (ترتيبٌ أقدم قد يُعاد كتابته فيمحو القيمة).

ALTER TABLE `invoices` MODIFY COLUMN `invoiceStatus` ENUM(
  'PENDING','CONFIRMED','PAID','PARTIALLY_PAID','CANCELLED','RETURNED','SUPERSEDED'
) NOT NULL DEFAULT 'PENDING';

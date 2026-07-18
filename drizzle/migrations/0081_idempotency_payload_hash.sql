-- 0081: idempotency — hash الحمولة القانونيّ لكشف «نفس المفتاح بحمولةٍ مختلفة» (المخاطرة الجهازية #٥).
-- عمود إضافيّ nullable ⇒ الصفوف الحالية تبقى null (بلا فحص hash، توافقٌ خلفيّ). الكتابات الجديدة عبر
-- المسارات المُعتمِدة تملؤه، وcheckIdempotency يرمي CONFLICT عند اختلاف hash الحمولة لنفس المفتاح.
ALTER TABLE `idempotencyKeys` ADD COLUMN `payloadHash` varchar(64) NULL AFTER `refId`;

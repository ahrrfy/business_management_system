-- ش٥ متابعة المراجعة العدائية (٦/٨/٢٦) — فهرسا حارس رصيد زين (telecom.ts):
-- قراءات الحارس القافلة (FOR UPDATE) كانت بلا فهرسٍ خادم ⇒ فحص الكود الأحاديّ يقفل X كامل
-- نطاق TELECOM (نموّ غير محدود + تسلسل عمليات زين كلّها عبر الفروع)، وSUM السقف اليوميّ مثله.
-- الأول يحصر قفل الازدواج بسجلّات/فجوة الكود المعنيّ وحدها؛ الثاني يحصر قفل السقف اليوميّ
-- بسجلّات المستخدم نفسه لليوم الجاري (تسلسل المستخدم الواحد مقصودٌ ويبقى).
ALTER TABLE `receipts` ADD INDEX `idx_receipt_paymethod_ref` (`paymentMethod`,`referenceNumber`);--> statement-breakpoint
ALTER TABLE `receipts` ADD INDEX `idx_receipt_paymethod_user_date` (`paymentMethod`,`createdBy`,`createdAt`);

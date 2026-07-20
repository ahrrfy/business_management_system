-- idempotency لإنشاء المورّد — نظير 0051 للعميل تماماً: clientRequestId (UUID من نموذج الإضافة)
-- + قيد فريد يمنع صفاً ثانياً عند إعادة الإرسال (نقر مزدوج/إعادة محاولة شبكة/replay). NULL مسموح
-- ومتعدّد (المسارات القديمة والاستيراد والبذرة لا تمرّره) — نفس نمط uq_supplier_legacy.
ALTER TABLE `suppliers` ADD `clientRequestId` varchar(64);--> statement-breakpoint
ALTER TABLE `suppliers` ADD CONSTRAINT `uq_supplier_client_request` UNIQUE(`clientRequestId`);

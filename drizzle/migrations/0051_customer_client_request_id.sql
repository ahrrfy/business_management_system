-- dup-detect (٦/٧): idempotency لإنشاء العميل — clientRequestId (UUID من العميل) + قيد فريد
-- يمنع صفاً ثانياً عند إعادة الإرسال (نقر مزدوج/إعادة محاولة شبكة/replay). NULL مسموح
-- ومتعدّد (المسارات القديمة والاستيراد لا تمرّره) — نفس نمط uq_customer_legacy.
ALTER TABLE `customers` ADD `clientRequestId` varchar(64);--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `uq_customer_client_request` UNIQUE(`clientRequestId`);

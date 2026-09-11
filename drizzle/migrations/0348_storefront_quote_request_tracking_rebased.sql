-- رمز ضيف opaque لطلب العرض: رقم SRQ يبقى مرجعاً قابلاً للعرض فقط ولا يصبح صلاحية تتبع.
ALTER TABLE `storefrontQuoteRequests`
  ADD COLUMN `guestTrackingPublicId` char(32) NULL AFTER `clientRequestId`,
  ADD COLUMN `guestTrackingTokenHash` char(64) NULL AFTER `guestTrackingPublicId`,
  ADD COLUMN `guestTrackingExpiresAt` timestamp NULL AFTER `guestTrackingTokenHash`,
  ADD CONSTRAINT `uq_store_quote_request_guest_tracking_public_id` UNIQUE(`guestTrackingPublicId`),
  ADD CONSTRAINT `uq_store_quote_request_guest_tracking_hash` UNIQUE(`guestTrackingTokenHash`);

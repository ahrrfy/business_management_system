-- حجز مخزون طلب المتجر PENDING كان بلا نهاية: يستطيع طلب COD غير مؤكّد حبس ATP إلى الأبد.
-- نخزّن لقطة انتهاء ثابتة لكل طلب، ونرحّل القديم من تاريخ طلبه كي يصبح ATP صحيحاً فور النشر.
SET NAMES utf8mb4;
--> statement-breakpoint

ALTER TABLE `onlineOrders`
  ADD COLUMN `reservationExpiresAt` TIMESTAMP(3) NULL AFTER `orderDate`;
--> statement-breakpoint

UPDATE `onlineOrders`
SET `reservationExpiresAt` = DATE_ADD(`orderDate`, INTERVAL 24 HOUR)
WHERE `reservationExpiresAt` IS NULL;
--> statement-breakpoint

CREATE INDEX `idx_order_status_reservation_expiry`
  ON `onlineOrders` (`orderStatus`, `reservationExpiresAt`);

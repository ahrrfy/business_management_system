-- حجز مخزون طلب المتجر PENDING كان بلا نهاية: يستطيع طلب COD غير مؤكّد حبس ATP إلى الأبد.
-- نخزّن لقطة انتهاء ثابتة لكل طلب، ونرحّل القديم من تاريخ طلبه كي يصبح ATP صحيحاً فور النشر.
SET NAMES utf8mb4;
--> statement-breakpoint

-- قبل أن يظهر العمود الجديد لأي عامل، أغلق نافذة DDL على عقد الإصدار القديم وحده.
-- لا DROP هنا: 0208 هجرة تطبيق واحد، وإسقاط pre-guard قبل بديله يصنع الفجوة نفسها.
CREATE TRIGGER `trg_online_orders_expired_activation_pre_bu`
BEFORE UPDATE ON `onlineOrders`
FOR EACH ROW
BEGIN
  IF NEW.`orderStatus` IN ('CONFIRMED', 'PROCESSING')
    AND OLD.`orderStatus` NOT IN ('CONFIRMED', 'PROCESSING')
    AND DATE_ADD(OLD.`orderDate`, INTERVAL 24 HOUR) <= CURRENT_TIMESTAMP(3) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'expired online order reservation cannot be activated';
  END IF;
END;
--> statement-breakpoint

ALTER TABLE `onlineOrders`
  ADD COLUMN `reservationExpiresAt` TIMESTAMP(3) NULL AFTER `orderDate`;
--> statement-breakpoint

UPDATE `onlineOrders`
SET `reservationExpiresAt` = DATE_ADD(`orderDate`, INTERVAL 24 HOUR)
WHERE `reservationExpiresAt` IS NULL;
--> statement-breakpoint

ALTER TABLE `onlineOrders`
  MODIFY COLUMN `reservationExpiresAt` TIMESTAMP(3) NULL
    DEFAULT (DATE_ADD(`orderDate`, INTERVAL 24 HOUR));
--> statement-breakpoint

CREATE INDEX `idx_order_status_reservation_expiry`
  ON `onlineOrders` (`orderStatus`, `reservationExpiresAt`);
--> statement-breakpoint

-- pre-guard ما زال فعالاً هنا؛ لذلك إسقاط نسخة final متبقية من محاولة جزئية آمن.
DROP TRIGGER IF EXISTS `trg_online_orders_expired_activation_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_online_orders_expired_activation_bu`
BEFORE UPDATE ON `onlineOrders`
FOR EACH ROW
BEGIN
  IF NEW.`orderStatus` IN ('CONFIRMED', 'PROCESSING')
    AND OLD.`orderStatus` NOT IN ('CONFIRMED', 'PROCESSING')
    AND COALESCE(
      OLD.`reservationExpiresAt`,
      DATE_ADD(OLD.`orderDate`, INTERVAL 24 HOUR)
    ) <= CURRENT_TIMESTAMP(3) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'expired online order reservation cannot be activated';
  END IF;
END;
--> statement-breakpoint

-- لا يُسقط الحارس المؤقت إلا بعد نجاح إنشاء final ووجود الحارسين معاً.
DROP TRIGGER IF EXISTS `trg_online_orders_expired_activation_pre_bu`;

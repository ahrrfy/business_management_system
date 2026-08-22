-- إصلاح schema-push: Drizzle يمثل العمود والفهرس لكنه لا ينشئ triggers.
-- final قائم أثناء إعادة التطبيق؛ وعلى قاعدة طازجة لا تبدأ الخدمة قبل اكتمال هذا السكربت.
SET NAMES utf8mb4;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_online_orders_expired_activation_pre_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_online_orders_expired_activation_pre_bu`
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

-- لا لحظة بلا حارس بعد إنشاء pre: استبدل final تحته ثم أزل المؤقت أخيراً.
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

DROP TRIGGER IF EXISTS `trg_online_orders_expired_activation_pre_bu`;

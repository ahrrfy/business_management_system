-- حارس فترة النشر المختلط: عامل ما قبل 0208 لا يعرف انتهاء حجز طلب المتجر، وقد يعيد
-- تفعيل تخصيصٍ منتهٍ بتحديث الحالة مباشرةً. قاعدة البيانات هي seam المشترك بين الإصدارين.
SET NAMES utf8mb4;
--> statement-breakpoint

-- آمن عند إعادة التطبيق، ولا يتصادم مع أي trigger سابق على onlineOrders.
DROP TRIGGER IF EXISTS `trg_online_orders_expired_activation_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_online_orders_expired_activation_bu`
BEFORE UPDATE ON `onlineOrders`
FOR EACH ROW
BEGIN
  -- CONFIRMED وPROCESSING وحدهما تخصّصان ATP بعد مغادرة PENDING. لا نفحص انتقالاً
  -- داخل الحالة الفعالة كي لا تنتهي طلبات مؤكدة لاحقاً، ونستعمل OLD كي لا يستطيع
  -- تحديثٌ واحد تمديد اللقطة ثم التأكيد. حجب الإحياء من CANCELLED يغلق سباق العامل
  -- القديم مع sweeper، بينما يبقى PENDING المنتهي -> CANCELLED مسموحاً.
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

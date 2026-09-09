-- منفعة تسعير المتجر لا تُستنتج من جداول حيّة عند التجهيز: الأسعار والعروض قد تتغير بعد
-- قبول العميل للطلب. اللقطة تثبت مصدر التوفير الذي اختاره الخادم وتبقي الكوبون قابلاً
-- للتدقيق من دون السماح بتراكبه مع العرض أو الجملة.
ALTER TABLE `onlineOrders`
  ADD COLUMN `pricingBenefitType` enum('NONE','WHOLESALE','OFFER','COUPON') NOT NULL DEFAULT 'NONE' AFTER `couponDiscount`,
  ADD COLUMN `pricingBenefitLabel` varchar(160) NULL AFTER `pricingBenefitType`,
  ADD COLUMN `pricingBenefitDiscount` decimal(15,2) NOT NULL DEFAULT '0.00' AFTER `pricingBenefitLabel`;

-- ٥/٨ — أجرة التوصيل تمريرٌ لا إيراد + زبونٌ عابر مرجعيّ على الفاتورة/أمر الشغل.
--
-- الخلل المُعالَج: كانت أجرة التوصيل تُضمّ إلى workOrders.salePrice في شاشة الاستقبال، فتصير
-- إيراداً بهامش ١٠٠٪ وتدخل درج الكاشير، بينما أجرة المندوب الحقيقية رقمٌ آخر غير مربوط
-- (deliveryConsignments.deliveryFee) مسارُ صرفه الوحيد هو خصمها من التوريد — وهو مسارٌ يستحيل
-- بلوغه إذا دفع الزبون كامل المبلغ في الاستقبال (codAmount=0 ⇒ الإرسالية تُنشَأ DELIVERED فوراً).
-- النتيجة: الأجرة تُقيَّد نقداً في الدرج مرّةً ولا تخرج أبداً ⇒ الموظّف يسلّمها للمندوب ثم يعجز
-- عن إغلاق ورديته (enforceCashGovernance يرفض أيّ فرق).

-- أوامر الشغل القائمة أُنشئت وأجرتها **مضمومةٌ داخل salePrice** (السلوك القديم)، فلو صُنّفت
-- COURIER لحُصِّلت الأجرة ضمن COD ثم لم تُخصَم من التوريد ⇒ المندوب يورّد أجرته سهواً.
-- تصنيفها SHOP يُبقي سلوكها القديم حرفياً (تُخصَم من التوريد مصروفاً)، ثم يصير الافتراضي
-- COURIER للأوامر الجديدة التي لم تعُد أجرتها داخل salePrice. صفر أثرٍ رجعيّ على أمرٍ طائر.
ALTER TABLE `workOrders`
  ADD COLUMN `deliveryFeeCollection` ENUM('COURIER','COUNTER','SHOP') NOT NULL DEFAULT 'SHOP',
  ADD COLUMN `contactName` VARCHAR(255) NULL,
  ADD COLUMN `contactPhone` VARCHAR(32) NULL;
--> statement-breakpoint
ALTER TABLE `workOrders`
  ALTER COLUMN `deliveryFeeCollection` SET DEFAULT 'COURIER';
--> statement-breakpoint
ALTER TABLE `invoices`
  ADD COLUMN `contactName` VARCHAR(255) NULL,
  ADD COLUMN `contactPhone` VARCHAR(32) NULL;
--> statement-breakpoint
-- الإرساليات القائمة أُنشئت والأجرة مضمومة في codAmount (السلوك القديم) ثم تُخصَم من التوريد
-- كمصروف. أقرب تصنيفٍ صادق لها تاريخياً هو SHOP: الخصم من التوريد يبقى مصروفاً كما كان،
-- فلا ينقلب أثرٌ محاسبيّ بأثرٍ رجعيّ على إرساليةٍ مفتوحة قبل الترقية.
ALTER TABLE `deliveryConsignments`
  ADD COLUMN `consignmentFeeCollection` ENUM('COURIER','COUNTER','SHOP') NOT NULL DEFAULT 'SHOP',
  ADD COLUMN `feeSettledAt` TIMESTAMP NULL;
--> statement-breakpoint
ALTER TABLE `deliveryConsignments`
  ALTER COLUMN `consignmentFeeCollection` SET DEFAULT 'COURIER';
--> statement-breakpoint
ALTER TABLE `accountingEntries`
  MODIFY COLUMN `entryType` ENUM(
    'SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING',
    'INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN',
    'DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_FEE_HELD','DELIVERY_WRITEOFF',
    'EXCHANGE_DEPOSIT','EXCHANGE_WITHDRAW','EXCHANGE_FX_BUY','EXCHANGE_SETTLE','EXCHANGE_FEE',
    'EXCHANGE_FX_DIFF','GIFT_OUT','SHIFT_FLOAT_OUT','TREASURY_FUNDING',
    'DIGITAL_WALLET_DEPOSIT','DIGITAL_WALLET_WITHDRAWAL','DIGITAL_WALLET_CONSUMPTION',
    'DIGITAL_WALLET_REVERSAL','DIGITAL_WALLET_ADJUSTMENT','DIGITAL_WRITEOFF'
  ) NOT NULL;

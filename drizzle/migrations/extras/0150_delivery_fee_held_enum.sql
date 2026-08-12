-- ٥/٨ — قيمة enum جديدة على accountingEntries.entryType: `DELIVERY_FEE_HELD`.
--
-- لماذا هنا؟ `drizzle-kit push` **لا يوسّع enum قائماً** (يُنشئ الأعمدة الجديدة ويتجاهل تغيير
-- قِيَم الـenum صامتاً). الإنتاج يمرّ بهجرة 0149 عبر migrator فيحصل على القيمة، أمّا قاعدة
-- الاختبار/CI فتُبنى بـpush ⇒ تبقى بلا القيمة فيسقط كلّ إدراجٍ لقيد الأمانة بخطأ بيانات.
-- MODIFY COLUMN تُعيد تعريف العمود كما هو مطلوب ⇒ idempotent بطبيعتها (بلا فحصٍ مسبق).

ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` ENUM(
  'SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING',
  'INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN',
  'DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_FEE_HELD','DELIVERY_WRITEOFF',
  'EXCHANGE_DEPOSIT','EXCHANGE_WITHDRAW','EXCHANGE_FX_BUY','EXCHANGE_SETTLE','EXCHANGE_FEE',
  'EXCHANGE_FX_DIFF','GIFT_OUT','SHIFT_FLOAT_OUT','TREASURY_FUNDING',
  'DIGITAL_WALLET_DEPOSIT','DIGITAL_WALLET_WITHDRAWAL','DIGITAL_WALLET_CONSUMPTION',
  'DIGITAL_WALLET_REVERSAL','DIGITAL_WALLET_ADJUSTMENT','DIGITAL_WRITEOFF'
) NOT NULL;

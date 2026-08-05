-- تمييز «التوصيل المجّاني» عن «بلا توصيل» على الفاتورة (قرار المالك ٥/٨/٢٦).
--
-- قبلها: كلتا الحالتين `deliveryFee = 0` فلا تُفرَّقان — فلا الفاتورة تُظهر للزبون أنّك
-- تنازلتَ له عن الأجرة، ولا التقارير تعرف كم توصيلاً أُهدي. الصفر يُقرأ «لا توصيل».
--
-- بعدها ثلاث حالات صريحة:
--   بلا توصيل      : deliveryFree = 0 و deliveryFee = 0        ⇒ لا سطر توصيل إطلاقاً
--   توصيل مدفوع    : deliveryFee > 0                            ⇒ «أجرة التوصيل: X»
--   توصيل مجّاني    : deliveryFree = 1 و deliveryWaivedAmount=X  ⇒ «التوصيل: مجاناً — قيمته X»
--
-- `deliveryWaivedAmount` = القيمة المُتنازَل عنها (شفافية: يراها الزبون وتُحصى في التقارير).
-- **لا أثر ماليّ**: لا إيراد ولا قيد — الإيراد يبقى `deliveryFee` وحده (صفرٌ هنا)، وهذان
-- العمودان إفصاحٌ لا محاسبة. صفر أثر رجعيّ: كل الفواتير التاريخية 0/0 ⇒ تُقرأ «بلا توصيل»
-- كما كانت تماماً.
ALTER TABLE `invoices` ADD COLUMN `deliveryFree` BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `deliveryWaivedAmount` DECIMAL(15,2) NOT NULL DEFAULT '0.00';

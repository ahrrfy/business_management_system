-- ①ج استمرارية نقد الورديات: مطابقة الرصيد الافتتاحيّ للوردية بالمتبقّي فعلياً في الدرج بعد إغلاق
-- آخر وردية مغلقة لنفس (الفرع×النوع) — المتبقّي = المعدود − المُسلَّم للخزينة. عند اختلاف المُدخَل عن
-- المتوقَّع: تحذيرٌ + سببٌ إلزاميّ يُسجَّل تدقيقياً (لا حظر — قد يبدأ الكاشير برصيدٍ مختلفٍ مشروعاً:
-- إيداع/سحب من الخزينة). الأعمدة كلّها nullable ⇒ صفر أثر رجعيّ على الورديات القائمة (المفتوحة
-- والتاريخية تُعامَل معاملة «أوّل وردية»: لا مطابقة ولا تحذير).
-- ⚠️ MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS — الإضافة صريحة (نمط 0102).
ALTER TABLE `shifts` ADD `closingDrawerCash` decimal(15,2);--> statement-breakpoint
ALTER TABLE `shifts` ADD `openingExpectedCash` decimal(15,2);--> statement-breakpoint
ALTER TABLE `shifts` ADD `openingDiscrepancyReason` varchar(500);

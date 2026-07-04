-- 0046 (٤/٧/٢٦): إضافة عمود `promisedDate` لـ`arReminders` — تتبّع وعد الدفع.
-- عمود nullable ⇒ آمن للتطبيق على جداول موجودة (السطور القائمة تبقى promisedDate=NULL).
-- الحماية من إعادة التطبيق عبر drizzle journal (لا حاجة لـIF NOT EXISTS الذي لا يدعمه MySQL 5.7).

ALTER TABLE `arReminders` ADD COLUMN `promisedDate` date;

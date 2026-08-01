-- 0139 — جدول الدوام الأسبوعيّ (ساعات لكل يوم) بدل «أيام راحة + ساعة واحدة»
--
-- سبب التغيير (قرار المالك ٣١/٧): «ونحن الجمعة لدينا دوام لساعات نحن نحدّدها».
-- نموذج 0138 (`restDays` + `dailyHours`) يعرف حالتين فقط: يومَ دوامٍ كامل أو راحةً تامّة —
-- ولا يستطيع تمثيل يومٍ بساعاتٍ أقلّ. الجدول الأسبوعيّ يوحّد المفهومين:
--
--   {"الأحد":8,"الاثنين":8,"الثلاثاء":8,"الأربعاء":8,"الخميس":8,"الجمعة":4,"السبت":0}
--
-- **صفر ساعة = يوم راحة**، فلا حاجة لقائمة راحةٍ منفصلة. ومنه يُشتقّ مقام سعر الساعة
-- (مجموع ساعات أيام الشهر) فيصير أدقّ: الجمعة تُسهم بأربع ساعات لا بثمانٍ ولا بصفر.
--
-- **إسقاط أعمدة 0138 آمن**: مُتحقَّقٌ على الإنتاج قبل الكتابة أن أياً منها لم يُستعمل قط
-- (صفر موظف له `restDays` أو `dailyHours`، وصفّ الإعدادات المفرد لم يُنشأ أصلاً) ⇒ لا بيانات تُفقد.

ALTER TABLE `employees` ADD COLUMN `workSchedule` json;
--> statement-breakpoint
ALTER TABLE `employees` DROP COLUMN `restDays`;
--> statement-breakpoint
ALTER TABLE `employees` DROP COLUMN `dailyHours`;
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` ADD COLUMN `defaultWorkSchedule` json;
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` DROP COLUMN `standardDailyHours`;
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` DROP COLUMN `defaultRestDays`;

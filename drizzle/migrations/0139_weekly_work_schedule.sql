-- 0139 — جدول الدوام الأسبوعيّ (ساعات لكل يوم) بدل «أيام راحة + ساعة واحدة»
--
-- سبب التغيير (قرار المالك ٣١/٧): «ونحن الجمعة لدينا دوام لساعات نحن نحدّدها».
-- نموذج 0138 (`restDays` + `dailyHours`) يعرف حالتين فقط: يومَ دوامٍ كامل أو راحةً تامّة —
-- ولا يستطيع تمثيل يومٍ بساعاتٍ أقلّ. الجدول الأسبوعيّ يوحّد المفهومين:
--
--   {"الأحد":{"hours":8,"rate":4500}, … ,"الجمعة":{"hours":4,"rate":6000},"السبت":{"hours":0}}
--
-- **صفر ساعة = يوم راحة**، فلا حاجة لقائمة راحةٍ منفصلة.
--
-- و`rate` **سعر ساعة ذلك اليوم — وهو أصل الحساب** (قرار المالك ٣١/٧): «سعر الساعة يختلف
-- من موظف لآخر، والمجموع التراكميّ لأيام الشهر هو الراتب المستحقّ، وليس الشرط الموجود في
-- حقل الراتب». تركُه فارغاً يشتقّه من (الراتب ÷ ساعات الشهر) فيبقى المسار القديم متاحاً.
-- والساعات فوق المقرَّر اليوميّ تُحتسب **أوفر تايم** ببندٍ مستقلّ لا تتضخّم به الأجرة الأساس.
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
--> statement-breakpoint
-- حارس المعقولية: سقف ساعات اليوم الواحد (قرار المالك: لا ٢٠ ولا ١٨ ولا ١٦ ساعة عمل).
ALTER TABLE `hrAttendanceSettings` ADD COLUMN `maxDailyHours` decimal(5,2) NOT NULL DEFAULT '12.00';

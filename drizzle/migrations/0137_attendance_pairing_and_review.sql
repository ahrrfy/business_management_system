-- 0137 — احتساب ساعات الحضور بمزاوجة البصمات + وسم اليوم الناقص + إعداد الوردية الليلية
--
-- (١) needsReview/reviewReason: يومٌ بعدد بصمات فرديّ (نُسيت بصمة الخروج) كان يُسجَّل
--     «حاضر» بصفر ساعات وصفر أجر بصمتٍ فلا ينتبه أحد حتى يوم الراتب. الآن يُوسَم
--     ليصحّحه المدير يدوياً قبل إغلاق الشهر — لا أجر يُدفع على تخمين.
--
-- (٢) hrAttendanceSettings: الوردية الليلية العابرة منتصف الليل نادرة (قرار مالك)
--     ⇒ معطَّلة افتراضياً. تفعيلها يجعل بصمة الفجر (قبل ساعة الفصل) تُغلق وردية أمس
--     بدل أن تفتح يوماً جديداً بصفر ساعات ويضيع أجر ليلةٍ كاملة.
--
-- ملاحظة: احتساب الساعات نفسه صار (مجموع فترات دخول←خروج) بدل (آخر − أول) فتُطرح
-- الاستراحات — تغيير منطق في الكود لا في المخطّط، ولا يمسّ صفوفاً محسوبة سابقاً.

ALTER TABLE `attendance` ADD COLUMN `needsReview` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `attendance` ADD COLUMN `reviewReason` varchar(120);
--> statement-breakpoint
CREATE INDEX `idx_att_review` ON `attendance` (`needsReview`,`attendanceDate`);
--> statement-breakpoint
CREATE TABLE `hrAttendanceSettings` (
	`id` int NOT NULL DEFAULT 1,
	`nightShiftEnabled` boolean NOT NULL DEFAULT false,
	`nightShiftCutoffHour` int NOT NULL DEFAULT 8,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `hrAttendanceSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` ADD CONSTRAINT `hrAttendanceSettings_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`);

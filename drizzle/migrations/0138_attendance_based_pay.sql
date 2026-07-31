-- 0138 — الأجر بالحضور (قرار المالك ٣١/٧/٢٠٢٦)
--
-- «الموظف الذي يحضر هو الذي له احتساب راتب، والذي غاب يوماً فلا راتب له في هذا الغياب»،
-- والاحتساب **بالساعات**:
--     سعر ساعة الشهريّ = راتبه ÷ ساعات دوامه في الشهر
--     أجرُه            = ساعات حضوره الفعلية × ذلك السعر
-- وساعات الدوام = (أيام الشهر عدا أيام راحته) × ساعات دوامه اليومية.
--
-- (١) employees.restDays / dailyHours: أيام الراحة **تختلف بين الموظفين** (قرار مالك)
--     ⇒ لكلٍّ جدولُه. بدونها كان التفعيل يخصم أربعة أيام شهرياً من الجميع (الجُمَع).
--     NULL = يرث الافتراضي العامّ أدناه.
--
-- (٢) attendancePayEnabled/From: **معطَّل افتراضياً** ويلزمه تاريخ سريان صريح — قبل
--     تشغيل جهاز الحضور لا توجد بيانات أصلاً، فتفعيلٌ بأثرٍ رجعيّ يُظهر الجميع غائبين
--     ويُصفّر رواتب أشهرٍ ماضية. ما قبل التاريخ يُعامَل يوم دوامٍ مدفوعاً كاملاً.
--
-- صفر أثر على المسيّرات القائمة: بلا تفعيل يبقى الحساب الحاليّ حرفياً.

ALTER TABLE `employees` ADD COLUMN `restDays` json;
--> statement-breakpoint
ALTER TABLE `employees` ADD COLUMN `dailyHours` decimal(5,2);
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` ADD COLUMN `attendancePayEnabled` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` ADD COLUMN `attendancePayFrom` date;
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` ADD COLUMN `standardDailyHours` decimal(5,2) NOT NULL DEFAULT '8.00';
--> statement-breakpoint
ALTER TABLE `hrAttendanceSettings` ADD COLUMN `defaultRestDays` json;

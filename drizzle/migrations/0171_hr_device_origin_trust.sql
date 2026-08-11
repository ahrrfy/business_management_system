-- «العنوان يُتعلَّم لا يُكتَب» — رصد محاولات اتصال أجهزة الحضور من مصادر غير موثوقة.
--
-- سبب الوجود (عطل ١١/٨/٢٦): مزوّد الإنترنت يغيّر عنوان المتجر العامّ دورياً، فتصدّ بوّابتا
-- الأمان جهازَ البصمة **بصمت** ساعاتٍ طويلة؛ ولأنّ العنوان الموثوق مكتوبٌ يدوياً في مكانين
-- بلا شاشة (‎.env + عمود ip) كان التعافي يتطلّب SSH وتعديلاً يدوياً على الإنتاج.
--
-- هذا الجدول يحوّل المحاولة المرفوضة من سطرِ سجلٍّ يُدفن إلى واقعةٍ مرئية قابلة للحسم:
-- تُعتمَد **تلقائياً** متى عزّزتها جلسةُ موظّفٍ مُصادَقٍ من العنوان نفسه (نفس حدّ الثقة —
-- شبكة المتجر — لكن مُحدَّثاً بدل أن يتعفّن)، وإلّا ظهرت في الشاشة لاعتمادٍ بنقرة.
--
-- القيد الفريد (serialNumber, ip): صفٌّ واحد لكلّ مصدر مهما تكرّرت المحاولات — الجهاز يقرع
-- كلّ ~٢٠٠م.ث عند الرفض (رصدنا ٤٧٢٤ محاولة في ساعات)، فلولاه لأُغرق الجدول.
CREATE TABLE `hrDeviceOriginAttempts` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `deviceId` bigint,
  `serialNumber` varchar(64) NOT NULL,
  `ip` varchar(64) NOT NULL,
  `decision` varchar(32) NOT NULL,
  `attemptCount` int NOT NULL DEFAULT 1,
  `firstSeenAt` timestamp NOT NULL DEFAULT (now()),
  `lastSeenAt` timestamp NOT NULL DEFAULT (now()),
  `resolvedAt` timestamp NULL,
  `resolution` varchar(16),
  `resolvedBy` int,
  CONSTRAINT `hrDeviceOriginAttempts_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_hr_origin_sn_ip` UNIQUE(`serialNumber`,`ip`),
  CONSTRAINT `fk_hr_origin_device`
    FOREIGN KEY (`deviceId`) REFERENCES `hrFingerprintDevices`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_hr_origin_user`
    FOREIGN KEY (`resolvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_hr_origin_pending` ON `hrDeviceOriginAttempts` (`resolvedAt`,`lastSeenAt`);

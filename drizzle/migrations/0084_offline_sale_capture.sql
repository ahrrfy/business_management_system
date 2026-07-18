-- 0084: التقاط البيع الأوفلايني (الشريحة ٣ من خطة العمل ثنائي الاتجاه).
-- originatedOffline: وسم فاتورة التُقطت على جهاز الكاشير أثناء انقطاع الاتصال وأُعيد تشغيلها
--   عبر offline.replaySale (تقرير «المبيعات الأوفلاين» + وسم تجاوز المخزون بالسالب).
-- offlineReceiptNumber: الرقم المؤقّت OFF-... المطبوع على الإيصال الحراري وقت الالتقاط —
--   يبقى قابلاً للبحث بورقة الزبون (مرتجعات/استفسار) بعد إصدار الرقم الرسمي INV.
-- capturedAt: لحظة البيع الحقيقية على الجهاز (قيود الدفتر تبقى بوقت الخادم — سلامة قفل الفترة).
ALTER TABLE `invoices` ADD COLUMN `originatedOffline` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `offlineReceiptNumber` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `capturedAt` timestamp NULL;
--> statement-breakpoint
CREATE INDEX `idx_invoice_offline_receipt` ON `invoices` (`offlineReceiptNumber`);

-- SOD-01/02 (تدقيق ٢٠/٦/٢٦): فصل المهام في الرواتب — تسجيل مُعتمِد/دافع المسيّر.
-- مُصغَّر يدوياً: أداة التوليد أعادت إنشاء جداول قائمة (انجراف لقطات meta عن SQL)؛
-- الجداول/الفهارس الأخرى موجودة أصلاً في أي قاعدة مُهاجَرة (0012–0014)، فنُبقي عمودَينا فقط.
ALTER TABLE `payrollRuns` ADD `approvedBy` int;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD `paidBy` int;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_paidBy_users_id_fk` FOREIGN KEY (`paidBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- HR-PAY-01 (سباق الدفع المزدوج): نموذج «مسيّر واحد شهريّاً لكل الشركة» ⇒ التفرّد بالشهر وحده.
-- كان (period,branchId) يُتيح مسيّراً لكل فرع بينما التوليد يُحمّل كل الموظّفين ⇒ دفع مزدوج.
-- ⚠️ يتطلّب عدم وجود مسيّرَين لنفس الشهر مسبقاً (نظّف أي تكرار قبل التطبيق على قاعدة قائمة).
ALTER TABLE `payrollRuns` DROP INDEX `uq_payroll_period_branch`;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `uq_payroll_period` UNIQUE(`period`);

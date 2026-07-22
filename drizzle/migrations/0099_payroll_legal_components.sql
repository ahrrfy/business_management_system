-- المكوّنات القانونية العراقية للرواتب (0098، البند ④): إعدادات مفردة (singleton id=1، نمط taxSettings)
-- + أعمدة لقطة على payrollItems/payrollRuns. ثلاثة مكوّنات كلٌّ بمفتاح تفعيل مستقلّ **معطَّل افتراضياً**:
-- ضمان اجتماعي (حصّتا موظف/رب عمل + وعاء) + ضريبة دخل مستقطعة (شرائح تصاعدية + إعفاء) + مكافأة نهاية خدمة.
-- ⚠️ النِّسب/الشرائح يضبطها المالك مع محاسبه القانونيّ (القيم هنا صفر/توضيحية). ما لم يُفعَّل مكوّن ⇒ صفر أثر
-- على الرواتب (net/deductions كما هي). كل أعمدة اللقطة DEFAULT '0' ⇒ صفر انحدار على المسيّرات القائمة.
CREATE TABLE `payrollLegalSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`socialSecurityEnabled` boolean NOT NULL DEFAULT false,
	`socialSecurityEmployeeRate` decimal(5,2) NOT NULL DEFAULT '0',
	`socialSecurityEmployerRate` decimal(5,2) NOT NULL DEFAULT '0',
	`socialSecurityBase` enum('basic','gross') NOT NULL DEFAULT 'basic',
	`incomeTaxEnabled` boolean NOT NULL DEFAULT false,
	`incomeTaxBrackets` json,
	`incomeTaxExemption` decimal(15,2) NOT NULL DEFAULT '0',
	`endOfServiceEnabled` boolean NOT NULL DEFAULT false,
	`endOfServiceDaysPerYear` decimal(6,2) NOT NULL DEFAULT '0',
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payrollLegalSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `payrollLegalSettings` ADD CONSTRAINT `fk_payroll_legal_updated_by` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `payrollItems` ADD `socialSecurityEmployee` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollItems` ADD `incomeTax` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollItems` ADD `socialSecurityEmployer` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollItems` ADD `endOfServiceAccrual` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD `totalSocialSecurityEmployee` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD `totalIncomeTax` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD `totalSocialSecurityEmployer` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD `totalEndOfServiceAccrual` decimal(15,2) DEFAULT '0' NOT NULL;

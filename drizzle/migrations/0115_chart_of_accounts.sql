-- شجرة الحسابات (Chart of Accounts) — أساس الدفتر المزدوج (P0، قرار المالك ٢٧/٧). جدولٌ **إضافيّ بحت**
-- عكسه DROP TABLE — صفر أثر على أيّ دفترٍ/رصيدٍ قائم. كل حساب يحمل `systemRole` يربطه بالمفهوم القائم في
-- النظام (ذمم العملاء↔customers، المخزون↔branchStock، المبيعات↔إيراد قيود البيع…) — أساس محرّك القيود (P1).
-- البذر داخل الهجرة (بيانات مرجعية) ⇒ يصل كلَّ قاعدة تُطبَّق عليها الهجرات (إنتاج/اختبار/تطوير) مرّةً واحدة.
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`code` varchar(20) NOT NULL,
	`name` varchar(120) NOT NULL,
	`type` enum('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE') NOT NULL,
	`parentId` bigint,
	`systemRole` varchar(40),
	`isActive` boolean NOT NULL DEFAULT true,
	`sortOrder` int NOT NULL DEFAULT 0,
	`notes` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_account_code` UNIQUE(`code`),
	CONSTRAINT `uq_account_system_role` UNIQUE(`systemRole`)
);
--> statement-breakpoint
CREATE INDEX `idx_account_type` ON `accounts` (`type`);
--> statement-breakpoint
INSERT INTO `accounts` (`id`,`code`,`name`,`type`,`parentId`,`systemRole`,`sortOrder`) VALUES
(1,'1000','الأصول','ASSET',NULL,NULL,10),
(2,'1100','الصندوق','ASSET',1,'CASH',11),
(3,'1150','البطاقة / البنك','ASSET',1,'CARD_BANK',12),
(4,'1200','المخزون','ASSET',1,'INVENTORY',13),
(5,'1300','ذمم العملاء (مدينون)','ASSET',1,'AR',14),
(6,'1400','سلف الموظفين','ASSET',1,'EMPLOYEE_ADVANCES',15),
(7,'1500','الأصول الثابتة','ASSET',1,'FIXED_ASSETS',16),
(8,'2000','الالتزامات','LIABILITY',NULL,NULL,20),
(9,'2100','ذمم الموردين (دائنون)','LIABILITY',8,'AP',21),
(10,'2200','ذمم مودِعي الأمانة','LIABILITY',8,'CONSIGNMENT_PAYABLE',22),
(11,'2300','رواتب مستحقة','LIABILITY',8,'ACCRUED_SALARY',23),
(12,'2900','التزامات أخرى','LIABILITY',8,'OTHER_LIABILITY',29),
(13,'3000','حقوق الملكية','EQUITY',NULL,NULL,30),
(14,'3100','رأس المال','EQUITY',13,'CAPITAL',31),
(15,'3200','الأرباح المحتجزة','EQUITY',13,'RETAINED_EARNINGS',32),
(16,'3900','رصيد افتتاحيّ','EQUITY',13,'OPENING_EQUITY',39),
(17,'4000','الإيرادات','REVENUE',NULL,NULL,40),
(18,'4100','مبيعات القرطاسية والكتب','REVENUE',17,'SALES_STATIONERY',41),
(19,'4200','إيرادات المطبعة الرقمية','REVENUE',17,'SALES_PRINT',42),
(20,'4300','إيرادات الفلكس / الطباعة العريضة','REVENUE',17,'SALES_FLEX',43),
(21,'4400','إيرادات التوصيل','REVENUE',17,'DELIVERY_REVENUE',44),
(22,'4500','عمولات الصيرفة','REVENUE',17,'EXCHANGE_COMMISSION',45),
(23,'4900','إيرادات أخرى','REVENUE',17,'OTHER_REVENUE',49),
(24,'5000','المصروفات','EXPENSE',NULL,NULL,50),
(25,'5100','تكلفة المبيعات','EXPENSE',24,'COGS',51),
(26,'5200','الرواتب والأجور','EXPENSE',24,'SALARIES',52),
(27,'5300','الإيجار','EXPENSE',24,'RENT',53),
(28,'5400','الكهرباء والخدمات','EXPENSE',24,'UTILITIES',54),
(29,'5500','مصروفات تشغيلية عامة','EXPENSE',24,'OPERATING_EXPENSE',55),
(30,'5600','خسائر (تالف / شحن غير مسترد / فروق)','EXPENSE',24,'LOSSES',56),
(31,'5900','مصروفات أخرى','EXPENSE',24,'OTHER_EXPENSE',59);

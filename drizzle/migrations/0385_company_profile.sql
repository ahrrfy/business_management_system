CREATE TABLE IF NOT EXISTS `companyProfile` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`tradeName` varchar(255),
	`shortName` varchar(100),
	`legalSubtitle` varchar(255),
	`commercialRegistry` varchar(100),
	`taxNumber` varchar(100),
	`chamberLicense` varchar(100),
	`address` text,
	`phones` json,
	`logoUrl` text,
	`footerText` text,
	`updatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `companyProfile_id` PRIMARY KEY(`id`),
	CONSTRAINT `companyProfile_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
INSERT IGNORE INTO `companyProfile` (
	`id`,
	`name`,
	`tradeName`,
	`shortName`,
	`legalSubtitle`,
	`commercialRegistry`,
	`taxNumber`,
	`chamberLicense`,
	`address`,
	`phones`,
	`footerText`
) VALUES (
	1,
	'الرؤية العربية للتجارة العامة',
	'المكتبة العربية للطباعة والقرطاسية',
	'الرؤية العربية',
	'مطبعة ومكتبة وقرطاسية وتجهيزات مكتبية متكاملة',
	'412093',
	'900123456',
	'غ-7821',
	'العراق — بغداد — شارع المتنبي / فرع الكرادة',
	'[{"label":"المبيعات والطلبات","number":"+9647701234567"},{"label":"الحسابات والإدارة","number":"+9647801234567"},{"label":"المطبعة والإنتاج","number":"+9647501234567"}]',
	'الرؤية العربية للتجارة العامة — بغداد — هاتف: 07701234567'
);

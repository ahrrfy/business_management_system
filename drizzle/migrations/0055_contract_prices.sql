-- بند 12ب (٧/٧): التسعير التعاقدي — سعر خاص بعميل لوحدة منتج يتقدّم على فئات التسعير الثلاث
-- عند البيع لهذا العميل (عقود الدوائر الحكومية). فريد لكل (عميل × وحدة منتج).
CREATE TABLE `customerContractPrices` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`customerId` bigint NOT NULL,
	`productUnitId` bigint NOT NULL,
	`price` decimal(15,2) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`note` varchar(255),
	`createdBy` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customerContractPrices_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_contract_customer_unit` UNIQUE(`customerId`,`productUnitId`)
);--> statement-breakpoint
CREATE INDEX `idx_contract_customer` ON `customerContractPrices` (`customerId`);

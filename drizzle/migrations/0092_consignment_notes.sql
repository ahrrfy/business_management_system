-- بضاعة الأمانة — ش٢: سندات الإيداع/السحب/الاستبدال. راجع docs/consignment-design-2026-07-20.md §٧.
-- سند نهائيّ فور ترحيله (لا status ولا حذف)؛ التصحيح بسند معاكس. الاستبدال نوع ثالث بأسطر ذات اتجاه.
CREATE TABLE `consignmentNotes` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`noteNumber` varchar(32) NOT NULL,
	`noteType` enum('DEPOSIT','WITHDRAW','EXCHANGE') NOT NULL,
	`consignorId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`clientRequestId` varchar(64),
	`notes` text,
	`attachmentUrl` mediumtext,
	`createdBy` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `consignmentNotes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_consign_note_number` UNIQUE(`noteNumber`),
	CONSTRAINT `uq_consign_note_request` UNIQUE(`clientRequestId`)
);
--> statement-breakpoint
CREATE TABLE `consignmentNoteLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`noteId` bigint NOT NULL,
	`lineDirection` enum('IN','OUT') NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint NOT NULL,
	`quantity` decimal(15,3) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitShareSnapshot` decimal(15,2) NOT NULL DEFAULT '0',
	`notes` text,
	CONSTRAINT `consignmentNoteLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `consignmentNotes` ADD CONSTRAINT `consignmentNotes_consignorId_suppliers_id_fk` FOREIGN KEY (`consignorId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `consignmentNotes` ADD CONSTRAINT `consignmentNotes_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `consignmentNoteLines` ADD CONSTRAINT `consignmentNoteLines_noteId_consignmentNotes_id_fk` FOREIGN KEY (`noteId`) REFERENCES `consignmentNotes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `consignmentNoteLines` ADD CONSTRAINT `consignmentNoteLines_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_cn_consignor` ON `consignmentNotes` (`consignorId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_cn_branch` ON `consignmentNotes` (`branchId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_cnl_note` ON `consignmentNoteLines` (`noteId`);--> statement-breakpoint
CREATE INDEX `idx_cnl_variant` ON `consignmentNoteLines` (`variantId`);

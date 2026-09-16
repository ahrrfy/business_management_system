-- لقطة مكوّنات البكج على سطر التحويل: يبقى السطر بكجاً تشغيلياً واحداً، وتُحرَّك مكوّناته
-- الفعلية من اللقطة نفسها عند الإرسال والاستلام والإلغاء. تعديل الوصفة بعد الإرسال لا يغيّر
-- مستنداً بالطريق ولا يصنع انحراف مخزون صامتاً بين الفرعين.

CREATE TABLE `stockTransferLineBundleComponents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`transferLineId` bigint NOT NULL,
	`componentVariantId` bigint NOT NULL,
	`componentBaseQuantity` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stockTransferLineBundleComponents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stlbc_line_component` UNIQUE(`transferLineId`,`componentVariantId`),
	CONSTRAINT `chk_stlbc_qty` CHECK (`componentBaseQuantity` > 0),
	CONSTRAINT `fk_stlbc_line` FOREIGN KEY (`transferLineId`) REFERENCES `stockTransferLines`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_stlbc_component` FOREIGN KEY (`componentVariantId`) REFERENCES `productVariants`(`id`) ON DELETE restrict ON UPDATE no action,
	INDEX `idx_stlbc_component` (`componentVariantId`)
);

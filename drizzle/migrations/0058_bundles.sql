-- bundles (٧/٧/٢٦): المنتجات المركّبة (باندل/بكج) — منتج حقيقي بباركود وسعر مستقل،
-- لكن بلا رصيد مخزنيّ خاص به: التكلفة تُحسب لحظة البيع من مجموع تكاليف المكوّنات (WAVG الحيّ)،
-- والمخزون يُخصَم من كل مكوّن مباشرةً. النَست ممنوع خادمياً (مكوّن البكج لا يكون بكجاً).
-- الفكرة الأساسية:
--   * products.isBundle = مؤشّر «هذا منتج مركّب» — لا يُخزَّن له branchStock ولا يمرّ في applyMovement.
--   * bundleComponents = وصفة المكوّنات: كم وحدة أساس من المكوّن تدخل في كل وحدة أساس من البكج.
--   * قيد التفرّد على (bundle, component) يمنع تكرار الأسطر — الكميّة الأكبر تُدار برقم القاعدة نفسها.
--   * cascade على البكج (حذفه ⇒ حذف صفوف الوصفة)، restrict على المكوّن (منع حذف مكوّن مستعمَل حيّاً).
--   * CHECK(componentBaseQuantity > 0) قيد قاعدة دفاع في العمق (لا فقط تطبيقي في bundleService).

ALTER TABLE `products` ADD `isBundle` boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE INDEX `idx_product_is_bundle` ON `products` (`isBundle`);--> statement-breakpoint

CREATE TABLE `bundleComponents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`bundleVariantId` bigint NOT NULL,
	`componentVariantId` bigint NOT NULL,
	`componentBaseQuantity` int NOT NULL,
	`componentUnitId` bigint,
	`sortOrder` int NOT NULL DEFAULT 0,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bundleComponents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_bundle_component` UNIQUE(`bundleVariantId`,`componentVariantId`),
	CONSTRAINT `chk_bundle_component_qty` CHECK (`componentBaseQuantity` > 0)
);--> statement-breakpoint
CREATE INDEX `idx_bundle_component_bundle` ON `bundleComponents` (`bundleVariantId`);--> statement-breakpoint
CREATE INDEX `idx_bundle_component_child` ON `bundleComponents` (`componentVariantId`);--> statement-breakpoint
ALTER TABLE `bundleComponents` ADD CONSTRAINT `fk_bundle_component_bundle` FOREIGN KEY (`bundleVariantId`) REFERENCES `productVariants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bundleComponents` ADD CONSTRAINT `fk_bundle_component_child` FOREIGN KEY (`componentVariantId`) REFERENCES `productVariants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bundleComponents` ADD CONSTRAINT `fk_bundle_component_unit` FOREIGN KEY (`componentUnitId`) REFERENCES `productUnits`(`id`) ON DELETE set null ON UPDATE no action;

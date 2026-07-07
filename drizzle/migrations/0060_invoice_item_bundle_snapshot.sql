-- gstack B6 (٧/٧/٢٦): لقطة مكوّنات البكج لحظة البيع — يحرس المرتجع من انحراف الوصفة.
-- المشكلة: مرتجع البكج كان يستعمل `bundleComponents` الحاليّة؛ لو عُدّلت الوصفة بين البيع
-- والإرجاع (نمط شائع في السوق المتذبذب)، المرتجع يعيد مكوّنات مختلفة عن التي بيعت ⇒ انحراف
-- مخزون صامت (COGS مجمَّد لكن الرفوف تنحرف). الحلّ: نُخزّن نسخة من الوصفة على invoiceItem لحظة
-- إنشائه، ومسار المرتجع يقرأ منها بدل الوصفة الحيّة.
--
-- ذرّية: الإدراج يجري داخل نفس معاملة إنشاء الفاتورة (sale/create.ts) ⇒ لا لقطة بلا فاتورة.
-- FK cascade على invoiceItems (يذهب مع الفاتورة الملغاة/المحذوفة) + restrict على المكوّن
-- (المكوّن يجب أن يظل موجوداً ما دام هناك فاتورة تشير إليه — مرآة قيد bundleComponents).

CREATE TABLE `invoiceItemBundleComponents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceItemId` bigint NOT NULL,
	`componentVariantId` bigint NOT NULL,
	`componentBaseQuantity` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoiceItemBundleComponents_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_iibc_qty` CHECK (`componentBaseQuantity` > 0)
);--> statement-breakpoint
CREATE INDEX `idx_iibc_item` ON `invoiceItemBundleComponents` (`invoiceItemId`);--> statement-breakpoint
CREATE INDEX `idx_iibc_component` ON `invoiceItemBundleComponents` (`componentVariantId`);--> statement-breakpoint
ALTER TABLE `invoiceItemBundleComponents` ADD CONSTRAINT `fk_iibc_item` FOREIGN KEY (`invoiceItemId`) REFERENCES `invoiceItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceItemBundleComponents` ADD CONSTRAINT `fk_iibc_component` FOREIGN KEY (`componentVariantId`) REFERENCES `productVariants`(`id`) ON DELETE restrict ON UPDATE no action;

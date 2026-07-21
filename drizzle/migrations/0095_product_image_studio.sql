-- image-studio (شريحة ٠): تخزين صور المنتجات الهجين المعنون-بالمحتوى. أعمدة NULLable إضافية على
-- productImages؛ `url` يبقى بلا مسّ (توافق خلفيّ — القراءة المزدوجة objectKey?store:url في شريحة لاحقة).
-- reviewStatus/origin بقيمة افتراضية ⇒ كل الصور القائمة تبقى APPROVED/ORIGINAL (صفر تغيّر سلوكيّ).
-- راجع docs/product-image-studio-design-2026-07-21.md §١.
ALTER TABLE `productImages` ADD `objectKey` varchar(255);--> statement-breakpoint
ALTER TABLE `productImages` ADD `originalKey` varchar(255);--> statement-breakpoint
ALTER TABLE `productImages` ADD `contentHash` varchar(64);--> statement-breakpoint
ALTER TABLE `productImages` ADD `thumbDataUrl` mediumtext;--> statement-breakpoint
ALTER TABLE `productImages` ADD `mime` varchar(32);--> statement-breakpoint
ALTER TABLE `productImages` ADD `width` int;--> statement-breakpoint
ALTER TABLE `productImages` ADD `height` int;--> statement-breakpoint
ALTER TABLE `productImages` ADD `bytes` int;--> statement-breakpoint
ALTER TABLE `productImages` ADD `reviewStatus` enum('APPROVED','PENDING_REVIEW','REJECTED') NOT NULL DEFAULT 'APPROVED';--> statement-breakpoint
ALTER TABLE `productImages` ADD `origin` enum('ORIGINAL','STUDIO_FREE','STUDIO_PRO','MANUAL') NOT NULL DEFAULT 'ORIGINAL';--> statement-breakpoint
ALTER TABLE `productImages` ADD `migratedAt` timestamp;

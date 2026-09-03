-- ═══ recordVersions — اللقطة والاستعادة (م٦ ق٨ من برنامج v2، ٣/٩/٢٦) ═══
--
-- المبدأ الحاكم: **لا لقطة ⇒ لا تعديل**. كل تعديلٍ لكيانٍ مرجعيّ (منتج/عميل/مورّد/…)
-- يُنشئ صفَّ لقطةٍ داخل نفس المعاملة، يحمل الحمولةَ الكاملة قبل التعديل. الاستعادة =
-- تعديلٌ جديدٌ يحمل حمولةَ إصدارٍ قديمٍ، ويمرّ بكلّ حرّاس التعديل. لا كتابةٌ خامٌّ للجدول
-- الأصل — ولا محوٌ للتاريخ.
--
-- بلا FK جامدة على `entityId`/`actorUserId`/`branchId`: الجدول مرجعيٌّ متعدّد الأنواع
-- (entity polymorphic)، وحذف الطرف الأمّ رجعياً يجب ألّا يُقيّده سجلّ التاريخ. الفهارس
-- تكفي للاستعلامات الحاكمة (تاريخ كيان، أعمال فاعل).
--
-- ملاحظة على `db:push`: هذا الجدولُ جديدٌ بأعمدةٍ عادية ⇒ يبنيه `db:push` من `schema.ts`
-- مباشرةً، فلا يلزم تسجيلٌ في `ci-apply-extra-migrations.mjs` (السجلّ هناك للـGENERATED
-- والـCHECK القائم وتوسيع enum لا يمثّلها push موثوقاً).

CREATE TABLE `recordVersions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`entityType` varchar(50) NOT NULL,
	`entityId` bigint NOT NULL,
	`versionNumber` int NOT NULL,
	`payloadJson` json NOT NULL,
	`reason` varchar(500),
	`actorUserId` bigint NOT NULL,
	`branchId` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `recordVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_entity_version` UNIQUE(`entityType`,`entityId`,`versionNumber`)
);
--> statement-breakpoint

CREATE INDEX `idx_entity_history` ON `recordVersions` (`entityType`,`entityId`,`createdAt`);
--> statement-breakpoint

CREATE INDEX `idx_actor` ON `recordVersions` (`actorUserId`,`createdAt`);

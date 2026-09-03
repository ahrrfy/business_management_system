-- ═══ محرّك العكس الواحد — القانون ق٧ (٣/٩/٢٦) ═══
--
-- الجدول `documentEffects` ينسخ أثر أيّ مستندٍ (بيع/شراء/سند/أمر شغل/طلب متجر/…) الماليَّ في
-- **نفس المعاملة** الذي وقع فيها. صفٌّ لكلّ أثرٍ ذي معنى (حركة مخزون، قيد، رصيد عميل، عهدة
-- توصيل، مدفوع، عمولة، عربون، كوبون، هدية، قسط، بطاقة، أمانة، تقريب، أوفلاين). محرّك العكس
-- يقرأ صفوف APPLY لمستندٍ ثمّ يكتب صفوف REVERSE مقابلة، والثابت المحروس بذلك:
--
--   Σ signedAmount   لكل (documentType,documentId,effectKind) = 0
--   Σ signedQuantity لكل (documentType,documentId,effectKind) = 0
--
-- بعد الاكتمال. الجدول **مسار ظلّيّ لا مرجعُ حقيقة في هذه الشريحة**: التنفيذاتُ اليدوية
-- القائمة تبقى كما هي، والمحرّك يعمل بجانبها ويُسجَّل الفرق. ⇒ لا FK جامدة على الجداول
-- المُتأثّرة (effectTable/effectRowId مرجعية بلا قيدٍ ضامن) كي لا يُقيّد الحذف الرجعيّ
-- سجلَّ الأثر ولا يُبطل التزامنَ مع خدماتٍ لا تعرفه بعد.
--
-- إدخالٌ فقط (append-only بحكم عدم توفير مسار UPDATE في الخدمة). العكسُ يحمل
-- `reversalOfEffectId` مؤشّراً للصفّ المعكوس داخل الجدول نفسه، فيمكن ترتيبه ذرّياً وردياً
-- لكل بند APPLY (١↔١) — يحرسه اختبارٌ عشوائيٌّ ببذرةٍ ثابتة.
--
-- ملاحظة على `db:push`: هذا الجدولُ جديدٌ بأعمدةِ enum جديدةٍ ⇒ `db:push` يبنيها من
-- `schema.ts` مباشرةً، فلا يلزم تسجيلٌ في `ci-apply-extra-migrations.mjs` (السجلّ هناك
-- مخصَّصٌ لتوسيع enum قائم أو GENERATED/TRIGGER لا يُمثّلها push).

CREATE TABLE `documentEffects` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`documentType` varchar(40) NOT NULL,
	`documentId` bigint NOT NULL,
	`effectKind` enum(
		'INVENTORY',
		'LEDGER_ENTRY',
		'CUSTOMER_BALANCE',
		'SUPPLIER_BALANCE',
		'DELIVERY_CUSTODY',
		'PAID_AMOUNT',
		'COMMISSION',
		'DEPOSIT',
		'COUPON',
		'GIFT',
		'INSTALLMENT',
		'CARD',
		'CONSIGNMENT',
		'ROUNDING',
		'OFFLINE'
	) NOT NULL,
	`phase` enum('APPLY','REVERSE') NOT NULL,
	`effectTable` varchar(64),
	`effectRowId` bigint,
	`signedAmount` decimal(15,4) NOT NULL DEFAULT '0',
	`signedQuantity` int NOT NULL DEFAULT 0,
	`branchId` bigint,
	`actorUserId` int,
	`reversalOfEffectId` bigint,
	`reason` varchar(200),
	`scope` varchar(40),
	`payloadJson` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `documentEffects_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_document_effects_reversal_shape` CHECK (
		(`phase` = 'APPLY' AND `reversalOfEffectId` IS NULL)
		OR (`phase` = 'REVERSE' AND `reversalOfEffectId` IS NOT NULL)
	)
);
--> statement-breakpoint

CREATE INDEX `idx_document_effects_doc` ON `documentEffects` (`documentType`,`documentId`);
--> statement-breakpoint

CREATE INDEX `idx_document_effects_doc_kind` ON `documentEffects` (`documentType`,`documentId`,`effectKind`);
--> statement-breakpoint

CREATE INDEX `idx_document_effects_reversal_of` ON `documentEffects` (`reversalOfEffectId`);
--> statement-breakpoint

CREATE INDEX `idx_document_effects_created` ON `documentEffects` (`createdAt`);
--> statement-breakpoint

ALTER TABLE `documentEffects`
	ADD CONSTRAINT `fk_document_effects_reversal_of`
	FOREIGN KEY (`reversalOfEffectId`) REFERENCES `documentEffects`(`id`)
	ON DELETE RESTRICT ON UPDATE NO ACTION;

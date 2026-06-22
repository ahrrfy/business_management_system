-- 0022 (٢٢/٦/٢٦): مخطّط الخزينة الكامل (treasury-stage2) — كان مفقوداً منذ commit c10ab54.
-- شريحة الخزينة دُمجت لـmain (PR #20) بتعديلات schema.ts بلا توليد هجرة فعلية ⇒ الإنتاج
-- يُشغّل كود يَطلب أعمدة غير موجودة:
--   • shifts.countedBreakdown  ⇒ كل استعلام SELECT * على shifts (POS shifts.current، Z-report،
--     /treasury، /shifts، الـDashboard) يفشل بـER_BAD_FIELD_ERROR ⇒ 500 ⇒ على الواجهة:
--     «حدث خطأ غير متوقّع في النظام» (TRPC_CODE_AR.INTERNAL_SERVER_ERROR).
--   • cashTransfers  ⇒ كل مسار التحويلات + لوحة الخزينة + cashTransferService تفشل.
--   • CASH_HANDOVER / CASH_TRANSFER_OUT / CASH_TRANSFER_IN  ⇒ closeShift مع handover يفشل
--     بـER_DATA_TOO_LONG (قيمة ENUM غير معروفة) ⇒ تسليم الوردية للخزينة لا يَعمل.
--
-- مرجع: drizzle/schema.ts (بعد c10ab54) + سوابق 0002 (MODIFY enum) و 0010b (CREATE TABLE +
-- FK + INDEX) و 0018 (CHECK يدوي). الترتيب آمن: تَوسعة ENUM وإضافة عمود لا تُغلقان الجدول
-- (DDL سريعة في MySQL 8) قبل CREATE TABLE الجديد كي لا تَعتمد عليها كتابات لاحقة.
--
-- ⚠️ ملاحظة _journal/snapshot: ضمن هذه الـPR يُحدَّث _journal.json فقط (drizzle migrator
-- يَقرأ منه قائمة الهجرات). meta/0022_snapshot.json يُتوقَّع توليدُه آلياً عبر `pnpm db:generate`
-- محلياً قبل/بعد الدمج (سوف يَرى الـmigrator أنّ الـSQL مُطبَّق بالفعل ويُولّد snapshot فقط).
-- الـsnapshot ليس مطلوباً لتطبيق الهجرة — مطلوب فقط لاحقاً لـdb:verify كي يَكتشف الانحراف.

-- ── ١) shifts.countedBreakdown ─────────────────────────────────────────────────
-- snapshot لعدّاد فئات IQD وقت الإغلاق (تدقيق بحت بلا تأثير محاسبي).
-- nullable: ورديات تاريخية مغلقة قبل ٢١/٦ تَبقى صالحة بـNULL.
ALTER TABLE `shifts` ADD `countedBreakdown` json;--> statement-breakpoint

-- ── ٢) accountingEntries.entryType: توسعة بثلاث قيم لـcash movements ─────────
-- MODIFY COLUMN يَحفظ ترتيب القيم القديمة (آمن — التَخزين الداخلي بـordinal index، تَغيير
-- الترتيب يُفسد القيم الحالية). نُضيف الجديدة في النهاية. (سابقة: 0002 مع INTERNAL_USE/WASTAGE.)
ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN') NOT NULL;--> statement-breakpoint

-- ── ٣) جدول cashTransfers ─────────────────────────────────────────────────────
-- نقل نقد ذرّي من خزينة فرع إلى خزينة فرع آخر (cashBucket=TREASURY في الـreceipts).
-- transferNumber بنمط CT-{fromBranch}-YYYYMMDD-NNNNN (مُولَّد في cashTransferService).
CREATE TABLE `cashTransfers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`transferNumber` varchar(50) NOT NULL,
	`fromBranchId` bigint NOT NULL,
	`toBranchId` bigint NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`cashTransferStatus` enum('IN_TRANSIT','RECEIVED','CANCELLED') NOT NULL DEFAULT 'IN_TRANSIT',
	`sentBy` int NOT NULL,
	`receivedBy` int,
	`cancelledBy` int,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	`receivedAt` timestamp,
	`cancelledAt` timestamp,
	`sentReceiptId` bigint,
	`receivedReceiptId` bigint,
	`reversalReceiptId` bigint,
	`notes` text,
	`cancellationReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cashTransfers_id` PRIMARY KEY(`id`),
	CONSTRAINT `cashTransfers_transferNumber_unique` UNIQUE(`transferNumber`)
);
--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_fromBranchId_branches_id_fk` FOREIGN KEY (`fromBranchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_toBranchId_branches_id_fk` FOREIGN KEY (`toBranchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_sentBy_users_id_fk` FOREIGN KEY (`sentBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_receivedBy_users_id_fk` FOREIGN KEY (`receivedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_cancelledBy_users_id_fk` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_sentReceiptId_receipts_id_fk` FOREIGN KEY (`sentReceiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_receivedReceiptId_receipts_id_fk` FOREIGN KEY (`receivedReceiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashTransfers` ADD CONSTRAINT `cashTransfers_reversalReceiptId_receipts_id_fk` FOREIGN KEY (`reversalReceiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_xfer_from` ON `cashTransfers` (`fromBranchId`,`cashTransferStatus`);--> statement-breakpoint
CREATE INDEX `idx_xfer_to` ON `cashTransfers` (`toBranchId`,`cashTransferStatus`);--> statement-breakpoint
CREATE INDEX `idx_xfer_status` ON `cashTransfers` (`cashTransferStatus`);--> statement-breakpoint
CREATE INDEX `idx_xfer_sent_at` ON `cashTransfers` (`sentAt`);--> statement-breakpoint

-- ── ٤) CHECK يدوي: مبلغ التحويل > 0 (سابقة 0018) ─────────────────────────────
-- التعليق في schema.ts يَنصّ صراحةً: «DB CHECK > 0 (migration manual)». MySQL 8 يَفرضه فعلياً.
-- مبلغ ≤ 0 لا معنى تجاري له ويُخفي تلاعباً — حارس بنيوي يَمنعه من القاعدة.
ALTER TABLE `cashTransfers` ADD CONSTRAINT `chk_cashTransfers_amount_positive` CHECK (`amount` > 0);

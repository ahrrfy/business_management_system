-- ش٥ (٦/٨/٢٦) — رصيد اتصال زين (TELECOM) طريقةَ دفعٍ خامسة بحسابٍ مشتقٍّ يُسوّى دورياً.
-- docs/reception-cashier-system-design-2026-08-05.md §٥.٤-٥.٥ + §٩.٤.
-- القاعدة المعمَّمة (V10): قيمة enum على جدولٍ قائم = MODIFY COLUMN هنا (مسار الإنتاج عبر
-- migrator) + نسخة extras مكرَّرة حرفياً آخر قائمة ci-apply (مسار CI عبر push) — واحدةٌ
-- وحدها = عطلٌ صامت. db:verify يفحص وجود القيمة قبل pm2 reload.
ALTER TABLE `receipts` MODIFY COLUMN `paymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET','EXCHANGE','TELECOM') NOT NULL;--> statement-breakpoint
ALTER TABLE `workOrders` MODIFY COLUMN `woPaymentMethod` enum('CASH','CARD','TRANSFER','WALLET','TELECOM') DEFAULT 'CASH';--> statement-breakpoint
ALTER TABLE `receipts` ADD COLUMN `telecomSenderPhone` varchar(32);--> statement-breakpoint
ALTER TABLE `cardReconciliations` ADD COLUMN `accountKind` enum('CARD','TELECOM') NOT NULL DEFAULT 'CARD';--> statement-breakpoint
-- استبدالٌ ذرّيّ (DROP+ADD في ALTER واحدة): الفهرس يخدم FK الفرع، وإسقاطه المنفصل يفشل ER_1553؛
-- branchId يبقى متصدّراً ليرضي الـFK ويخدم «آخر مطابقة (نوع، فرع)» معاً.
ALTER TABLE `cardReconciliations` DROP INDEX `idx_cardrecon_branch`, ADD INDEX `idx_cardrecon_branch` (`branchId`,`accountKind`,`asOfDate`);

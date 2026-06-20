-- 0018 (٢٠/٦/٢٦): دفاع في العمق على مستوى القاعدة — قيود CHECK لعدم السالبية + UNIQUE بنيوي.
-- مصدر التشخيص: تدقيق ٢٠/٦ (DB-01 على branchStock.quantity). أضيفت القيود فقط على الأعمدة
-- التي هي «غير سالبة بنيوياً دائماً» أو «فريدة بنيوياً» — أُقصيت الأعمدة الموقَّعة المشروعة
-- (أرصدة AR/AP، تقريب النقد، قيود RETURN/التخلّص من الأصول السالبة) عمداً.
--
-- ملاحظة: MySQL 8 يفرض CHECK فعلياً (بخلاف 5.7). CHECK يسمح بـNULL (يقيّد القيم غير الـNULL فقط)
-- ⇒ آمن على الأعمدة الاختيارية (rating). UNIQUE في MySQL يسمح بتعدّد NULL ⇒ يفرض التفرّد على
-- القيم غير الـNULL فقط (nationalId الاختياري).
--
-- ⚠️ قبل التطبيق على الإنتاج: شغّل `node scripts/precheck-0018.mjs` على قاعدة الإنتاج —
-- يكشف أي صفّ سيُخالف أي قيد جديد (يُخرِج رمز خروج غير صفري عند أي مخالفة).

-- ── CHECK (col >= 0) ──
-- ⛔ branchStock.quantity أُقصِي عمداً (رغم DB-01): خدمات الطباعة (allowNegative) تَستهلك المادة
-- وتُتعقَّب حتى لو دفعت الرصيد سالباً (قرار عمل مشروع — printSaleService)، فقيدُ >=0 يَكسر بيع
-- الطباعة. حارس البيع الزائد يبقى تطبيقياً (oversell guard) للبيع العاديّ.
ALTER TABLE `receipts` ADD CONSTRAINT `chk_receipts_amount_nonneg` CHECK (`amount` >= 0);--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `chk_expenses_amount_nonneg` CHECK (`amount` >= 0);--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `chk_invoices_subtotal_nonneg` CHECK (`subtotal` >= 0);--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `chk_invoices_total_nonneg` CHECK (`total` >= 0);--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `chk_invoices_paidAmount_nonneg` CHECK (`paidAmount` >= 0);--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `chk_invoiceItems_quantity_nonneg` CHECK (`quantity` >= 0);--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `chk_invoiceItems_baseQuantity_nonneg` CHECK (`baseQuantity` >= 0);--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `chk_invoiceItems_unitPrice_nonneg` CHECK (`unitPrice` >= 0);--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `chk_invoiceItems_total_nonneg` CHECK (`total` >= 0);--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `chk_purchaseOrders_total_nonneg` CHECK (`total` >= 0);--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `chk_purchaseOrders_paidAmount_nonneg` CHECK (`paidAmount` >= 0);--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `chk_purchaseOrderItems_quantity_nonneg` CHECK (`quantity` >= 0);--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `chk_purchaseOrderItems_baseQuantity_nonneg` CHECK (`baseQuantity` >= 0);--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `chk_purchaseOrderItems_unitPrice_nonneg` CHECK (`unitPrice` >= 0);--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `chk_purchaseOrderItems_total_nonneg` CHECK (`total` >= 0);--> statement-breakpoint
ALTER TABLE `productVariants` ADD CONSTRAINT `chk_productVariants_costPrice_nonneg` CHECK (`costPrice` >= 0);--> statement-breakpoint

-- ── CHECK (rating BETWEEN 0 AND 5) — يسمح بـNULL ──
ALTER TABLE `suppliers` ADD CONSTRAINT `chk_suppliers_rating_range` CHECK (`rating` >= 0 AND `rating` <= 5);--> statement-breakpoint
ALTER TABLE `jobApplicants` ADD CONSTRAINT `chk_jobApplicants_rating_range` CHECK (`rating` >= 0 AND `rating` <= 5);--> statement-breakpoint

-- ── UNIQUE على nationalId (varchar اختياري؛ تعدّد NULL مسموح، التفرّد على القيم الفعلية) ──
ALTER TABLE `employees` ADD CONSTRAINT `uq_employee_national_id` UNIQUE (`nationalId`);

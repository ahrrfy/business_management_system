-- ش٠ (٥/٨/٢٦) — إصلاحات مانعة حيّة لمحطة خدمة الزبائن (الوثيقة الحاكمة:
-- docs/reception-cashier-system-design-2026-08-05.md §٥.٤ + ش٠):
--
-- ١) workOrders.depositReceiptId (V3): هويّة إيصال العربون الصريحة. كان الالتقاط ظنّياً
--    بـ`.limit(1)` على (workOrderId, IN, invoiceId NULL) فيتصادم مع إيصال أجرة COUNTER
--    (نفس البصمة تماماً) ⇒ إلغاء الأمر قد يردّ مبلغ الأجرة بدل العربون، والتسليم/الإرسال
--    قد يربط الإيصال الخاطئ بالفاتورة. بلا FK — receipts يشير إلى workOrders أصلاً
--    (تجنّب حلقة مفاتيح أجنبية).
-- ٢) backfill: أقدم إيصال IN غير مربوط بفاتورة وغير إيصال أجرة (DLV-FEE-%) لكل أمرٍ
--    عربونه موجب — يغطّي الأوامر الطائرة (RECEIVED/IN_PROGRESS/READY) التي ستُقرأ لاحقاً.
-- ٣) idx_invoice_shift (V2): طابور الاستقبال يفلتر على invoices.shiftId ويقطع بـid
--    (keyset) — التعليق القديم ادّعى أنه «مفهرَس» ولا فهرس له فعلاً.
ALTER TABLE `workOrders` ADD COLUMN `depositReceiptId` bigint;--> statement-breakpoint
CREATE INDEX `idx_wo_deposit_receipt` ON `workOrders` (`depositReceiptId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_shift` ON `invoices` (`shiftId`,`id`);--> statement-breakpoint
UPDATE `workOrders` w
JOIN (
  SELECT `workOrderId`, MIN(`id`) AS `rid`
  FROM `receipts`
  WHERE `direction` = 'IN'
    AND `invoiceId` IS NULL
    AND `workOrderId` IS NOT NULL
    AND (`referenceNumber` IS NULL OR `referenceNumber` NOT LIKE 'DLV-FEE-%')
  GROUP BY `workOrderId`
) r ON r.`workOrderId` = w.`id`
SET w.`depositReceiptId` = r.`rid`
WHERE w.`depositReceiptId` IS NULL AND w.`deposit` > 0;
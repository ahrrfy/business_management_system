-- 0032 (٢٩/٦/٢٦): فهارس invoices مُغطّية بترتيب (التاريخ ثم الحالة) — مُثبَتة بالقياس على ٥٠٠ألف فاتورة.
-- السياق: تقارير المبيعات (getSalesRegister/getSalesByDimension) تُرشّح على نطاق invoiceDate + invoiceStatus
-- NOT IN ('CANCELLED'). بعد جعل الاستعلام قابلاً للفهرسة (S2)، تبيّن أنّ ترتيب فهرس S1
-- (branchId, invoiceStatus, invoiceDate) خاطئ: invoiceStatus نفيٌ غير-مساواة يكسر بادئة النطاق ⇒
-- لا يُستعمل invoiceDate كنطاق. الترتيب الصحيح المُغطّي = (التاريخ ثم الحالة):
--   idx_invoice_date_status        (invoiceDate, invoiceStatus)              — تقارير بلا فلتر فرع
--   idx_invoice_branch_date_status (branchId, invoiceDate, invoiceStatus)    — تقارير بفلتر فرع
-- القياس (نافذة شهر على ٥٠٠ألف فاتورة): القابل-للفهرسة بلا مُغطٍّ كان ٤٨٦٦مس؛ مع هذين الفهرسين ١٩٩٥/١٠١٢مس
-- (أسرع من غير-القابل ٢٨٥٥/١١٥٢مس)، ويمسح نافذة التاريخ فقط (~١٧ألف) بدل كل الفواتير (تدهور خطّي عند ١٠٠×).
-- ملاحظة: idx_invoice_branch_date (0013) صار بادئةً من idx_invoice_branch_date_status ⇒ مرشّح حذف لاحق (تقليل كلفة الكتابة).
-- نمط idempotency مطابق 0013 (٥ chunks/فهرس، mysql2 multipleStatements:false). أسماء أعمدة DB.

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_date_status');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_invoice_date_status` ON `invoices` (`invoiceDate`, `invoiceStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_branch_date_status');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_invoice_branch_date_status` ON `invoices` (`branchId`, `invoiceDate`, `invoiceStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

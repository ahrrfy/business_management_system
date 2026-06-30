-- 0033 (٢٩/٦/٢٦): حذف idx_invoice_branch_date — صار بادئةً مكرّرةً من idx_invoice_branch_date_status (S2).
-- مُثبَت بالقياس على ٥٠٠ألف فاتورة عبر EXPLAIN: استعلام (branch + نطاق تاريخ) — مع/بدون idx_invoice_branch_date —
-- يختار idx_invoice_branch_date_status (المُغطّي الجديد) ⇒ ١٦٣١٦ صف في الحالتين، بلا فقدان أداء.
--
-- أبقينا idx_invoice_branch_status_date (S1، ترتيب status-first): قاعدة «status-first يكسر البادئة» تنطبق
-- على النفي NOT IN فقط (حالة S2 لتقارير المبيعات). للشمول الإيجابي IN ('PENDING','PARTIALLY_PAID') —
-- نمط AR aging — المُحسِّن يختار (branch,status,date) ويُسرّعها ٥× (٥٤٢٠ مقابل ٢٩٧٧٠ صف).
--
-- الفائدة: تقليل كلفة الكتابة على invoices (شاهدنا تباطؤ البذر ٧٤٥٦←١٠٧٨/ث مع نموّ الفهارس) + توفير مساحة.
-- نمط idempotency مطابق 0013/0030/0031/0032 (٥ chunks، multipleStatements:false). MySQL 8 InnoDB:
-- DROP INDEX ثانوي INPLACE/LOCK=NONE ⇒ تافه إنتاجياً.

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_branch_date');
--> statement-breakpoint
SET @s := IF(@x > 0, 'DROP INDEX `idx_invoice_branch_date` ON `invoices`', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

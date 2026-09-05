-- مرآة حرّاس append-only في 0315 لقاعدة الاختبار/CI المبنية بـdb:push من schema.

DROP TRIGGER IF EXISTS `trg_supplier_invoice_draft_revisions_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_supplier_invoice_draft_revisions_bu`
BEFORE UPDATE ON `supplierInvoiceDraftRevisions`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'supplier invoice draft revisions are append-only';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_invoice_draft_revisions_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_supplier_invoice_draft_revisions_bd`
BEFORE DELETE ON `supplierInvoiceDraftRevisions`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'supplier invoice draft revisions are append-only';
END;

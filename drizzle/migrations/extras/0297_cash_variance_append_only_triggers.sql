-- مرآة حرّاس append-only في 0297 لقواعد db:push/CI.
DROP TRIGGER IF EXISTS `trg_cash_variance_cases_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_cases_bu` BEFORE UPDATE ON `cashVarianceCases`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance cases are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_variance_cases_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_cases_bd` BEFORE DELETE ON `cashVarianceCases`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance cases are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_variance_events_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_events_bu` BEFORE UPDATE ON `cashVarianceCaseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance events are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_variance_events_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_events_bd` BEFORE DELETE ON `cashVarianceCaseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance events are append-only';

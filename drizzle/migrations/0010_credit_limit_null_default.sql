-- نَقل كل قيم 0 الحالية إلى NULL (دلالة H4: 0=حظر، null=بلا حدّ).
UPDATE customers SET creditLimit = NULL WHERE creditLimit = '0' OR creditLimit = '0.00';--> statement-breakpoint
ALTER TABLE customers MODIFY COLUMN creditLimit DECIMAL(15,2) DEFAULT NULL;

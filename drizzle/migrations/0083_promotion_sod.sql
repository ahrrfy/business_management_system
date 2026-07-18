-- 0083: فصل المهام (SOD) على اعتماد الترقية + معالجة effectiveDate المستقبليّ.
-- createdBy (nullable): إثبات مُنشئ الترقية لفرض «المعتمِد ≠ المُنشئ» (الصفوف القديمة null ⇒ لا فرض عليها).
-- appliedAt (nullable): يميّز الترقية المعتمَدة المطبَّقة على راتب الموظف عن المؤجَّلة (effectiveDate مستقبليّ)
--   التي تُطبَّق لاحقاً عند بلوغ تاريخها (كنسة عند توليد الرواتب).
ALTER TABLE `employeePromotions` ADD COLUMN `createdBy` int NULL AFTER `approvedBy`;
--> statement-breakpoint
ALTER TABLE `employeePromotions` ADD COLUMN `appliedAt` timestamp NULL AFTER `createdBy`;
--> statement-breakpoint
ALTER TABLE `employeePromotions` ADD CONSTRAINT `employeePromotions_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`);

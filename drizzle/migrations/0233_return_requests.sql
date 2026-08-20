-- طلبات الإرجاع من المحطة (قرار المالك ١٨/٨: «طلب موظف + اعتماد مدير»).
--
-- الحال قبلها: `returns.create` محصورٌ بالمدير (`salesManagerProcedure`)، وموظّف الاستقبال
-- يُقال له حرفياً «استدعِ المدير» في شاشته. ورفضُ الزبون وإرجاعُ المندوب **حدثٌ يوميّ** —
-- فالعمل يتوقّف حتى يحضر المدير، أو يُحفَظ المرتجع بحسابه هو فتضيع نسبة الفاعل.
--
-- النمط مستنسَخٌ من `stockAdjustmentRequests` حرفياً (ماكر-تشيكر مُختبَر):
--  · الطلب **مستند نيّةٍ لا مال**: لا قيد ولا إيصال ولا حركة مخزون حتى الاعتماد.
--  · **لقطة تفاؤلية** (`invoiceReturnedSnapshot`): يُرفَض الاعتماد إن تحرّك مرتجع الفاتورة
--    بين الطلب والاعتماد — وإلّا اعتُمد طلبٌ بُني على حالةٍ لم تعد قائمة فانعكس البيع مرّتين.
--  · المُعتمِد ≠ المُنشئ (يُفرَض في الخدمة؛ admin مستثنى للتصحيح الإداريّ كسائر SOD).
SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `returnRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `invoiceId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  -- أسطر المرتجع المطلوبة: [{ invoiceItemId, baseQuantity }] — تُنفَّذ حرفياً عند الاعتماد.
  `linesJson` JSON NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  -- لقطة `invoices.returnedTotal` لحظة الطلب (حارس تفاؤليّ عند الاعتماد).
  `invoiceReturnedSnapshot` DECIMAL(15, 2) NOT NULL DEFAULT '0',
  `returnRequestStatus` ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED')
    NOT NULL DEFAULT 'PENDING_APPROVAL',
  `createdBy` INT NOT NULL,
  `approvedBy` INT NULL,
  `approvedAt` TIMESTAMP NULL,
  -- الفاتورة/المرتجع الناتج عن الاعتماد (أثرٌ يربط النيّة بالتنفيذ).
  `resultReturnInvoiceId` BIGINT NULL,
  `rejectionReason` VARCHAR(500) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_retreq_status_branch` (`returnRequestStatus`, `branchId`),
  KEY `idx_retreq_invoice` (`invoiceId`),
  KEY `idx_retreq_creator` (`createdBy`),
  CONSTRAINT `fk_retreq_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`),
  CONSTRAINT `fk_retreq_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_retreq_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_retreq_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

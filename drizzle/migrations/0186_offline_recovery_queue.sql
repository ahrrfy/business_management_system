-- 0186 — طابور استرداد المبيعات الأوفلاينية المرفوضة (المسار و-٤، ورقة الإصلاحات ١٦/٨)
-- ===============================================================
-- الجذر: بيعٌ نقديّ التُقط أوفلاين ووصل بعد إغلاق ورديته (أو بعد ٧٢ ساعة) يُرفض بـ
-- PRECONDITION_FAILED ولا يُكتب منه شيء — والزبون **دفع فعلاً والبضاعة خرجت**. كان العنصر
-- يبقى في طابور الجهاز وحده، فإن مُسحت بيانات المتصفّح ضاع الإيراد والمخزون والنقد نهائياً.
--
-- هذا الجدول ليس دفتراً: صفٌّ فيه لا يُنشئ أثراً مالياً البتّة. هو **صندوق التقاطٍ خادميّ**
-- ينجو من مسح الجهاز، ويتحوّل إلى قيدٍ فقط حين يُرحّله المدير عبر createSale إلى وردية مفتوحة.
--
-- `uq_offline_recovery_request` على clientRequestId: إعادة محاولة الجهاز (وهي متكرّرة بطبعها)
-- تُحدِّث الصفّ ولا تُنشئ نسخةً ثانية ⇒ الطابور يعكس عدد العمليات لا عدد المحاولات.

CREATE TABLE IF NOT EXISTS `offlineRecoveryItems` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `branchId` bigint NOT NULL,
  `deviceId` varchar(64) DEFAULT NULL,
  `clientRequestId` varchar(64) NOT NULL,
  `offlineReceiptNumber` varchar(40) NOT NULL,
  `capturedAt` timestamp NOT NULL,
  `payload` mediumtext NOT NULL,
  `rejectCode` varchar(40) NOT NULL,
  `rejectReason` text,
  `recoveryStatus` enum('PENDING','POSTED','DISCARDED') NOT NULL DEFAULT 'PENDING',
  `invoiceId` bigint DEFAULT NULL,
  `reviewedBy` int DEFAULT NULL,
  `reviewedAt` timestamp NULL DEFAULT NULL,
  `discardReason` text,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `offlineRecoveryItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_offline_recovery_request` UNIQUE(`clientRequestId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- > statement-breakpoint

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offlineRecoveryItems'
    AND INDEX_NAME = 'idx_offline_recovery_status'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX idx_offline_recovery_status ON offlineRecoveryItems (recoveryStatus, branchId)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

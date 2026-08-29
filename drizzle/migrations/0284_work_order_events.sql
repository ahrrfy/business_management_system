-- 0278_work_order_events: سجلّ أحداث دورة حياة أمر الشغل (Event Store)
--
-- الغرض (Slice 6، ٢٨/٨/٢٦، المحور ١ من التدقيق): تعميمُ نموذج `deliveryEvents` المرجعيّ
-- على أمر الشغل. `workOrderRouter.timeline` كان يقرأ من `auditLogs` وحده — سجلٌّ عامٌّ
-- بأعمدة JSON صعبة الاستعلام. `workOrderEvents` طبقةٌ ثانية منظَّمة بـfromStatus/toStatus
-- كأعمدةٍ مُنمَّطة قابلة للفهرسة، و`eventKey` UNIQUE يمنع الازدواج على مستوى القاعدة.
--
-- **Dual-write:** المسارات الحاليّة تبقى تكتب `logAuditTx` (لا كسر لـtimeline القائم)،
-- والخدمات الحرِجة تكتب `recordWorkOrderEvent` على التوازي — لاحقاً يمكن الاستغناء عن
-- الكتابة المزدوجة بعد إثبات موثوقيّة السجلّ الجديد.
--
-- Idempotent: يستعمل INFORMATION_SCHEMA للتحقّق قبل CREATE (نمط 0179/0276).

SET @db := DATABASE();
SET @tbl_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='workOrderEvents');
SET @sql := IF(@tbl_exists = 0, '
CREATE TABLE `workOrderEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `eventKey` varchar(160) NOT NULL,
  `workOrderId` bigint NOT NULL,
  `eventType` varchar(60) NOT NULL,
  `fromStatus` varchar(30) DEFAULT NULL,
  `toStatus` varchar(30) DEFAULT NULL,
  `payload` json DEFAULT NULL,
  `actorUserId` int DEFAULT NULL,
  `branchId` bigint DEFAULT NULL,
  `occurredAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `workOrderEvents_eventKey_unique` (`eventKey`),
  KEY `idx_wo_event_wo_time` (`workOrderId`,`occurredAt`),
  KEY `idx_wo_event_type` (`eventType`),
  KEY `wo_event_actor_fk_idx` (`actorUserId`),
  CONSTRAINT `wo_event_wo_fk` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `wo_event_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

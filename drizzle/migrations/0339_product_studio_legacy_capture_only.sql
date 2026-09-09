-- يسجل مصدر المحتوى وصلاحيته وقت الكتابة مستقلاً عن مرسل الصورة. حذف الحساب أو تغيير دوره
-- لاحقاً لا يبدّل حقيقة أن المدير أعدّ المحتوى، ولا يعدّ مسح الباركود دليلاً على ملكية النص.
ALTER TABLE `productImageJobs`
  ADD COLUMN `contentPreparedBy` int NULL,
  ADD COLUMN `contentPreparedByManager` tinyint(1) NOT NULL DEFAULT 0,
  ADD CONSTRAINT `fk_pijob_content_prepared_by`
    FOREIGN KEY (`contentPreparedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL;

-- نحتفظ فقط بالمسودات القديمة التي يثبت سجلها أن مديراً أرسل المحتوى بنفسه. المسوّدات التي
-- أرسلها مدير مباشرةً تحمل submittedBy، والمسودات المحفوظة قبل الإرسال نستردّ آخر حفظٍ لها
-- من سجل التدقيق. هذا الإثبات لا يعتمد على حالة الباركود لأنها تخص دخول المصوّر للمهمة فقط.
UPDATE `productImageJobs` AS `job`
INNER JOIN `users` AS `submitter` ON `submitter`.`id` = `job`.`submittedBy`
SET
  `job`.`contentPreparedBy` = `submitter`.`id`,
  `job`.`contentPreparedByManager` = 1
WHERE `job`.`status` IN ('ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REJECTED')
  AND (`submitter`.`role` IN ('admin', 'manager') OR `submitter`.`isOwner` = 1)
  AND (
    `job`.`proposedName` IS NOT NULL
    OR `job`.`proposedDescription` IS NOT NULL
    OR `job`.`proposedMarketingCopy` IS NOT NULL
  );

UPDATE `productImageJobs` AS `job`
INNER JOIN (
  SELECT `entityId`, MAX(`id`) AS `auditId`
  FROM `auditLogs`
  WHERE `entityType` = 'productImageJob'
    AND `action` = 'productStudio.saveDraft'
  GROUP BY `entityId`
) AS `lastDraft` ON `lastDraft`.`entityId` = CAST(`job`.`id` AS CHAR)
INNER JOIN `auditLogs` AS `draftAudit` ON `draftAudit`.`id` = `lastDraft`.`auditId`
INNER JOIN `users` AS `preparer` ON `preparer`.`id` = `draftAudit`.`userId`
SET
  `job`.`contentPreparedBy` = `preparer`.`id`,
  `job`.`contentPreparedByManager` = 1
WHERE `job`.`status` IN ('ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REJECTED')
  AND `job`.`contentPreparedByManager` = 0
  AND (`preparer`.`role` IN ('admin', 'manager') OR `preparer`.`isOwner` = 1)
  AND (
    `job`.`proposedName` IS NOT NULL
    OR `job`.`proposedDescription` IS NOT NULL
    OR `job`.`proposedMarketingCopy` IS NOT NULL
  );

-- قبل بوابة الباركود كانت واجهة المصوّر تحفظ اقتراح الاسم/الوصف معها. أي محتوى نشط بلا
-- إثبات صلاحية مدير ليس مسودة كتالوج موثوقة، فيمسح من المهمة وحدها ولا نعدل المنتج أو السجل
-- المعتمد والملغى. يشمل ذلك المهام التي مُسح باركودها لاحقاً؛ الباركود ليس مصدر المحتوى.
UPDATE `productImageJobs`
SET
  `proposedName` = NULL,
  `proposedDescription` = NULL,
  `proposedMarketingCopy` = NULL,
  `revision` = `revision` + 1,
  `updatedAt` = CURRENT_TIMESTAMP
WHERE `contentPreparedByManager` = 0
  AND `status` IN ('ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REJECTED')
  AND (
    `proposedName` IS NOT NULL
    OR `proposedDescription` IS NOT NULL
    OR `proposedMarketingCopy` IS NOT NULL
  );

-- 0062: باركودات بديلة (aliases) لوحدة المنتج
--
-- الفكرة: منتج واحد بتكلفة وسعر ومخزن موحّد قد يحمل عدّة باركودات في السوق
-- (نفس السلعة بأشكال خارجية مختلفة، أو دفعات استيراد بترميز مختلف). بدل تكرار
-- المتغيّر/الوحدة (مما يُفرّغ التقارير المخزنيّة والماليّة)، نُخزّن الباركودات البديلة
-- في جدول جانبيّ يشير كلٌّ منها إلى `productUnitId` الأصليّ.
--
-- التفرّد العالميّ: `barcode` في هذا الجدول UNIQUE على مستوى العمود. لكن الحدس
-- المطلوب هو: باركود واحد لا يخصّ سلعتَين مختلفتَين. لذلك التطبيق يفحص الأساسيّ
-- (`productUnits.barcode`) والبديل (هذا الجدول) معاً قبل السماح بأيّ إدخال جديد
-- — راجع `productCreate.ts::checkBarcodesTaken`.
--
-- الحذف: FK cascade على `productUnits` — إن حُذفت الوحدة، تختفي كل باركوداتها البديلة.
-- `createdBy` مرجع للمستخدم كي نعرف من أضاف كل باركود (سجلّ تدقيق خفيف).

CREATE TABLE IF NOT EXISTS `productUnitBarcodes` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `productUnitId` BIGINT NOT NULL,
  `barcode` VARCHAR(64) NOT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `createdBy` INT DEFAULT NULL,
  `createdAt` TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE KEY `uq_unit_barcode_alias` (`barcode`),
  KEY `idx_alias_unit` (`productUnitId`),
  CONSTRAINT `fk_alias_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alias_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
);

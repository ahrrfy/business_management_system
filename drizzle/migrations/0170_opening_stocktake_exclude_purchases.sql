-- استلام الشراء هو افتتاح فعلي لرصيد الصنف في الفرع؛ الإصدارات السابقة أبقت openedAt فارغاً
-- بعد حركة الشراء، فظل الصنف مؤهلاً للجرد الافتتاحي والبيع بالسالب أثناء نافذة الافتتاح.
UPDATE `branchStock` AS bs
INNER JOIN (
  SELECT
    im.`variantId`,
    im.`branchId`,
    MIN(im.`createdAt`) AS `firstPurchasedAt`
  FROM `inventoryMovements` AS im
  WHERE im.`movementType` = 'IN'
    AND im.`referenceType` = 'PURCHASE_ORDER'
  GROUP BY im.`variantId`, im.`branchId`
) AS fp
  ON fp.`variantId` = bs.`variantId`
 AND fp.`branchId` = bs.`branchId`
SET bs.`openedAt` = fp.`firstPurchasedAt`
WHERE bs.`openedAt` IS NULL;

-- أوامر الشراء غير الملغاة تُخرج أصنافها من الجرد الافتتاحي في فرع الأمر نفسه. ننظف الجلسات
-- النشطة فقط، ونحفظ تاريخ الجلسات المعتمدة/الملغاة والجرد الدوري كما هو.
-- إن كانت الجلسة في REVIEW فقد تغيّر نطاق المستند بعد توقيعه الأول؛ نُبطل التوقيع قبل التنظيف
-- كي يتطلب الاعتماد النهائي توقيعاً أول جديداً على النطاق المتبقي.
UPDATE `stocktakeSessions` AS ss
INNER JOIN `stocktakeItems` AS si ON si.`sessionId` = ss.`id`
INNER JOIN `purchaseOrderItems` AS poi ON poi.`variantId` = si.`variantId`
INNER JOIN `purchaseOrders` AS po
  ON po.`id` = poi.`purchaseOrderId`
 AND po.`branchId` = ss.`branchId`
SET ss.`firstSignBy` = NULL,
    ss.`firstSignAt` = NULL
WHERE ss.`sessionType` = 'OPENING'
  AND ss.`stocktakeStatus` = 'REVIEW'
  AND po.`poStatus` <> 'CANCELLED';

DELETE sre
FROM `stocktakeItemReviewEvents` AS sre
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sre.`sessionId`
INNER JOIN `purchaseOrderItems` AS poi ON poi.`variantId` = sre.`variantId`
INNER JOIN `purchaseOrders` AS po
  ON po.`id` = poi.`purchaseOrderId`
 AND po.`branchId` = ss.`branchId`
WHERE ss.`sessionType` = 'OPENING'
  AND ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND po.`poStatus` <> 'CANCELLED';

DELETE sd
FROM `stocktakeDecisions` AS sd
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sd.`sessionId`
INNER JOIN `purchaseOrderItems` AS poi ON poi.`variantId` = sd.`variantId`
INNER JOIN `purchaseOrders` AS po
  ON po.`id` = poi.`purchaseOrderId`
 AND po.`branchId` = ss.`branchId`
WHERE ss.`sessionType` = 'OPENING'
  AND ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND po.`poStatus` <> 'CANCELLED';

DELETE sc
FROM `stocktakeCounts` AS sc
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sc.`sessionId`
INNER JOIN `purchaseOrderItems` AS poi ON poi.`variantId` = sc.`variantId`
INNER JOIN `purchaseOrders` AS po
  ON po.`id` = poi.`purchaseOrderId`
 AND po.`branchId` = ss.`branchId`
WHERE ss.`sessionType` = 'OPENING'
  AND ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND po.`poStatus` <> 'CANCELLED';

-- stocktakeItems قد يشير إلى stocktakeCountOperations؛ حذفه أولاً يحرر المرجع بـSET NULL.
DELETE si
FROM `stocktakeItems` AS si
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = si.`sessionId`
INNER JOIN `purchaseOrderItems` AS poi ON poi.`variantId` = si.`variantId`
INNER JOIN `purchaseOrders` AS po
  ON po.`id` = poi.`purchaseOrderId`
 AND po.`branchId` = ss.`branchId`
WHERE ss.`sessionType` = 'OPENING'
  AND ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND po.`poStatus` <> 'CANCELLED';

DELETE sco
FROM `stocktakeCountOperations` AS sco
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sco.`sessionId`
INNER JOIN `purchaseOrderItems` AS poi ON poi.`variantId` = sco.`variantId`
INNER JOIN `purchaseOrders` AS po
  ON po.`id` = poi.`purchaseOrderId`
 AND po.`branchId` = ss.`branchId`
WHERE ss.`sessionType` = 'OPENING'
  AND ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND po.`poStatus` <> 'CANCELLED';

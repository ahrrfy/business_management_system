-- المنتجات الخدمية (ومنها عروض البطاقات الرقمية والاشتراكات) لا تملك رصيداً مخزنياً.
-- الإصدارات السابقة أدخلتها في نطاقات الجرد، وقد تكون عليها عدّات أو قرارات في جلسات
-- ما زالت مفتوحة. ننظف الجلسات النشطة فقط ونحفظ تاريخ الجلسات المعتمدة كما هو.

DELETE sre
FROM `stocktakeItemReviewEvents` AS sre
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sre.`sessionId`
INNER JOIN `productVariants` AS pv ON pv.`id` = sre.`variantId`
INNER JOIN `products` AS p ON p.`id` = pv.`productId`
WHERE ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND p.`isService` = 1;

DELETE sd
FROM `stocktakeDecisions` AS sd
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sd.`sessionId`
INNER JOIN `productVariants` AS pv ON pv.`id` = sd.`variantId`
INNER JOIN `products` AS p ON p.`id` = pv.`productId`
WHERE ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND p.`isService` = 1;

DELETE sc
FROM `stocktakeCounts` AS sc
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sc.`sessionId`
INNER JOIN `productVariants` AS pv ON pv.`id` = sc.`variantId`
INNER JOIN `products` AS p ON p.`id` = pv.`productId`
WHERE ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND p.`isService` = 1;

-- stocktakeItems قد يشير إلى stocktakeCountOperations؛ حذفه أولاً يحرر المرجع بـSET NULL.
DELETE si
FROM `stocktakeItems` AS si
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = si.`sessionId`
INNER JOIN `productVariants` AS pv ON pv.`id` = si.`variantId`
INNER JOIN `products` AS p ON p.`id` = pv.`productId`
WHERE ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND p.`isService` = 1;

DELETE sco
FROM `stocktakeCountOperations` AS sco
INNER JOIN `stocktakeSessions` AS ss ON ss.`id` = sco.`sessionId`
INNER JOIN `productVariants` AS pv ON pv.`id` = sco.`variantId`
INNER JOIN `products` AS p ON p.`id` = pv.`productId`
WHERE ss.`stocktakeStatus` IN ('COUNTING', 'REVIEW')
  AND p.`isService` = 1;

-- 0384: Sync product channel labels (posLabel, invoiceLabel, storeTitle, shortTitle)
-- with products.name when they diverged without an approved/applied content draft.
-- Fixes PR-2027-UAIF where posLabel remained frozen to the previous product name.
UPDATE `products` p
INNER JOIN `productVariants` pv ON pv.productId = p.id
SET
  p.posLabel = LEFT(p.name, 120),
  p.invoiceLabel = LEFT(p.name, 255),
  p.storeTitle = LEFT(p.name, 255),
  p.shortTitle = LEFT(p.name, 160)
WHERE pv.sku = 'PR-2027-UAIF';
--> statement-breakpoint
UPDATE `products` p
LEFT JOIN (
  SELECT DISTINCT `productId`
  FROM `productContentDrafts`
  WHERE `status` IN ('APPROVED', 'APPLIED') AND `productId` IS NOT NULL
) drafts ON drafts.productId = p.id
SET
  p.posLabel = LEFT(p.name, 120),
  p.invoiceLabel = LEFT(p.name, 255),
  p.storeTitle = LEFT(p.name, 255),
  p.shortTitle = LEFT(p.name, 160)
WHERE drafts.productId IS NULL
  AND p.name IS NOT NULL
  AND (
    p.posLabel IS NULL
    OR p.posLabel <> LEFT(p.name, 120)
  );

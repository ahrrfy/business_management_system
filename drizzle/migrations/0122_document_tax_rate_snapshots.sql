ALTER TABLE `invoices`
  ADD COLUMN `taxRatePercent` decimal(5,2) NOT NULL DEFAULT '0.00' AFTER `taxAmount`;

ALTER TABLE `quotations`
  ADD COLUMN `taxRatePercent` decimal(5,2) NOT NULL DEFAULT '0.00' AFTER `taxAmount`;

ALTER TABLE `purchaseOrders`
  ADD COLUMN `taxRatePercent` decimal(5,2) NOT NULL DEFAULT '0.00' AFTER `taxAmount`;

UPDATE `invoices`
SET `taxRatePercent` = CASE
  WHEN `taxAmount` > 0 AND (`subtotal` - `discountAmount`) > 0
    THEN LEAST(100.00, ROUND((`taxAmount` / (`subtotal` - `discountAmount`)) * 100, 2))
  ELSE 0.00
END;

UPDATE `quotations`
SET `taxRatePercent` = CASE
  WHEN `taxAmount` > 0 AND (`subtotal` - `discountAmount`) > 0
    THEN LEAST(100.00, ROUND((`taxAmount` / (`subtotal` - `discountAmount`)) * 100, 2))
  ELSE 0.00
END;

UPDATE `purchaseOrders`
SET `taxRatePercent` = CASE
  WHEN `taxAmount` > 0 AND `subtotal` > 0
    THEN LEAST(100.00, ROUND((`taxAmount` / `subtotal`) * 100, 2))
  ELSE 0.00
END;

-- usdTotal التاريخي كان يحفظ صافي البضاعة فقط؛ بعد تثبيت النسبة يصبح إجمالي فاتورة
-- المورد بالدولار شاملاً الضريبة، مثل total الديناري (الشحن/الكمرك يبقيان ديناريين منفصلين).
UPDATE `purchaseOrders`
SET `usdTotal` = ROUND(`usdTotal` * (1 + (`taxRatePercent` / 100)), 2)
WHERE `agreedCurrency` = 'USD'
  AND `usdTotal` IS NOT NULL
  AND `taxRatePercent` > 0;

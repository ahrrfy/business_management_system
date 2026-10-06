-- 07/10/26: Heal historical ghost delivery assignments
-- Any onlineOrder that is marked SHIPPED with a deliveryPartyId, but has NO active ONLINE_ORDER deliveryConsignment, is considered a ghost assignment.
-- This resets them to PROCESSING and clears the party ID.
UPDATE onlineOrders o
SET o.deliveryPartyId = NULL, o.status = 'PROCESSING'
WHERE o.deliveryPartyId IS NOT NULL
  AND o.status = 'SHIPPED'
  AND NOT EXISTS (
      SELECT 1 
      FROM deliveryConsignments c 
      WHERE c.sourceType = 'ONLINE_ORDER' 
        AND c.sourceId = o.id 
        AND c.status != 'CANCELLED'
  );

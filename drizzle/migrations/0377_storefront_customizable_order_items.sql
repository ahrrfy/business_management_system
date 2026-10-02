ALTER TABLE `onlineOrderItems`
  ADD COLUMN `customizationSnapshot` json NULL AFTER `total`;

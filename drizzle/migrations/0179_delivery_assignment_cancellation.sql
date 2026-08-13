ALTER TABLE `deliveryConsignments`
  MODIFY COLUMN `parcelStatus` ENUM(
    'ASSIGNED',
    'ACCEPTED',
    'PICKED_UP',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'FAILED',
    'CANCELLED',
    'RETURNED'
  ) NOT NULL DEFAULT 'ASSIGNED',
  MODIFY COLUMN `status` ENUM(
    'DISPATCHED',
    'DELIVERED',
    'PARTIAL',
    'CANCELLED',
    'RETURNED',
    'WRITTEN_OFF'
  ) NOT NULL DEFAULT 'DISPATCHED',
  ADD COLUMN `cancelledAt` TIMESTAMP NULL AFTER `failureReason`,
  ADD COLUMN `cancellationReason` VARCHAR(500) NULL AFTER `cancelledAt`,
  ADD COLUMN `cancelledBy` INT NULL AFTER `cancellationReason`,
  ADD CONSTRAINT `deliveryConsignments_cancelledBy_users_id_fk`
    FOREIGN KEY (`cancelledBy`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

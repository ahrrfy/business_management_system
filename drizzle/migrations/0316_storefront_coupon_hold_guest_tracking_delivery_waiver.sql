ALTER TABLE `onlineOrders`
  ADD COLUMN `deliveryFree` boolean NOT NULL DEFAULT false AFTER `shippingCost`,
  ADD COLUMN `deliveryWaivedAmount` decimal(15,2) NOT NULL DEFAULT '0.00' AFTER `deliveryFree`,
  ADD COLUMN `guestTrackingPublicId` varchar(32) NULL AFTER `clientRequestId`,
  ADD COLUMN `guestTrackingTokenHash` varchar(64) NULL AFTER `guestTrackingPublicId`,
  ADD COLUMN `guestTrackingExpiresAt` timestamp(3) NULL AFTER `guestTrackingTokenHash`,
  ADD CONSTRAINT `uq_online_order_guest_tracking_public_id` UNIQUE (`guestTrackingPublicId`),
  ADD CONSTRAINT `uq_online_order_guest_tracking_hash` UNIQUE (`guestTrackingTokenHash`);
--> statement-breakpoint
CREATE TABLE `couponReservations` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `couponId` bigint NOT NULL,
  `programId` bigint NOT NULL,
  `onlineOrderId` bigint NOT NULL,
  `customerId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `discountAmount` decimal(15,2) NOT NULL,
  `status` enum('ACTIVE','REDEEMED','RELEASED') NOT NULL DEFAULT 'ACTIVE',
  `expiresAt` timestamp(3) NULL,
  `reservedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `redeemedAt` timestamp(3) NULL,
  `releasedAt` timestamp(3) NULL,
  `releaseReason` varchar(120) NULL,
  CONSTRAINT `couponReservations_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_coupon_reservation_order` UNIQUE (`onlineOrderId`),
  CONSTRAINT `fk_coupon_reservation_coupon` FOREIGN KEY (`couponId`) REFERENCES `coupons` (`id`),
  CONSTRAINT `fk_coupon_reservation_program` FOREIGN KEY (`programId`) REFERENCES `couponPrograms` (`id`),
  CONSTRAINT `fk_coupon_reservation_order` FOREIGN KEY (`onlineOrderId`) REFERENCES `onlineOrders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_reservation_customer` FOREIGN KEY (`customerId`) REFERENCES `customers` (`id`),
  CONSTRAINT `fk_coupon_reservation_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`)
);
--> statement-breakpoint
-- Mixed-version backfill: orders accepted before deployment already promised their coupon. Preserve every
-- pre-dispatch promise even if the aggregate now exceeds a program limit; the service honors an order's own
-- ACTIVE reservation and blocks only new reservations until capacity becomes available again.
INSERT INTO `couponReservations` (
  `couponId`, `programId`, `onlineOrderId`, `customerId`, `branchId`,
  `discountAmount`, `status`, `expiresAt`
)
SELECT
  `c`.`id`,
  `c`.`programId`,
  `o`.`id`,
  `o`.`customerId`,
  `o`.`branchId`,
  `o`.`couponDiscount`,
  'ACTIVE',
  CASE
    WHEN `o`.`orderStatus` = 'PENDING'
      THEN COALESCE(`o`.`reservationExpiresAt`, DATE_ADD(`o`.`orderDate`, INTERVAL 24 HOUR))
    ELSE NULL
  END
FROM `onlineOrders` `o`
INNER JOIN `coupons` `c`
  ON `c`.`codeHash` = SHA2(`o`.`couponCode`, 256)
WHERE `o`.`orderStatus` IN ('PENDING', 'CONFIRMED', 'PROCESSING')
  AND `o`.`couponCode` IS NOT NULL
  AND `o`.`couponDiscount` > 0
  AND `o`.`branchId` IS NOT NULL
  AND `c`.`couponStatus` = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX `idx_coupon_reservation_coupon_status`
  ON `couponReservations` (`couponId`, `status`, `expiresAt`);
--> statement-breakpoint
CREATE INDEX `idx_coupon_reservation_program_customer_status`
  ON `couponReservations` (`programId`, `customerId`, `status`, `expiresAt`);

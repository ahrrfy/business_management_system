ALTER TABLE `waOutbox`
  ADD COLUMN `customerId` bigint NULL AFTER `toPhoneE164`;
--> statement-breakpoint
CREATE INDEX `idx_wa_outbox_customer_status`
  ON `waOutbox` (`customerId`, `status`);
--> statement-breakpoint
ALTER TABLE `waHubSettings`
  ADD COLUMN `flowReservationNearExpiry` boolean NOT NULL DEFAULT false AFTER `flowConsignmentWithdraw`;
--> statement-breakpoint
ALTER TABLE `reservations`
  ADD COLUMN `nearExpiryNotifiedAt` timestamp NULL AFTER `expiresAt`;
--> statement-breakpoint
CREATE INDEX `idx_reservation_near_expiry`
  ON `reservations` (`reservationStatus`, `reservationChannel`, `nearExpiryNotifiedAt`, `expiresAt`);

-- برنامج اختياري يطلبه العميل الموثق قبل أول طلب متجر؛ لا إصدار تلقائي.
ALTER TABLE `couponPrograms`
  ADD COLUMN `isFirstOrderSelfService` boolean NOT NULL DEFAULT false AFTER `perCustomerLimit`;

-- قيد مستقل يحسم ضغطات العميل المتزامنة: برنامج واحد × عميل واحد × كوبون واحد.
CREATE TABLE `storefrontFirstOrderCouponClaims` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `programId` bigint NOT NULL,
  `customerId` bigint NOT NULL,
  `couponId` bigint NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `storefrontFirstOrderCouponClaims_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_store_first_coupon_program_customer` UNIQUE(`programId`, `customerId`),
  CONSTRAINT `uq_store_first_coupon_claim_coupon` UNIQUE(`couponId`),
  CONSTRAINT `fk_store_first_coupon_claim_program`
    FOREIGN KEY (`programId`) REFERENCES `couponPrograms`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_store_first_coupon_claim_customer`
    FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_store_first_coupon_claim_coupon`
    FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`) ON DELETE SET NULL
);

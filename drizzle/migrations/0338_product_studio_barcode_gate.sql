ALTER TABLE `productImageJobs`
  ADD COLUMN `barcodeVerifiedBy` int NULL,
  ADD COLUMN `barcodeVerifiedAt` timestamp NULL,
  ADD CONSTRAINT `fk_pijob_barcode_verified_by`
    FOREIGN KEY (`barcodeVerifiedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL;

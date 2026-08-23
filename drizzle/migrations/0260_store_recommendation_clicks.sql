CREATE TABLE IF NOT EXISTS `storeRecommendationDailyMetrics` (
  `branchId` BIGINT NOT NULL,
  `metricDate` DATE NOT NULL,
  `sourceProductId` BIGINT NOT NULL,
  `recommendedProductId` BIGINT NOT NULL,
  `clicks` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`branchId`, `metricDate`, `sourceProductId`, `recommendedProductId`),
  KEY `idx_store_recommendation_metric_date` (`metricDate`),
  KEY `idx_store_recommendation_product` (`recommendedProductId`, `metricDate`),
  CONSTRAINT `fk_store_recommendation_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_store_recommendation_source` FOREIGN KEY (`sourceProductId`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_store_recommendation_recommended` FOREIGN KEY (`recommendedProductId`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

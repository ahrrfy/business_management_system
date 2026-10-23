CREATE TABLE `deliveryShipmentMembers` (
  `consignmentId` bigint NOT NULL,
  `leaderConsignmentId` bigint NOT NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`consignmentId`),
  KEY `idx_shipment_leader` (`leaderConsignmentId`),
  CONSTRAINT `fk_shipment_member` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments` (`id`),
  CONSTRAINT `fk_shipment_leader` FOREIGN KEY (`leaderConsignmentId`) REFERENCES `deliveryConsignments` (`id`),
  CONSTRAINT `fk_shipment_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`)
);

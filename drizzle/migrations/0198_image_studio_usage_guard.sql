-- حوكمة تكلفة/تحمل استوديو الصور (0198): عداد يومي ذريّ لكل مزود.
-- الحجز يسبق النداء الخارجي ولا يُسترد بعده، لأن timeout لا يثبت أن المزود لم يقتطع الرصيد.
CREATE TABLE `imageStudioUsageDaily` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`usageDate` date NOT NULL,
	`service` enum('REMOVEBG','AI') NOT NULL,
	`requestCount` int NOT NULL DEFAULT 0,
	`lastRequestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `imageStudioUsageDaily_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_image_studio_usage_daily_service` UNIQUE(`usageDate`,`service`)
);

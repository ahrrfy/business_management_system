-- ═══ controlRequests — جدول الحوكمة الموحّد (م٧ من برنامج v2، ٣/٩/٢٦) ═══
--
-- **العلّة المقيسة:** المستودع يحمل ٣٠ جدول «طلب اعتماد» منفصلاً و~٥٠ إجراء قرار في
-- ٣٥ راوتراً، بلا مفردةٍ واحدة تجمعها. المشتريات وحدها فيها ثمانيةُ طوابيرَ متفرّقة
-- (D3 في `scripts/check-friction.mjs`، خطّ أساس ٧٥ موضعاً). هذا الجدولُ علاجُه:
-- طاولة واحدة لكل طلبات القرار، مفتاحها `decisionKey` من `shared/decisionRegistry.ts`.
--
-- **المبدأ الحاكم:** طلبٌ نشطٌ واحد لكل (قرار، كيان). فرضٌ بنيويٌّ عبر عمودٍ مولَّدٍ
-- STORED: `activeSlot` يحمل بصمة (decisionKey, entityType, entityId) حين PENDING فقط،
-- وNULL بعد القرار. UNIQUE(activeSlot) يمنع الازدواج بلا حجب طلبٍ ثانٍ **بعد** أن
-- يُحسم الأوّل. MySQL يعتبر NULL في UNIQUE مميّزاً ⇒ لا حدود على المحسومة.
--
-- **فصل المهام (SOD) بنيويّاً:** CHECK يفرض أنّ المُقرِّر ليس المُنشئ. الطلبُ المحسومُ
-- لا يُعاد فتحه — يُحرَس ذلك في الخدمة عبر `WHERE status = 'PENDING'` في UPDATE.
--
-- **بلا FK جامدة على entityId:** الجدول متعدّد الأنواع (polymorphic) كنظير
-- `recordVersions`؛ حذفُ الطرف الأمّ رجعياً يجب ألّا يُقيّده سجلّ الحوكمة.
--
-- **لا راوتر ولا UI في هذه الشريحة:** المعمار وحده. التوصيلُ في موجاتٍ لاحقة
-- (م٧ ق٢-ق٥ في الخطة) — عندها تحلّ محلّ الجداول المتشظّية تدريجياً بلا كسرها.

CREATE TABLE `controlRequests` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`decisionKey` varchar(80) NOT NULL,
	`entityType` varchar(50) NOT NULL,
	`entityId` bigint NOT NULL,
	`status` enum('PENDING','APPROVED','REJECTED','WITHDRAWN','SUPERSEDED') NOT NULL DEFAULT 'PENDING',
	`requestedByUserId` bigint NOT NULL,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`decidedByUserId` bigint,
	`decidedAt` timestamp,
	`reason` varchar(1000) NOT NULL,
	`decisionNote` varchar(1000),
	`payloadJson` json,
	`branchId` bigint,
	`activeSlot` varchar(200) GENERATED ALWAYS AS (
		CASE WHEN `status` = 'PENDING'
			THEN CONCAT(`decisionKey`, '\t', `entityType`, '\t', CAST(`entityId` AS CHAR))
			ELSE NULL
		END
	) STORED,
	CONSTRAINT `controlRequests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_active_control_request` UNIQUE(`activeSlot`),
	CONSTRAINT `chk_control_request_decision_shape` CHECK (
		(`status` = 'PENDING' AND `decidedByUserId` IS NULL AND `decidedAt` IS NULL AND `decisionNote` IS NULL)
		OR (`status` IN ('APPROVED','REJECTED','SUPERSEDED') AND `decidedByUserId` IS NOT NULL AND `decidedAt` IS NOT NULL)
		OR (`status` = 'WITHDRAWN' AND `decidedAt` IS NOT NULL)
	),
	CONSTRAINT `chk_control_request_maker_checker` CHECK (
		`decidedByUserId` IS NULL
		OR `status` = 'WITHDRAWN'
		OR `decidedByUserId` <> `requestedByUserId`
	),
	CONSTRAINT `chk_control_request_reject_needs_note` CHECK (
		`status` <> 'REJECTED' OR (`decisionNote` IS NOT NULL AND CHAR_LENGTH(TRIM(`decisionNote`)) > 0)
	)
);
--> statement-breakpoint

CREATE INDEX `idx_control_request_pending_by_kind` ON `controlRequests` (`decisionKey`,`status`,`requestedAt`);
--> statement-breakpoint

CREATE INDEX `idx_control_request_by_entity` ON `controlRequests` (`entityType`,`entityId`,`requestedAt`);
--> statement-breakpoint

CREATE INDEX `idx_control_request_by_requester` ON `controlRequests` (`requestedByUserId`,`requestedAt`);
--> statement-breakpoint

CREATE INDEX `idx_control_request_by_decider` ON `controlRequests` (`decidedByUserId`,`decidedAt`);

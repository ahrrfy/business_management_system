-- طلبات إقفال الشهر (ش٥ب من docs/double-entry-p2-plan-2026-08-11.md).
--
-- قرار المالك (١١/٨): **المدير يطلُب، والأدمن/المالك يُقفل** — لا يُفتَح قفل الفترة للمدير.
-- السبب مكتشَفٌ من الكود لا مفترَض: `periodLockRouter.lock` محصورٌ بـadminProcedure منذ بنائه،
-- و`financialPeriods` **بلا branchId** ⇒ القفل عامٌّ على الشركة كلّها. فتحُه للمدير كان سيجعل
-- مديرَ فرعٍ واحدٍ يقفل الشهر على الفرعين معاً — إضعافُ ضابطٍ قائم.
--
-- وقرارٌ ثانٍ: **لا تجاوز للحاجز إطلاقاً**. الحاجزان (وردية مفتوحة · سند معلَّق) مطلقان، وهو
-- الأسلم تقنياً: سندٌ معلَّقٌ يُترَك خلف قفلٍ يصير غير قابلٍ للاعتماد أبداً (assertPeriodOpen
-- يرفضه) ⇒ التجاوز كان سيخلق سنداً ميّتاً.
--
-- لا branchId في الجدول عمداً: القفل عامّ، فالطلب عامّ، والجاهزية تُحسب لكل الفروع حتماً
-- (جاهزيةٌ مُنطَّقةٌ بفرع الطالب كانت ستُجيز الإقفال وفرعٌ آخر فيه وردية مفتوحة).
CREATE TABLE `monthCloseRequests` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `month` varchar(7) NOT NULL,
  `status` enum('PENDING_APPROVAL','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING_APPROVAL',
  -- لقطة الجاهزية لحظة الطلب (JSON) — للتدقيق ولمقارنة ما رآه الطالب بما يراه المعتمِد.
  -- **ليست** مصدر القرار: الاعتماد يُعيد الفحص حيّاً تحت المعاملة (لا يُصدَّق ادّعاءٌ مخزَّن).
  `readinessSnapshot` text NOT NULL,
  `requestedBy` int NOT NULL,
  `requestedAt` timestamp NOT NULL DEFAULT (now()),
  `decidedBy` int,
  `decidedAt` timestamp NULL,
  `rejectionReason` varchar(500),
  -- financialPeriods.id الناتج عن الاعتماد — أثرٌ مباشر من الطلب إلى القفل الذي أنتجه.
  `lockedPeriodId` bigint,
  -- طلبٌ معلَّقٌ واحدٌ لكل شهر: يحمل الشهر عند الإنشاء وNULL عند الحسم، وUNIQUE يسمح بـNULL
  -- متعدّد ⇒ طلبان متزامنان على نفس الشهر يفشل ثانيهما بـER_DUP_ENTRY. **نمط shifts.openGuard
  -- حرفياً** لا عمودٌ مولَّد: الأعمدة المولَّدة لا تُعلَن في drizzle/schema.ts في هذا المشروع،
  -- وقاعدة الاختبار تُبنى بـdb:push منه ⇒ عمودٌ مولَّدٌ كان سيغيب عنها فينهار الحارس صامتاً.
  `pendingGuard` varchar(7),
  CONSTRAINT `monthCloseRequests_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_month_close_pending` UNIQUE(`pendingGuard`),
  CONSTRAINT `fk_mcr_requested_by`
    FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcr_decided_by`
    FOREIGN KEY (`decidedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- طابور الاعتماد للأدمن: أحدث المعلَّقات أولاً.
CREATE INDEX `idx_mcr_status_requested` ON `monthCloseRequests` (`status`,`requestedAt`);

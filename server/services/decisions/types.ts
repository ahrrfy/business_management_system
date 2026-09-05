/**
 * ═══ صندوق «مطلوب مني الآن» — العقود الداخلية (م٧ ق٢: «الفعل في مكانه») ═══
 *
 * **العلّة المقيسة:** المستودع يحمل ثلاثين طابورَ اعتمادٍ في خمسةٍ وثلاثين راوتراً، والشاشة
 * التي يفتحها المعتمِد فعلاً (`/my-work`) كانت تجمع ستّةً منها فقط وتعرض «عدد الأسطر» بلا
 * صنفٍ ولا سعر، ثمّ ترسله إلى شاشةٍ أخرى ليقرّر. هذا المجلّد يبني الصندوق **من السجلّ**
 * (`shared/decisionRegistry.ts`): كلُّ نوعٍ مُسجَّلٍ يصله **مصدرٌ** يعرف كيف يسرد طلباته
 * المعلَّقة بما يُقرَّر عليه، وكيف يحسمها بـ**نفس** دالّة الخدمة التي يستدعيها راوترُه الأصليّ.
 *
 * ## ثلاثة قيود لا تُكسَر
 *
 * ١) **لا حسمَ مكتوبٌ هنا.** `DecisionSource.decide` يستدعي دالّةَ الحسم القائمة داخل خدمتها
 *    (بحرّاسها: فصل المهام، بوّابة المالك، القفل التفاؤليّ). كتابةُ حسمٍ ثانٍ = مسارٌ ماليّ
 *    ثانٍ ينجرف عن الأوّل.
 * ٢) **البوّابة تُعاد بنفس مفرداتها.** كلُّ مصدرٍ يحمل `gate` يصف بوّابةَ الإجراء الأصليّ
 *    (`moduleProcedure(roles, module, FULL)` / `ownerProcedure` / ...) ويُقيَّم بـ**نفس** دوالّ
 *    `shared/permissions.ts` التي تنفّذها `server/trpc.ts` — لا فحصَ صلاحيةٍ جديد.
 * ٣) **لا قراءةَ `ctx`.** الخدمة تستقبل `DecisionActor` صريحاً (CLAUDE.md §٢).
 */
import type {
  DecisionAction,
  DecisionDecideResult,
  DecisionFreshness,
  DecisionKind,
  DecisionRowModel,
} from "@shared/decisionRegistry";
import type { PermissionMap } from "@shared/permissions";

/** الفاعل كما يراه الصندوق — مشتقٌّ في الراوتر من `ctx.user` مرّةً واحدة. */
export interface DecisionActor {
  userId: number;
  /** الفرع المُسنَد، أو `null` للمالك/الأدمن بلا فرع. */
  branchId: number | null;
  role: string;
  /** `users.isOwner` — المالك يُطبَّع إلى `admin` في `normalizeOwnerAuthority` لكنّ الصفة تبقى. */
  isOwner: boolean;
  permissionsOverride: PermissionMap | null;
  /** `canCrossBranches` — المالك/الأدمن وحدهما. */
  crossBranch: boolean;
}

/**
 * وصفُ بوّابة الإجراء الأصليّ بمفردات `server/trpc.ts` نفسها:
 *  · `MODULE`        ⇐ `moduleProcedure(roles, moduleKey, "FULL")` (بوّابة وحدة + فرعٌ مُسنَد لغير العابر)
 *  · `MODULE_MAP`    ⇐ `protectedProcedure.use(requireModule(moduleKey, "FULL"))` (بلا قائمة أدوار)
 *  · `OWNER`         ⇐ `ownerProcedure` (+ وحدةٌ اختيارية حين يُركَّب عليها `requireModule`)
 *  · `REPORTS_ADMIN` ⇐ `reportsAdminProcedure` (reports:FULL ثمّ admin)
 */
export type DecisionGate =
  | { type: "MODULE"; moduleKey: string; roles: readonly string[] }
  | { type: "MODULE_MAP"; moduleKey: string }
  | { type: "OWNER"; moduleKey?: string }
  | { type: "REPORTS_ADMIN" };

/** مدخلُ الحسم كما يصل من الراوتر بعد zod. */
export interface DecideInput {
  kind: DecisionKind;
  id: number;
  action: DecisionAction;
  /** مفتاحُ تكرارٍ من الشاشة لكلّ نقرة — يُشتقّ منه `decisionKey` للخدمات التي تشترطه. */
  clientRequestId: string;
  reason?: string | null;
  expectedVersion?: number | null;
  confirmations?: Record<string, boolean>;
  reference?: string | null;
}

/** نطاقُ السرد: الفروع التي يراها الفاعل (`null` = كلّ الفروع) ولحظة «الآن». */
export interface DecisionScope {
  branchIds: number[] | null;
  now: Date;
}

/**
 * مصدرُ نوعٍ (أو زوجِ اعتماد/رفض) في الصندوق.
 *
 * `freshness` يُقرأ قبل الحسم كي لا يُبلَّغ نجاحٌ على طلبٍ حُسم من غيرك (STALE) — وهو
 * فحصٌ مسبقٌ للرسالة لا حارسٌ: الحارسُ الحقيقيّ قفلُ الخدمة نفسها.
 */
export interface DecisionSource {
  key: string;
  kinds: readonly DecisionKind[];
  gate: DecisionGate;
  list(actor: DecisionActor, scope: DecisionScope): Promise<DecisionRowModel[]>;
  freshness(id: number): Promise<DecisionFreshness>;
  decide(input: DecideInput, actor: DecisionActor, options: DecideOptions): Promise<DecisionDecideResult>;
}

/**
 * ملحقاتُ الحسم التي لا تقرؤها الخدمة من `ctx` بل تُسلَّم صراحةً. `audit` يلزم دالّةً واحدة
 * قائمة (`approveWorkOrderCancellationRefund`) تكتب أثرَ تدقيقها بنفسها — يُمرَّر كما هو.
 */
export interface DecideOptions {
  audit?: unknown;
}

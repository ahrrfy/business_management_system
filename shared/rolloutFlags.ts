/**
 * أعلامُ الطرح (Rollout Flags) — نظامُ السلامة لبرنامج v2.
 *
 * السبب (الموجة صفر، ٢/٩/٢٦): الخطة تَعِد بأنّ **كل موجةٍ خلف علَمٍ يُطفأ ويُعيد السلوك
 * القديم كما هو**، وأنّ كل حسابٍ جديد **يعمل ظلّياً** بجانب القديم قبل أن يصير مرجعاً.
 * وعدٌ بلا آليةٍ ليس وعداً — فهذه هي الآلية.
 *
 * ثلاثة أوضاع، ومعناها واحدٌ في كل موضع:
 *
 *   OFF     السلوك القديم وحده. الجديد **لا يُنفَّذ ولا يُحسَب**. هذا الافتراض دائماً.
 *   SHADOW  القديم هو المرجع، والجديد **يُحسَب ويُسجَّل فرقُه** ولا يؤثّر في شيء.
 *           لا يُنتقَل منه إلى ON إلّا بعد أيامٍ متطابقة (§١٠ من الخطة).
 *   ON      الجديد هو المرجع.
 *
 * **لماذا متغيّرات بيئة لا جدولُ إعدادات:**
 *   ١) صفر هجرة ⇒ الموجة صفر لا تمسّ المخطّط، فلا تستطيع أن تُؤذي.
 *   ٢) الإطفاء **افتراضٌ بنيويّ**: علَمٌ غير مضبوطٍ = OFF. لا يمكن أن يُنسى علَمٌ مفتوحاً
 *      لأنّ فتحَه فعلٌ صريحٌ في النشر، لا صفٌّ في قاعدةٍ قد يُكتَب بالخطأ.
 *   ٣) قراءةُ العلَم **لا تعتمد على القاعدة** — فلا يُغيّر عطلُ قاعدةٍ سلوكاً مالياً.
 *
 * ⚠️ **فخُّ PM2 عند النشر (درسٌ مسجَّل):** متغيّرٌ غير مُصرَّحٍ في كتلة `env` بملفّ
 * `ecosystem` **يتجمّد على أوّل `pm2 start`** — فالنشر اللاحق لا يحدّثه أبداً وبلا تحذير.
 * ⇒ أيّ علَمٍ يُفتَح على الإنتاج يجب أن يُصرَّح في `ecosystem` أوّلاً، ويُتحقَّق بعد النشر
 * من `pm2 jlist` (حقل `pm2_env`) لا من الملفّ. «الملفّ صحيح والنشر نجح» ليس إثباتاً.
 */

/** وضعُ الطرح. `OFF` هو الافتراض دائماً وفي كل الأعلام. */
export type RolloutMode = "OFF" | "SHADOW" | "ON";

export const ROLLOUT_MODES = ["OFF", "SHADOW", "ON"] as const;

export interface RolloutFlagSpec {
  /** مفتاحُ متغيّر البيئة كاملاً — `ROLLOUT_` + الاسم. */
  readonly env: string;
  /** تسميةٌ عربيّةٌ تُعرَض في تقرير الحالة. */
  readonly label: string;
  /** الموجة التي ينتمي إليها العلَم (من خطة v2). */
  readonly wave: string;
  /**
   * الأوضاع المقبولة لهذا العلَم. ليس لكلّ علَمٍ ظلٌّ: «وضعُ التوصيل في الكاشير» إمّا
   * يظهر أو لا — ولا معنى لحسابه ظلّياً. وإعلانُ ظلٍّ لا يُنفَّذ يُنتج طمأنينةً كاذبة.
   */
  readonly supports: readonly RolloutMode[];
  /** ماذا يحدث حين يكون مطفأً — يُقرَأ في التقرير وفي مراجعة النشر. */
  readonly offMeans: string;
}

/**
 * سجلّ أعلام v2. كل علَمٍ هنا **يقابل موجةً في الخطة المعتمَدة** — ولا يُضاف علَمٌ بلا
 * موجة، وإلّا صار المستودع مليئاً بمفاتيحَ لا أحد يعرف متى تُغلق.
 */
export const ROLLOUT_FLAGS = {
  /**
   * م١ — رصيد جهة التوصيل («النقد بيدها») مشتقٌّ من دفترٍ إلحاقيّ بدل عمودٍ مخزَّن.
   *
   * القارئُ الوحيد على الخادم `server/services/delivery/cashSource.ts` (`deliveryCashSource()`):
   *   `OFF`/`SHADOW` ⇒ `stored` — `deliveryParties.currentBalance` هو المرجع لسقف التوريد
   *   (`remittance.ts`) وسقف العهدة (`parties.assertFloatLimitTx`) والتسوية الحرّة (`settle.ts`)؛
   *   `ON` ⇒ `ledger` — `deriveCashInHandFromLedger` من `deliveryLedgerEntries`.
   * لوحةُ الجهات (`board.ts`) تعرض المصدرَين معاً دائماً مع فرقهما (`cashInHandDrift`)، و
   * `reconcileDeliveryFloat` يُبلغ الانحراف باسم الجهة. **القلبُ إلى `ON` قرارُ مالكٍ بعد ٧ أيامٍ
   * متطابقة** (الخطّة §١٠) — لا يُقلَب في نشرٍ عاديّ.
   */
  courierLedgerDerived: {
    env: "ROLLOUT_COURIER_LEDGER_DERIVED",
    label: "دفترُ جهة التوصيل المشتقّ",
    wave: "م1",
    supports: ["OFF", "SHADOW", "ON"],
    offMeans: "العمود المخزَّن `deliveryParties.currentBalance` يبقى المرجع كما اليوم.",
  },
  /**
   * م١ (PR-4، أتمتة ١) — الكنّاس يَسِم الطردَ المتقادم بلا قبض `FAILED` تلقائياً
   * (`staleSweep.autoFailStaleParcels`: عمرُه فوق `deliveryParties.maxOpenParcelAgeDays` ولا
   * `COD_COLLECTED`) بحدث `AUTO_FAILED_SLA` ومهمّةٍ للمالك، تحت سقفٍ يوميّ
   * (`DELIVERY_MAX_AUTO_FAILS_PER_DAY`). التراجع: إعادةُ الإسناد FAILED→ASSIGNED القائمة.
   */
  deliveryAutoFailSla: {
    env: "ROLLOUT_DELIVERY_AUTO_FAIL_SLA",
    label: "وسمُ التعذّر الآليّ بانقضاء SLA",
    wave: "م1",
    supports: ["OFF", "ON"],
    offMeans: "الكنّاس يُصعّد إعلامياً فقط (`STALE_ESCALATED`) ولا يغيّر حالة أيّ طرد.",
  },
  /** م١ — الوضع الثاني في الكاشير: بيعٌ عبر التوصيل بخمسة حقولٍ إضافية. */
  posDeliveryMode: {
    env: "ROLLOUT_POS_DELIVERY_MODE",
    label: "وضعُ التوصيل في الكاشير",
    wave: "م1",
    supports: ["OFF", "ON"],
    offMeans: "الكاشير بوضعٍ واحد؛ الإسناد للتوصيل يبقى من شاشاته الحالية.",
  },
  /** م١ — الذمّة عند الإسناد تُقيَّد على جهة التوصيل لا على العميل. */
  dispatchDebtOnParty: {
    env: "ROLLOUT_DISPATCH_DEBT_ON_PARTY",
    label: "الذمّة عند الإسناد على الجهة",
    wave: "م1",
    supports: ["OFF", "SHADOW", "ON"],
    offMeans: "الذمّة تُقيَّد على العميل عند الإسناد ويُفحَص سقفُ ائتمانه كما اليوم.",
  },
  /**
   * م1 — سياسة الاعتماد الجديدة (`shared/approvalPolicy.ts`): شخصان لا أكثر، والمالك
   * حصراً يعتمد، وما ينفّذه المالك يُعتمَد تلقائياً. البوّابة تنفتح عند خروج المال أو
   * محو الأثر فقط، وما عداهما يُنفَّذ فوراً.
   */
  ownerOnlyApproval: {
    env: "ROLLOUT_OWNER_ONLY_APPROVAL",
    label: "سياسةُ الاعتماد: المالك حصراً",
    wave: "م1",
    /**
     * ⛔ **`OFF` وحدها حتى تكتمل ثلاثةٌ** — والقفلُ مقصودٌ لا سهو (مراجعة Codex، PR #954).
     *
     * السياسةُ الجديدة **تُسقط فصلَ المهام القائم** على كلّ فعلٍ تصنيفُه `null` (وهو جوهرُ
     * التبسيط)، ووعدُها التعويضيّ ثلاثةُ أشياء **لم يُبنَ منها شيءٌ بعد**:
     *   ① `soloExecutionRecord` بلا مستدعٍ ولا وجهةِ حفظٍ ولا تقريرٍ يقرؤها ⇒ كلُّ تنفيذٍ
     *      بشخصٍ واحد يقع **بلا الأثر المركزيّ الموعود**. ضابطٌ تعويضيٌّ غيرُ موجود.
     *   ② `planApproval` بلا مستدعٍ في شيفرة الإنتاج ⇒ فعلُ المالك **لا يُعتمَد تلقائياً**
     *      وما لا بوّابةَ له يظلّ يمرّ بدورة طلبٍ وقرار. أي أنّ التبسيط الموعود لا يقع.
     *   ③ مساران يُصنّفهما العقدُ `ERASE_EFFECT` صراحةً — تسويةُ المخزون بالنقص
     *      (`inventory/adjustmentApproval.ts`) وإعادةُ تقييم التكلفة
     *      (`inventory/costRevaluationRequest.ts`) — **لا يمرّان بالبوّابة**، فمديرُ مخزونٍ
     *      غيرُ مالك يظلّ يغيّر رصيداً أو قيمةَ صنفٍ بينما يُعلن النظام أنّ المالك وحده يعتمد.
     *
     *   ④ (Codex #958) `salesControlRouter.approve` يمرّ بـ`approveSalesControlRequest`
     *      وحارسِه `assertManager` — فمديرُ الفرع يعتمد مرتجعاتٍ وإلغاءاتٍ محكومة بلا
     *      استشارةِ هذا العلَم. النظامُ قد يُعلن «المالك وحده» بينما غيرُ المالك يُقرّر أثراً
     *      مالياً على مستندٍ حيّ. توصيلُ الحارس بالبوّابة عملٌ في مسار المبيعات، ولم يُنجَز
     *      بعد. الفجوةُ موثَّقةٌ صراحةً حتى لا يُتوهَّم «مغلق» بلا دليل.
     *
     * ⇒ **لا يُرفَع هذا العلَم إلى `ON` في الإنتاج قبل إغلاق ①و②و④ معاً.** أُغلق ③ في هذا
     * الفرع (وُصل مسارا المخزون بالبوّابة). وجُرِّب قصرُ `supports` على `OFF` فأنتج شيفرةً
     * ميتةً لا يبلغها اختبار — وحارسٌ يمنع التحقّق أسوأ من فجوةٍ موثَّقة، فبقي `ON` مدعوماً
     * والافتراضُ `OFF` كما هو.
     */
    supports: ["OFF", "ON"],
    offMeans:
      "سلسلةُ الفصل الحالية تبقى كما هي (٣ إلى ٥ مستخدمين متمايزين لكلّ أمر شراء).",
  },
  /** م٢ — محرّك العكس الواحد بدل عشرين تنفيذاً يدوياً. */
  reversalEngine: {
    env: "ROLLOUT_REVERSAL_ENGINE",
    label: "محرّك العكس الواحد",
    wave: "م2",
    supports: ["OFF", "SHADOW", "ON"],
    offMeans: "كل خدمةٍ تعكس بيدها كما اليوم؛ لا سجلَّ آثارٍ ولا عكسَ مركزيّ.",
  },
  /** م٢ — رفضُ الزبون يُغلق المستند تلقائياً بنقرةِ سببٍ واحدة. */
  autoCloseOnRefusal: {
    env: "ROLLOUT_AUTO_CLOSE_ON_REFUSAL",
    label: "الإغلاق التلقائيّ عند الرفض",
    wave: "م2",
    supports: ["OFF", "ON"],
    offMeans: "الرفض يمرّ بمسار المرتجع/الإلغاء اليدويّ الحاليّ بخطواته كاملةً.",
  },
  /** م٢ — مكوّنٌ واحد لاختيار مصدر ردّ المال (درج · خزينة · بطاقة). */
  refundRailPicker: {
    env: "ROLLOUT_REFUND_RAIL_PICKER",
    label: "منتقي مصدر ردّ المال الموحّد",
    wave: "م2",
    supports: ["OFF", "ON"],
    offMeans: "كل شاشةٍ تختار مصدر الردّ بطريقتها الحالية.",
  },
  /** م٢ — «الخطوة التالية ومالكها» على كل مستند. */
  nextAction: {
    env: "ROLLOUT_NEXT_ACTION",
    label: "الخطوة التالية ومالكها",
    wave: "م2",
    supports: ["OFF", "ON"],
    offMeans: "لا رقاقةَ خطوةٍ تالية؛ المستخدم يستنتج وجهته كما اليوم.",
  },
} as const satisfies Record<string, RolloutFlagSpec>;

export type RolloutFlagKey = keyof typeof ROLLOUT_FLAGS;

export const ROLLOUT_FLAG_KEYS = Object.keys(ROLLOUT_FLAGS) as RolloutFlagKey[];

/** هل القيمة وضعُ طرحٍ صالح؟ */
export function isRolloutMode(value: unknown): value is RolloutMode {
  return typeof value === "string" && (ROLLOUT_MODES as readonly string[]).includes(value);
}

/**
 * يحلّ وضعَ علَمٍ من قيمةٍ خامّة (متغيّر بيئة عادةً).
 *
 * **يفشل مغلقاً في كل الحالات الملتبسة** — وهذا جوهرُ النظام: قيمةٌ غائبة أو فارغة أو
 * مكتوبةٌ خطأً أو وضعٌ لا يدعمه العلَم ⇒ `OFF`. لا نُخمّن نيّةَ من كتب `ROLLOUT_X=on`
 * بحروفٍ صغيرة… بل نقبلها بعد التطبيع، ونرفض ما لا نفهمه.
 *
 * والسببُ يُعاد مع النتيجة لا يُبتلَع: تقريرُ الحالة يجب أن يقول **لماذا** علَمٌ مطفأ،
 * وإلّا أمضى أحدٌ ساعةً يبحث عن ميزةٍ ظنّها مفتوحة.
 */
export function resolveRolloutMode(
  key: RolloutFlagKey,
  raw: string | undefined | null,
): { mode: RolloutMode; reason: "default" | "explicit" | "unsupported" | "invalid" } {
  const spec = ROLLOUT_FLAGS[key];
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { mode: "OFF", reason: "default" };

  const normalized = trimmed.toUpperCase();
  if (!isRolloutMode(normalized)) return { mode: "OFF", reason: "invalid" };
  // التوسيع مقصود: `as const` يضيّق `supports` إلى صفّ حرفيّ لكل علَمٍ على حدة، فيرفض
  // `includes` وسماً خارجه. والسؤال هنا **وقتُ تشغيل** لا وقتُ ترجمة — نفحص قيمةً جاءت
  // من البيئة، ورفضُ المترجم لها هو بالضبط الحالة التي نريد كشفها لا منعَ فحصها.
  const supported = spec.supports as readonly RolloutMode[];
  if (!supported.includes(normalized)) return { mode: "OFF", reason: "unsupported" };
  return { mode: normalized, reason: "explicit" };
}

/** نصٌّ عربيٌّ يشرح سببَ الوضع — يُعرَض في تقرير الحالة وفي مراجعة النشر. */
export function rolloutReasonLabel(
  key: RolloutFlagKey,
  reason: "default" | "explicit" | "unsupported" | "invalid",
): string {
  const spec = ROLLOUT_FLAGS[key];
  switch (reason) {
    case "default":
      return `مطفأ (الافتراض) — ${spec.env} غير مضبوط.`;
    case "explicit":
      return `مضبوطٌ صراحةً عبر ${spec.env}.`;
    case "unsupported":
      return `مطفأ — الوضع المطلوب لا يدعمه هذا العلَم (المدعوم: ${spec.supports.join(" · ")}).`;
    case "invalid":
      return `مطفأ — قيمةُ ${spec.env} غير مفهومة (المقبول: ${ROLLOUT_MODES.join(" · ")}).`;
  }
}

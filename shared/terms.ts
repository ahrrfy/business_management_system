/**
 * terms — القاموسُ الموحَّد لمفهومَين اثنين لا غير: **القناة** و**طريقة الدفع** (٢/٩/٢٦).
 *
 * ═══════════════════════ لماذا وُجد هذا الملفّ ═══════════════════════
 * القياسُ الذي سبقه (جردٌ على الشيفرة لا تقدير):
 *   · **القناة** مُعرَّفةٌ **سبعَ مرّات** في المخطّط والمشترَك — إحداها **نسخةٌ حرفية** من أخرى
 *     (`tasks.sourceChannel` ≡ `conversations.convChannel`، والتعليقُ فوقها يقولها صراحةً:
 *     «نَفس تِعداد convChannel»). سبعةُ تعدادات ⇒ سبعُ قوائم قيمٍ مختلفة الطول والترتيب.
 *   · **طريقةُ الدفع** مُعرَّفةٌ **١٤ مرّة** في `client/**` وحدها (زائدَ ٣ في `server/**`)،
 *     وقد **انحرفت فعلاً** — لا نظرياً: خمسُ قيمٍ تحمل اسمَين مختلفَين أو أكثر (الجدول أدناه).
 *
 * القاموسُ هذا **إضافةٌ لا هدم**: لم يُحذَف قاموسٌ قائم ولم يُعدَّل. الوصلُ (استهلاكُ الشاشات
 * منه) وتقاعدُ القواميس المنجرفة **موجةٌ لاحقة** — وهذا الجدولُ هو دليلُها.
 *
 * ═══════════════════════ جدول الانحرافات المرصودة ═══════════════════════
 * **أ) طريقة الدفع — قيمةٌ واحدة بأسماءٍ متعدّدة:**
 *
 * | القيمة   | الاسم                | الموضع (file:line)                                                       |
 * |----------|----------------------|--------------------------------------------------------------------------|
 * | CASH     | «نقدي»               | الأغلبيّة — `client/src/lib/paymentMethod.ts:18` وأحدَ عشرَ موضعاً غيره     |
 * | CASH     | «نقداً»              | `client/src/pages/Payroll.tsx:75`                                        |
 * | CASH     | «نقداً من الدرج»     | `client/src/components/hr/EmployeeAdvanceRepaymentPanel.tsx:67` · `client/src/components/returns/ReturnComposer.tsx:40` |
 * | CASH     | «نقداً من الخزينة»   | `client/src/lib/terminationSettlement.ts:96`                             |
 * | CASH     | «النقد»              | `client/src/pages/Reconcile.tsx:839`                                     |
 * | CARD     | «بطاقة»              | الأغلبيّة                                                                 |
 * | CARD     | «بطاقة/حساب مصرفي»   | `client/src/pages/Payroll.tsx:75`                                        |
 * | CARD     | «على البطاقة»        | `client/src/components/returns/ReturnComposer.tsx:40`                    |
 * | CHECK    | «صك»                 | `client/src/lib/paymentMethod.ts:20` · `client/src/lib/printing/shiftRaster.ts:18` · `client/src/pages/CustomerStatement.tsx:73` · `server/services/treasury/helpers.ts:12` |
 * | CHECK    | «صكّ» (بشدّة)         | `client/src/components/vouchers/voucherUiPolicy.ts:74` — **حرفٌ واحد يفرّق** |
 * | TRANSFER | «تحويل»              | الأغلبيّة                                                                 |
 * | TRANSFER | «تحويل مصرفي»        | `client/src/components/vouchers/voucherUiPolicy.ts:75` · `client/src/pages/Payroll.tsx:75` · `EmployeeAdvanceRepaymentPanel.tsx:67` |
 * | WALLET   | «محفظة»              | الأغلبيّة                                                                 |
 * | WALLET   | «محفظة دفع»          | `client/src/pages/Payroll.tsx:75` · `EmployeeAdvanceRepaymentPanel.tsx:67` |
 *
 * **ب) طريقة الدفع — قاموسٌ ناقصٌ أو زائدٌ عن أخيه:**
 *   · `client/src/pages/Expenses.tsx:81` — أضاف **ACCRUAL** («استحقاق») وأسقط **TELECOM**
 *     و**EXCHANGE**. وهو الوحيدُ المحقّ في ACCRUAL: العمود `expenses.expensePaymentMethod`
 *     يحملها فعلاً بينما `receipts.paymentMethod` لا. ⇒ الاتّحادُ يلزمه القيمتان معاً.
 *   · `client/src/pages/PrintPOS.tsx:125` — ثلاثُ قيمٍ فقط (CASH/CARD/TRANSFER) بلا WALLET.
 *   · `client/src/components/financial/FinancialSourceBadge.tsx:44` — **يخلط مفهومَين** في
 *     قاموسٍ واحد: `DRAWER`/`TREASURY`/`BANK`/`STOCK` (مصدرُ المال) مع `CASH`/`CARD`/… (طريقتُه).
 *   · `client/src/pages/Purchases.tsx:57` — الرمزُ `CASH` نفسه يعني هناك **نوع التسوية**
 *     (نقدي مقابل آجل) لا طريقةَ الدفع. ⇒ عند الوصل: لا تُبدَّل هذه بقاموسنا.
 *
 * **ج) القناة — قيمةٌ واحدة باسمَين:**
 *
 * | القيمة  | الاسم           | الموضع                                                   |
 * |---------|-----------------|----------------------------------------------------------|
 * | WALK_IN | «حضوري»         | `shared/receptionChannel.ts:58` · `server/services/reportsProductionService.ts:247` |
 * | WALK_IN | «زيارة مباشرة»  | `shared/salesPipeline.ts:20`                              |
 * | PHONE   | «هاتف»          | `shared/receptionChannel.ts:62`                           |
 * | PHONE   | «اتصال هاتفي»   | `shared/salesPipeline.ts:21`                              |
 * | STORE   | «المتجر»        | `shared/receptionChannel.ts:63`                           |
 * | STORE   | «المتجر الإلكتروني» | `shared/invoiceChannel.ts:20` · `client/src/pages/Offers.tsx:47` |
 * | STORE   | «متجر webhook»  | `client/src/lib/integrationCenter.ts:35`                  |
 * | OTHER   | «أخرى»          | `shared/receptionChannel.ts:64` · `shared/invoiceChannel.ts:21` |
 * | OTHER   | «مصدر آخر»      | `shared/salesPipeline.ts:28`                              |
 *
 * ⇒ الموظّفُ يقرأ **اسمَين لشيءٍ واحد** بحسب الشاشة، وشاشةُ التقارير تُظهر «حضوري» بينما
 *   شاشةُ العملاء المحتملين تُظهر «زيارة مباشرة» لنفس الصفّ المُحوَّل — فيظنّهما مصدرَين.
 *
 * ═══════════════════════ لماذا `compact` بلا تشكيل ═══════════════════════
 * نفسُ سبب [`deliveryTerminology.ts`](./deliveryTerminology.ts) — وهو مقيسٌ لا مُفترَض: خطّ
 * الواجهة (Cairo/Tajawal) تحت 14px يرسم «مُ» كأنّها «ف» و«سُ» كأنّها «ش»، فقرأ موظّفٌ «سُلِّم»
 * «شلَم». الحارسُ `pnpm check:tashkeel` يفرض ذلك على الشارات ورؤوس الجداول.
 * ⇒ البنيةُ الثلاثيّة: `compact` (شارة/رأسُ عمود، بلا تشكيل) · `prose` (عنوان/فقرة، بتشكيل)
 *   · `tooltip` (خاصّية `title`، تظهر بحجمٍ نظاميّ أكبر فالتشكيل فيها مأمون).
 *
 * ⛔ لا إيموجي (حارس `check:emoji`) — الأيقونات أسماءُ `lucide-react` في قواميسها القائمة.
 */

/** البنيةُ الثلاثيّة لكلّ مصطلح — مطابقةٌ لـ`DeliveryTerm` عمداً (نمطٌ واحد في المستودع). */
export interface Term {
  /** للشارات ورؤوس الأعمدة بحجم < 14px — **بلا تشكيل** (يحرسه `check:tashkeel`). */
  compact: string;
  /** للعناوين والفقرات بحجم متوسّط فأكبر — بتشكيلٍ كامل حيث يُفيد. */
  prose: string;
  /** شرحٌ يظهر عند التحويم (خاصّية `title`) — يقول ما هو المفهوم وأين يُستعمَل. */
  tooltip: string;
}

/* ══════════════════════════════ ١) القناة ══════════════════════════════ */

/**
 * اتّحادُ القيم السبع بعد إزالة التكرار — **١٤ قيمة**.
 *
 * الترتيب مقصود: القنواتُ السبعُ المشتركة أوّلاً (وهي التي تتكرّر في أكثر من تعداد)، ثمّ
 * الأربعُ الخاصّةُ بالعملاء المحتملين، ثمّ الثلاثُ الخاصّةُ بقناة الفاتورة، و`OTHER` أخيراً
 * (المُلتقِطُ دائماً في ذيل أيّ قائمة اختيار).
 *
 * ⚠️ **الاتّحادُ ليس ترخيصاً بالكتابة:** لكلّ عمودٍ تعدادُه الضيّق في المخطّط، وكتابةُ
 * `FACEBOOK` على `workOrders.receptionChannel` تسقط بخطأ قاعدة. هذا القاموس **للعرض
 * والتسمية**؛ التضييقُ يبقى عند العمود (انظر `CHANNEL_SOURCE_ENUMS` أدناه).
 */
export const UNIFIED_CHANNELS = [
  // السبعُ المشتركة (يحملها `convChannel` و`sourceChannel` كاملةً).
  "WALK_IN",
  "PHONE",
  "WHATSAPP",
  "INSTAGRAM",
  "TIKTOK",
  "STORE",
  // الأربعُ الخاصّة بـ`salesLeads.source` (تسويقٌ لا استلامُ طلب).
  "FACEBOOK",
  "WEBSITE",
  "REFERRAL",
  "CAMPAIGN",
  // الثلاثُ الخاصّة بـ`shared/invoiceChannel.ts` (محطّةُ الإصدار لا مصدرُ الزبون).
  "RETAIL",
  "RECEPTION",
  "PRINT",
  "OTHER",
] as const;

export type UnifiedChannel = (typeof UNIFIED_CHANNELS)[number];

/**
 * **من أين جاءت كلُّ قيمة** — سجلٌّ يجعل الاتّحادَ قابلاً للإثبات لا للادّعاء، ويجعل أيَّ
 * توسيعٍ لتعدادٍ في المخطّط بلا تسميةٍ هنا **يسقط في الاختبار** بدل أن يظهر رمزاً إنجليزياً
 * خامّاً على شاشةٍ عربيّة.
 *
 * المفتاحُ اسمُ التعداد كما هو في `drizzle/schema.ts` (أو مسارُ الملفّ المشترَك).
 */
export const CHANNEL_SOURCE_ENUMS = {
  /** `workOrders.receptionChannel` — [drizzle/schema.ts:3872]. STORE غائبةٌ عمداً. */
  receptionChannel: ["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE", "OTHER"],
  /** `conversations.convChannel` — [drizzle/schema.ts:11357]. صندوقُ الوارد. */
  convChannel: ["WHATSAPP", "INSTAGRAM", "TIKTOK", "STORE", "PHONE", "WALK_IN", "OTHER"],
  /** `tasks.sourceChannel` — [drizzle/schema.ts:11702]. **نسخةٌ حرفية** من `convChannel`. */
  sourceChannel: ["WHATSAPP", "INSTAGRAM", "TIKTOK", "STORE", "PHONE", "WALK_IN", "OTHER"],
  /** `channelIntegrations.intChannel` — [drizzle/schema.ts:11484]. تكاملاتٌ لا قنواتُ زبون. */
  intChannel: ["WHATSAPP", "INSTAGRAM", "STORE"],
  /** `reservations.reservationChannel` — [drizzle/schema.ts:14502]. حجزُ البضاعة. */
  reservationChannel: ["PHONE", "WALK_IN", "WHATSAPP", "STORE"],
  /** `salesLeads.source` — [drizzle/schema.ts:16743]. مصدرُ العميل المحتمَل (تسويقيّ). */
  salesLeadSource: [
    "WALK_IN",
    "PHONE",
    "WHATSAPP",
    "INSTAGRAM",
    "FACEBOOK",
    "WEBSITE",
    "REFERRAL",
    "CAMPAIGN",
    "OTHER",
  ],
  /** `shared/invoiceChannel.ts` — اشتقاقٌ لا عمود: محطّةُ إصدار الفاتورة. */
  invoiceChannel: ["RETAIL", "RECEPTION", "PRINT", "STORE", "OTHER"],
} as const satisfies Record<string, readonly UnifiedChannel[]>;

/**
 * الاسمُ العربيُّ **الواحد** لكلّ قناة. حُسمت الأسماءُ المتنازَع عليها هكذا:
 *   · `WALK_IN` ⇒ «حضوري» (لا «زيارة مباشرة»): الأشيعُ في الشيفرة، والأقصرُ لرأس عمود.
 *   · `STORE` ⇒ «المتجر» في `compact` و«المتجر الإلكترونيّ» في `prose`: الطولُ هو الفرقُ
 *     الحقيقيّ بين القاموسَين لا المعنى، فحُفظ كلاهما في موضعه الصحيح بدل الاختيار بينهما.
 *   · `OTHER` ⇒ «أخرى» (لا «مصدر آخر»): محايدةٌ تصلح للقناة وللمصدر معاً.
 */
export const CHANNEL_TERMS: Record<UnifiedChannel, Term> = {
  WALK_IN: {
    compact: "حضوري",
    prose: "حضوريّ (زيارةٌ مباشرة)",
    tooltip: "الزبون جاء إلى المكتبة بنفسه. قناةُ وصولٍ لا علاقةَ لها بطريقة الدفع — الحضوريّ قد يشتري آجلاً.",
  },
  PHONE: {
    compact: "هاتف",
    prose: "اتّصالٌ هاتفيّ",
    tooltip: "الطلب وصل باتّصالٍ هاتفيّ. المعرّفُ المرافق هو رقم المتّصل.",
  },
  WHATSAPP: {
    compact: "واتساب",
    prose: "واتساب",
    tooltip: "الطلب وصل عبر واتساب. المعرّفُ المرافق هو رقم الواتساب الذي راسَلنا منه.",
  },
  INSTAGRAM: {
    compact: "إنستغرام",
    prose: "إنستغرام",
    tooltip: "الطلب وصل عبر رسائل إنستغرام. المعرّفُ المرافق هو اسم الحساب.",
  },
  TIKTOK: {
    compact: "تيك توك",
    prose: "تيك توك",
    tooltip: "الطلب وصل عبر رسائل تيك توك. المعرّفُ المرافق هو اسم الحساب.",
  },
  STORE: {
    compact: "المتجر",
    prose: "المتجر الإلكترونيّ",
    tooltip: "الطلب وصل من متجرنا الإلكترونيّ. المعرّفُ المرافق هو رقم الطلب في المتجر.",
  },
  FACEBOOK: {
    compact: "فيسبوك",
    prose: "فيسبوك",
    tooltip: "مصدرُ عميلٍ محتمَل جاء من فيسبوك. خاصٌّ بمسار العملاء المحتملين لا بأوامر الشغل.",
  },
  WEBSITE: {
    compact: "الموقع",
    prose: "الموقع الإلكترونيّ",
    tooltip: "مصدرُ عميلٍ محتمَل ملأ نموذجاً على الموقع. غيرُ «المتجر»: هذا استفسارٌ لا طلبُ شراء.",
  },
  REFERRAL: {
    compact: "ترشيح",
    prose: "ترشيحٌ من عميل",
    tooltip: "عميلٌ حاليّ رشَّح لنا هذا العميل المحتمَل. يُستعمَل في تقارير جودة المصادر.",
  },
  CAMPAIGN: {
    compact: "حملة",
    prose: "حملةٌ تسويقيّة",
    tooltip: "العميل المحتمَل جاء من حملةٍ تسويقيّة مدفوعة أو موسميّة. يُقاس به عائدُ الحملة.",
  },
  RETAIL: {
    compact: "كاشير التجزئة",
    prose: "كاشير التجزئة",
    tooltip: "الفاتورة صدرت من محطّة كاشير التجزئة. محطّةُ الإصدار لا مصدرُ الزبون.",
  },
  RECEPTION: {
    compact: "الاستقبال",
    prose: "كاشير الاستقبال",
    tooltip: "الفاتورة صدرت من محطّة الاستقبال (أوامر الشغل والخدمات). محطّةُ الإصدار لا مصدرُ الزبون.",
  },
  PRINT: {
    compact: "المطبعة",
    prose: "كاشير المطبعة",
    tooltip: "الفاتورة صدرت من محطّة خدمات المطبعة. محطّةُ الإصدار لا مصدرُ الزبون.",
  },
  OTHER: {
    compact: "أخرى",
    prose: "قناةٌ أخرى",
    tooltip: "قناةٌ لا تندرج تحت المسمّياتِ أعلاه، أو قيمةٌ قديمة قبل ضبط القنوات.",
  },
};

/* ══════════════════════ ٢) طريقة الدفع ══════════════════════ */

/**
 * اتّحادُ طرق الدفع بعد إزالة التكرار — **٩ قيم**.
 *
 * الترتيب مقصود: الأربعُ المفعَّلةُ للقبض أوّلاً (نقد · بطاقة · تحويل · محفظة — نفسُ ترتيب
 * أزرار الكاشير)، ثمّ المقصورتان بمسارَيهما (`TELECOM` شاشةُ البطاقات الرقميّة، `EXCHANGE`
 * تسديدُ المورّد عبر الصيرفة)، ثمّ `CHECK` المرفوضةُ بقرار المالك، ثمّ القيمتان
 * **المشتقّتان** (`MIXED` و`ACCRUAL`) اللتان لا يختارهما كاشيرٌ من شاشة.
 */
export const UNIFIED_PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "TRANSFER",
  "WALLET",
  "TELECOM",
  "EXCHANGE",
  "CHECK",
  "MIXED",
  "ACCRUAL",
] as const;

export type UnifiedPaymentMethod = (typeof UNIFIED_PAYMENT_METHODS)[number];

/**
 * **من أين جاءت كلُّ قيمة** — نفسُ غرض `CHANNEL_SOURCE_ENUMS`: توسيعُ عمودٍ بلا تسميةٍ هنا
 * يسقط في الاختبار بدل أن يُعرَض رمزاً إنجليزياً خامّاً (وهي العلّةُ التي أصابت `EXCHANGE`
 * فعلاً حتى أُضيفت إلى `client/src/lib/paymentMethod.ts`).
 */
export const PAYMENT_METHOD_SOURCE_ENUMS = {
  /** `receipts.paymentMethod` — [drizzle/schema.ts:2547]. التعدادُ الأوسعُ للإيصالات. */
  receiptPaymentMethod: ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "EXCHANGE", "TELECOM"],
  /** `expenses.expensePaymentMethod` — [drizzle/schema.ts:3666]. وحدَه يحمل `ACCRUAL`. */
  expensePaymentMethod: ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "ACCRUAL"],
  /** `workOrders.woPaymentMethod` — [drizzle/schema.ts:3890]. طريقةُ **العربون** وحده. */
  woPaymentMethod: ["CASH", "CARD", "TRANSFER", "WALLET", "TELECOM"],
  /** `externalPaymentAttempts.externalPaymentMethod` — [drizzle/schema.ts:3294]. غيرُ النقد. */
  externalPaymentMethod: ["CARD", "CHECK", "TRANSFER", "WALLET"],
  /**
   * `invoices.paymentMethod` — عمودُ `varchar(20)` لا تعداد، تكتبه الخدمة. `MIXED` قيمةُ
   * **عرضٍ مشتقّة** عند تعدّد روافد السداد؛ لا شاشةَ تُرسلها ولا كاشيرَ يختارها.
   */
  invoicePaymentMethod: ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM", "MIXED"],
} as const satisfies Record<string, readonly UnifiedPaymentMethod[]>;

/**
 * الاسمُ العربيُّ **الواحد** لكلّ طريقة. حُسمت الأسماءُ المتنازَع عليها هكذا:
 *   · `CASH` ⇒ «نقدي» في `compact` — لا «نقداً من الدرج» ولا «نقداً من الخزينة»: هاتان
 *     تخلطان **الطريقة** بـ**الوعاء** (`cashBucket`)، والوعاءُ عمودٌ مستقلٌّ له تسميتُه.
 *   · `CHECK` ⇒ «صك» بلا شدّة (الشدّةُ تشكيلٌ يسقط في الشارة).
 *   · `TRANSFER` ⇒ «تحويل» في `compact` و«تحويل مصرفيّ» في `prose`: الطولُ هو الفرق.
 *   · `CARD` ⇒ «بطاقة» — لا «بطاقة/حساب مصرفي»: الشرطةُ المائلة في رأس عمودٍ تُقرأ خيارَين.
 */
export const PAYMENT_METHOD_TERMS: Record<UnifiedPaymentMethod, Term> = {
  CASH: {
    compact: "نقدي",
    prose: "نقداً",
    tooltip: "قبضٌ أو صرفٌ نقديّ. الوحيدُ الذي يمسّ الدرج أو الخزينة — الوعاءُ يحدّده cashBucket لا الطريقة.",
  },
  CARD: {
    compact: "بطاقة",
    prose: "بطاقةٌ مصرفيّة",
    tooltip: "دفعٌ ببطاقةٍ عبر جهاز نقاط البيع. لا يمسّ درج الكاشير (cashBucket يبقى فارغاً) ويلزمه إثباتٌ بآخر أربعة أرقام.",
  },
  TRANSFER: {
    compact: "تحويل",
    prose: "تحويلٌ مصرفيّ",
    tooltip: "حوالةٌ مصرفيّة إلى حسابنا. لا تمسّ الدرج، ويلزمها مرجعٌ نصّيّ يثبت الحوالة.",
  },
  WALLET: {
    compact: "محفظة",
    prose: "محفظةٌ إلكترونيّة",
    tooltip: "دفعٌ عبر محفظةٍ إلكترونيّة. لا يمسّ الدرج، ويلزمه مرجعُ العمليّة من تطبيق المحفظة.",
  },
  TELECOM: {
    compact: "رصيد زين",
    prose: "رصيد زين",
    tooltip: "أكوادُ كروت شحن زين — «زين حصراً» بنيوياً: لا حقلَ لمزوّدٍ آخر. حسابٌ مشتقّ يُسوّى دورياً ولا يلمس الدرج أبداً.",
  },
  EXCHANGE: {
    compact: "صيرفة",
    prose: "صيرفة",
    tooltip: "سندُ صرفٍ عبر مكتب الصيرفة لتسديد مورّد. طريقةٌ خادميّةٌ بحتة لا يختارها كاشيرٌ من شاشة، ولا تمسّ الدرج ولا الخزينة.",
  },
  CHECK: {
    compact: "صك",
    prose: "صكّ",
    tooltip: "صكٌّ مصرفيّ. مرفوضٌ بقرار المالك «لا تعامل بالصكوك» — يبقى في القاموس لتعريب صفوفٍ قديمة لا لعرضه خياراً.",
  },
  MIXED: {
    compact: "مختلطة",
    prose: "طرقٌ مختلطة",
    tooltip: "الفاتورة سُدّدت بأكثر من رافد (نقدٌ وتحويلٌ مثلاً). قيمةُ عرضٍ مشتقّة تكتبها الخدمة — لا يختارها كاشيرٌ ولا تُرسَل في حمولة دفع.",
  },
  ACCRUAL: {
    compact: "استحقاق",
    prose: "قيدُ استحقاق",
    tooltip: "مصروفٌ اعتُرف به محاسبياً بلا خروج نقدٍ بعد. خاصٌّ بجدول المصروفات وحدَه — لا وجودَ له في الإيصالات.",
  },
};

/* ══════════════════════ دوالُّ الوصول ══════════════════════ */

export function isUnifiedChannel(v: unknown): v is UnifiedChannel {
  return typeof v === "string" && (UNIFIED_CHANNELS as readonly string[]).includes(v);
}

export function isUnifiedPaymentMethod(v: unknown): v is UnifiedPaymentMethod {
  return typeof v === "string" && (UNIFIED_PAYMENT_METHODS as readonly string[]).includes(v);
}

/**
 * مصطلحُ القناة — أو `null` حين تكون القيمةُ فارغة.
 *
 * ⚠️ **لا افتراضَ لـ`WALK_IN` عند NULL هنا** خلافاً لـ`receptionChannelLabel`: ذاك الافتراض
 * ملكُ العمود (`workOrders.receptionChannel` قيمتُه الافتراضيّة `WALK_IN` في المخطّط) لا ملكُ
 * المفهوم. صفٌّ من `tasks.sourceChannel` بـNULL يعني «مهمّةٌ داخليّة بلا قناة» — تسميتُها
 * «حضوري» كذبٌ صريح. كلُّ مستهلكٍ يقرّر افتراضَه بنفسه.
 * والقيمةُ غيرُ المعروفة (صفٌّ قديم) تُطوى إلى `OTHER` بدل عرض رمزٍ إنجليزيّ خامّ.
 */
export function channelTerm(v: string | null | undefined): Term | null {
  if (v == null || v === "") return null;
  return isUnifiedChannel(v) ? CHANNEL_TERMS[v] : CHANNEL_TERMS.OTHER;
}

/** نسخةُ الشارة/رأس العمود (بلا تشكيل) — «—» حين لا قناة. */
export function channelCompact(v: string | null | undefined): string {
  return channelTerm(v)?.compact ?? "—";
}

/** نسخةُ العنوان/الفقرة (بتشكيل) — «—» حين لا قناة. */
export function channelProse(v: string | null | undefined): string {
  return channelTerm(v)?.prose ?? "—";
}

/** شرحُ التحويم (خاصّية `title`) — سلسلةٌ فارغة حين لا قناة (فلا يُعرَض tooltip فارغ). */
export function channelTooltip(v: string | null | undefined): string {
  return channelTerm(v)?.tooltip ?? "";
}

/**
 * خياراتٌ جاهزةٌ لمُنتقٍ — **مرِّر تعدادَ عمودك** (`CHANNEL_SOURCE_ENUMS.receptionChannel`
 * مثلاً) ولا تمرّر الاتّحادَ كلَّه: كتابةُ قيمةٍ خارج تعداد العمود تسقط بخطأ قاعدة.
 */
export function channelTermOptions(
  only?: readonly UnifiedChannel[],
): { value: UnifiedChannel; compact: string; prose: string; tooltip: string }[] {
  return (only ?? UNIFIED_CHANNELS).map((value) => ({ value, ...CHANNEL_TERMS[value] }));
}

/** مصطلحُ طريقة الدفع — `null` حين تكون القيمةُ فارغةً أو غيرَ معروفة. */
export function paymentMethodTerm(v: string | null | undefined): Term | null {
  if (v == null || v === "") return null;
  return isUnifiedPaymentMethod(v) ? PAYMENT_METHOD_TERMS[v] : null;
}

/**
 * نسخةُ الشارة/رأس العمود. السلوكُ عند المجهول **مطابقٌ عمداً** لـ`paymentMethodLabel`
 * القائمة في `client/src/lib/paymentMethod.ts`: «—» للفارغ، والرمزُ نفسُه للمجهول — كي يكون
 * الوصلُ في الموجة اللاحقة **حافظاً للسلوك** لا مُحدِثاً لانحدارٍ صامت في صفوفٍ قديمة.
 */
export function paymentMethodCompact(v: string | null | undefined): string {
  if (v == null || v === "") return "—";
  return paymentMethodTerm(v)?.compact ?? v;
}

/** نسخةُ العنوان/الفقرة (بتشكيل) — نفسُ سياسة المجهول أعلاه. */
export function paymentMethodProse(v: string | null | undefined): string {
  if (v == null || v === "") return "—";
  return paymentMethodTerm(v)?.prose ?? v;
}

/** شرحُ التحويم — سلسلةٌ فارغة للفارغ والمجهول (فلا يُعرَض tooltip فارغ ولا كاذب). */
export function paymentMethodTooltip(v: string | null | undefined): string {
  return paymentMethodTerm(v)?.tooltip ?? "";
}

/**
 * خياراتٌ جاهزةٌ لمُنتقٍ — **مرِّر تعدادَ عمودك أو سياسةَ القبض**
 * (`INBOUND_ENABLED_PAYMENT_METHODS`) ولا تمرّر الاتّحادَ كلَّه: فيه `MIXED` و`ACCRUAL`
 * المشتقّتان و`CHECK` المرفوضةُ بقرار المالك — عرضُها خيارٌ بصفر مسار نجاح.
 */
export function paymentMethodTermOptions(
  only?: readonly UnifiedPaymentMethod[],
): { value: UnifiedPaymentMethod; compact: string; prose: string; tooltip: string }[] {
  return (only ?? UNIFIED_PAYMENT_METHODS).map((value) => ({ value, ...PAYMENT_METHOD_TERMS[value] }));
}

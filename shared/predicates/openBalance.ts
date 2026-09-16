/**
 * openBalance — **رصيد الفاتورة المفتوح**: مصدر الحقيقة الوحيد لصيغة
 * `total − paidAmount − returnedTotal`.
 *
 * **الجذر:** المسند مكتوبٌ بيدٍ في أكثر من عشرين موضعاً (SQL خامّ، وقوالب drizzle، وحسابات
 * decimal.js)، وقد **انحرف فعلاً**: بعضُها يقصّه بـ`GREATEST(…,0)` وبعضُها يتركه موقَّعاً،
 * وترتيبُ الطرح يختلف، ومجموعةُ الحالات المستبعَدة تختلف بين الموضع وأخيه في **نفس الدالّة**.
 * كلُّ استعلامٍ جديدٍ يُعيد كتابته يبدأ عمرَه بفرصةٍ جديدةٍ للانحراف.
 *
 * ⛔ **هذه الوحدة تبني المسند فقط — لا تصلح شيئاً.** المواضع المنحرفة المرصودة أدناه
 * تُترك **كما هي**: توحيدُها تغييرُ سلوكٍ ماليّ (أرقامٌ يراها المالك تتغيّر) يقرّره المالك
 * لا وكيلٌ عابر. وصلُ المستهلكين شريحةٌ مستقلّة بقرارٍ صريح.
 *
 * ---
 * ## الصيغة المعتمَدة (مُستخرَجة من الشيفرة لا من التوقّع)
 *
 *   رصيد مفتوح = total − paidAmount − returnedTotal
 *
 * وهي حرفياً ما يقوله تعليق العمود في `drizzle/schema.ts` (تحت `invoices.returnedTotal`):
 * «AR الحقيقي للفاتورة = max(total − paidAmount − returnedTotal, 0)».
 *
 * ## وضعان — والاختيار بينهما ليس ذوقاً
 *
 * ١) **`COLLECTIBLE`** (مقصوص بـ`GREATEST(…, 0)`) — «كم يصحّ أن نطالب العميل به الآن؟».
 *    القصُّ إلزاميّ هنا: الدفع الزائد **مسموحٌ في هذا النظام** (قرار مالك سارٍ)، والفاتورة
 *    المُرتجَعة بعد قبضها تُنتج قيمةً سالبة — وجمعُ سالبٍ في دلو تقادُم (aging) يُنقص ذمّةَ
 *    فاتورةٍ أخرى مستحقّة فيُظهر العميل أقلّ مديونيةً ممّا هو. رصيدُ العميل الدائن يُعالَج على
 *    بطاقته (`customers.currentBalance`) لا بأن يُخصم من فاتورةٍ لا علاقة له بها.
 *    ⇒ هذا وضعُ التقارير والدلاء والفلاتر والتحصيل.
 *
 * ٢) **`SIGNED`** (بلا قصّ) — «هل يطابق المشتقُّ رصيداً **موقَّعاً** مخزَّناً؟».
 *    القصُّ هنا **عطبٌ**: `customers.currentBalance` مصدرٌ موقَّع قد يكون سالباً (دفعٌ زائد أو
 *    مرتجعٌ نقديّ)، فقصُّ الطرف المشتقّ عند الصفر يُنتج «انحرافاً وهمياً» في كل حالةٍ مشروعة.
 *    وهو الدرس المكتوب صراحةً في `server/services/reconcileService.ts:491-493`
 *    («السابق استعمل GREATEST(.,0) … فأنتج انحرافاً وهمياً»).
 *    ⇒ هذا وضعُ المطابقة (reconcile) وكلّ من يقارن بمصدرٍ موقَّع.
 *
 * ## ولكلّ وضعٍ **مجموعةُ حالاتٍ مستبعَدة** ترافقه — لا تُخلَط
 * راجع `shared/invoiceStatus.ts`: `DEAD_INVOICE_STATUSES` و`VOIDED_INVOICE_STATUSES`
 * **ليستا مترادفتين**، والفارق `RETURNED`.
 *  • `COLLECTIBLE` ⇒ `DEAD_INVOICE_STATUSES` (CANCELLED · RETURNED · SUPERSEDED): مستندٌ ميت
 *    لا يقبل تحصيلاً جديداً. و`SUPERSEDED` أخطرها: `correct.ts` يُبقي `total` كاملاً و**يُصفّر**
 *    `returnedTotal` ⇒ الأصلُ يبدو مستحقّاً بكامل قيمته لكل قارئٍ غافل.
 *  • `SIGNED` ⇒ `VOIDED_INVOICE_STATUSES` (CANCELLED · SUPERSEDED **دون** RETURNED): استبعادُ
 *    `RETURNED` هنا يُسقِط طرفَ `−paidAmount` الدائن لعميلٍ قُبِضت منه فاتورةٌ ثمّ أُرجِعت
 *    بالكامل ⇒ انحرافٌ بمقدار ما قبضناه. (تحت القصّ لا يظهر الفرق: القيمة سالبةٌ فتُقصّ إلى
 *    صفر أصلاً — ولهذا يُغري الخلطُ ولا يُمسَك إلّا في الوضع الموقَّع.)
 *
 * ---
 * ## جردُ الانحراف المرصود (١/٩/٢٦) — **موثَّقٌ لا مُصلَح**
 *
 * ### أ) قصٌّ أم لا — الشكل نفسه يختلف
 *  • `server/services/reconcileService.ts:564-578` — **بلا `GREATEST`** (موقَّع) واستبعادٌ
 *    بـ`NOT IN ('CANCELLED','SUPERSEDED')`. ⇒ ليس عطباً: هو `SIGNED` بعينه، ومُعلَّلٌ في رأس
 *    الدالّة. أُدرِج هنا لأنّ من يقرأ «كلُّ المواضع تقصّ إلّا هذا» يظنّه سهواً فيوحّده — فيُعيد
 *    إنتاج الانحراف الوهميّ الذي أُغلق.
 *  • `server/routers/saleRouter.ts:1156-1157` — `dueAmount` في رأس القائمة **بلا قصّ**
 *    واستبعادٌ `NOT IN ('CANCELLED','SUPERSEDED')`، بينما صفوفُ نفس الشاشة تُفلتَر بمسندٍ
 *    مقصوصٍ ضمنياً (`> 0`) وباستبعاد `DEAD`. ⇒ رأسٌ يجمع سالباً على موجب، وصفوفٌ لا تعرض
 *    السالب أصلاً: **الرأس لا يساوي مجموع صفوفه** على عميلٍ دُفِع له زائداً.
 *
 * ### ب) الفرع اليتيم بلا فلتر الحالة الميتة
 *  • `server/routers/saleRouter.ts:365-369` — `balanceState = "DEPOSIT_DUE"` **وحده بلا**
 *    `notInArray(invoices.status, DEAD_INVOICE_STATUSES)`، بينما إخوته الثلاثة في نفس السلسلة
 *    يحملونه: `OUTSTANDING` (:373) · `UNPAID` (:378) · `SETTLED` (:382).
 *    ⇒ فلترُ «عربونٌ مستحقّ تكملته» يُظهر فاتورةَ أمرِ شغلٍ **مُلغاةً أو مُستبدَلة** قُبِض
 *    عربونُها، فيُطالَب زبونٌ بتكملة مستندٍ ميت.
 *    ⚠️ **والفجوةُ أضيقُ ممّا تبدو، فلا تُصلَح بمثالٍ مستحيل:** الفرعُ يشترط
 *    `paidAmount > 0` (`saleRouter.ts:367`). و`SUPERSEDED` **لا تعبر أبداً** لأنّ
 *    `sale/correct.ts:409` يُصفّر `paidAmount` مع `returnedTotal` معاً. و`RETURNED`
 *    مرتجعةٌ بالكامل ⇒ المسند `= −paidAmount ≤ 0` فتسقط على `> 0`. يبقى **`CANCELLED`
 *    وحدها** — وحافّتُها **أضيقُ ممّا قيل هنا أوّلاً، والحسابُ الأوّل كان خاطئاً**
 *    (أمسكته مراجعةٌ عدائية ٢/٩/٢٦؛ صُحِّح بقراءة [`sale/cancel.ts`](../../server/services/sale/cancel.ts)):
 *      `newPaid = paid − refund` **مقصوصاً عند صفر**، و`newRet = ret + remainingAmount`
 *      ⇒ المسند `= refund − paid`، وبعد القصّ **`= 0`**.
 *    أي أنّ `CANCELLED` **لا تعبر `> 0`** إلّا حين ينجرف `invoices.returnedTotal` عن مجموع
 *    قيود `RETURN`. فالفجوةُ مشروطةٌ بانجرافِ بيانات، لا بمسارٍ طبيعيّ.
 *    ⚠️ وتُرك هذا الجردُ مصحَّحاً لا محذوفاً عمداً: ملفٌّ وظيفتُه أن يُبنى عليه لاحقاً، ورقمٌ
 *    خاطئٌ فيه يشيخ ويُضلّل مَن يقيس عليه — وهو أخطرُ من غياب السطر.
 *  • `server/routers/saleRouter.ts:376-377` — فرع `UNPAID` يكتب المسند ناقصاً
 *    (`total − returnedTotal`) لا كاملاً؛ مكافئٌ حسابياً **فقط** لاقترانه بشرط `paidAmount = 0`
 *    في السطر الذي قبله. مكافأةٌ هشّة: من يحذف الشرط أو يعيد ترتيب السطرين يكسر المعنى بلا أن
 *    يلمس المسند نفسه.
 *
 * ### ج) مجموعةُ حالاتٍ ثالثة لا هي `DEAD` ولا `VOIDED`
 *  • `server/services/customerOperationsService.ts:198` و`server/services/reportsAlertsService.ts:315`
 *    — `NOT IN ('CANCELLED','RETURNED')` ⇒ **`SUPERSEDED` غائبة** فتعبر الفاتورةُ المستبدَلة.
 *    (هما على «آخر شراء» ومجاميع بنودٍ لا على المسند نفسه، لكنّهما نفسُ الانزلاق: قائمةُ حالاتٍ
 *    مكتوبةٌ بيدٍ بدل استهلاك القاموس — وهو ما حذّر منه رأس `invoiceStatus.ts` حرفياً.)
 *
 * ### د) قائمةٌ **بيضاء** أضيق من «غير ميت»
 *    ثمانيةُ مواضع تُفلتر بـ`invoiceStatus IN ('PENDING','PARTIALLY_PAID')` بدل استبعاد الميت:
 *    `reports/arAging.ts:86` · `reports/arAging.ts:463` (النظير بـTS) ·
 *    `reportsAgingDetailService.ts:91` · `reportsCreditExposureService.ts:~105` ·
 *    `reports/dashboard.ts:178` · `reportsAlertsService.ts:145` ·
 *    `customerOperationsService.ts:184,191` · `routers/superAppRouter.ts:232`.
 *    ⇒ تُسقِط `CONFIRMED` — وهي حالةٌ في الـenum قد تحمل رصيداً مفتوحاً كاملاً. مخفَّفٌ أثرُها
 *    بأنّ `computeInvoiceStatus` لا تُنتجها أبداً (`ledgerService.ts:342-356`)، لكنّها تُكتَب
 *    مباشرةً في مساراتٍ أخرى ⇒ الاعتمادُ على ذلك ضمانٌ ظرفيّ لا بنيويّ.
 *
 * ### هـ) ترتيبُ الطرح — لا أثر حسابيّ، لكنّه يُصعّب المطابقة بالعين
 *    `total − returnedTotal − paidAmount` في `delivery/dispatchInvoice.ts:228` ·
 *    `delivery/settle.ts:392` · `delivery/courier.ts:1365` · `installment/plan.ts:150`،
 *    مقابل `total − paidAmount − returnedTotal` في `sale/controlRequests.ts:284` ·
 *    `deliveryLegacyRepairService.ts:361,496,954`.
 *    الطرحُ تجميعيّ فالنتيجة واحدة؛ لكنّ هذه المواضع **موقَّعةٌ كلُّها** ثمّ يتصرّف كلٌّ منها في
 *    السالب بطريقته: `dispatchInvoice` يرفض برسالة، و`settle` يقصّ سطرياً، و`plan` يرفض بـ`lte(0)`،
 *    و`deliveryLegacyRepairService` **يقصّ** — مواضعُه الثلاثة (`:361` · `:496` · `:954`)
 *    ملفوفةٌ كلُّها بـ`DecimalMaxZero` (`:983`) وهي `GREATEST(…,0)` حرفياً. ويبقى
 *    `controlRequests.ts:284` وحده بلا قصٍّ ولا رفض — ومستهلكُه الوحيد `outstanding.gt(0)`
 *    فالسالبُ لا أثرَ له عملياً.
 *
 * ---
 * ⚠️ **هذه الوحدة تستورد `drizzle-orm`** ⇒ لا تستوردها من `client/**` (تجرّ الـORM إلى حزمة
 * المتصفّح). الجزء الحسابيّ (`openBalanceOf`) نقيٌّ بـdecimal.js ويصلح للطرفين لو فُصل لاحقاً.
 */
import Decimal from "decimal.js";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { DEAD_INVOICE_STATUSES, VOIDED_INVOICE_STATUSES } from "../invoiceStatus";

/** دقّة أعمدة المال في المخطّط: `decimal(15,2)`. تُثبَّت هنا كي يتطابق طرفا الصيغة رقماً برقم. */
export const OPEN_BALANCE_PRECISION = 15;
export const OPEN_BALANCE_SCALE = 2;

/** وضعا المسند. الاختيار بينهما موصوفٌ في رأس الملفّ — وليس ذوقاً. */
export const OPEN_BALANCE_MODES = ["COLLECTIBLE", "SIGNED"] as const;
export type OpenBalanceMode = (typeof OPEN_BALANCE_MODES)[number];

/**
 * **الثابت المُصرَّح: هل يُلفّ بـ`GREATEST(…, 0)`؟**
 *  • `COLLECTIBLE = true` — يصحّ حين يُجمَع المسند أو يُقارَن بصفر: دلاء التقادم، «المتبقّي»،
 *    فلاتر التحصيل، سقوف الردّ. السالبُ هنا ليس ديناً على العميل بل دَينٌ **لنا عليه** لا يجوز
 *    أن يُخصم من فاتورةٍ أخرى — مكانه بطاقة العميل.
 *  • `SIGNED = false` — يصحّ حين يُقارَن المسند بمصدرٍ **موقَّع** (`customers.currentBalance`)
 *    أو حين يكون السالبُ نفسه هو المعلومة المطلوبة (كم دُفِع زائداً). القصُّ هنا يخترع انحرافاً.
 * ⛔ لا وضعَ ثالث: استعمالٌ لا ينطبق عليه أحدهما فهو سؤالٌ مختلف لا صيغةٌ ثالثة لهذا المسند.
 */
export const OPEN_BALANCE_CLAMPED: Record<OpenBalanceMode, boolean> = {
  COLLECTIBLE: true,
  SIGNED: false,
};

/** الوضع الافتراضي: المقصوص. أغلبُ القرّاء تقاريرُ ودلاء، وخطؤه أهونُ من خطأ العكس. */
export const OPEN_BALANCE_DEFAULT_MODE: OpenBalanceMode = "COLLECTIBLE";

/**
 * مجموعةُ الحالات المستبعَدة المرافقة لكلّ وضع — من `shared/invoiceStatus.ts` لا مكتوبةً بيد.
 * الفارق `RETURNED`، وسببُ الفارق مشروحٌ في رأس الملفّ.
 *
 * ⚠️ هذه **مرافِقةٌ للمسند لا جزءٌ منه**: `openBalanceExpr` لا يحقنها في التعبير (التعبيرُ
 * يُستعمَل في `SELECT` كما في `WHERE`، وحقنُ شرطِ حالةٍ داخل قيمةٍ يُنتج تعبيراً لا يُقرأ).
 * المستدعي يضيفها شرطاً مستقلّاً — واشتقاقُها من هنا يمنع النسخ اليدويّ الذي أنتج الانحراف (ج).
 */
// ⚠️ `as const satisfies` لا توصيفٌ صريح: التوصيف بـ`readonly string[]` **يوسّع** الأنواع
// الحرفية فيرفض `notInArray(invoices.status, [...])` بـTS2769 — أي أنّ المُصدَّر الموضوع
// لمنع النسخ اليدويّ يصير غيرَ قابلٍ للاستعمال، فيعود المستدعي إلى النسخ. أمسكه فحصُ أنواع.
export const OPEN_BALANCE_EXCLUDED_STATUSES = {
  COLLECTIBLE: DEAD_INVOICE_STATUSES,
  SIGNED: VOIDED_INVOICE_STATUSES,
} as const satisfies Record<OpenBalanceMode, readonly string[]>;

/** هل تُستبعَد هذه الحالة من المسند في هذا الوضع؟ (نظيرُ الشرط أعلاه لصفٍّ محمَّل في TS). */
export function isOpenBalanceExcludedStatus(
  status: string | null | undefined,
  mode: OpenBalanceMode = OPEN_BALANCE_DEFAULT_MODE,
): boolean {
  // التوسيع مقصود ومعكوسُ اتّجاهِ التصريح أعلاه: هناك نحتاج الأنواعَ الحرفيةَ ليقبلها
  // `notInArray`، وهنا نفحص حالةً **وقت تشغيل** جاءت من صفٍّ محمَّل أو من مدخلٍ خارجيّ —
  // ورفضُ المترجم لها هو الحالةُ التي نريد كشفها لا منعَ فحصها.
  const excluded = OPEN_BALANCE_EXCLUDED_STATUSES[mode] as readonly string[];
  return status != null && excluded.includes(status);
}

/**
 * أعمدةُ المسند الثلاثة كما يمرّرها المستدعي — عمودُ drizzle أو أيّ جزء `sql`.
 * ⛔ **لا تستورد هذه الوحدة `drizzle/schema.ts`** عمداً: تبقى نقيّةً فتصلح للاستعلام على
 * `invoices` باسمٍ مستعار (`i.total` في SQL خامّ) كما تصلح على الجدول مباشرةً.
 */
export type OpenBalanceColumns = {
  total: SQLWrapper;
  paidAmount: SQLWrapper;
  returnedTotal: SQLWrapper;
};

/**
 * تعبيرُ SQL للرصيد المفتوح.
 *
 * الشكلُ المولَّد (وضع `COLLECTIBLE`):
 *   `GREATEST(CAST(<total> AS DECIMAL(15,2)) - CAST(<paid> AS DECIMAL(15,2)) - CAST(<ret> AS DECIMAL(15,2)), 0)`
 *
 * **لماذا `CAST` صريحٌ ثلاث مرّات** وأعمدةُ المخطّط `decimal(15,2)` أصلاً: التعبيرُ يُستعمَل
 * أيضاً فوق أعمدةٍ عابرةٍ من `LEFT JOIN` أو جدولٍ مشتقّ حيث قد يستنتج MySQL نوعاً مضاعفاً
 * (`DOUBLE`) فيتسرّب خطأُ فاصلةٍ عائمة إلى مال. التثبيتُ الصريح يجعل الحساب عشرياً دقيقاً أياً
 * كان مصدرُ العمود — وهو أيضاً ما يجعل النظيرَ بـdecimal.js مطابقاً تماماً (اختبار التكافؤ).
 *
 * ⛔ **بلا `COALESCE` داخل التعبير**: `GREATEST(NULL, 0)` في MySQL = `NULL`، وكلُّ المواضع
 * القائمة تعتمد أنّ `SUM`/`MAX` يتجاهلان NULL لصفِّ عميلٍ بلا فواتير (`LEFT JOIN`). حقنُ
 * `COALESCE` هنا يقلب دلالة `IS NULL` عند المستدعي. لفُّ الناتج بـ`COALESCE(…, 0)` **عند
 * التجميع** يبقى مسؤوليةَ المستدعي كما هو قائمٌ اليوم.
 */
export function openBalanceExpr(
  cols: OpenBalanceColumns,
  mode: OpenBalanceMode = OPEN_BALANCE_DEFAULT_MODE,
): SQL<string> {
  const dec = sql.raw(`DECIMAL(${OPEN_BALANCE_PRECISION},${OPEN_BALANCE_SCALE})`);
  const raw = sql<string>`CAST(${cols.total} AS ${dec}) - CAST(${cols.paidAmount} AS ${dec}) - CAST(${cols.returnedTotal} AS ${dec})`;
  return OPEN_BALANCE_CLAMPED[mode] ? sql<string>`GREATEST(${raw}, 0)` : raw;
}

/** صفُّ فاتورةٍ محمَّل (mysql2 يُرجع أعمدة `decimal` نصوصاً — ولذلك `string` أوّلاً). */
export type OpenBalanceRow = {
  total: string | number | Decimal | null | undefined;
  paidAmount: string | number | Decimal | null | undefined;
  returnedTotal?: string | number | Decimal | null | undefined;
};

/**
 * تحويلٌ إلى `Decimal` بدلالة عمودٍ `decimal(15,2)`.
 *
 * تقريبُ **المدخلات** صريحٌ (`ROUND_HALF_UP` على منزلتين) فلا يتّكل على `Decimal.set` العموميّ
 * في هذه الخطوة، وهو نفسُه ما يفعله `CAST(… AS DECIMAL(15,2))` في MySQL.
 * ⚠️ **لكنّ الاستقلال ليس تامّاً ولا يُدّعى:** نتيجةَ `minus` نفسها تخضع لـ`Decimal.precision`
 * العموميّ. لا عطبَ اليوم (`server/services/money.ts` يضبطها ٤٠، والافتراضيّ ٢٠، وكلاهما يسع
 * ١٥ رقماً)، لكنّ خفضَها دون ١٥ يُفسد الطرح على المبالغ الكبيرة — والادّعاءُ بضمانٍ لا نملكه
 * أسوأ من الاعتراف بالشرط.
 */
function toColumnDecimal(x: OpenBalanceRow[keyof OpenBalanceRow]): Decimal {
  if (x === null || x === undefined || x === "") return new Decimal(0);
  let d: Decimal;
  try {
    d = new Decimal(x as Decimal.Value);
  } catch {
    throw new Error(`قيمة مالية غير صالحة في مسند الرصيد المفتوح: ${String(x)}`);
  }
  if (!d.isFinite()) {
    throw new Error(`قيمة مالية غير صالحة في مسند الرصيد المفتوح: ${String(x)}`);
  }
  return d.toDecimalPlaces(OPEN_BALANCE_SCALE, Decimal.ROUND_HALF_UP);
}

/**
 * النظيرُ الحسابيّ لـ`openBalanceExpr` — **نفسُ الرقم** لنفس المدخلات (يُثبته اختبار التكافؤ
 * في `openBalance.test.ts`: يُصيّر تعبيرَ SQL نصّاً ثمّ يُقيّمه بدلالة MySQL ويقارن الطرفين).
 *
 * يُرجِع `Decimal` لا نصّاً: التسلسلُ إلى عمودٍ (`toDbMoney`) قرارُ المستدعي، وإرجاعُ نصٍّ من
 * هنا يُغري بمقارنة نصوصٍ حيث المطلوب مقارنةُ أرقام.
 *
 * ⚠️ **فرقٌ مقصود عن SQL في حالة NULL**: هنا `null` ⇒ صفر (الصفُّ محمَّلٌ فعلاً وأعمدتُه
 * `NOT NULL` في المخطّط)، بينما في SQL تنتشر `NULL` عبر التعبير (صفُّ `LEFT JOIN` بلا فاتورة).
 * الفرقُ خارج نطاق التكافؤ لأنّه ليس صفَّ فاتورةٍ أصلاً.
 */
export function openBalanceOf(
  row: OpenBalanceRow,
  mode: OpenBalanceMode = OPEN_BALANCE_DEFAULT_MODE,
): Decimal {
  const open = toColumnDecimal(row.total)
    .minus(toColumnDecimal(row.paidAmount))
    .minus(toColumnDecimal(row.returnedTotal));
  return OPEN_BALANCE_CLAMPED[mode] && open.isNegative() ? new Decimal(0) : open;
}

/** هل على الفاتورة رصيدٌ مفتوحٌ فعلاً؟ (`> 0` — المقارنةُ الوحيدة التي تصحّ في الوضعين). */
export function hasOpenBalance(
  row: OpenBalanceRow,
  mode: OpenBalanceMode = OPEN_BALANCE_DEFAULT_MODE,
): boolean {
  return openBalanceOf(row, mode).gt(0);
}

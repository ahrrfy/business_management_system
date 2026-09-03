/**
 * shared/batchDivisibility.ts — قاعدة **قابلية قسمة الدفعة** في الإنتاج بوصفة.
 * مصدر حقيقة واحد يستعمله الخادم (حارس الاستهلاك) والشاشتان (محرّر الوصفات + شاشة التشغيل).
 *
 * ## لماذا توجد هذه القاعدة أصلاً
 * المخزون في هذا النظام **عدد صحيح بالوحدة الأساس** (`branchStock.quantity`، وكل حركة عبر
 * `applyMovement` بـ`baseQuantity` صحيح). واستهلاك مكوّنٍ في تشغيلة = `qtyPerOutputBase × الدفعة`.
 * فإن كان المعامِل كسرياً، جاءت دفعاتٌ بعينها باستهلاكٍ كسريّ (نصف ورقة) — ولا سبيل لخصمه:
 * إمّا يُفسد الدفتر أو **يُقرَّب صامتاً**، والتقريب الصامت هو ما يمنعه مبدأ «لا وحدة تضيع بصمت».
 * ولذلك يرفض `runPreview` تلك الدفعة.
 *
 * ## الفخّ الذي جاءت هذه الوحدة لتغلقه
 * الرفض **ليس اختبار حجم بل اختبار باقي قسمة** — فهو غير تصاعديّ: الأصغر ليس أسلم.
 * معامِل `0.01` يقبل 100 و200 ويرفض 50 و150. فالمستعمل يرى «تعمل عند 100 فقط» ويستنتج
 * أنّ النظام محدود بـ100، والمواد متوفّرة تماماً. القاعدة هنا تحسب **المضاعف المطلوب**
 * صراحةً كي تُعلنه الشاشتان بدل أن يُكتشَف بالتجربة.
 *
 * ## الحدّ الأعلى مضمون
 * محرّر الوصفات يخزّن المعامِل بـ`toFixed(RECIPE_COEF_DECIMALS)` ⇒ كل المقامات تقسم
 * `10^4`، فأيّ `lcm` لها يقسمه أيضاً ⇒ المضاعف المطلوب **لا يتجاوز 10000 أبداً** بلا انفجار.
 */

/** أقصى منازل عشرية يخزّنها محرّر الوصفات لمعامِل المكوّن (`qtyPerOutputBase`). */
export const RECIPE_COEF_DECIMALS = 4;

/** أقصى مضاعفٍ ممكن — مقلوب أصغر حبيبة مخزَّنة (10^4). ثابتٌ مشتقّ لا مُختار. */
export const MAX_BATCH_MULTIPLE = 10 ** RECIPE_COEF_DECIMALS;

/*
 * حسابٌ بأعداد JS العادية لا BigInt: هدف tsc في هذا المستودع دون ES2020 (لا literals لـbigint)،
 * والمدى هنا آمنٌ بيقين — كل المقامات تقسم 10^4، و`lcm` بينها ≤ 10^8، والبسط الأكبر
 * يبقى دون `Number.MAX_SAFE_INTEGER` بمراتب.
 */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return (a / gcd(a, b)) * b;
}

/** منازل القيمة العشرية كنصّ (بلا Decimal — الوحدة نقيّة وبلا اعتماديات). */
function decimalPlaces(raw: string): number {
  const dot = raw.indexOf(".");
  if (dot < 0) return 0;
  return raw.slice(dot + 1).replace(/0+$/, "").length;
}

/**
 * أصغر عددٍ صحيح موجب `M` يجعل `coef × M` عدداً صحيحاً — أي **مقام المعامِل بعد الاختزال**.
 * أمثلة: `80 ⇒ 1` · `0.5 ⇒ 2` · `0.25 ⇒ 4` · `0.16 ⇒ 25` · `0.01 ⇒ 100`.
 * المعامِل غير الصالح (صفر/سالب/غير رقميّ) يُعيد 1 — القاعدة لا تُقحم رأيها على تحقّقٍ آخر.
 */
export function coefficientBatchMultiple(coef: string | number): number {
  const raw = String(coef).trim();
  if (!raw || !Number.isFinite(Number(raw)) || Number(raw) <= 0) return 1;
  const dp = Math.min(decimalPlaces(raw), RECIPE_COEF_DECIMALS);
  if (dp === 0) return 1;
  const denom = 10 ** dp;
  // البسط = المعامِل مضروباً في المقام، محسوباً **نصّياً** كي لا تُدخِل الفاصلة العائمة خطأً
  // (0.29 × 100 = 28.999999999999996 في الحساب العائم).
  const [intPart, fracPart = ""] = raw.split(".");
  const scaled = Number(intPart + fracPart.slice(0, dp).padEnd(dp, "0"));
  if (!Number.isSafeInteger(scaled)) return 1;
  const g = gcd(scaled, denom);
  return denom / (g === 0 ? 1 : g);
}

/**
 * المضاعف المطلوب للوصفة كاملةً = `lcm` مقامات كل مكوّناتها.
 * الوصفة بمعامِلات صحيحة كلّها ⇒ 1 (كل الدفعات صالحة).
 */
export function requiredBatchMultiple(coefficients: Array<string | number>): number {
  let acc = 1;
  for (const c of coefficients) {
    acc = lcm(acc, coefficientBatchMultiple(c));
    if (acc === 0) return 1;
  }
  return acc > 0 && acc <= MAX_BATCH_MULTIPLE ? acc : 1;
}

/** هل هذه الدفعة صالحة لهذه المعامِلات؟ */
export function isBatchDivisible(coefficients: Array<string | number>, batch: number): boolean {
  if (!Number.isInteger(batch) || batch <= 0) return false;
  return batch % requiredBatchMultiple(coefficients) === 0;
}

/** أكبر دفعةٍ صالحة لا تتجاوز سقفاً (تُستعمل لقصّ «الأقصى الممكن إنتاجه» على المضاعف). */
export function largestValidBatchAtMost(cap: number, multiple: number): number {
  const m = Number.isInteger(multiple) && multiple > 0 ? multiple : 1;
  if (!Number.isFinite(cap) || cap < m) return 0;
  return Math.floor(cap / m) * m;
}

/** جملة عربية جاهزة تشرح القيد — نصٌّ واحدٌ لا يُعاد صوغه في كل شاشة. */
export function batchMultipleNote(multiple: number): string | null {
  if (!Number.isInteger(multiple) || multiple <= 1) return null;
  return `هذه الوصفة تقبل دفعاتٍ مضاعفةً لـ${multiple} فقط (${multiple} · ${multiple * 2} · ${multiple * 3} …) — لأنّ أحد معامِلاتها كسريّ بالوحدة الأساس.`;
}

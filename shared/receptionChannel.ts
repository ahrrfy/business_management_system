/**
 * **قناة وصول الطلب** — قاموسٌ واحد يحكم التسمية (١٩/٨).
 *
 * كانت سبعةَ قواميس محلّية مُنجرفة على نفس عمود `workOrders.receptionChannel`، وثلاثةٌ منها
 * تسمّي `WALK_IN` **«عميل نقدي»** — وهو خلطٌ بين مفهومَين لا علاقة لأحدهما بالآخر:
 *   · **القناة** = من أين وصل الطلب (حضوراً · واتساب · إنستغرام · هاتفاً…).
 *   · **«عميل نقدي»** = `invoices.customerId IS NULL` (بيعٌ مكتمل التحصيل بلا صاحب ذمّة).
 * فزبونٌ جاء بنفسه واشترى **آجلاً** كانت شاشتُه تقول «عميل نقدي» في خانة القناة — شاشةٌ تكذب.
 * وبقيّةُ القواميس تختلف في التشكيل وحده («حُضوري» · «حضوري» · «حضور» · «مباشر») فيقرأ
 * الموظّف أربعةَ أسماء لشيءٍ واحد.
 *
 * ⛔ لا شاشة تُعيد تعريف هذا القاموس محلّياً — يحرسه `receptionChannel.test.ts`.
 * الأيقونات أسماءُ `lucide-react` (الواجهة تستوردها) لا إيموجي (حارس `check:emoji`).
 */
export const RECEPTION_CHANNELS = [
  "WALK_IN",
  "WHATSAPP",
  "INSTAGRAM",
  "TIKTOK",
  "PHONE",
  "STORE",
  "OTHER",
] as const;

export type ReceptionChannel = (typeof RECEPTION_CHANNELS)[number];

/**
 * القيم الستّ المسموحة على `workOrders.receptionChannel` بحكم المخطّط (`STORE` ليست منها —
 * تخصّ صندوق الوارد وحده). أيّ مُنتقٍ في شاشات أوامر الشغل يشتقّ خياراته من هذه بالضبط.
 */
export const WORK_ORDER_CHANNELS = [
  "WALK_IN",
  "WHATSAPP",
  "INSTAGRAM",
  "TIKTOK",
  "PHONE",
  "OTHER",
] as const satisfies readonly ReceptionChannel[];

/** الاسم العربيّ الوحيد لكل قناة. */
const LABELS: Record<ReceptionChannel, string> = {
  WALK_IN: "حضوري",
  WHATSAPP: "واتساب",
  INSTAGRAM: "إنستغرام",
  TIKTOK: "تيك توك",
  PHONE: "هاتف",
  STORE: "المتجر",
  OTHER: "أخرى",
};

/** اسم أيقونة `lucide-react` لكل قناة (تستوردها الواجهة بنفسها). */
const ICONS: Record<ReceptionChannel, string> = {
  WALK_IN: "Store",
  WHATSAPP: "MessageCircle",
  INSTAGRAM: "Instagram",
  TIKTOK: "Music2",
  PHONE: "Phone",
  STORE: "ShoppingBag",
  OTHER: "Circle",
};

/** ماذا يُكتب في حقل «المعرّف» المرافق للقناة (فارغ ⇒ لا حقل). */
const HANDLE_HINTS: Record<ReceptionChannel, string> = {
  WALK_IN: "",
  WHATSAPP: "رقم الواتساب",
  INSTAGRAM: "اسم الحساب",
  TIKTOK: "اسم الحساب",
  PHONE: "رقم المتّصل",
  STORE: "رقم الطلب",
  OTHER: "المصدر",
};

/** مثالُ الإدخال واتّجاهه لحقل المعرّف (فارغ ⇒ لا حقل — الحضوريّ بلا معرّف). */
const HANDLE_INPUT: Record<ReceptionChannel, { placeholder: string; dir: "ltr" | "rtl" }> = {
  WALK_IN: { placeholder: "—", dir: "rtl" },
  WHATSAPP: { placeholder: "+9647701234567", dir: "ltr" },
  INSTAGRAM: { placeholder: "@username", dir: "ltr" },
  TIKTOK: { placeholder: "@username", dir: "ltr" },
  PHONE: { placeholder: "+9647701234567", dir: "ltr" },
  STORE: { placeholder: "—", dir: "rtl" },
  OTHER: { placeholder: "—", dir: "rtl" },
};

export function receptionChannelHandleInput(v: string | null | undefined) {
  if (v != null && isReceptionChannel(v)) return HANDLE_INPUT[v];
  return HANDLE_INPUT.OTHER;
}

/** هل تحتاج هذه القناة حقلَ معرّف أصلاً؟ (الحضوريّ لا). */
export function receptionChannelNeedsHandle(v: string | null | undefined): boolean {
  return receptionChannelHandleHint(v) !== "";
}

export function isReceptionChannel(v: unknown): v is ReceptionChannel {
  return typeof v === "string" && (RECEPTION_CHANNELS as readonly string[]).includes(v);
}

/** التسمية العربية — تقبل NULL (الافتراضي `WALK_IN` كما في المخطّط) وأيّ قيمةٍ غريبة. */
export function receptionChannelLabel(v: string | null | undefined): string {
  if (v == null) return LABELS.WALK_IN;
  return isReceptionChannel(v) ? LABELS[v] : v;
}

export function receptionChannelIcon(v: string | null | undefined): string {
  if (v == null) return ICONS.WALK_IN;
  return isReceptionChannel(v) ? ICONS[v] : ICONS.OTHER;
}

export function receptionChannelHandleHint(v: string | null | undefined): string {
  if (v == null) return HANDLE_HINTS.WALK_IN;
  return isReceptionChannel(v) ? HANDLE_HINTS[v] : HANDLE_HINTS.OTHER;
}

/** خياراتٌ جاهزةٌ لأيّ مُنتقٍ في الواجهة — ترتيبٌ واحد في كل الشاشات. */
export function receptionChannelOptions<T extends ReceptionChannel = ReceptionChannel>(
  only?: readonly T[],
): {
  value: T;
  label: string;
  icon: string;
  handleHint: string;
  placeholder: string;
  dir: "ltr" | "rtl";
}[] {
  return ((only ?? RECEPTION_CHANNELS) as readonly T[]).map((v) => ({
    value: v,
    label: LABELS[v],
    icon: ICONS[v],
    handleHint: HANDLE_HINTS[v],
    placeholder: HANDLE_INPUT[v].placeholder,
    dir: HANDLE_INPUT[v].dir,
  }));
}

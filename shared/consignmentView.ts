/**
 * **حالة العرض الموحّدة للإرسالية** — القاموس الوحيد الذي يقول للموظّف «أين طردي ومَن الكرة
 * بملعبه» (٢٢/٨).
 *
 * لماذا اشتقاقٌ مركّب لا عموداً جديداً: الحقيقة موزّعة أصلاً على أربعة أعمدة
 * (`parcelStatus` × `consignmentStatus` × `moneyStatus` × `returnDeclaredAt`) **وطبيعة الجهة**
 * (لها بوّابة مندوب أم كيانُ بياناتٍ يُثبِت بالكشف) — وكلُّ شاشةٍ كانت ستركّبها بقاموسها الخاصّ
 * فتنجرف حتماً (درس القواميس السبعة في `receptionChannel`). السياق الإنتاجيّ: ٧٩/٨٤ طرداً
 * «مُسنَداً» لجهاتٍ بلا بوّابة، أي أنّ التقدّم لن يأتي أبداً من مندوبٍ لا يملك حساباً —
 * التمييز بين «مُسنَد — لم يخرج» (بوّابة ستُحدِّث) و«بانتظار كشف الشركة» (الموظّف يجب أن
 * يُدخِل الكشف) هو جوهرُ هذا القاموس.
 *
 * ⛔ لا شاشة تُعيد تعريف هذا القاموس محلّياً — يحرسه `consignmentView.test.ts`.
 */

export type ConsignmentViewKey =
  | "RETURN_DECLARED"
  | "FAILED"
  | "DELIVERED_AWAITING_REMIT"
  | "IN_TRANSIT"
  | "AWAITING_STATEMENT"
  | "ASSIGNED"
  | "CLOSED";

export interface ConsignmentViewInput {
  parcelStatus: string | null;
  /** حالة الإغلاق (`deliveryConsignments.status` — عمود DB الخام `consignmentStatus`). */
  status: string | null;
  moneyStatus: string | null;
  /** ختمُ إعلان الرجوع — **يبقى بعد استلام المرتجع** (أثرٌ تاريخيّ لا حالة). */
  returnDeclaredAt: unknown;
  /** هل للجهة أعضاء بوّابة؟ (`hasPortalAccess` من `parties.ts` — يصل رقماً من SQL أحياناً). */
  partyHasPortal: boolean | number | null;
}

/** حالتا الإرسالية الحيّتان — ما عداهما مستندٌ منتهٍ لا ينتظر فعلاً من أحد. */
const LIVE_STATUSES = ["DISPATCHED", "PARTIAL"] as const;

export function deriveConsignmentView(r: ConsignmentViewInput): ConsignmentViewKey {
  // حارس الحياة أوّلاً: `returnDeclaredAt` لا يُمسَح عند استلام المرتجع (status=RETURNED)،
  // فبدونه تبقى الإرسالية المُستلَمة «بانتظار المرتجع» إلى الأبد — قاموسٌ يكذب.
  // (درس [[read-every-writer-before-you-rely-on-a-field]]: اقرأ مَن يكتب الحقل قبل البناء عليه.)
  if (!LIVE_STATUSES.includes(r.status as (typeof LIVE_STATUSES)[number])) return "CLOSED";
  if (r.returnDeclaredAt != null) return "RETURN_DECLARED";
  if (r.parcelStatus === "FAILED") return "FAILED";
  // سُلِّم فعلاً والإغلاق لم يكتمل ⇒ النقد بيد الجهة بانتظار التوريد (الحيّ هنا DISPATCHED/PARTIAL).
  if (r.parcelStatus === "DELIVERED") return "DELIVERED_AWAITING_REMIT";
  if (r.parcelStatus === "ACCEPTED" || r.parcelStatus === "PICKED_UP" || r.parcelStatus === "OUT_FOR_DELIVERY") {
    return "IN_TRANSIT";
  }
  if (r.parcelStatus === "ASSIGNED") {
    // جهةٌ بلا بوّابة لن «تقبل» الطرد أبداً — الحقيقة ستأتي من كشفها المستنديّ لا من مندوب.
    return r.partyHasPortal ? "ASSIGNED" : "AWAITING_STATEMENT";
  }
  return "CLOSED";
}

/**
 * التسمية العربية المعتمدة — `ASSIGNED` تُطابق `WO_DELIVERY_STATE_AR` حرفياً (اسمٌ واحد للشيء الواحد).
 *
 * Slice DFP2 (٣١/٨/٢٦): التسميات بلا تشكيل (شارات صغيرة ١١-١٢px):
 *   خطّ الواجهة يرسم «مُ + كلمة» + تشكيل كأنّه «ف + كلمة» في الحجم الصغير
 *   («سُلِّم» → «شلَم»، «مُسنَد» → «فسند»). المصطلحات الأدبيّة (بتشكيل كامل) في
 *   `shared/deliveryTerminology.ts.prose` للعناوين والفقرات ذات الحجم الأكبر.
 */
export const CONSIGNMENT_VIEW_AR: Record<ConsignmentViewKey, string> = {
  RETURN_DECLARED: "بانتظار المرتجع",
  FAILED: "تعذر التسليم",
  DELIVERED_AWAITING_REMIT: "سلم — بانتظار التوريد",
  IN_TRANSIT: "بالطريق",
  AWAITING_STATEMENT: "بانتظار كشف الشركة",
  ASSIGNED: "مسند — لم يخرج",
  CLOSED: "مغلقة",
};

export function consignmentViewLabel(key: ConsignmentViewKey): string {
  return CONSIGNMENT_VIEW_AR[key];
}

/** توكنز دلالية (حارس `check:colors`): info للمنتظر فعلَنا، warn لما هو خارج أيدينا، danger للمتعثّر، ok للمُسلَّم. */
export const CONSIGNMENT_VIEW_CLS: Record<ConsignmentViewKey, string> = {
  RETURN_DECLARED: "border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  FAILED: "border-[var(--sem-danger)]/45 bg-[var(--sem-danger-bg)] text-[var(--sem-danger)]",
  DELIVERED_AWAITING_REMIT: "border-[var(--sem-ok)]/45 bg-[var(--sem-ok-bg)] text-[var(--sem-ok)]",
  IN_TRANSIT: "border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  AWAITING_STATEMENT: "border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  ASSIGNED: "border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  CLOSED: "border-border bg-muted text-muted-foreground",
};

/**
 * ترتيب العرض في الطوابير: الأحوجُ لقرارٍ أوّلاً (متعثّر ← مرتجع منتظَر ← نقدٌ خارج المكتبة ←
 * ما ينتظر إدخال الموظّف ← ما ينتظر الجهة) — لا الترتيبَ الزمنيّ لدورة الحياة.
 */
export const CONSIGNMENT_VIEW_ORDER: readonly ConsignmentViewKey[] = [
  "FAILED",
  "RETURN_DECLARED",
  "DELIVERED_AWAITING_REMIT",
  "AWAITING_STATEMENT",
  "ASSIGNED",
  "IN_TRANSIT",
  "CLOSED",
];

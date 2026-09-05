/**
 * shared/capabilities.ts — طبقة القدرات الدقيقة (module:action) — ش٥ RBAC.
 *
 * ⚠️ **مؤجَّلة التفعيل بقرار المالك** (٢٤/٧): هذا الملف **نموذجٌ وسقالة مُختبَرة فقط**، غير موصولٍ
 * بأي بوّابة إنفاذ بعد. ما دام العلَم `RBAC_CAPABILITIES` معطَّلاً (الافتراضي) فالإنفاذ يبقى على مستوى
 * الوحدة (FULL/READ/NONE) حرفياً كما هو — **صفر أثر سلوكيّ**. تفعيله ترقيةٌ يقوم بها المالك بوعي:
 * وضع ظِلّ تدقيقيّ ← فحص AND مزدوج ← قلب العلَم بيئةً-بيئةً (dt→staging→prod).
 *
 * الفكرة: FULL على وحدةٍ يمنح **قدراتها غير الحسّاسة** تلقائياً؛ أمّا الحسّاسة (إلغاء بيع، اعتماد صرف،
 * اعتماد تسوية…) فتتطلّب **منحاً صريحاً** — فيُبنى «بيع بلا إلغاء» و«خزينة بلا اعتماد» (المستحيل اليوم).
 * والفشل مغلق: عند رفع العلَم، دورٌ بلا grants صريحة (capabilityGrants=NULL) تُغلَق قدراته الحسّاسة
 * حتى لو الوحدة FULL — لا تُشتقّ من FULL (تصحيح المراجعة العدائية: قلب العلَم لا يمنح طمأنينة كاذبة).
 */

import { resolvePermissions, type AccessLevel, type PermissionMap, type RoleKey } from "./permissions";

export type CapabilityAction = string; // "sell" | "void" | "voucher.approve" | ...
export type CapabilityKey = string;    // "sales:void" — `${module}:${action}`

export interface Capability {
  key: CapabilityKey;
  module: string;
  action: CapabilityAction;
  /** المستوى الأدنى للوحدة الذي يشتقّ هذه القدرة تلقائياً (غير الحسّاسة فقط). */
  minLevel: AccessLevel;
  /** قدرةٌ حسّاسة (إلغاء/اعتماد/شطب) — لا تُشتقّ من FULL، تتطلّب منحاً صريحاً. */
  sensitive: boolean;
  /** مجموعة فصل المهام — قدرتان في نفس المجموعة بأزواج SOD_CONFLICTS لا تجتمعان في دورٍ واحد. */
  sodGroup?: string;
  label: string;
}

/** كتالوج القدرات — يفصل التشغيل عن الإجراء المديريّ الذي يفتحه اليوم FULL دفعةً. (* = حسّاسة.) */
export const CAPABILITIES: Capability[] = [
  // المبيعات (تجزئة)
  { key: "sales:view", module: "sales", action: "view", minLevel: "READ", sensitive: false, label: "عرض المبيعات" },
  { key: "sales:sell", module: "sales", action: "sell", minLevel: "FULL", sensitive: false, label: "إصدار فاتورة بيع" },
  { key: "sales:return", module: "sales", action: "return", minLevel: "FULL", sensitive: false, label: "مرتجع بيع" },
  { key: "sales:pay", module: "sales", action: "pay", minLevel: "FULL", sensitive: false, label: "تحصيل دفعة" },
  { key: "sales:void", module: "sales", action: "void", minLevel: "FULL", sensitive: true, label: "إلغاء فاتورة *" },
  // نقطة البيع (خدمات الطباعة)
  { key: "pos:view", module: "pos", action: "view", minLevel: "READ", sensitive: false, label: "عرض نقطة البيع" },
  { key: "pos:sell", module: "pos", action: "sell", minLevel: "FULL", sensitive: false, label: "بيع خدمات طباعة" },
  { key: "pos:pricing.view", module: "pos", action: "pricing.view", minLevel: "FULL", sensitive: false, label: "تسعير الطباعة" },
  // أوامر الشغل (استقبال)
  { key: "workorders:view", module: "workorders", action: "view", minLevel: "READ", sensitive: false, label: "عرض أوامر الشغل" },
  { key: "workorders:receive", module: "workorders", action: "receive", minLevel: "FULL", sensitive: false, label: "استقبال أمر شغل" },
  { key: "workorders:deliver", module: "workorders", action: "deliver", minLevel: "FULL", sensitive: false, label: "تسليم وفوترة" },
  { key: "workorders:cancel", module: "workorders", action: "cancel", minLevel: "FULL", sensitive: true, label: "إلغاء أمر شغل *" },
  // الخزينة — فصل مهام حرِج
  { key: "treasury:view", module: "treasury", action: "view", minLevel: "READ", sensitive: false, label: "عرض الخزينة" },
  { key: "treasury:shift.open", module: "treasury", action: "shift.open", minLevel: "READ", sensitive: false, label: "فتح وردية" },
  { key: "treasury:shift.close", module: "treasury", action: "shift.close", minLevel: "READ", sensitive: false, label: "إغلاق وردية" },
  { key: "treasury:voucher.create", module: "treasury", action: "voucher.create", minLevel: "FULL", sensitive: false, sodGroup: "voucher", label: "إنشاء سند" },
  { key: "treasury:voucher.approve", module: "treasury", action: "voucher.approve", minLevel: "FULL", sensitive: true, sodGroup: "voucher", label: "اعتماد سند *" },
  { key: "treasury:transfer", module: "treasury", action: "transfer", minLevel: "FULL", sensitive: true, label: "تحويل نقديّ *" },
  // المخزون — فصل مهام
  { key: "inventory:view", module: "inventory", action: "view", minLevel: "READ", sensitive: false, label: "عرض المخزون" },
  { key: "inventory:movement.create", module: "inventory", action: "movement.create", minLevel: "FULL", sensitive: false, label: "حركة مخزون" },
  { key: "inventory:adjust.request", module: "inventory", action: "adjust.request", minLevel: "FULL", sensitive: false, sodGroup: "invAdjust", label: "طلب تسوية مخزون" },
  { key: "inventory:adjust.approve", module: "inventory", action: "adjust.approve", minLevel: "FULL", sensitive: true, sodGroup: "invAdjust", label: "اعتماد تسوية مخزون *" },
  { key: "inventory:stocktake.create", module: "inventory", action: "stocktake.create", minLevel: "FULL", sensitive: false, sodGroup: "stocktake", label: "إنشاء جرد" },
  { key: "inventory:stocktake.approve", module: "inventory", action: "stocktake.approve", minLevel: "FULL", sensitive: true, sodGroup: "stocktake", label: "اعتماد جرد *" },
  // المصروفات — فصل مهام
  { key: "expenses:create", module: "expenses", action: "create", minLevel: "FULL", sensitive: false, sodGroup: "expenses", label: "إدخال مصروف" },
  { key: "expenses:approve", module: "expenses", action: "approve", minLevel: "FULL", sensitive: true, sodGroup: "expenses", label: "اعتماد مصروف *" },
  // العمولات — فصل مهام
  { key: "commissions:view", module: "commissions", action: "view", minLevel: "READ", sensitive: false, label: "عرض العمولات" },
  { key: "commissions:run.compute", module: "commissions", action: "run.compute", minLevel: "FULL", sensitive: false, sodGroup: "commissions", label: "احتساب عمولة" },
  { key: "commissions:run.approve", module: "commissions", action: "run.approve", minLevel: "FULL", sensitive: true, sodGroup: "commissions", label: "اعتماد عمولة *" },
  // التقارير — فصل رؤية التكلفة
  { key: "reports:view", module: "reports", action: "view", minLevel: "READ", sensitive: false, label: "عرض التقارير" },
  { key: "reports:cost.view", module: "reports", action: "cost.view", minLevel: "READ", sensitive: true, label: "رؤية التكلفة/الربح *" },
];

export const CAPABILITY_BY_KEY: Record<CapabilityKey, Capability> =
  Object.fromEntries(CAPABILITIES.map((c) => [c.key, c]));

/**
 * أزواج فصل المهام ذات **المنع الصلب** (منشئ+معتمِد في دورٍ واحد ممنوع). قرار المالك يؤكّد القائمة.
 * تُستعمَل في باني الأدوار لرفض حفظ توليفةٍ سامّة، وفي التحقّق الخادميّ عند التفعيل.
 */
export const SOD_CONFLICTS: [CapabilityKey, CapabilityKey][] = [
  ["treasury:voucher.create", "treasury:voucher.approve"],
  ["commissions:run.compute", "commissions:run.approve"],
  ["inventory:adjust.request", "inventory:adjust.approve"],
  ["inventory:stocktake.create", "inventory:stocktake.approve"],
  ["expenses:create", "expenses:approve"],
];

export interface CapabilityGrants {
  allow?: CapabilityKey[];
  deny?: CapabilityKey[];
}

/**
 * يحلّ القدرات الفعّالة لدورٍ من خريطته الوحدية + منح/سلب صريح (capabilityGrants).
 *  - كل قدرةٍ **غير حسّاسة** يحقّق مستوى وحدتها minLevel ⇒ مُمنوحة تلقائياً.
 *  - القدرات **الحسّاسة** لا تُشتقّ من FULL أبداً ⇒ تتطلّب `allow` صريحاً (فشلٌ مغلق).
 *  - `deny` يتجاوز أي منح (اشتقاقاً أو allow).
 *  - grants=null/undefined (دور «غير مُهاجَر») ⇒ الحسّاس مغلقٌ كليّاً، وغير الحسّاس بالاشتقاق فقط.
 */
export function resolveCapabilities(
  moduleMap: Record<string, AccessLevel>,
  grants?: CapabilityGrants | null,
): Set<CapabilityKey> {
  const out = new Set<CapabilityKey>();
  const level = (m: string): AccessLevel => moduleMap[m] ?? "NONE";
  const satisfies = (lvl: AccessLevel, min: AccessLevel) =>
    lvl === "FULL" || (min === "READ" && lvl === "READ");

  for (const cap of CAPABILITIES) {
    if (!cap.sensitive && satisfies(level(cap.module), cap.minLevel)) out.add(cap.key);
  }
  for (const key of grants?.allow ?? []) {
    const cap = CAPABILITY_BY_KEY[key];
    // منح صريح لقدرةٍ حسّاسة (أو غيرها) — مشروطٌ بأن الوحدة تحقّق مستواها (لا منح فوق وحدةٍ محجوبة).
    if (cap && satisfies(level(cap.module), cap.minLevel)) out.add(key);
  }
  for (const key of grants?.deny ?? []) out.delete(key);
  return out;
}

/** هل يملك هذا (الخريطة + المنح) هذه القدرة فعلاً؟ */
export function hasCapability(
  moduleMap: Record<string, AccessLevel>,
  grants: CapabilityGrants | null | undefined,
  key: CapabilityKey,
): boolean {
  return resolveCapabilities(moduleMap, grants).has(key);
}

/** يكشف توليفات SoD السامّة داخل مجموعة قدرات فعّالة — يعيد الأزواج المتعارضة (للرفض/التحذير). */
export function detectSodConflicts(effective: Set<CapabilityKey>): [CapabilityKey, CapabilityKey][] {
  return SOD_CONFLICTS.filter(([a, b]) => effective.has(a) && effective.has(b));
}

/**
 * هل طبقة القدرات مُفعَّلة؟ العلَم البيئيّ `RBAC_CAPABILITIES=1`. الافتراضي **معطَّل** ⇒ الإنفاذ على
 * مستوى الوحدة حرفياً (صفر أثر). لا يُقرأ إلا خادمياً؛ العميل يستعمل القيمة المُمرَّرة من الخادم.
 */
export function capabilitiesEnabled(env?: Record<string, string | undefined>): boolean {
  const e = env ?? (typeof process !== "undefined" ? process.env : undefined);
  return e?.RBAC_CAPABILITIES === "1" || e?.RBAC_CAPABILITIES === "true";
}

/**
 * هل يعمل **تحقّق القدرات الظِلّيّ** (م٨)؟ مصدره وضعُ الظلّ الموثَّق `AUTHZ_ENGINE=shadow` («يحسب
 * ويسجّل بلا إنفاذ» — docs/authz/15-rollout-plan.md §15.2). **آمنُ التفعيل**: الظلّ لا يغيّر قرار
 * البوّابة إطلاقاً (يسجّل التباين/فوات التغطية فقط)، فتفعيلُه لا يُفعّل أيّ سقالةِ إنفاذٍ ناقصة.
 *
 * ⚠️ منفصلٌ **عمداً** عن `capabilitiesEnabled()` (علَم الإنفاذ `RBAC_CAPABILITIES` الذي **يبقى معطَّلاً**
 * — §15.2): كان الظلّ مربوطاً بذاك العلَم فصار جمعُ التتبّع يتطلّب علَماً يُمنَع المشغّلون من رفعه (سقالةٌ
 * ناقصةٌ بلا عمود `capabilityGrants`). تصحيحُ مراجعة Codex على PR #1026: الظلّ الآن على `AUTHZ_ENGINE=shadow`،
 * والإنفاذُ المستقبليّ يبقى على `RBAC_CAPABILITIES` منفصلاً ⇒ مسارُ جمع التتبّع الموثَّق قابلٌ للتنفيذ فعلاً.
 */
export function capabilityShadowEnabled(env?: Record<string, string | undefined>): boolean {
  const e = env ?? (typeof process !== "undefined" ? process.env : undefined);
  return (e?.AUTHZ_ENGINE ?? "").trim().toLowerCase() === "shadow";
}

/* ════════════════════════ م٨ — وصلُ القدرات كتحقّقٍ ظِلّيّ (صفر انحدار) ════════════════════════
 * الهدف: أن يُعيد نموذجُ القدرات إنتاجَ **قرار اليوم بالضبط** على مستوى الوحدة، فيُصبح جاهزاً للتفعيل
 * الواعي لاحقاً بلا مفاجآت. الوصلُ في الخادم يبقى **ظِلّاً**: يُستشار خلف علَمٍ معطَّلٍ افتراضياً ولا
 * يغيّر قرار البوّابة القائمة إطلاقاً (لا يوسّع الوصول ولا يضيّقه)، ويسجّل تبايناً حين يختلف. */

/**
 * يشتقّ منح القدرات لدورٍ من **خريطته الوحدية القائمة** — كي يُطابق `hasCapability` قرارَ البوّابة
 * الحاليّ لكلّ (وحدة، مستوى). السبب: اليوم، الوحدةُ عند FULL تفتح **كلّ** أفعالها بما فيها الحسّاسة
 * (إلغاء/اعتماد/تحويل — راجع `requireModuleGate` في server/trpc.ts). فنمنح كلّ قدرةٍ حسّاسةٍ صراحةً
 * حيثما وحدتُها FULL؛ وغيرُ الحسّاسة تُشتقّ تلقائياً من المستوى داخل `resolveCapabilities`. النتيجة:
 *   hasCapability(map, deriveCapabilityGrants(map), key) ≡ levelSatisfies(map[key.module], key.minLevel)
 * أي **نفس** قرار `requireModule` بالضبط لأيّ مفتاح قدرة.
 *
 * ⚠️ هذا **توثيقُ سلوك اليوم لا تضييقُه**: فصلُ الحسّاس عن FULL (بيعٌ بلا إلغاء) ترقيةٌ واعيةٌ لاحقة
 * (منحٌ/سلبٌ صريحٌ لكلّ دور)، خارج نطاق هذه الشريحة. المنح هنا مشتقٌّ آليّاً من الخريطة، لا سياسةٌ جديدة.
 */
export function deriveCapabilityGrants(moduleMap: Record<string, AccessLevel>): CapabilityGrants {
  const allow: CapabilityKey[] = [];
  for (const cap of CAPABILITIES) {
    if (cap.sensitive && (moduleMap[cap.module] ?? "NONE") === "FULL") allow.push(cap.key);
  }
  return { allow };
}

/** يشتقّ منح دورٍ قياسيّ (قالب + أوفررايد) — غلافٌ مريح فوق `deriveCapabilityGrants`. */
export function deriveGrantsForRole(
  role: RoleKey,
  override?: PermissionMap | null,
): CapabilityGrants {
  return deriveCapabilityGrants(resolvePermissions(role, override));
}

/**
 * قرارُ الوصول للوحدة كما يراه **نموذجُ القدرات** — تمثيلٌ ظِلّيٌّ لقرار `requireModule`/`moduleProcedure`
 * لكن مشتقٌّ من مجموعة القدرات الفعّالة لا من الخريطة مباشرةً (كي يكون النموذجُ مصدرَ الحقيقة عند التفعيل).
 *  - `minLevel==="READ"` ⇒ يكفي حيازةُ أيّ قدرة **عرضٍ غير حسّاسة** في الوحدة (`{module}:view`…).
 *  - `minLevel==="FULL"` ⇒ يكفي حيازةُ أيّ قدرة **كتابةٍ غير حسّاسة** FULL في الوحدة (أضعفُها كافٍ لتمثيل «كامل»).
 * يُعيد `null` حين تكون الوحدةُ/المستوى **غير مُغطّاةٍ** بكتالوج القدرات (لا مقارنةَ ممكنة) — لا `true/false` زوراً.
 * القدرات المستعمَلة للتمثيل **غير حسّاسة**، فقرارُها = `levelSatisfies(map[module], minLevel)` بالضبط، مستقلٌّ عن المنح.
 */
export function capabilityModuleDecision(
  moduleMap: Record<string, AccessLevel>,
  grants: CapabilityGrants | null | undefined,
  moduleKey: string,
  minLevel: AccessLevel,
): boolean | null {
  const rep = CAPABILITIES.filter(
    (c) =>
      c.module === moduleKey &&
      !c.sensitive &&
      (minLevel === "FULL" ? c.minLevel === "FULL" : c.minLevel === "READ"),
  );
  if (rep.length === 0) return null; // الوحدة/المستوى غير مُغطّى بالكتالوج ⇒ لا مقارنة
  const effective = resolveCapabilities(moduleMap, grants);
  return rep.some((c) => effective.has(c.key));
}

export interface ShadowGateDecision {
  /** القرار المُنفَّذ فعلاً — **دائماً** قرارُ البوّابة القائمة (م٨ ظِلٌّ لا إنفاذ). */
  allow: boolean;
  /** هل خالف نموذجُ القدرات القرارَ القائم (والعلَم مفعّل والوحدة مُغطّاة)؟ — للتسجيل لا للإنفاذ. */
  divergence: boolean;
}

/**
 * القرار الظِلّيّ الموحَّد الذي يستدعيه الخادم: القدرات **لا تفتح ولا تُغلق** في م٨ — `allow` يبقى
 * `gateAllowed` مهما كان قرارُ القدرات. نُعلّم `divergence` فقط حين يكون العلَمُ مفعّلاً والوحدةُ مُغطّاةً
 * والقراران مختلفَين، ليُسجَّل التباينُ ويُبنى عليه التضييقُ الواعي لاحقاً. دالّةٌ نقيّةٌ يختبرها التكافؤ.
 */
export function moduleGateShadowDecision(
  gateAllowed: boolean,
  capabilityAllowed: boolean | null,
  flagEnabled: boolean,
): ShadowGateDecision {
  const divergence = flagEnabled && capabilityAllowed !== null && capabilityAllowed !== gateAllowed;
  return { allow: gateAllowed, divergence };
}

/** ثلاثُ نتائجَ **متمايزة** للتحقّق الظِلّيّ لبوّابةٍ مفردة — تُميّز «فوات التغطية» عن «التطابق». */
export type CapabilityShadowOutcome = "uncovered" | "match" | "divergence";

/**
 * يصنّف نتيجة الظلّ لبوّابةٍ مفردة، ويستهلكه `auditCapabilityShadow` (server/trpc.ts) لإصدار الحدث
 * المناسب لكلٍّ منها:
 *  - `uncovered` — `capabilityAllowed===null`: الوحدة/المستوى **خارج كتالوج القدرات** (كلّ `purchases`،
 *    أو زوجٌ بلا فعلٍ ممثِّل مثل `expenses/READ` و`reports/FULL`) ⇒ لا مقارنةَ ممكنة. نُميّزه صراحةً كي
 *    لا يُحسَب غيرُ المُغطّى **تطابقاً مُتحقَّقاً** (فوات تغطية، لا نجاح) — المصفوفة تُغطّي جزءاً من المرور
 *    وحده، فتشغيلُ ظلٍّ قد يبدو نظيفاً وأغلبُ المرور لم يُقارَن قطّ.
 *  - `divergence` — القدراتُ تخالف البوّابة (الوحدة مُغطّاة) ⇒ يُسجَّل للتضييق الواعي لاحقاً.
 *  - `match` — القدراتُ تطابق البوّابة.
 * دالّةٌ نقيّةٌ يختبرها التكافؤ. لا تُغيّر أيَّ قرار (م٨ ظِلٌّ لا إنفاذ).
 */
export function classifyCapabilityShadow(
  gateAllowed: boolean,
  capabilityAllowed: boolean | null,
): CapabilityShadowOutcome {
  if (capabilityAllowed === null) return "uncovered";
  return capabilityAllowed === gateAllowed ? "match" : "divergence";
}

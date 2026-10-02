import type { TargetAndTransition } from "framer-motion";

/**
 * خريطة الحركات التفاعلية المستمرة والدقيقة لكل شعار وحدة (Continuous Physical Micro-Interactions):
 * تتميز كل حركة بالاستمرارية الحية أثناء التحويم (repeat: Infinity) والانسيابية العالية
 * مع احترام تفضيلات المستخدم لتقليل الحركة (prefers-reduced-motion).
 */
export const MODULE_ICON_HOVER_MOTIONS: Record<string, TargetAndTransition> = {
  // الإدارة والإعدادات (دوران ترسي ميكانيكي مستمر)
  settings: {
    rotate: [0, 360],
    transition: { duration: 4.5, repeat: Infinity, ease: "linear" },
  },

  // التوصيل (شاحنة تتحرك بانسيابية مع ارتجاج الطريق)
  delivery: {
    y: [0, -1.2, 0.6, -1, 0],
    x: [0, 1.2, -0.8, 1, 0],
    transition: { duration: 0.55, repeat: Infinity, ease: "easeInOut" },
  },

  // توصيلاتي (قفزات سريعة لطرد التوصيل)
  myDeliveries: {
    y: [0, -4, 0],
    scale: [1, 1.12, 1],
    transition: { duration: 1.0, repeat: Infinity, ease: "easeInOut" },
  },

  // بوابة المرتجعات (دوران لولبي مستمر للتدوير)
  returns: {
    rotate: [0, -360],
    transition: { duration: 2.0, repeat: Infinity, ease: "linear" },
  },

  // إعلانات وتوجيهات الشركة (رنين بندولي مستمر للجرس)
  announcements: {
    rotate: [0, -18, 16, -12, 10, -5, 0],
    transformOrigin: "50% 12%",
    transition: { duration: 1.1, repeat: Infinity, ease: "easeInOut" },
  },

  // الهدايا والمجانيات (اهتزاز مرح ومستمر لصندوق الهدية)
  gifts: {
    rotate: [0, -8, 8, -6, 6, 0],
    scale: [1, 1.1, 1.04, 1.08, 1],
    transition: { duration: 0.85, repeat: Infinity, ease: "easeInOut" },
  },

  // الصيرفة (دوران ثلاثي الأبعاد مستمر للعملة)
  exchange: {
    rotateY: [0, 180, 360],
    scale: [1, 1.14, 1],
    transition: { duration: 1.6, repeat: Infinity, ease: "easeInOut" },
  },

  // الإقفال والرقابة (نبض إغلاق وأمان محكم)
  closing: {
    y: [0, -3, 0],
    scale: [1, 0.92, 1.1, 1],
    transition: { duration: 1.3, repeat: Infinity, ease: "easeInOut" },
  },

  // مسودات المحتوى (نجوم تتلألأ وتدور ببريق مستمر)
  contentDrafts: {
    rotate: [0, 180, 360],
    scale: [1, 1.18, 0.94, 1.14, 1],
    transition: { duration: 2.4, repeat: Infinity, ease: "easeInOut" },
  },

  // المطبعة والإنتاج (حركة رأس الطباعة الأفقي)
  workOrders: {
    x: [-2, 2, -2, 2, 0],
    y: [0, -1, 0],
    transition: { duration: 0.6, repeat: Infinity, ease: "linear" },
  },

  // التقارير والكشوفات (نبضات حية لأعمدة النمو المالي)
  reports: {
    scaleY: [0.88, 1.2, 0.92, 1.14, 1],
    transformOrigin: "50% 90%",
    transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
  },

  // نقطة البيع (حركة دحرجة عربة التسوق مع تلقي المنتجات)
  pos: {
    x: [-1.2, 1.2, -1.2],
    y: [0, 1, -0.5, 0],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },

  // قارئ الأسعار (نبض مسح ضوئي متواصل)
  priceChecker: {
    scale: [1, 1.08, 1],
    transition: { duration: 1.25, repeat: Infinity, ease: "easeInOut" },
  },

  // CRM والعلاقات (تلويح وترحاب مستمر بالعملاء)
  crm: {
    rotate: [-6, 6, -6],
    scale: [1, 1.08, 1],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },

  // مطلوب مني الآن (نبض ختم القرار والمتابعة الحية)
  myWork: {
    scale: [1, 1.18, 0.94, 1.12, 1],
    rotate: [0, -5, 3, 0],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },

  // المهام والتذاكر (متابعة المهام بسلاسة حركية)
  tasks: {
    x: [-2, 2, -2],
    scale: [1, 1.08, 1],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },

  // المبيعات (خروج إيصال مالي للأعلى بانتظام)
  sales: {
    y: [2, -4, 2],
    scaleY: [0.94, 1.12, 0.94],
    transition: { duration: 1.3, repeat: Infinity, ease: "easeInOut" },
  },

  // الخزينة والمدفوعات (محفظة نقدية تتوسع وتنبض)
  treasury: {
    scale: [1, 1.12, 1],
    rotate: [-3, 3, -3],
    transition: { duration: 1.3, repeat: Infinity, ease: "easeInOut" },
  },

  // حساب البطاقة/البنك (تمرير بطاقة الدفع المائل)
  cardAccount: {
    x: [-3, 4, -3],
    rotate: [-4, 6, -4],
    transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
  },

  // البطاقات الرقمية (تفتّح وتمايل حزمة البطاقات)
  digitalCards: {
    rotate: [-8, 8, -8],
    scale: [1, 1.1, 1],
    transition: { duration: 1.3, repeat: Infinity, ease: "easeInOut" },
  },

  // المخزون والبضاعة (صناديق ترتفع وتستقر في تناغم مستمر)
  inventory: {
    y: [0, -3, 0, -1.5, 0],
    scale: [1, 1.07, 1],
    transition: { duration: 1.3, repeat: Infinity, ease: "easeInOut" },
  },

  // المشتريات (استلام واعتماد طرود المشتريات)
  purchases: {
    y: [-4, 1, 0, -4],
    rotate: [-3, 3, -3],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },

  // الموردون (ارتقاء أبراج ومقرات الشركات الموردة)
  suppliers: {
    scale: [1, 1.09, 1],
    y: [0, -2, 0],
    transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
  },

  // طلبات المتجر (مظلة متجر تتأرجح بحيوية في النسيم)
  store: {
    y: [0, -3, 0],
    rotate: [-3, 3, -3],
    transition: { duration: 1.3, repeat: Infinity, ease: "easeInOut" },
  },

  // استوديو المنتجات (التقاط صور وميض فلاش الكاميرا)
  productStudio: {
    scale: [1, 0.92, 1.16, 0.96, 1],
    rotate: [0, -3, 3, 0],
    transition: { duration: 1.3, repeat: Infinity, ease: "easeInOut" },
  },

  // شجرة الحسابات (أعمدة هيكل مالي ترتفع بثبات ورسوخ)
  chartOfAccounts: {
    y: [0, -3, 0],
    scale: [1, 1.08, 1],
    transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
  },

  // الدليل المحاسبي النظامي (ختم التدقيق والامتثال القانوني)
  statutoryAccounting: {
    scale: [1, 0.92, 1.14, 1],
    rotate: [0, -4, 0],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },

  // الأصول الثابتة (نبضات معالجة خوادم حية)
  assets: {
    y: [0, -2, 0, -1, 0],
    scale: [1, 1.07, 1],
    transition: { duration: 1.1, repeat: Infinity, ease: "easeInOut" },
  },

  // الموارد البشرية (حقيبة أعمال تنفيذية ترتفع في حركة مستمرة)
  hr: {
    y: [0, -4, 0],
    rotate: [-3, 3, -3],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },
};

/** حركة افتراضية رشيقة لأي وحدة غير معرفة */
const DEFAULT_ICON_MOTION: TargetAndTransition = {
  scale: [1, 1.12, 1],
  y: [0, -2, 0],
  transition: { duration: 1.1, repeat: Infinity, ease: "easeInOut" },
};

/**
 * الحصول على حالة حركة الأيقونة التفاعلية بناءً على معرف الوحدة وحالة التحويم
 */
export function getIconHoverMotion(
  moduleId: string,
  isHovered: boolean,
  shouldReduceMotion: boolean | null,
): TargetAndTransition | undefined {
  if (!isHovered || shouldReduceMotion) {
    return {
      x: 0,
      y: 0,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      rotate: 0,
      rotateY: 0,
      transition: { duration: 0.2, ease: "easeOut" },
    };
  }

  return MODULE_ICON_HOVER_MOTIONS[moduleId] ?? DEFAULT_ICON_MOTION;
}

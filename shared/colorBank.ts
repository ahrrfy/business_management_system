/**
 * colorBank.ts — بنك ألوان عربي شامل (مصدر الحقيقة الوحيد للون الحقيقي من الاسم).
 *
 * نقيّ تماماً (بلا DOM/شبكة/عشوائية) ⇒ مشترك بين العميل والخادم وقابل للاختبار.
 * الهدف: أي اسم لون يكتبه المستخدم بالعربية (أو بمرادف/إنكليزي/تهجئة مختلفة) يُحوَّل إلى
 * لونه الحقيقي «#RRGGBB»، أو null إن لم يُعرَف (لا نخترع لوناً أبداً).
 *
 * الاستعمال:
 *   resolveColorHex("أزرق")        => "#0000FF"
 *   resolveColorHex("زيتي")        => "#808000"
 *   resolveColorHex("أزرق فاتح")   => لون مشتقّ بتفتيح الأزرق
 *   resolveColorHex("لون تركوازي") => "#40E0D0"
 *   resolveColorHex("بلابل")       => null
 *
 * المتغيّر يخزّن اللون الصريح (colorHex) عند اختيار المستخدم؛ وإلّا يُستنتَج من الاسم هنا —
 * فيظهر اللون الحقيقي في كل الشاشات ولكل المستخدمين بلا الحاجة لتخزين لكل صفّ.
 */

export interface ColorEntry {
  /** الاسم المعياريّ (كما يُعرَض). */
  name: string;
  /** اللون الحقيقي «#RRGGBB». */
  hex: string;
  /** مرادفات/تهجئات/أسماء إنكليزية تُطابَق كلّها لنفس اللون. */
  aliases?: string[];
}

/* ============================ القاموس (≈١٥٢ لوناً) ============================ */

export const COLOR_BANK: ColorEntry[] = [
  // — محايدات (أبيض/أسود) —
  { name: "أبيض", hex: "#FFFFFF", aliases: ["white", "وايت", "بيضاء"] },
  { name: "أسود", hex: "#000000", aliases: ["black", "بلاك", "سوداء"] },
  { name: "أسود فاحم", hex: "#0A0A0A", aliases: ["فاحم", "jet black", "أسود قاتم"] },
  { name: "أوف وايت", hex: "#FAF9F6", aliases: ["off white", "off-white", "أبيض مكسور", "اوف وايت"] },
  { name: "ثلجي", hex: "#FFFAFA", aliases: ["snow", "ثلج", "أبيض ثلجي"] },
  { name: "حليبي", hex: "#FBF7EF", aliases: ["milky", "milk", "حليب", "لبني حليبي"] },
  { name: "لؤلؤي", hex: "#EAE0C8", aliases: ["pearl", "لؤلؤ", "لولوي"] },
  { name: "طباشيري", hex: "#E8E8E0", aliases: ["chalk", "طباشير"] },
  { name: "صدفي", hex: "#FFF5EE", aliases: ["seashell", "صدف", "محاري"] },
  { name: "عاجي", hex: "#FFFFF0", aliases: ["ivory", "عاج"] },
  { name: "كريمي", hex: "#FFFDD0", aliases: ["cream", "كريم", "كريمي فاتح"] },
  { name: "شامبانيا", hex: "#F7E7CE", aliases: ["champagne", "شمبانيا", "شامباني"] },

  // — أحمر / وردي / خمري —
  { name: "أحمر", hex: "#FF0000", aliases: ["red", "احمر فاقع", "حمراء"] },
  { name: "أحمر قاني", hex: "#C8102E", aliases: ["قاني", "cardinal"] },
  { name: "قرمزي", hex: "#DC143C", aliases: ["قرمز", "crimson"] },
  { name: "سكارلت", hex: "#FF2400", aliases: ["scarlet", "قرمزي فاقع", "سكارليت", "قان"] },
  { name: "دموي", hex: "#8B0000", aliases: ["dark red", "احمر داكن", "دم", "احمر غامق", "دمي"] },
  { name: "عنّابي", hex: "#841B2D", aliases: ["عنابي", "jujube", "عناب"] },
  { name: "خمري", hex: "#722F37", aliases: ["نبيذي", "نبيتي", "wine"] },
  { name: "بورجوندي", hex: "#800020", aliases: ["برغندي", "burgundy", "بوردو", "بردوه"] },
  { name: "ياقوتي", hex: "#9B111E", aliases: ["ياقوت", "ruby"] },
  { name: "عقيقي", hex: "#A72608", aliases: ["عقيق", "carnelian"] },
  { name: "جوري", hex: "#C21E56", aliases: ["ورد جوري", "rose red"] },
  { name: "فيراري", hex: "#FF2800", aliases: ["ferrari", "احمر فيراري"] },
  { name: "طماطمي", hex: "#FF6347", aliases: ["tomato", "بندورة", "طماطة"] },
  { name: "مرجاني", hex: "#FF7F50", aliases: ["coral", "كورال", "مرجان"] },
  { name: "سلموني", hex: "#FA8072", aliases: ["salmon", "سالمون", "سلمون"] },
  { name: "وردي", hex: "#FFC0CB", aliases: ["pink", "بمبي", "بنك", "بينك", "زهري فاتح"] },
  { name: "زهري", hex: "#FFB6C1", aliases: ["زهر", "light pink"] },
  { name: "بيبي بينك", hex: "#F4C2C2", aliases: ["baby pink", "بيبي بنك", "وردي طفولي"] },
  { name: "هوت بينك", hex: "#FF69B4", aliases: ["hot pink", "وردي فاقع", "زهري فاقع"] },
  { name: "قرنفلي", hex: "#FFA6C9", aliases: ["carnation", "قرنفل"] },
  { name: "روز", hex: "#FF66B2", aliases: ["rose", "روزي"] },
  { name: "فوشيا", hex: "#FF00FF", aliases: ["fuchsia", "ماجنتا", "magenta", "فوشي"] },
  { name: "بصلي", hex: "#C9938B", aliases: ["onion"] },
  { name: "لحمي", hex: "#F3C6A5", aliases: ["flesh", "بشري"] },
  { name: "نيود", hex: "#E3BC9A", aliases: ["nude", "نيودي"] },

  // — برتقالي / بني / ترابي —
  { name: "برتقالي", hex: "#FFA500", aliases: ["برتقال", "orange", "اورنج"] },
  { name: "برتقالي محروق", hex: "#CC5500", aliases: ["burnt orange", "برتقالي داكن"] },
  { name: "جزري", hex: "#F4661B", aliases: ["carrot", "جزر"] },
  { name: "مشمشي", hex: "#F7B267", aliases: ["apricot", "مشمش"] },
  { name: "خوخي", hex: "#FFDAB9", aliases: ["peach", "بيتشي", "خوخ"] },
  { name: "نحاسي", hex: "#B87333", aliases: ["copper", "نحاس"] },
  { name: "برونزي", hex: "#CD7F32", aliases: ["bronze", "برونز"] },
  { name: "طوبي", hex: "#AB4E3D", aliases: ["آجري", "brick", "طابوقي"] },
  { name: "محروق", hex: "#8A3324", aliases: ["burnt sienna", "سيينا"] },
  { name: "صدئي", hex: "#B7410E", aliases: ["rust", "صدأ", "صدا"] },
  { name: "مغري", hex: "#CC7722", aliases: ["ochre", "مغرة", "اوكر", "اوكري"] },
  { name: "تراكوتا", hex: "#E2725B", aliases: ["terracotta", "فخاري", "خزفي", "تيراكوتا"] },
  { name: "كموني", hex: "#C08B54", aliases: ["cumin", "كمون"] },
  { name: "خردلي", hex: "#D4A017", aliases: ["mustard", "خردل", "مستردة"] },
  { name: "زيتي", hex: "#808000", aliases: ["olive", "زيتوني"] },
  { name: "كاكي", hex: "#8A795D", aliases: ["khaki", "كاكي عسكري"] },
  { name: "جملي", hex: "#C19A6B", aliases: ["camel", "جمالي"] },
  { name: "ترابي", hex: "#C2A878", aliases: ["earth", "تراب"] },
  { name: "رملي", hex: "#C2B280", aliases: ["sand", "رمل"] },
  { name: "صحراوي", hex: "#EDC9AF", aliases: ["desert", "ديزرت"] },
  { name: "سمني", hex: "#E3C9A8", aliases: ["سمن"] },
  { name: "حمصي", hex: "#CBA57B", aliases: ["حمص"] },
  { name: "تان", hex: "#D2B48C", aliases: ["tan", "تاني", "بيج غامق"] },
  { name: "بيج", hex: "#F5F5DC", aliases: ["beige", "بيج فاتح"] },
  { name: "لوزي", hex: "#EFDECD", aliases: ["almond", "لوز"] },
  { name: "بني", hex: "#795548", aliases: ["brown", "بنّي"] },
  { name: "بني محمر", hex: "#A0522D", aliases: ["sienna", "بني مائل للاحمر"] },
  { name: "شوكولاتي", hex: "#5D3A1A", aliases: ["chocolate", "شوكولاته", "شكولاتة", "شوكولاتة"] },
  { name: "قهوائي", hex: "#6F4E37", aliases: ["coffee", "قهوة", "قهوي"] },
  { name: "كستنائي", hex: "#954535", aliases: ["chestnut", "كستنة"] },
  { name: "عسلي", hex: "#C9922B", aliases: ["honey", "عسل"] },
  { name: "كراميلي", hex: "#C87F31", aliases: ["caramel", "كراميل"] },
  { name: "طيني", hex: "#8B6C5C", aliases: ["clay", "طين"] },
  { name: "بندقي", hex: "#7A4B32", aliases: ["hazel", "بندق"] },
  { name: "جوزي", hex: "#5C4033", aliases: ["walnut", "جوز"] },
  { name: "عودي", hex: "#4E342E", aliases: ["oud", "عود"] },
  { name: "موكا", hex: "#967969", aliases: ["mocha", "موكه"] },
  { name: "لاتيه", hex: "#C8A27C", aliases: ["latte", "لاتية"] },
  { name: "كابتشينو", hex: "#A67B5B", aliases: ["cappuccino", "كابوتشينو"] },
  { name: "إسبريسو", hex: "#4B3621", aliases: ["espresso", "اسبريسو", "اسبرسو"] },
  { name: "قرفي", hex: "#7B3F00", aliases: ["cinnamon", "قرفة"] },
  { name: "زنجبيلي", hex: "#B06500", aliases: ["ginger", "زنجبيل"] },
  { name: "حنّائي", hex: "#B05C3B", aliases: ["حنائي", "henna", "حناوي", "حني"] },

  // — أصفر / ذهبي —
  { name: "أصفر", hex: "#FFFF00", aliases: ["yellow", "اصفر فاقع", "صفراء"] },
  { name: "ليموني", hex: "#FDE910", aliases: ["lemon", "ليمي", "ليمون"] },
  { name: "كناري", hex: "#FFE800", aliases: ["canary", "اصفر كناري"] },
  { name: "أصفر ذهبي", hex: "#FFDF00", aliases: ["golden yellow", "ذهبي فاتح"] },
  { name: "ذهبي", hex: "#FFD700", aliases: ["gold", "دهبي", "ذهب"] },
  { name: "ذهبي وردي", hex: "#B76E79", aliases: ["rose gold", "روز غولد", "روزغولد", "وردي ذهبي"] },
  { name: "كهرماني", hex: "#FFBF00", aliases: ["amber", "عنبري", "كهرمان"] },
  { name: "زعفراني", hex: "#F4C430", aliases: ["saffron", "زعفران"] },
  { name: "قشّي", hex: "#E4D96F", aliases: ["straw", "قشي", "قش"] },
  { name: "ياسميني", hex: "#F8DE7E", aliases: ["jasmine", "ياسمين"] },

  // — أخضر —
  { name: "أخضر", hex: "#008000", aliases: ["green", "اخضر فاقع", "خضراء"] },
  { name: "زمردي", hex: "#50C878", aliases: ["emerald", "زمرد"] },
  { name: "فستقي", hex: "#93C572", aliases: ["pistachio", "فستق"] },
  { name: "نعناعي", hex: "#98FB98", aliases: ["mint", "نعناع", "منت"] },
  { name: "تفاحي", hex: "#8DB600", aliases: ["apple green", "تفاح", "اخضر تفاحي"] },
  { name: "عشبي", hex: "#7CB518", aliases: ["grass", "حشيشي", "عشب", "زرعي"] },
  { name: "لايمي", hex: "#BFFF00", aliases: ["lime", "لايم", "اخضر ليموني"] },
  { name: "شارتروز", hex: "#7FFF00", aliases: ["chartreuse", "شارتريوز"] },
  { name: "صنوبري", hex: "#01796F", aliases: ["pine", "صنوبر"] },
  { name: "طحلبي", hex: "#8A9A5B", aliases: ["moss", "طحلب"] },
  { name: "عسكري", hex: "#4B5320", aliases: ["military", "army", "ميليتاري", "اخضر عسكري"] },
  { name: "أفوكادو", hex: "#568203", aliases: ["avocado", "افوكادو"] },
  { name: "زنجاري", hex: "#4E9A87", aliases: ["verdigris", "زنجار"] },
  { name: "زبرجدي", hex: "#B4C424", aliases: ["peridot", "زبرجد"] },
  { name: "أخضر فسفوري", hex: "#39FF14", aliases: ["neon green", "نيون اخضر", "اخضر نيون"] },
  { name: "أخضر بحري", hex: "#2E8B57", aliases: ["sea green"] },
  { name: "تيل", hex: "#008080", aliases: ["teal", "تركوازي داكن", "تيلي"] },

  // — أزرق / سماوي / فيروزي —
  { name: "أزرق", hex: "#0000FF", aliases: ["blue", "بلو", "ازرق فاقع", "زرقاء"] },
  { name: "بترولي", hex: "#0E5A6B", aliases: ["petrol", "بترول", "ازرق بترولي"] },
  { name: "سماوي", hex: "#87CEEB", aliases: ["sky", "سمائي", "سما", "sky blue"] },
  { name: "لبني", hex: "#B5D3E7", aliases: ["milk blue", "ازرق لبني"] },
  { name: "بيبي بلو", hex: "#89CFF0", aliases: ["baby blue", "ازرق طفولي"] },
  { name: "أزرق بودرة", hex: "#B0E0E6", aliases: ["powder blue", "بودري", "ازرق بودري"] },
  { name: "تركوازي", hex: "#40E0D0", aliases: ["تركواز", "turquoise"] },
  { name: "فيروزي", hex: "#2EC4C4", aliases: ["فيروز", "فيروزه"] },
  { name: "تيفاني", hex: "#0ABAB5", aliases: ["tiffany", "تفاني", "ازرق تيفاني"] },
  { name: "سيان", hex: "#00FFFF", aliases: ["cyan", "أكوا", "aqua", "اكوا", "سماوي فاقع"] },
  { name: "طاووسي", hex: "#1CA9C9", aliases: ["peacock", "طاووس"] },
  { name: "لازوردي", hex: "#26619C", aliases: ["lapis", "لازورد"] },
  { name: "أزور", hex: "#007FFF", aliases: ["azure", "ازرق سماوي", "ازور"] },
  { name: "كوبالت", hex: "#0047AB", aliases: ["cobalt", "كوبلت", "كوبالتي"] },
  { name: "أزرق ملكي", hex: "#4169E1", aliases: ["royal blue", "رويال", "ازرق رويال"] },
  { name: "جينزي", hex: "#1560BD", aliases: ["denim", "دنيم", "جينز"] },
  { name: "فولاذي أزرق", hex: "#4682B4", aliases: ["steel blue", "ستيل بلو", "ازرق فولاذي"] },
  { name: "سافير", hex: "#0F52BA", aliases: ["sapphire", "ياقوت ازرق", "سفير"] },
  { name: "بحري", hex: "#024A86", aliases: ["marine", "مارين"] },
  { name: "كحلي", hex: "#000080", aliases: ["navy", "نيفي", "كحلة"] },
  { name: "نيلي", hex: "#3F51B5", aliases: ["indigo", "نيلة", "انديجو"] },
  { name: "أزرق منتصف الليل", hex: "#191970", aliases: ["midnight blue", "ميدنايت", "كحلي غامق"] },

  // — بنفسجي / أرجواني —
  { name: "بنفسجي", hex: "#7E22CE", aliases: ["violet", "بنفسج", "فيوليت"] },
  { name: "أرجواني", hex: "#800080", aliases: ["purple", "أرجوان", "بربل"] },
  { name: "موف", hex: "#E0B0FF", aliases: ["mauve", "موف فاتح"] },
  { name: "ليلكي", hex: "#C8A2C8", aliases: ["lilac", "ليلك"] },
  { name: "خزامي", hex: "#B57EDC", aliases: ["خزامى"] },
  { name: "لافندر", hex: "#E6E6FA", aliases: ["lavender", "لافندري"] },
  { name: "برقوقي", hex: "#8E4585", aliases: ["plum", "برقوق", "بلوم"] },
  { name: "عنبي", hex: "#6F2DA8", aliases: ["grape", "عنب"] },
  { name: "باذنجاني", hex: "#614051", aliases: ["eggplant", "aubergine", "باذنجان", "بيتنجاني"] },
  { name: "توتي", hex: "#77264A", aliases: ["mulberry", "توت"] },
  { name: "أوركيد", hex: "#DA70D6", aliases: ["orchid", "اوركيد", "اوركيدا"] },

  // — رمادي / فضي / معدنيّات —
  { name: "رمادي", hex: "#808080", aliases: ["gray", "grey", "رماد", "سكني"] },
  { name: "رصاصي", hex: "#74787B", aliases: ["رصاص", "lead gray"] },
  { name: "فحمي", hex: "#36454F", aliases: ["charcoal", "فحم", "رمادي فحمي"] },
  { name: "دخاني", hex: "#8A8D8F", aliases: ["smoke", "smoky", "دخان"] },
  { name: "أردوازي", hex: "#708090", aliases: ["slate", "سليت", "رمادي مزرق"] },
  { name: "فضي", hex: "#C0C0C0", aliases: ["silver", "فضّي", "سلفر"] },
  { name: "بلاتيني", hex: "#E5E4E2", aliases: ["platinum", "بلاتين"] },
  { name: "تيتانيوم", hex: "#878681", aliases: ["titanium", "تيتانيومي"] },
  { name: "جرافيت", hex: "#383838", aliases: ["graphite", "جرافيتي", "غرافيت"] },
  { name: "فولاذي", hex: "#71797E", aliases: ["steel gray", "ستيل", "رمادي فولاذي"] },
  { name: "حجري", hex: "#928E85", aliases: ["stone", "حجر"] },
  { name: "إسمنتي", hex: "#9A9B96", aliases: ["cement", "سمنتي", "اسمنتي"] },
];

/* ============================ معدِّلات الدرجة (فاتح/غامق) ============================ */

interface Modifier {
  kind: "light" | "dark";
  /** شدّة المزج نحو الأبيض (فاتح) أو الأسود (غامق) — بين 0 و1. */
  strength: number;
}

// المفاتيح مُطبّعة مسبقاً (بلا همزة/تشكيل). أُبقيت المعدِّلات القاطعة دلالياً فقط
// (تفتيح/تغميق)؛ استُبعدت الغامضة (زاهي/فاقع) لأنها إمّا لا تعني تغيّر إضاءة أو مغطّاة بالمرادفات.
const MODIFIERS: Record<string, Modifier> = {
  "فاتح": { kind: "light", strength: 0.35 },
  "باهت": { kind: "light", strength: 0.3 },
  "فسفوري": { kind: "light", strength: 0.18 },
  "نيون": { kind: "light", strength: 0.15 },
  "ثلجي": { kind: "light", strength: 0.5 },
  "غامق": { kind: "dark", strength: 0.4 },
  "غامج": { kind: "dark", strength: 0.4 },
  "غميق": { kind: "dark", strength: 0.4 },
  "قاتم": { kind: "dark", strength: 0.5 },
  "داكن": { kind: "dark", strength: 0.45 },
  "غامقة": { kind: "dark", strength: 0.4 },
  "فاتحة": { kind: "light", strength: 0.35 },
};

/* ============================ التطبيع ============================ */

/**
 * يطبّع اسم اللون للمقارنة: يزيل التشكيل والتطويل، ويوحّد الهمزات/الألف/الياء/الكاف/التاء المربوطة،
 * ويصغّر الحروف اللاتينية، ويحوّل الفواصل/الرموز إلى مسافة مفردة. (بلا حذف «ال»/«لون» — يُعالَج في resolve.)
 */
export function normalizeColorName(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);
  // إزالة التطويل وكل علامات التشكيل العربية (بما فيها الألف الخنجرية).
  s = s.replace(/[ـً-ٰٟ]/g, "");
  s = s
    .replace(/[آأإٱ]/g, "ا") // آ أ إ ٱ → ا
    .replace(/ؤ/g, "و") // ؤ → و
    .replace(/ئ/g, "ي") // ئ → ي
    .replace(/ء/g, "") // ء → (حذف)
    .replace(/ة/g, "ه") // ة → ه
    .replace(/[ىی]/g, "ي") // ى ی → ي
    .replace(/ک/g, "ك"); // ک → ك
  s = s.toLowerCase();
  // الفواصل/الرموز (مسافة، فاصلة عربية/لاتينية، شرطة، شرطة سفلية، نقطة، أقواس…) → مسافة مفردة.
  s = s.replace(/[\s،,/\\_.()[\]-]+/g, " ").trim();
  return s;
}

/* ============================ البحث والاستنتاج ============================ */

// خريطة بحث مبنيّة مرّة: اسم/مرادف مُطبّع → hex (أوّل قيمة تفوز عند التصادم).
const LOOKUP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of COLOR_BANK) {
    const put = (raw: string) => {
      const k = normalizeColorName(raw);
      if (k && !m.has(k)) m.set(k, c.hex);
    };
    put(c.name);
    for (const a of c.aliases ?? []) put(a);
  }
  return m;
})();

/** بحث مباشر مع تسامح مع «ه» النهائية (صيغة التأنيث: قرمزيه ← قرمزي). */
function direct(norm: string): string | null {
  const hit = LOOKUP.get(norm);
  if (hit) return hit;
  if (norm.endsWith("ه") && norm.length > 1) {
    const h2 = LOOKUP.get(norm.slice(0, -1));
    if (h2) return h2;
  }
  return null;
}

const HEX6 = /^#?[0-9a-fA-F]{6}$/;

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function toHex2(n: number): string {
  return clamp255(n).toString(16).padStart(2, "0");
}

/** يفتّح/يغمّق لوناً بمزجه نحو الأبيض (light) أو الأسود (dark) بشدّة المعدِّل. */
function applyShade(hex: string, mod: Modifier): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const f = mod.strength;
  const mix = (c: number) => (mod.kind === "light" ? c + (255 - c) * f : c * (1 - f));
  return `#${toHex2(mix(r))}${toHex2(mix(g))}${toHex2(mix(b))}`.toUpperCase();
}

/**
 * يحلّ نصّاً مُطبّعاً إلى hex: مباشر ← حذف «ال»/«لون» ← مُعدِّل+أساس (كلا الترتيبين، تعاوديّاً)
 * ← مركّب لونين (الرمز الأخصّ ثم الأول). يعيد null إن تعذّر (لا اختراع لون).
 */
function resolveNorm(norm: string, depth = 0): string | null {
  if (!norm || depth > 5) return null;

  const d0 = direct(norm);
  if (d0) return d0;

  // حذف «ال» التعريف من بداية النص كمحاولة (الأزرق ← أزرق).
  if (norm.startsWith("ال") && norm.length >= 4) {
    const d1 = direct(norm.slice(2));
    if (d1) return d1;
  }

  // الرموز مع تجريد «ال» التعريف من كلّ رمز (الأزرق الفاتح ← ازرق فاتح).
  const tokens = norm
    .split(" ")
    .filter(Boolean)
    .map((t) => (t.startsWith("ال") && t.length >= 4 && !MODIFIERS[t] ? t.slice(2) : t));
  if (tokens.length >= 2) {
    // مُعدِّل في أيّ موضع (فاتح/غامق…): انزعه وطبّقه على استنتاج بقيّة الرموز
    // — «أزرق فاتح»، «فاتح أزرق»، «أزرق غامق جداً» تلتقط المعدِّل كلّها.
    const mi = tokens.findIndex((t) => MODIFIERS[t]);
    if (mi !== -1) {
      const base = resolveNorm(tokens.filter((_, i) => i !== mi).join(" "), depth + 1);
      if (base) return applyShade(base, MODIFIERS[tokens[mi]]);
    }
    // مركّب بلا مُعدِّل: جرّب الأخصّ (الأخير) ثم الأول — «لون أزرق» ← أزرق، «أزرق سماوي» ← سماوي.
    const dLast = resolveNorm(tokens[tokens.length - 1], depth + 1);
    if (dLast) return dLast;
    const dFirst = resolveNorm(tokens[0], depth + 1);
    if (dFirst) return dFirst;
  }
  return null;
}

/**
 * يحوّل أيّ اسم لون مكتوب إلى لونه الحقيقي «#RRGGBB»، أو null إن لم يُعرَف.
 * إن كان المُدخَل نفسه hex صالحاً («#1e90ff») يُعاد مُطبّعاً بأحرف كبيرة (يُغني عن جدول).
 */
export function resolveColorHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (HEX6.test(raw)) return `#${raw.replace("#", "").toUpperCase()}`;
  return resolveNorm(normalizeColorName(raw));
}

/** يُطبّع hex لصيغة «#RRGGBB» بأحرف كبيرة، أو null إن غير صالح (لمُدخَل منتقي اللون). */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  return HEX6.test(raw) ? `#${raw.replace("#", "").toUpperCase()}` : null;
}

/* ============================ رمز SKU لاتينيّ من اسم اللون ============================ */

// خريطة الاسم/المرادف المُطبّع → إدخال البنك (لاشتقاق رمز SKU لاتينيّ من مرادفه الإنكليزيّ).
const ENTRY_LOOKUP: Map<string, ColorEntry> = (() => {
  const m = new Map<string, ColorEntry>();
  for (const c of COLOR_BANK) {
    const put = (raw: string) => {
      const k = normalizeColorName(raw);
      if (k && !m.has(k)) m.set(k, c);
    };
    put(c.name);
    for (const a of c.aliases ?? []) put(a);
  }
  return m;
})();

/**
 * رمز ثابت قصير (djb2 → base36) من نصّ — لاتينيّ، حتميّ عبر المنصّات، وغير فارغ لأيّ اسم.
 * `len` يضبط طوله (افتراضي ٢ ⇒ ١٢٩٦ خانة). يأخذ الخانات **الدُّنيا** (الأكثر عشوائيةً) لا العُليا
 * (التي تتكدّس لأسماء متقاربة الطول) — تمييزاً أفضل بين أسماء تتشارك البادئة المقروءة.
 */
export function skuToken(s: string, len = 2): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().slice(-len).padStart(len, "0");
}

/** أوّل بادئة لاتينية (٣ محارف) من قائمة أسماء/مرادفات (يتخطّى العربيّ لأنه يُفرَّغ من ASCII)، أو "". */
function latinPrefix(names: string[]): string {
  for (const n of names) {
    const p = n.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
    if (p) return p;
  }
  return "";
}

/**
 * كود SKU فريد محسوب مرّةً لكلّ لون في البنك (اسمه المعياريّ → كود): بادئة مقروءة من مرادفه الإنكليزيّ،
 * تبقى **نظيفة** حين تكون فريدة (برونزي→BRO، بترولي→PET)، وتُلحَق برمزٍ ثابتٍ أدنى فقط عند تصادم البادئة
 * (خوخي/طاووسي/لؤلؤي تتشارك PEA) حتى التفرّد التامّ عبر البنك كلّه. الترتيب حتميّ (ترتيب COLOR_BANK) ⇒
 * الكود ثابت. هكذا يُضمَن **حقنٌ حقيقيّ** (لا لونان في البنك بنفس الكود) بأقصر شكلٍ مقروء.
 */
const ENTRY_CODE: Map<string, string> = (() => {
  const used = new Set<string>();
  const m = new Map<string, string>();
  for (const c of COLOR_BANK) {
    const prefix = latinPrefix([c.name, ...(c.aliases ?? [])]) || "C" + skuToken(c.name);
    let code = prefix;
    for (let salt = 1; used.has(code); salt++) code = prefix + skuToken(c.name + (salt > 1 ? salt : ""));
    used.add(code);
    m.set(c.name, code);
  }
  return m;
})();

/**
 * يشتقّ **رمز SKU لاتينيّاً غير فارغ ومميّزاً لكلّ اسم لون مختلف**:
 *   • لونٌ معروف في البنك ⇒ كوده الفريد المحسوب (`ENTRY_CODE`) — نظيفٌ ما أمكن، ومتطابق لكلّ مرادفات
 *     نفس اللون (برونزي == bronze) ومميّزٌ عن كلّ لونٍ آخر في البنك.
 *   • لونٌ غير معروف (كـ«الوان») ⇒ بادئة لاتينية إن كُتب لاتينياً وإلّا "C" + رمز ثابت من الاسم المُطبّع.
 *
 * السبب (٨ يوليو): الاشتقاق القديم كان يسقط لكودٍ **فارغ** لأيّ اسم عربيّ خارج خريطة الـ١٦ لوناً القصيرة،
 * فتشترك عدّة ألوان في نفس الـSKU الأساس ⇒ «SKU مكرّر بين المتغيّرات» يمنع الحفظ. وقصُّ المرادف الإنكليزيّ
 * إلى ٣ محارف وحده لا يكفي (خوخي/طاووسي→PEA، جزري/كراميلي→CAR تتصادم) — فالتفرّد محسوبٌ عبر البنك كلّه.
 */
export function colorSkuCode(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return "";
  const norm = normalizeColorName(raw);
  const entry = ENTRY_LOOKUP.get(norm);
  if (entry) return ENTRY_CODE.get(entry.name)!;
  // لونٌ غير معروف: بادئة لاتينية إن وُجدت وإلّا "C" + رمز ثابت من الاسم المُطبّع ⇒ تمييز غير فارغ دائماً.
  const prefix = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "C";
  return prefix + skuToken(norm || raw);
}

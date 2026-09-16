/**
 * KioskView — تجربة «قارئ الأسعار» المشتركة (بنر متحرك + محرّك مسح + تحجيم لوحة 1920×1080).
 *
 * وضعان:
 *  - mode="staff": داخل التطبيق (/price-checker) — مستخدم مسجَّل، يختار الفرع، لوحة إعدادات كاملة + خروج للوحة.
 *  - mode="device": جهاز كشك خارجي (/kiosk) — مصادقة جهاز (كوكي)، الفرع مفروض خادمياً (لا يُرسَل branchId)،
 *    لوحة إعدادات مُقتضبة (عرض/ثيم/ملء شاشة + إنهاء جلسة الجهاز) بلا اختيار فرع وبلا خروج للتطبيق وبلا محاكاة.
 *
 * البيانات آمنة للزبون (kioskRouter): بلا تكلفة ولا كمية مخزون.
 */
import "@/pages/PriceChecker.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import QRCode from "qrcode";
import { trpc } from "@/lib/trpc";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { X, Maximize, WifiOff, Package, Keyboard } from "lucide-react";
import { fmtAr } from "@/lib/money";
import { playScanSuccess, playScanNotFound } from "@/lib/audioFeedback";
import { useScreenWakeLock } from "@/lib/screenWakeLock";

export type KProduct = {
  productId: number;
  productName: string;
  brand: string | null;
  category: string | null;
  variantName: string | null;
  unitName: string;
  price: string | null;
  originalPrice?: string | null;
  discountPercent?: string | null;
  promotionName?: string | null;
  barcode: string | null;
  imageUrl: string | null;
  availableUnits?: {
    unitName: string;
    conversionFactor: number;
    price: string | null;
    barcode: string | null;
  }[];
};

export type KPromo = {
  id: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
};

export type SlideItem =
  | { type: "product"; product: KProduct; id: string }
  | { type: "promo"; promo: KPromo; id: string };


type Settings = {
  branchId: number | null;
  theme: "light" | "dark";
  priceScale: number;
  rotateSec: number;
  priceDuration: number;
  showLogo: boolean;
  showInstruction: boolean;
  showQr: boolean;
  contactLabel: string;
  contactUrl: string;
  enableSound: boolean;
};

const DEFAULTS: Settings = {
  branchId: null,
  theme: "light",
  priceScale: 1,
  rotateSec: 6,
  priceDuration: 7,
  showLogo: true,
  showInstruction: true,
  showQr: true,
  contactLabel: "تابعنا وتواصل معنا",
  contactUrl: "https://wa.me/9647700000000",
  enableSound: true,
};
const LS_KEY = "kiosk_settings_v1";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {/* ignore */}
  return { ...DEFAULTS };
}

const cssVar = (name: string, value: string | number) => ({ [name]: String(value) }) as React.CSSProperties;

type ScanState =
  | { mode: "idle"; token: number }
  | { mode: "result"; product: KProduct; code: string; token: number }
  | { mode: "notfound"; code: string; token: number }
  | { mode: "neterror"; code: string; token: number };

// ── أيقونات خطّية ───────────────────────────────────────────────────────────
const IconScan = ({ s = 52 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 8v8M10 8v8M13 8v8M16 8v8" />
  </svg>
);
const IconCheck = ({ s = 28 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const IconSearchX = ({ s = 64 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M9 9l4 4M13 9l-4 4" />
  </svg>
);

/**
 * نافذة تحميل صور الكاروسيل: الشريحة الحالية + المجاورتان (بالتفاف الطرفين).
 *
 * **لماذا نافذةٌ لا `loading="lazy"`:** الشرائح كلّها مرسومة معاً ومكدّسة (`.slide{position:absolute;
 * inset:0}`) وتُخفى بـ**`opacity:0` لا `display:none`** ⇒ كلّها «داخل الشاشة» عند مراقب التقاطع،
 * فـ`lazy` **لا يؤجّل شيئاً** ويُحمّل الخمسمئة فوراً. حذف الـ`<img>` نفسه هو الوحيد الذي يمنع الطلب.
 *
 * والمجاورتان مقصودتان: الشريحة التالية تُحمَّل **قبل** ظهورها (الدورة ثوانٍ) فلا تومض فارغةً
 * عند التبديل — وهي شاشةُ معرضٍ أمام الزبون.
 */
export function isNearActive(i: number, idx: number, n: number): boolean {
  if (n <= 3) return true;
  // **تطبيع `idx` إلزاميّ لا احترازيّ:** قد يتجاوز `n` لحظةَ تقلّص القائمة (إعادة جلب البنر كل
  // ٥ د، أو تبديل الفرع) لأن `useEffect` الذي يُصفّره يعمل **بعد** الرسم. وباقي القسمة في
  // جافاسكربت يحمل إشارة المقسوم ⇒ `(i - idx + n) % n` يصير **سالباً** فيمرّ `<= 1` لكل الشرائح
  // تقريباً: قياسٌ فعليّ عند idx=499 وn=100 ⇒ **100/100** شريحة تُرسَم بدل 3 — أي انفجارُ
  // الطلبات نفسه الذي وُجدت النافذة لتمنعه، في اللحظة نفسها التي تُختبَر فيها.
  const active = ((idx % n) + n) % n;
  const forward = (i - active + n) % n;
  const backward = (active - i + n) % n;
  return Math.min(forward, backward) <= 1;
}

// ── صورة المنتج أو خانة بديلة ────────────────────────────────────────────────
function KioskImage({ p, defer = false }: { p: KProduct; defer?: boolean }) {
  // شريحةٌ بعيدة: لا `<img>` إطلاقاً ⇒ لا طلب. وهي بـopacity:0 أصلاً فلا أثر بصريّ.
  if (defer) return <div className="kpc-ph" aria-hidden="true" />;
  if (p.imageUrl) return <img className="kpc-img" src={p.imageUrl} alt={p.productName} draggable={false} />;
  return (
    <div className="kpc-ph">
      <span className="kpc-ph-cat">{p.category ?? p.brand ?? "منتج"}</span>
      <span className="kpc-ph-sub">صورة المنتج</span>
    </div>
  );
}

// ── كتلة السعر (مشتركة بين البنر وبطاقة المسح مع دعم العروض والخصومات) ──────
function PriceBlock({ p, priceScale }: { p: KProduct; priceScale: number }) {
  const hasDiscount = !!(p.originalPrice && p.price && p.originalPrice !== p.price);
  return (
    <div className="price-wrap" style={cssVar("--ps", priceScale)}>
      <div className="price-label">
        سعر المفرد
        {p.promotionName && <span className="kpc-promo-tag">{p.promotionName}</span>}
      </div>
      {p.price != null ? (
        <>
          {hasDiscount && (
            <div className="kpc-original-price">
              <span className="kpc-was-num">{fmtAr(p.originalPrice)}</span>
              <span className="kpc-was-cur">د.ع</span>
              {p.discountPercent && <span className="kpc-discount-badge">{p.discountPercent}% خصم</span>}
            </div>
          )}
          <div className="price-row">
            <span className="price-num">{fmtAr(p.price)}</span>
            <span className="price-cur">د.ع</span>
          </div>
          <div className="price-unit">للـ{p.unitName} الواحدة</div>
        </>
      ) : (
        <div className="price-none">السعر غير متوفّر — اسأل الموظّف</div>
      )}
    </div>
  );
}

// ── صورة الشريحة الترويجية ──────────────────────────────────────────────
function PromoSlideMedia({ promo, defer = false }: { promo: KPromo; defer?: boolean }) {
  if (defer) return <div className="kpc-ph" aria-hidden="true" />;
  if (promo.imageUrl) return <img className="kpc-img" src={promo.imageUrl} alt={promo.title} draggable={false} />;
  return (
    <div className="kpc-ph">
      <span className="kpc-ph-cat">عرض خاص</span>
      <span className="kpc-ph-sub">الرؤية العربية</span>
    </div>
  );
}

// ── خلط Fisher-Yates (نسخة جديدة — لا يطال المصدر) ─────────────────────────
function fisherYates<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── بناء حلقة الشرائح بدمج المنتجات مع البنرات الإعلانية الترويجية ─────────
function buildSlideDeck(products: KProduct[], promos: KPromo[]): SlideItem[] {
  if (products.length === 0 && promos.length === 0) return [];
  if (promos.length === 0) {
    return products.map((p) => ({ type: "product", product: p, id: `prod-${p.productId}` }));
  }
  if (products.length === 0) {
    return promos.map((pr) => ({ type: "promo", promo: pr, id: `promo-${pr.id}` }));
  }

  const deck: SlideItem[] = [];
  let promoIndex = 0;
  for (let i = 0; i < products.length; i++) {
    deck.push({ type: "product", product: products[i], id: `prod-${products[i].productId}` });
    // إدراج شريحة إعلانية كل ٥ منتجات بتناوب تسويقي جذاب
    if ((i + 1) % 5 === 0 && promos.length > 0) {
      const pr = promos[promoIndex % promos.length];
      deck.push({ type: "promo", promo: pr, id: `promo-${pr.id}-${i}` });
      promoIndex++;
    }
  }
  return deck;
}

// ── البنر المتحرك — خلط مستمر وعرض المنتجات والعروض بلا تكرار (حل فخ الـ 50 منتج) ─
function Banner({
  products: source,
  promos = [],
  rotateSec,
  priceScale,
  paused,
  branchKey,
}: {
  products: KProduct[];
  promos?: KPromo[];
  rotateSec: number;
  priceScale: number;
  paused: boolean;
  branchKey?: string | number | null;
}) {
  const [display, setDisplay] = useState<SlideItem[]>([]);
  const [idx, setIdx] = useState(0);
  const n = display.length;
  const rotateMs = Math.max(2, rotateSec) * 1000;

  // حفظ أحدث مصدر وعروض في مراجع لتحديث الدورة القادمة بلا قطع الدورة الحالية
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const promosRef = useRef(promos);
  promosRef.current = promos;

  // تهيئة أولية أو تحديث القائمة عند فراغها
  useEffect(() => {
    if (source.length === 0 && promos.length === 0) {
      if (display.length > 0) {
        setDisplay([]);
        setIdx(0);
      }
      return;
    }
    if (display.length === 0) {
      const shuffled = source.length > 1 ? fisherYates(source) : source;
      setDisplay(buildSlideDeck(shuffled, promos));
      setIdx(0);
    }
  }, [display.length, source, promos]);

  // تبديل الفرع الصريح (للموظف) يعيد ضبط الكاروسيل للفرع الجديد
  const prevBranchRef = useRef(branchKey);
  useEffect(() => {
    if (prevBranchRef.current !== branchKey) {
      prevBranchRef.current = branchKey;
      if (source.length === 0 && promos.length === 0) {
        setDisplay([]);
        setIdx(0);
      } else {
        const shuffled = source.length > 1 ? fisherYates(source) : source;
        setDisplay(buildSlideDeck(shuffled, promos));
        setIdx(0);
      }
    }
  }, [branchKey, source, promos]);

  // تطبيع المؤشر إذا تقلصت القائمة
  useEffect(() => {
    if (n > 0 && idx >= n) {
      setIdx(((idx % n) + n) % n);
    }
  }, [idx, n]);

  // دوران مستمر: تقدم سلس للشريحة التالية
  useEffect(() => {
    if (paused || n <= 1) return;
    const id = setInterval(() => {
      setIdx((prev) => {
        const next = prev + 1;
        if (next >= n) {
          return 0;
        }
        return next;
      });
    }, rotateMs);
    return () => clearInterval(id);
  }, [paused, n, rotateMs]);

  // عند العودة إلى الشريحة الأولى بعد إتمام الدورة، نخلط الكتالوج بهدوء للدورة التالية أو نفرغ القائمة إن انتهت
  const prevIdxRef = useRef(idx);
  useEffect(() => {
    if (prevIdxRef.current > 0 && idx === 0) {
      const curSource = sourceRef.current;
      const curPromos = promosRef.current;
      if (curSource.length === 0 && curPromos.length === 0) {
        setDisplay([]);
      } else {
        const shuffled = curSource.length > 1 ? fisherYates(curSource) : curSource;
        setDisplay(buildSlideDeck(shuffled, curPromos));
      }
    }
    prevIdxRef.current = idx;
  }, [idx]);

  if (n === 0) {
    return (
      <div className="banner">
        <div className="kpc-empty">
          <div className="kpc-empty-title">مرحباً بكم في المكتبة العربية</div>
          <div className="kpc-empty-sub">مرّر الباركود أمام الماسح لعرض سعر المنتج فوراً</div>
        </div>
      </div>
    );
  }

  return (
    <div className="banner">
      <div className="slides">
        {display.map((item, i) => {
          // ترشيح وافتراضية DOM: تصيير الشرائح النشطة والمجاورة فقط (3 شرائح كحد أقصى بدل 1000)
          if (!isNearActive(i, idx, n)) return null;
          const defer = false;
          if (item.type === "promo") {
            const pr = item.promo;
            return (
              <div key={item.id} className={"slide" + (i === idx ? " is-active" : "")} aria-hidden={i !== idx}>
                <div className="slide-promo">
                  <div className="promo-banner-media">
                    <PromoSlideMedia promo={pr} defer={defer} />
                  </div>
                  <div className="promo-info">
                    <div className="promo-badge">عرض خاص</div>
                    <h1 className="promo-title">{pr.title}</h1>
                    {pr.subtitle && <p className="promo-subtitle">{pr.subtitle}</p>}
                    {pr.ctaLabel && (
                      <div className="promo-callout">
                        <span>{pr.ctaLabel}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          }
          const p = item.product;
          return (
            <div key={item.id} className={"slide" + (i === idx ? " is-active" : "")} aria-hidden={i !== idx}>
              <div className="slide-media"><KioskImage p={p} defer={defer} /></div>
              <div className="slide-info">
                <div className="brand-chip">{[p.brand, p.category].filter(Boolean).join(" · ") || "منتج"}</div>
                <h1 className="prod-name">{p.productName}</h1>
                <PriceBlock p={p} priceScale={priceScale} />
              </div>
            </div>
          );
        })}
      </div>
      {n > 1 && (
        <div className="banner-progress">
          <div className="counter"><b>{idx + 1}</b> / {n}</div>
          <div className="track">
            <span
              className="fill"
              key={idx + "-" + rotateMs + "-" + (paused ? "p" : "r")}
              style={{ animationDuration: paused ? "0s" : rotateMs + "ms", animationPlayState: paused ? "paused" : "running" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── طبقة نتيجة المسح ──────────────────────────────────────────────────────────
function ScanOverlay({ scan, priceDuration, priceScale, onDismiss }: { scan: ScanState; priceDuration: number; priceScale: number; onDismiss: () => void }) {
  const [left, setLeft] = useState(priceDuration);
  useEffect(() => {
    if (scan.mode === "idle") return;
    setLeft(priceDuration);
    const t0 = Date.now();
    const tick = setInterval(() => {
      const rem = priceDuration - Math.floor((Date.now() - t0) / 1000);
      setLeft(rem > 0 ? rem : 0);
    }, 250);
    return () => clearInterval(tick);
  }, [scan.mode, scan.token, priceDuration]);

  if (scan.mode === "idle") return null;

  if (scan.mode === "neterror") {
    return (
      <div className="overlay" onClick={onDismiss}>
        <div className="result-card neterror" onClick={(e) => e.stopPropagation()}>
          <div className="nf-icon"><WifiOff size={56} aria-hidden /></div>
          <h2>تعذّر الاتصال بالخادم</h2>
          <div className="nf-code">{scan.code}</div>
          <p>تحقّق من اتصال شبكة المتجر ثم أعد المحاولة.</p>
          <button className="dismiss-btn" onClick={onDismiss}>عودة للعرض</button>
        </div>
      </div>
    );
  }

  if (scan.mode === "notfound") {
    return (
      <div className="overlay" onClick={onDismiss}>
        <div className="result-card notfound" onClick={(e) => e.stopPropagation()}>
          <div className="nf-icon"><IconSearchX s={64} /></div>
          <h2>لم يُعثر على هذا الباركود</h2>
          <div className="nf-code">{scan.code}</div>
          <p>تأكّد من المسح أو اطلب المساعدة من أحد موظّفي المكتبة.</p>
          <button className="dismiss-btn" onClick={onDismiss}>عودة للعرض</button>
        </div>
      </div>
    );
  }

  const p = scan.product;
  return (
    <div className="overlay" onClick={onDismiss}>
      <div className="result-card found" onClick={(e) => e.stopPropagation()} style={cssVar("--ps", priceScale)}>
        <div className="result-found-tag"><IconCheck s={28} /> المنتج المطلوب</div>
        <div className="result-body">
          <div className="result-media"><KioskImage p={p} /></div>
          <div className="result-info">
            <div className="brand-chip">{[p.brand, p.category].filter(Boolean).join(" · ") || "منتج"}</div>
            <h2 className="result-name">{p.productName}</h2>
            <div className="result-price"><PriceBlock p={p} priceScale={priceScale} /></div>
            {p.availableUnits && p.availableUnits.length > 0 && (
              <div className="kpc-units-box">
                <div className="kpc-units-title">
                  <Package className="size-5 text-primary" aria-hidden />
                  <span>عبوات ووحدات أخرى متوفّرة لهذا الصنف:</span>
                </div>
                <div className="kpc-units-grid">
                  {p.availableUnits.map((u, ui) => (
                    <div key={ui} className="kpc-unit-card">
                      <span className="kpc-unit-name">{u.unitName}</span>
                      <span className="kpc-unit-factor">تحتوي {u.conversionFactor} قطعة</span>
                      <span className="kpc-unit-price">{u.price != null ? `${fmtAr(u.price)} د.ع` : "غير متوفّر"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="result-foot">
          <span className="barcode-mono">باركود · {p.barcode ?? scan.code}</span>
          <span className="countdown">عودة للعرض خلال {left} ثانية</span>
        </div>
      </div>
    </div>
  );
}

// ── لوحة المفاتيح الرقمية باللمس للإدخال اليدوي ────────────────────────────────
function TouchKeypadModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (code: string) => void;
}) {
  const [val, setVal] = useState("");
  if (!open) return null;

  const press = (char: string) => {
    if (val.length < 24) setVal((prev) => prev + char);
  };
  const backspace = () => setVal((prev) => prev.slice(0, -1));
  const clear = () => setVal("");
  const submit = () => {
    if (val.trim()) {
      onSubmit(val.trim());
      setVal("");
      onClose();
    }
  };

  return (
    <div className="kpc-keypad-overlay" onClick={onClose}>
      <div className="kpc-keypad-card" onClick={(e) => e.stopPropagation()}>
        <div className="kpc-keypad-head">
          <strong>إدخال رقم الباركود يدوياً</strong>
          <button onClick={onClose} aria-label="إغلاق"><X className="size-6" /></button>
        </div>
        <div className="kpc-keypad-display">{val || "—"}</div>
        <div className="kpc-keypad-grid">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
            <button key={k} className="kpc-key-btn" onClick={() => press(k)}>{k}</button>
          ))}
          <button className="kpc-key-btn clear-btn" onClick={clear}>مسح</button>
          <button className="kpc-key-btn" onClick={() => press("0")}>0</button>
          <button className="kpc-key-btn clear-btn" onClick={backspace}>⌫</button>
        </div>
        <button className="kpc-key-btn action-btn" onClick={submit} disabled={!val.trim()}>
          بحث عن السعر
        </button>
      </div>
    </div>
  );
}

// ── الشاشة الرئيسية المشتركة ──────────────────────────────────────────────────
export default function KioskView({
  mode,
  deviceBranchName,
  onDeviceLogout,
}: {
  mode: "staff" | "device";
  /** اسم الفرع المعروض في وضع الجهاز (مفروض خادمياً). */
  deviceBranchName?: string;
  /** إنهاء جلسة الجهاز (وضع الجهاز فقط). */
  onDeviceLogout?: () => void;
}) {
  const isDevice = mode === "device";
  const [, navigate] = useLocation();
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  // تفعيل حارس استيقاظ الشاشة لمنع السكون والشاشة السوداء 24/7
  const wakeLock = useScreenWakeLock(true);
  const setTweak = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {/* ignore */}
      return next;
    });
  }, []);

  // الفروع — وضع الموظّف فقط (عامة بلا مصادقة). لا حاجة لـauth.me — قارئ الأسعار يعمل بلا دخول.
  const branchesQ = trpc.kiosk.publicBranches.useQuery(undefined, { enabled: !isDevice });
  const branches = branchesQ.data ?? [];
  const staffBranchId = settings.branchId ?? branches[0]?.id ?? null;
  const branchName = isDevice ? (deviceBranchName ?? "—") : (branches.find((b) => b.id === staffBranchId)?.name ?? "—");

  // البنر: كامل الكتالوج بلا سقف. وضع الجهاز مفروض خادمياً من التوكن (بدون تمرير فرع من العميل).
  const cachedProductsRef = useRef<KProduct[]>([]);
  const bannerQ = trpc.kiosk.banner.useQuery(
    isDevice ? {} : { branchId: staffBranchId ?? 0 },
    { enabled: isDevice || staffBranchId != null, refetchInterval: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );
  if (bannerQ.data && bannerQ.data.length > 0) {
    cachedProductsRef.current = bannerQ.data as KProduct[];
  }
  const products = (bannerQ.data && bannerQ.data.length > 0 ? bannerQ.data : cachedProductsRef.current) as KProduct[];

  // العروض والبنرات الإعلانية لشاشة الكشك
  const promosQ = trpc.kiosk.promotions.useQuery(
    isDevice ? undefined : { branchId: staffBranchId ?? undefined },
    { enabled: isDevice || staffBranchId != null, refetchInterval: 10 * 60 * 1000, refetchOnWindowFocus: false }
  );
  const promos = (promosQ.data ?? []) as KPromo[];

  // إن ألغى المدير الجهاز من الخادم، يُرفض الاستعلام بـUNAUTHORIZED ونُنهي الجلسة فوراً بلا انتظار
  useEffect(() => {
    if (isDevice && bannerQ.error?.data?.code === "UNAUTHORIZED") {
      onDeviceLogout?.();
    }
  }, [isDevice, bannerQ.error, onDeviceLogout]);

  // ── محرّك المسح ──
  const utils = trpc.useUtils();
  const [scan, setScan] = useState<ScanState>({ mode: "idle", token: 0 });
  const [keypadOpen, setKeypadOpen] = useState(false);

  const handleScan = useCallback(async (code: string) => {
    const clean = normalizeBarcodeScannerInput(String(code));
    if (!clean) return;
    if (!isDevice && staffBranchId == null) return;

    // 1. فحص فوري بالذاكرة المحلية (استجابة 0ms وصوت نجاح فوري) إن كان الباركود ضمن الكتالوج النشط
    const localMatch = products.find((pr) => pr.barcode === clean);
    if (localMatch) {
      if (settings.enableSound) playScanSuccess();
      setScan({ mode: "result", product: localMatch, code: clean, token: Date.now() });
    }

    // 2. فحص موثوق من الخادم لجلب خصومات العروض المحدّثة ووحدات الصنف الأخرى والباركودات البديلة
    try {
      const p = (await utils.kiosk.lookup.fetch(
        isDevice ? { barcode: clean } : { branchId: staffBranchId ?? 0, barcode: clean }
      )) as KProduct | null;
      if (p) {
        if (!localMatch && settings.enableSound) playScanSuccess();
        setScan({ mode: "result", product: p, code: clean, token: Date.now() });
      } else if (!localMatch) {
        if (settings.enableSound) playScanNotFound();
        setScan({ mode: "notfound", code: clean, token: Date.now() });
      }
    } catch (err: any) {
      if (isDevice && err?.data?.code === "UNAUTHORIZED") {
        onDeviceLogout?.();
        return;
      }
      if (!localMatch) {
        if (settings.enableSound) playScanNotFound();
        setScan({ mode: "neterror", code: clean, token: Date.now() });
      }
    }
  }, [isDevice, onDeviceLogout, staffBranchId, utils, products, settings.enableSound]);

  // نفس سياسة HID المشتركة؛ تقبل رموز الموردين القصيرة (محرفان) وكل ASCII القابل للطباعة،
  // وتتجاهل حقول إعدادات الكشك من دون مستمعٍ محليّ ينحرف عن بقية الشاشات.
  useBarcodeScanner(handleScan, { minLength: 2, thresholdMs: 120 });

  // الإغلاق التلقائي لنتيجة المسح.
  useEffect(() => {
    if (scan.mode === "idle") return;
    const id = setTimeout(() => setScan({ mode: "idle", token: 0 }), Math.max(2, settings.priceDuration) * 1000);
    return () => clearTimeout(id);
  }, [scan.mode, scan.token, settings.priceDuration]);

  // ── التحجيم: دعم شاشات الكشك العادية (1920×1080) والعمودية (Portrait 1080×1920) ──
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [isPortrait, setIsPortrait] = useState(false);
  useEffect(() => {
    const fit = () => {
      const c = canvasRef.current;
      if (!c) return;
      const portrait = window.innerHeight > window.innerWidth;
      setIsPortrait(portrait);
      const targetW = portrait ? 1080 : 1920;
      const targetH = portrait ? 1920 : 1080;
      const s = Math.min(window.innerWidth / targetW, window.innerHeight / targetH);
      c.style.transform = `translate(-50%, -50%) scale(${s})`;
    };
    fit();
    window.addEventListener("resize", fit);
    const t = setTimeout(fit, 60);
    return () => { window.removeEventListener("resize", fit); clearTimeout(t); };
  }, []);

  // ── QR التواصل ──
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!settings.showQr || !settings.contactUrl) { setQrUrl(null); return; }
    QRCode.toDataURL(settings.contactUrl, { margin: 0, width: 220, errorCorrectionLevel: "M" })
      .then((u) => { if (alive) setQrUrl(u); })
      .catch(() => { if (alive) setQrUrl(null); });
    return () => { alive = false; };
  }, [settings.showQr, settings.contactUrl]);

  const [panelOpen, setPanelOpen] = useState(false);
  const dismiss = () => setScan({ mode: "idle", token: 0 });

  return (
    <div
      className={"kioskpc-root" + (settings.theme === "dark" ? " kpc-dark" : "")}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className={"kpc-canvas" + (isPortrait ? " kpc-portrait" : "")} ref={canvasRef}>
        <div className="kiosk">
          {/* الترويسة */}
          <header className="kiosk-header">
            {settings.showLogo ? (
              <div className="logo">
                {/* الشعار الحقيقي (icon-512.png = نفس logo.png بحجمٍ خفيف) بدل مربّع «ر.ع» المصطنع */}
                <div className="logo-mark">
                  <img
                    src="/icon-512.png"
                    alt="شعار المكتبة العربية للطباعة والقرطاسية"
                    width={74}
                    height={74}
                    draggable={false}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                </div>
                <div className="logo-text">
                  <strong>الرؤية العربية</strong>
                  <span>للطباعة والقرطاسية</span>
                </div>
              </div>
            ) : <div />}
            <div className="header-right">
              <div className="kiosk-tag">قارئ الأسعار</div>
              {settings.showLogo && <div className="branch-chip"><span className="dot" />{branchName}</div>}
            </div>
          </header>

          <Banner
            products={products}
            promos={promos}
            rotateSec={settings.rotateSec}
            priceScale={settings.priceScale}
            paused={scan.mode !== "idle"}
            branchKey={isDevice ? "dev" : staffBranchId}
          />

          {/* التذييل: تعليمات + زر الإدخال اليدوي + QR */}
          <footer className="kiosk-footer">
            {settings.showInstruction ? (
              <div className="instruction">
                <span className="scan-badge"><IconScan s={52} /></span>
                <div className="instruction-text">
                  <strong>مرّر الباركود أمام الماسح</strong>
                  <span>لعرض سعر المنتج فوراً</span>
                </div>
              </div>
            ) : <div />}

            <button className="kpc-touch-trigger" onClick={() => setKeypadOpen(true)}>
              <Keyboard aria-hidden className="size-5" />
              <span>إدخال يدوي للرقم</span>
            </button>

            {settings.showQr && qrUrl ? (
              <div className="qr-box">
                <div className="qr-frame"><img src={qrUrl} alt="QR" draggable={false} /></div>
                <div className="qr-text">
                  <strong>{settings.contactLabel}</strong>
                  <span>امسح الرمز بكاميرا هاتفك</span>
                </div>
              </div>
            ) : <div />}
          </footer>

          <ScanOverlay scan={scan} priceDuration={settings.priceDuration} priceScale={settings.priceScale} onDismiss={dismiss} />
          <TouchKeypadModal open={keypadOpen} onClose={() => setKeypadOpen(false)} onSubmit={(c) => handleScan(c)} />
        </div>
      </div>

      {/* أدوات الموظّف (خارج اللوحة المُحجَّمة) — في وضع الجهاز ترسٌ خافت غير لافت للزبون */}
      <div className={"kpc-tools" + (isDevice ? " kpc-tools-device" : "")}>
        <button className="kpc-fab" onClick={() => setPanelOpen((v) => !v)} title="إعدادات الكشك">
          <IconScan s={20} /> {isDevice ? "" : "إعدادات الكشك"}
        </button>
      </div>

      {panelOpen && (
        <div className="kpc-panel">
          <div className="kpc-panel-head">
            <strong>إعدادات الكشك{isDevice ? " (للموظّف)" : ""}</strong>
            <button onClick={() => setPanelOpen(false)} aria-label="إغلاق"><X aria-hidden className="size-4" /></button>
          </div>
          <div className="kpc-panel-body">
            {/* اختيار الفرع — الموظّف فقط؛ في وضع الجهاز الفرع مفروض خادمياً */}
            {!isDevice ? (
              <div className="kpc-field">
                <label>الفرع</label>
                <select value={staffBranchId ?? ""} onChange={(e) => setTweak("branchId", e.target.value ? Number(e.target.value) : null)}>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            ) : (
              <div className="kpc-field">
                <label>الفرع (مفروض على هذا الجهاز)</label>
                <input type="text" value={branchName} readOnly disabled />
              </div>
            )}

            <div className="kpc-field">
              <label>الثيم</label>
              <div className="kpc-seg">
                <button className={settings.theme === "light" ? "on" : ""} onClick={() => setTweak("theme", "light")}>فاتح</button>
                <button className={settings.theme === "dark" ? "on" : ""} onClick={() => setTweak("theme", "dark")}>داكن</button>
              </div>
            </div>

            <div className="kpc-field">
              <label>مدّة عرض كل منتج: {settings.rotateSec} ث</label>
              <div className="kpc-row">
                <input type="range" min={3} max={15} step={1} value={settings.rotateSec} onChange={(e) => setTweak("rotateSec", Number(e.target.value))} />
              </div>
            </div>
            <div className="kpc-field">
              <label>مدّة بقاء بطاقة السعر: {settings.priceDuration} ث</label>
              <div className="kpc-row">
                <input type="range" min={3} max={15} step={1} value={settings.priceDuration} onChange={(e) => setTweak("priceDuration", Number(e.target.value))} />
              </div>
            </div>
            <div className="kpc-field">
              <label>كِبَر السعر: {settings.priceScale.toFixed(2)}×</label>
              <div className="kpc-row">
                <input type="range" min={0.8} max={1.4} step={0.05} value={settings.priceScale} onChange={(e) => setTweak("priceScale", Number(e.target.value))} />
              </div>
            </div>

            <label className="kpc-toggle">الشعار + اسم الفرع
              <input type="checkbox" checked={settings.showLogo} onChange={(e) => setTweak("showLogo", e.target.checked)} />
            </label>
            <label className="kpc-toggle">تعليمات المسح
              <input type="checkbox" checked={settings.showInstruction} onChange={(e) => setTweak("showInstruction", e.target.checked)} />
            </label>
            <label className="kpc-toggle">رمز QR للتواصل
              <input type="checkbox" checked={settings.showQr} onChange={(e) => setTweak("showQr", e.target.checked)} />
            </label>
            <label className="kpc-toggle">التنبيه الصوتي عند المسح
              <input type="checkbox" checked={settings.enableSound} onChange={(e) => setTweak("enableSound", e.target.checked)} />
            </label>

            <div className="kpc-field">
              <label>نص التواصل</label>
              <input type="text" value={settings.contactLabel} onChange={(e) => setTweak("contactLabel", e.target.value)} />
            </div>
            <div className="kpc-field">
              <label>رابط QR (واتساب/صفحة)</label>
              <input type="text" value={settings.contactUrl} onChange={(e) => setTweak("contactUrl", e.target.value)} />
            </div>

            <div className="kpc-field">
              <label>وضع العمل المستمر (منع سكون الشاشة 24/7)</label>
              <div className={`kpc-status-chip ${wakeLock.isLocked ? "active" : "inactive"}`}>
                <span className={`kpc-status-dot ${wakeLock.isLocked ? "active" : "inactive"}`} />
                <span>
                  {wakeLock.isLocked
                    ? "حارس استيقاظ الشاشة نشط ويعمل"
                    : "حارس استيقاظ الشاشة غير نشط (تحقق من إعدادات المتصفح والنظام)"}
                </span>
              </div>
            </div>

            {/* محاكاة المسح — الموظّف داخل التطبيق فقط (لا تُعرض للزبون على الجهاز) */}
            {!isDevice && (
              <div className="kpc-field">
                <label>تجربة المسح (محاكاة — للموظّف)</label>
                <div className="kpc-demo-list">
                  {products.slice(0, 12).map((p) => (
                    <button key={p.productId} className="kpc-demo-item" onClick={() => p.barcode && handleScan(p.barcode)} disabled={!p.barcode}>
                      <span className="di-name">{p.productName}</span>
                      <span className="di-bc">{p.barcode ?? "بلا باركود"}</span>
                    </button>
                  ))}
                  <button className="kpc-demo-item bad" onClick={() => handleScan("0000000000000")}>
                    <span className="di-name">باركود غير معروف (تجربة)</span>
                    <span className="di-bc">0000000000000</span>
                  </button>
                </div>
              </div>
            )}

            <div className="kpc-field">
              <button className="kpc-link-btn inline-flex items-center gap-1.5" onClick={() => { const el = document.documentElement; if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); }}>
                <span>ملء الشاشة</span>
                <Maximize aria-hidden className="size-4" />
              </button>
              {!isDevice ? (
                <button className="kpc-link-btn" onClick={() => navigate("/")}>خروج من الكشك ← لوحة التحكم</button>
              ) : (
                onDeviceLogout && <button className="kpc-link-btn kpc-danger" onClick={onDeviceLogout}>إنهاء جلسة الجهاز (للموظّف)</button>
              )}
            </div>
            <p className="kpc-note">الإعدادات تُحفظ على هذا الجهاز فقط. شاشة الزبون لا تعرض المخزون أو التكلفة.</p>
          </div>
        </div>
      )}
    </div>
  );
}

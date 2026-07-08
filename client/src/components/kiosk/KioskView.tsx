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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import QRCode from "qrcode";
import { trpc } from "@/lib/trpc";
import { X, Maximize } from "lucide-react";

export type KProduct = {
  productId: number;
  productName: string;
  brand: string | null;
  category: string | null;
  variantName: string | null;
  unitName: string;
  price: string | null;
  barcode: string | null;
  imageUrl: string | null;
};

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
};
const LS_KEY = "kiosk_settings_v1";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {/* ignore */}
  return { ...DEFAULTS };
}

const fmtPrice = (n: string | number) => Number(n).toLocaleString("en-US");
const cssVar = (name: string, value: string | number) => ({ [name]: String(value) }) as React.CSSProperties;

type ScanState =
  | { mode: "idle"; token: number }
  | { mode: "result"; product: KProduct; code: string; token: number }
  | { mode: "notfound"; code: string; token: number };

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

// ── صورة المنتج أو خانة بديلة ────────────────────────────────────────────────
function KioskImage({ p }: { p: KProduct }) {
  if (p.imageUrl) return <img className="kpc-img" src={p.imageUrl} alt={p.productName} />;
  return (
    <div className="kpc-ph">
      <span className="kpc-ph-cat">{p.category ?? p.brand ?? "منتج"}</span>
      <span className="kpc-ph-sub">صورة المنتج</span>
    </div>
  );
}

// ── كتلة السعر (مشتركة بين البنر وبطاقة المسح) ───────────────────────────────
function PriceBlock({ p, priceScale }: { p: KProduct; priceScale: number }) {
  return (
    <div className="price-wrap" style={cssVar("--ps", priceScale)}>
      <div className="price-label">سعر المفرد</div>
      {p.price != null ? (
        <>
          <div className="price-row">
            <span className="price-num">{fmtPrice(p.price)}</span>
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

// ── البنر المتحرك ─────────────────────────────────────────────────────────────
function Banner({ products, rotateSec, priceScale, paused }: { products: KProduct[]; rotateSec: number; priceScale: number; paused: boolean }) {
  const [idx, setIdx] = useState(0);
  const n = products.length;
  const rotateMs = Math.max(2, rotateSec) * 1000;

  useEffect(() => { if (idx >= n) setIdx(0); }, [n, idx]);
  useEffect(() => {
    if (paused || n <= 1) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % n), rotateMs);
    return () => clearInterval(id);
  }, [paused, n, rotateMs]);

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
        {products.map((p, i) => (
          <div key={p.productId} className={"slide" + (i === idx ? " is-active" : "")} aria-hidden={i !== idx}>
            <div className="slide-media"><KioskImage p={p} /></div>
            <div className="slide-info">
              <div className="brand-chip">{[p.brand, p.category].filter(Boolean).join(" · ") || "منتج"}</div>
              <h1 className="prod-name">{p.productName}</h1>
              <PriceBlock p={p} priceScale={priceScale} />
            </div>
          </div>
        ))}
      </div>
      {n > 1 && (
        <div className="banner-progress">
          <div className="counter"><b>{String(idx + 1).padStart(2, "0")}</b> / {String(n).padStart(2, "0")}</div>
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
  const setTweak = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {/* ignore */}
      return next;
    });
  }, []);

  // مستخدم النظام والفروع — وضع الموظّف فقط (مُعطّلة في وضع الجهاز كي لا تُطلق 401).
  const me = trpc.auth.me.useQuery(undefined, { enabled: !isDevice });
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: !isDevice });
  const branches = branchesQ.data ?? [];
  const staffBranchId = settings.branchId ?? me.data?.branchId ?? branches[0]?.id ?? null;
  const branchName = isDevice ? (deviceBranchName ?? "—") : (branches.find((b) => b.id === staffBranchId)?.name ?? "—");

  // البنر: الموظّف يرسل branchId؛ الجهاز يعتمد كوكيه (الفرع مفروض خادمياً) فلا يرسل branchId.
  // limit=500 (كل الكتالوج): يعرض البنر كامل المنتجات النشطة غير الخدمية، لا عيّنة ٤٠.
  const bannerQ = trpc.kiosk.banner.useQuery(
    isDevice ? { limit: 500 } : { branchId: staffBranchId ?? 0, limit: 500 },
    { enabled: isDevice || staffBranchId != null, refetchInterval: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  // خلط عشوائي (Fisher-Yates) عند كل جلب ناجح: react-query يُعيد نفس مرجع `data` بلا تغيير
  // إن لم يحدث fetch، وبمرجع جديد عند كل استجابة (كل ٥ دقائق) ⇒ useMemo يُعيد خلطها فقط
  // عند حدوث جلب فعلي. النتيجة: كل ٥ دقائق يرى الزبون ترتيباً مختلفاً بدل «أبجدي ممل» ثابت.
  // ذوات الصور تبقى في المقدّمة (الخادم يُرتّبها أولاً)، ثمّ الخلط داخل كل مجموعة.
  const products = useMemo<KProduct[]>(() => {
    const data = (bannerQ.data ?? []) as KProduct[];
    if (data.length <= 1) return data;
    const withImg: KProduct[] = [];
    const noImg: KProduct[] = [];
    for (const p of data) (p.imageUrl ? withImg : noImg).push(p);
    const shuffle = (arr: KProduct[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    return [...shuffle(withImg), ...shuffle(noImg)];
  }, [bannerQ.data]);

  // ── محرّك المسح ──
  const utils = trpc.useUtils();
  const [scan, setScan] = useState<ScanState>({ mode: "idle", token: 0 });
  const handleScan = useCallback(async (code: string) => {
    const clean = String(code).trim();
    if (!clean) return;
    if (!isDevice && staffBranchId == null) return;
    try {
      const p = (await utils.kiosk.lookup.fetch(
        isDevice ? { barcode: clean } : { branchId: staffBranchId ?? 0, barcode: clean }
      )) as KProduct | null;
      setScan(p ? { mode: "result", product: p, code: clean, token: Date.now() } : { mode: "notfound", code: clean, token: Date.now() });
    } catch {
      setScan({ mode: "notfound", code: clean, token: Date.now() });
    }
  }, [isDevice, staffBranchId, utils]);

  // الماسح يكتب بسرعة وينهي بـEnter — مع تجاهل حقول الإدخال (لوحة الإعدادات).
  const scanRef = useRef(handleScan);
  scanRef.current = handleScan;
  useEffect(() => {
    const buf = { s: "", last: 0 };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
      const now = Date.now();
      if (now - buf.last > 120) buf.s = "";
      buf.last = now;
      if (e.key === "Enter") {
        if (buf.s.length >= 3) scanRef.current(buf.s);
        buf.s = "";
        return;
      }
      if (e.key.length === 1 && /[\w\-]/.test(e.key)) buf.s += e.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // الإغلاق التلقائي لنتيجة المسح.
  useEffect(() => {
    if (scan.mode === "idle") return;
    const id = setTimeout(() => setScan({ mode: "idle", token: 0 }), Math.max(2, settings.priceDuration) * 1000);
    return () => clearTimeout(id);
  }, [scan.mode, scan.token, settings.priceDuration]);

  // ── التحجيم: لوحة 1920×1080 تُملأ في أي شاشة ──
  const canvasRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const fit = () => {
      const c = canvasRef.current;
      if (!c) return;
      const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
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
    <div className={"kioskpc-root" + (settings.theme === "dark" ? " kpc-dark" : "")}>
      <div className="kpc-canvas" ref={canvasRef}>
        <div className="kiosk">
          {/* الترويسة */}
          <header className="kiosk-header">
            {settings.showLogo ? (
              <div className="logo">
                <div className="logo-mark"><span>ر.ع</span></div>
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

          <Banner products={products} rotateSec={settings.rotateSec} priceScale={settings.priceScale} paused={scan.mode !== "idle"} />

          {/* التذييل: تعليمات + QR */}
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
            {settings.showQr && qrUrl ? (
              <div className="qr-box">
                <div className="qr-frame"><img src={qrUrl} alt="QR" /></div>
                <div className="qr-text">
                  <strong>{settings.contactLabel}</strong>
                  <span>امسح الرمز بكاميرا هاتفك</span>
                </div>
              </div>
            ) : <div />}
          </footer>

          <ScanOverlay scan={scan} priceDuration={settings.priceDuration} priceScale={settings.priceScale} onDismiss={dismiss} />
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

            <div className="kpc-field">
              <label>نص التواصل</label>
              <input type="text" value={settings.contactLabel} onChange={(e) => setTweak("contactLabel", e.target.value)} />
            </div>
            <div className="kpc-field">
              <label>رابط QR (واتساب/صفحة)</label>
              <input type="text" value={settings.contactUrl} onChange={(e) => setTweak("contactUrl", e.target.value)} />
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

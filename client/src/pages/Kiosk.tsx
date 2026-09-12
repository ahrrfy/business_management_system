/**
 * /kiosk — مدخل **جهاز الكشك الخارجي** (شاشة قارئ أسعار مستقلّة).
 *
 * ليست خلف <Protected>: الهوية كوكي **جهاز** (لا مستخدم نظام). التسلسل:
 *  ① المُشغّل يفتح /kiosk#t=<token> ⇒ نقرأ الرمز من الـfragment أو localStorage، نبادله بكوكي جهاز (deviceLogin).
 *     لا نُزيل الرمز من العنوان (stripHash) إلا بعد نجاح التوثيق، ونحتفظ بنسخة في localStorage للحصانة ضد انقطاع الشبكة.
 *  ② إن وُجد كوكي صالح من إقلاع سابق ⇒ deviceMe ينجح بلا رمز.
 *  ③ انقطاع شبكي أو إقلاع بطيء للراوتر ⇒ إعادة محاولة ذكية متكررة واستماع فوري لعودة الاتصال (online event).
 *  ④ غير مُصرَّح بعد استنفاذ المحاولات ⇒ شاشة واضحة + حقل تفعيل يدوي للموظّف (لصق الرمز).
 *
 * البيانات آمنة للزبون (kioskRouter): بلا تكلفة ولا مخزون. الرمز نطاقه قراءة الأسعار فقط.
 */
import { useEffect, useRef, useState } from "react";
import { Lock, RefreshCw, WifiOff } from "lucide-react";
import { trpc } from "@/lib/trpc";
import KioskView from "@/components/kiosk/KioskView";

const KIOSK_DEVICE_TOKEN_KEY = "alroya_kiosk_device_token_v1";

function readHashToken(): string | null {
  try {
    const h = window.location.hash.replace(/^#/, "");
    const p = new URLSearchParams(h);
    const t = p.get("t");
    return t && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

function getStoredToken(): string | null {
  try {
    const val = localStorage.getItem(KIOSK_DEVICE_TOKEN_KEY);
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

function setStoredToken(t: string) {
  try {
    localStorage.setItem(KIOSK_DEVICE_TOKEN_KEY, t.trim());
  } catch {/* ignore */}
}

function clearStoredToken() {
  try {
    localStorage.removeItem(KIOSK_DEVICE_TOKEN_KEY);
  } catch {/* ignore */}
}

function stripHash() {
  try {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {/* ignore */}
}

const wrap: React.CSSProperties = {
  position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
  background: "#0b0d16", color: "#e9ecf5", fontFamily: '"Cairo", system-ui, sans-serif', direction: "rtl", padding: 24,
};
const card: React.CSSProperties = {
  width: "min(440px, 92vw)", background: "#141826", border: "1px solid rgba(255,255,255,.08)",
  borderRadius: 18, padding: "30px 26px", textAlign: "center", boxShadow: "0 30px 80px -30px rgba(0,0,0,.7)",
};

export default function Kiosk() {
  const utils = trpc.useUtils();
  const tokenRef = useRef<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [manual, setManual] = useState("");
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);

  const deviceMe = trpc.kiosk.deviceMe.useQuery(undefined, {
    retry: (failureCount, error) => {
      // إن كان الخطأ صريحاً بأن الرمز ملغى فلا فائدة من إعادة المحاولة
      if ((error as any)?.data?.code === "UNAUTHORIZED") return false;
      return failureCount < 5;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    refetchOnWindowFocus: false,
  });

  const login = trpc.kiosk.deviceLogin.useMutation({
    onSuccess: () => {
      if (tokenRef.current) {
        setStoredToken(tokenRef.current);
      }
      stripHash();
      void utils.kiosk.deviceMe.invalidate();
    },
  });

  const logout = trpc.kiosk.deviceLogout.useMutation({
    onSuccess: () => {
      clearStoredToken();
      tokenRef.current = null;
      void utils.kiosk.deviceMe.invalidate();
    },
  });

  const refresh = trpc.kiosk.deviceRefresh.useMutation();

  // تجديد دوري لكوكي جلسة الجهاز كل ٢٤ ساعة حتى لا تنتهي الجلسة ما دام الجهاز يعمل
  useEffect(() => {
    if (!deviceMe.data) return;
    const interval = setInterval(() => {
      refresh.mutate();
    }, 24 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [deviceMe.data, refresh]);

  // إقلاع: قراءة الرمز من الـfragment أو من التخزين المحلي الآمن.
  useEffect(() => {
    const hashToken = readHashToken();
    const storedToken = getStoredToken();
    const t = hashToken || storedToken;

    if (t) {
      tokenRef.current = t;
      if (hashToken) {
        setStoredToken(hashToken);
      }
      login.mutate({ token: t });
    }
    setBooted(true);

    const handleOnline = () => {
      setIsOnline(true);
      void utils.kiosk.deviceMe.invalidate();
      const currentToken = tokenRef.current || getStoredToken();
      if (currentToken && !deviceMe.data) {
        login.mutate({ token: currentToken });
      }
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utils]);

  const authed = !!deviceMe.data;

  if (authed) {
    return (
      <KioskView
        mode="device"
        deviceBranchName={deviceMe.data?.branchName ?? undefined}
        onDeviceLogout={() => logout.mutate()}
      />
    );
  }

  // ما زلنا نحاول (تحميل الحالة أو تبادل الرمز).
  const working = !booted || deviceMe.isLoading || login.isPending || logout.isPending;
  if (working) {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={{ width: 54, height: 54, margin: "0 auto 16px", borderRadius: 14, background: "#1d2336", display: "flex", alignItems: "center", justifyContent: "center", color: "#6366f1" }}>
            <RefreshCw className="motion-safe:animate-spin" size={26} aria-hidden />
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>جارٍ تجهيز شاشة قارئ الأسعار…</div>
          <div style={{ fontSize: 13.5, opacity: 0.7, marginTop: 8 }}>لحظات للتحقق والاتصال بالخادم</div>
        </div>
      </div>
    );
  }

  // في حال انقطاع الشبكة أثناء الإقلاع
  if (!isOnline) {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={{ width: 56, height: 56, margin: "0 auto 14px", borderRadius: 16, background: "#2a1e24", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171" }}>
            <WifiOff aria-hidden size={28} />
          </div>
          <div style={{ fontSize: 19, fontWeight: 800 }}>في انتظار الاتصال بالشبكة</div>
          <p style={{ fontSize: 13.5, opacity: 0.75, lineHeight: 1.8, margin: "10px 0 18px" }}>
            تعذّر الوصول إلى شبكة المتجر حالياً. سيعيد القارئ الاتصال تلقائياً فور توفر الشبكة.
          </p>
          <button
            onClick={() => {
              const t = tokenRef.current || getStoredToken();
              if (t) login.mutate({ token: t });
              else void utils.kiosk.deviceMe.invalidate();
            }}
            style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#3f46d6", color: "#fff", fontFamily: "inherit", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
          >
            إعادة فحص الشبكة
          </button>
        </div>
      </div>
    );
  }

  // غير مُصرَّح: شاشة واضحة + تفعيل يدوي للموظّف.
  const failed = login.isError;
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ width: 60, height: 60, margin: "0 auto 14px", borderRadius: 16, background: "#1d2336", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Lock aria-hidden size={28} />
        </div>
        <div style={{ fontSize: 19, fontWeight: 800 }}>هذا الجهاز غير مُصرَّح</div>
        <p style={{ fontSize: 13.5, opacity: 0.75, lineHeight: 1.9, margin: "10px 0 18px" }}>
          {failed
            ? "رمز الجهاز غير صحيح أو مُلغى."
            : "لم يُفعَّل هذا الجهاز بعد."}
          {" "}اطلب من المدير إنشاء جهاز من:
          <br />
          <b>الإدارة ← شاشات قارئ الأسعار (الأجهزة)</b>
          <br />
          ثم استعمل المُشغّل، أو الصق رمز الجهاز هنا:
        </p>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="kde_..."
            dir="ltr"
            style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,.14)", background: "#0b0d16", color: "#e9ecf5", fontFamily: "monospace", fontSize: 13 }}
          />
          <button
            onClick={() => { const t = manual.trim(); if (t) { tokenRef.current = t; setStoredToken(t); login.mutate({ token: t }); } }}
            disabled={!manual.trim() || login.isPending}
            style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: "#3f46d6", color: "#fff", fontFamily: "inherit", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
          >
            تفعيل
          </button>
        </div>
        {(tokenRef.current || getStoredToken()) && failed && (
          <button
            onClick={() => {
              const t = tokenRef.current || getStoredToken();
              if (t) login.mutate({ token: t });
            }}
            style={{ marginTop: 12, border: "none", background: "transparent", color: "#9aa3e8", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
          >
            إعادة المحاولة بالرمز السابق
          </button>
        )}
      </div>
    </div>
  );
}

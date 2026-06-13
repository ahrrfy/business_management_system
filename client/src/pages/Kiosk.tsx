/**
 * /kiosk — مدخل **جهاز الكشك الخارجي** (شاشة قارئ أسعار مستقلّة).
 *
 * ليست خلف <Protected>: الهوية كوكي **جهاز** (لا مستخدم نظام). التسلسل:
 *  ① المُشغّل يفتح /kiosk#t=<token> ⇒ نقرأ الرمز من الـfragment، نبادله بكوكي جهاز (deviceLogin)،
 *     ثم نمسحه من شريط العنوان (history.replaceState) فلا يبقى ظاهراً.
 *  ② إن وُجد كوكي صالح من إقلاع سابق ⇒ deviceMe ينجح بلا رمز.
 *  ③ غير مُصرَّح ⇒ شاشة واضحة + حقل تفعيل يدوي للموظّف (لصق الرمز).
 *
 * البيانات آمنة للزبون (kioskRouter): بلا تكلفة ولا مخزون. الرمز نطاقه قراءة الأسعار فقط.
 */
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import KioskView from "@/components/kiosk/KioskView";

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

  const deviceMe = trpc.kiosk.deviceMe.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const login = trpc.kiosk.deviceLogin.useMutation({
    onSuccess: () => {
      stripHash();
      void utils.kiosk.deviceMe.invalidate();
    },
  });
  const logout = trpc.kiosk.deviceLogout.useMutation({
    onSuccess: () => {
      void utils.kiosk.deviceMe.invalidate();
    },
  });

  // إقلاع: التقط الرمز من الـfragment (إن وُجد) وبادله بكوكي.
  useEffect(() => {
    const t = readHashToken();
    if (t) {
      tokenRef.current = t;
      stripHash();
      login.mutate({ token: t });
    }
    setBooted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <div style={{ fontSize: 17, fontWeight: 700 }}>جارٍ تجهيز شاشة قارئ الأسعار…</div>
          <div style={{ fontSize: 13, opacity: 0.65, marginTop: 8 }}>لحظات من فضلك</div>
        </div>
      </div>
    );
  }

  // غير مُصرَّح: شاشة واضحة + تفعيل يدوي للموظّف.
  const failed = login.isError;
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ width: 60, height: 60, margin: "0 auto 14px", borderRadius: 16, background: "#1d2336", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>🔒</div>
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
            onClick={() => { const t = manual.trim(); if (t) { tokenRef.current = t; login.mutate({ token: t }); } }}
            disabled={!manual.trim() || login.isPending}
            style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: "#3f46d6", color: "#fff", fontFamily: "inherit", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
          >
            تفعيل
          </button>
        </div>
        {tokenRef.current && failed && (
          <button
            onClick={() => login.mutate({ token: tokenRef.current as string })}
            style={{ marginTop: 12, border: "none", background: "transparent", color: "#9aa3e8", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
          >
            إعادة المحاولة بالرمز السابق
          </button>
        )}
      </div>
    </div>
  );
}

import { Button } from "@/components/ui/button";
import { useConnectivity } from "@/lib/offline/connectivity";
import {
  getOfflineProfile,
  isOfflineUnlocked,
  markOfflineUnlocked,
  subscribeOfflineUnlock,
  verifyOfflinePin,
  type OfflineProfile,
} from "@/lib/offline/pinLock";
import { KeyRound, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "wouter";

/**
 * شاشة «تعذّر الاتصال بالخادم» أثناء التحقق من الجلسة (إقلاع التطبيق والاتصال مقطوع).
 * قبل الشريحة ١ كان فشل جلب auth.me الشبكي يُعامل كغياب جلسة فيُرمى المستخدم لشاشة الدخول —
 * الآن يبقى هنا وتُستأنف الجلسة تلقائياً فور عودة الاتصال (يُخطرنا مسبار connectivity).
 */
export function AuthConnectionError({ onRetry }: { onRetry: () => void }) {
  const state = useConnectivity();
  const prevState = useRef(state);
  useEffect(() => {
    // إعادة الجلب عند الانتقال الفعلي إلى online فقط — لا عند كل إعادة رسم (منع حلقة refetch).
    if (state === "online" && prevState.current !== "online") onRetry();
    prevState.current = state;
  }, [state, onRetry]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <WifiOff aria-hidden className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-lg font-semibold">تعذّر الاتصال بالخادم</p>
        <p className="text-sm text-muted-foreground">
          تحقّق من اتصال الإنترنت — ستُستأنف الجلسة تلقائياً فور عودة الاتصال.
        </p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        <RefreshCw aria-hidden className="size-4" />
        إعادة المحاولة
      </Button>
    </div>
  );
}

/**
 * بوابة الإقلاع دون اتصال (ش٥): تشغيل الجهاز والقطع مستمر ⇒ لا يمكن التحقق من الجلسة
 * خادمياً. مَن سبق دخوله أونلاين على هذا الجهاز وضبط رمز PIN يفتح **شاشة الكاشير فقط**
 * (بقية الشاشات تبقى «تتطلب اتصالاً»). حراسة واجهة للانضباط لا مصادقة تشفيرية — الترحيل
 * يستوثق بجلسة الخادم عند العودة، وأي إبطال خادمي يسري حينها. بلا ملف/PIN ⇒ شاشة
 * «تعذّر الاتصال» المعتادة. القفل يعود مع كل إعادة تحميل (حالة ذاكرة لا تخزين).
 */
export function OfflineBootGate({ onRetry, children }: { onRetry: () => void; children: React.ReactNode }) {
  const [loc] = useLocation();
  const unlocked = useSyncExternalStore(subscribeOfflineUnlock, isOfflineUnlocked, isOfflineUnlocked);
  const [profile, setProfile] = useState<OfflineProfile | null | undefined>(undefined);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fails, setFails] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getOfflineProfile().then((p) => setProfile(p ?? null));
  }, []);

  if (unlocked) {
    // مفتوح: الكاشير فقط — أي مسار آخر يُدَلّ على نقطة البيع بدل شاشات ستفشل استعلاماتها حتماً.
    if (loc === "/pos" || loc.startsWith("/pos?")) return <>{children}</>;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <WifiOff aria-hidden className="size-10 text-muted-foreground" />
        <p className="text-lg font-semibold">المتاح دون اتصال: نقطة البيع فقط</p>
        <Button asChild>
          <Link href="/pos">فتح نقطة البيع</Link>
        </Button>
      </div>
    );
  }

  if (profile === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">جارٍ التحميل…</div>;
  }
  if (!profile || !profile.hasPin) {
    // لا ملف جهاز/لا PIN ⇒ الشاشة المعتادة (مع تلميح الضبط لاحقاً من إعدادات شارة المزامنة).
    return <AuthConnectionError onRetry={onRetry} />;
  }

  const coolingDown = Date.now() < cooldownUntil;
  const submit = () => {
    if (busy || coolingDown || !pin) return;
    setBusy(true);
    void verifyOfflinePin(pin).then((ok) => {
      setBusy(false);
      if (ok) {
        markOfflineUnlocked();
        return;
      }
      setPin("");
      const nextFails = fails + 1;
      setFails(nextFails);
      if (nextFails >= 5) {
        // كبح محاولات محلي: ٥ إخفاقات ⇒ تهدئة ٣٠ ثانية (حماية من العبث السريع على المنضدة).
        setCooldownUntil(Date.now() + 30_000);
        setFails(0);
        setError("محاولات كثيرة — انتظر ٣٠ ثانية");
      } else {
        setError("رمز غير صحيح");
      }
    });
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <KeyRound aria-hidden className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-lg font-semibold">وضع العمل دون اتصال</p>
        <p className="text-sm text-muted-foreground">
          أدخل رمز PIN لفتح نقطة البيع — {profile.name}
        </p>
      </div>
      <div className="flex w-56 flex-col gap-2">
        <input
          type="password"
          inputMode="numeric"
          dir="ltr"
          autoFocus
          value={pin}
          onChange={(e) => { setPin(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="••••"
          className="h-11 rounded-md border bg-background px-3 text-center text-lg font-bold tracking-widest"
        />
        <Button onClick={submit} disabled={busy || coolingDown || !pin}>
          {busy ? "جارٍ التحقق…" : coolingDown ? "انتظر قليلاً…" : "فتح"}
        </Button>
        {error ? <p className="text-sm font-semibold text-red-600">{error}</p> : null}
      </div>
      <button type="button" onClick={onRetry} className="text-xs text-muted-foreground underline">
        إعادة محاولة الاتصال بالخادم
      </button>
    </div>
  );
}

/**
 * حارس الشاشات الأونلاينية (داخل Shell): من فتح شاشةً والاتصال مقطوع يرى رسالة صادقة بدل
 * استعلامات تدور ثم تفشل بأشكال متفرقة. أمّا من انقطع اتصاله وهو داخل شاشة محمَّلة فلا نطمس
 * بياناتها المعروضة — الشريط العلوي يكفي إعلاماً.
 * التنفيذ مزلاج أحادي الاتجاه: يُفتح عند أول لحظة اتصال ويبقى مفتوحاً (انقطاع لاحق لا يُخفي الشاشة).
 */
export function OnlineGate({ children }: { children: React.ReactNode }) {
  const state = useConnectivity();
  const [unblocked, setUnblocked] = useState(state === "online" || state === "syncing");
  useEffect(() => {
    if (state === "online" || state === "syncing") setUnblocked(true);
  }, [state]);
  if (!unblocked) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <WifiOff aria-hidden className="size-10 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-lg font-semibold">هذه الشاشة تتطلب اتصالاً بالخادم</p>
          <p className="text-sm text-muted-foreground">
            ستُحمَّل تلقائياً فور عودة الاتصال.
          </p>
        </div>
        <RefreshCw aria-hidden className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <>{children}</>;
}

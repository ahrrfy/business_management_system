import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, Settings2, ShieldCheck, X } from "lucide-react";

export const STOREFRONT_CONSENT_KEY = "arabia_store_consent_v1";

export type StorefrontConsent = {
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  updatedAt: string;
};

type ConsentContextValue = {
  consent: StorefrontConsent | null;
  analyticsAllowed: boolean;
  marketingAllowed: boolean;
  preferencesOpen: boolean;
  openPreferences: () => void;
  closePreferences: () => void;
  saveConsent: (next: Pick<StorefrontConsent, "analytics" | "marketing">) => void;
  allowNecessaryOnly: () => void;
  allowAll: () => void;
};

const ConsentContext = createContext<ConsentContextValue | null>(null);

function normalizeConsent(value: unknown): StorefrontConsent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StorefrontConsent>;
  if (candidate.necessary !== true || typeof candidate.analytics !== "boolean" || typeof candidate.marketing !== "boolean") return null;
  return {
    necessary: true,
    analytics: candidate.analytics,
    marketing: candidate.marketing,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
  };
}

export function readStorefrontConsent(storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): StorefrontConsent | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STOREFRONT_CONSENT_KEY);
    return raw ? normalizeConsent(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function ConsentProvider({ children }: { children: ReactNode }) {
  const [consent, setConsent] = useState<StorefrontConsent | null>(() => readStorefrontConsent());
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  useEffect(() => {
    setConsent(readStorefrontConsent());
  }, []);

  const saveConsent = useCallback((next: Pick<StorefrontConsent, "analytics" | "marketing">) => {
    const value: StorefrontConsent = { necessary: true, ...next, updatedAt: new Date().toISOString() };
    try {
      window.localStorage.setItem(STOREFRONT_CONSENT_KEY, JSON.stringify(value));
    } catch {
      // تظل الوظيفة الأساسية متاحة حتى إذا حُجب التخزين المحلي؛ لا نفعّل تتبعاً عابراً للجلسة.
    }
    setConsent(value);
    setPreferencesOpen(false);
  }, []);

  const value = useMemo<ConsentContextValue>(() => ({
    consent,
    analyticsAllowed: consent?.analytics === true,
    marketingAllowed: consent?.marketing === true,
    preferencesOpen,
    openPreferences: () => setPreferencesOpen(true),
    closePreferences: () => setPreferencesOpen(false),
    saveConsent,
    allowNecessaryOnly: () => saveConsent({ analytics: false, marketing: false }),
    allowAll: () => saveConsent({ analytics: true, marketing: true }),
  }), [consent, preferencesOpen, saveConsent]);

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

export function useStorefrontConsent(): ConsentContextValue {
  const context = useContext(ConsentContext);
  if (!context) throw new Error("useStorefrontConsent must be used inside ConsentProvider");
  return context;
}

function PreferencePanel() {
  const { consent, preferencesOpen, closePreferences, saveConsent } = useStorefrontConsent();
  const [analytics, setAnalytics] = useState(consent?.analytics === true);
  const [marketing, setMarketing] = useState(consent?.marketing === true);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setAnalytics(consent?.analytics === true);
    setMarketing(consent?.marketing === true);
  }, [consent, preferencesOpen]);

  return (
    <DialogPrimitive.Root open={preferencesOpen} onOpenChange={(open) => { if (!open) closePreferences(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-slate-950/45" />
        <DialogPrimitive.Content
          dir="rtl"
          aria-describedby="storefront-privacy-description"
          onOpenAutoFocus={(event) => { event.preventDefault(); closeButtonRef.current?.focus(); }}
          className="storefront-consent fixed inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-[81] mx-auto w-[calc(100%-1.5rem)] max-w-lg rounded-2xl bg-white p-5 text-right shadow-2xl outline-none sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
        >
          <div className="flex items-start justify-between gap-3">
            <DialogPrimitive.Close asChild>
              <button ref={closeButtonRef} type="button" aria-label="إغلاق تفضيلات الخصوصية" className="flex size-11 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"><X aria-hidden className="size-5" /></button>
            </DialogPrimitive.Close>
            <div>
              <DialogPrimitive.Title className="text-base font-black text-[#1e4a63]">تفضيلات الخصوصية</DialogPrimitive.Title>
              <p id="storefront-privacy-description" className="mt-1 text-xs font-semibold leading-6 text-slate-600">الشراء والتصفح الأساسيان لا يحتاجان إلى تحليلات أو تسويق.</p>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 p-3"><input type="checkbox" checked disabled className="mt-1 size-5 accent-[#1e4a63]" /><span><strong className="block text-sm font-black text-slate-700">ضرورية</strong><span className="text-xs font-semibold leading-5 text-slate-600">السلة، المفضلة، وتفضيل الخصوصية فقط.</span></span></label>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3"><input type="checkbox" checked={analytics} onChange={(event) => setAnalytics(event.target.checked)} className="mt-1 size-5 accent-[#1e4a63]" /><span><strong className="block text-sm font-black text-slate-700">تحليلات اختيارية</strong><span className="text-xs font-semibold leading-5 text-slate-600">عدادات مجمّعة ومجهّلة مثل نقرات التوصيات، بلا IP أو جلسة.</span></span></label>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3"><input type="checkbox" checked={marketing} onChange={(event) => setMarketing(event.target.checked)} className="mt-1 size-5 accent-[#1e4a63]" /><span><strong className="block text-sm font-black text-slate-700">تسويق اختياري</strong><span className="text-xs font-semibold leading-5 text-slate-600">يُستخدم فقط إذا أضيفت حملات موافق عليها لاحقاً؛ لا يتفعّل تلقائياً.</span></span></label>
          </div>
          <button type="button" onClick={() => saveConsent({ analytics, marketing })} className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#1e4a63] py-3 text-sm font-black text-white hover:bg-[#16394d]"><Check aria-hidden className="size-4" /> حفظ الاختيارات</button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConsentChoice() {
  const { consent, preferencesOpen, openPreferences, allowNecessaryOnly, allowAll } = useStorefrontConsent();
  return (
    <>
      {!consent && !preferencesOpen && (
        <aside className="storefront-consent fixed inset-x-3 z-[70] mx-auto max-w-3xl rounded-2xl border border-[#ead8c8] bg-white p-4 text-right shadow-xl" style={{ bottom: "max(.75rem, env(safe-area-inset-bottom))" }} aria-labelledby="storefront-consent-title">
          <div className="flex items-start gap-3"><ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-[#1e4a63]" /><div><h2 id="storefront-consent-title" className="text-sm font-black text-[#1e4a63]">نحترم خصوصيتك</h2><p className="mt-1 text-xs font-semibold leading-6 text-slate-500">نستخدم الضروري فقط افتراضياً. التحليلات والتسويق اختياريان ويمكن تغييرهما في أي وقت.</p></div></div>
          <div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" onClick={allowNecessaryOnly} className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50">الضرورية فقط</button><button type="button" onClick={openPreferences} className="flex min-h-11 items-center gap-1 rounded-lg border border-[#1e4a63]/30 px-3 py-2 text-xs font-black text-[#1e4a63] hover:bg-slate-50"><Settings2 aria-hidden className="size-3.5" /> تخصيص</button><button type="button" onClick={allowAll} className="min-h-11 rounded-lg bg-[#b43d31] px-3 py-2 text-xs font-black text-white hover:bg-[#922f28]">السماح بالاختيارات</button></div>
        </aside>
      )}
      {consent && <button type="button" onClick={openPreferences} className="storefront-consent fixed left-3 z-[60] min-h-11 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-black text-[#1e4a63] shadow-md hover:bg-slate-50" style={{ bottom: "max(.75rem, env(safe-area-inset-bottom))" }}>الخصوصية</button>}
      <PreferencePanel />
    </>
  );
}

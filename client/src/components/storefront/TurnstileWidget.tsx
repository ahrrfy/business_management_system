import React, { useEffect, useReducer, useRef } from "react";
import {
  STOREFRONT_TURNSTILE_ACTION,
  STOREFRONT_TURNSTILE_SCRIPT_URL,
} from "@shared/storefrontTurnstile";

type TurnstileStatus = "loading" | "ready" | "verified" | "expired" | "error";
type TurnstileEvent = "SCRIPT_READY" | "VERIFIED" | "EXPIRED" | "ERROR" | "RESET";

export function reduceTurnstileStatus(
  state: TurnstileStatus,
  event: TurnstileEvent,
): TurnstileStatus {
  if (event === "SCRIPT_READY" || event === "RESET") return "ready";
  if (event === "VERIFIED") return "verified";
  if (event === "EXPIRED") return "expired";
  if (event === "ERROR") return "error";
  return state;
}

export function turnstileStatusAllowsRetry(status: TurnstileStatus): boolean {
  return status === "error" || status === "expired";
}

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "light";
      language: "ar";
      size: "flexible";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

export function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${STOREFRONT_TURNSTILE_SCRIPT_URL}"]`,
    );
    const script = existing ?? document.createElement("script");
    const rejectFailedLoad = (reason: string) => {
      // لا نُبقِ عنصراً سبق أن أطلق error/load ناقصاً؛ إعادة فتح checkout يجب أن
      // تنشئ طلب تحميل جديداً بدل ربط listeners متأخرة بعنصر لن يطلق حدثاً آخر.
      script.remove();
      reject(new Error(reason));
    };
    const failed = () => rejectFailedLoad("TURNSTILE_SCRIPT_FAILED");
    const loaded = () => window.turnstile
      ? resolve()
      : rejectFailedLoad("TURNSTILE_API_MISSING");
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = STOREFRONT_TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  resetKey: number;
  onTokenChange: (token: string | null) => void;
  /** تترك واجهة المتجر الافتراضية إعادة الضبط كما هي، بينما WebView الأصلي يطلب محاولة يدوية فقط. */
  autoRetry?: boolean;
}

export function TurnstileWidget({ siteKey, resetKey, onTokenChange, autoRetry = true }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenChangeRef = useRef(onTokenChange);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, dispatch] = useReducer(reduceTurnstileStatus, "loading");
  const [retryNonce, requestRetry] = useReducer((value: number) => value + 1, 0);
  onTokenChangeRef.current = onTokenChange;

  useEffect(() => {
    let cancelled = false;
    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        dispatch("SCRIPT_READY");
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: STOREFRONT_TURNSTILE_ACTION,
          theme: "light",
          language: "ar",
          size: "flexible",
          callback: (token) => {
            if (cancelled) return;
            onTokenChangeRef.current(token);
            dispatch("VERIFIED");
          },
          "expired-callback": () => {
            if (cancelled) return;
            onTokenChangeRef.current(null);
            dispatch("EXPIRED");
            if (autoRetry && widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
          },
          "error-callback": () => {
            if (cancelled) return;
            onTokenChangeRef.current(null);
            dispatch("ERROR");
            if (autoRetry) {
              resetTimerRef.current = setTimeout(() => {
                if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
              }, 1_000);
            }
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          onTokenChangeRef.current(null);
          dispatch("ERROR");
        }
      });
    return () => {
      cancelled = true;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (widgetIdRef.current) window.turnstile?.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [autoRetry, retryNonce, siteKey]);

  useEffect(() => {
    const widgetId = widgetIdRef.current;
    if (!widgetId) return;
    onTokenChangeRef.current(null);
    window.turnstile?.reset(widgetId);
    dispatch("RESET");
  }, [resetKey]);

  const message = status === "verified"
    ? "اكتمل تحقق الأمان."
    : status === "expired"
      ? "انتهت صلاحية التحقق؛ أكمِل التحقق مرة أخرى."
      : status === "error"
        ? "تعذّر تحميل تحقق الأمان؛ تحقق من الاتصال ثم أعد المحاولة."
        : "التحقق من أن الطلب صادر من شخص حقيقي";
  const retryVerification = () => {
    onTokenChangeRef.current(null);
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      dispatch("RESET");
      return;
    }
    containerRef.current?.replaceChildren();
    dispatch("RESET");
    requestRetry();
  };

  return (
    <div
      dir="rtl"
      role="group"
      aria-label="تحقق أمان الطلب"
      className="w-full overflow-hidden rounded-2xl bg-white p-3 ring-1 ring-slate-200"
    >
      <p className="mb-2 text-xs font-bold text-slate-600">
        التحقق من أن الطلب صادر من شخص حقيقي
      </p>
      <div ref={containerRef} className="min-h-16 w-full" />
      <p
        aria-live="polite"
        className={`mt-2 text-xs ${status === "error" || status === "expired" ? "text-[var(--sem-neg)]" : "text-slate-500"}`}
      >
        {message}
      </p>
      {turnstileStatusAllowsRetry(status) && (
        <button
          type="button"
          onClick={retryVerification}
          className="mt-3 min-h-11 w-full rounded-xl border border-[#1e4a63] bg-white px-4 py-2 text-xs font-black text-[#1e4a63] transition hover:bg-[#eef5f7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1e4a63] focus-visible:ring-offset-2"
        >
          إعادة تحميل تحقق الأمان
        </button>
      )}
    </div>
  );
}

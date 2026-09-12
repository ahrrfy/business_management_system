/**
 * screenWakeLock — حارس إبقاء شاشة الكشك وقارئ الأسعار مستيقظة 24/7.
 *
 * يمنع سكون الشاشة (Screen Sleep / Blanking / Black Screen) عبر:
 *  1. تقنية Screen Wake Lock API الرسمية المدمجة في المتصفح (`navigator.wakeLock`).
 *  2. إعادة طلب القفل تلقائياً عند عودة الشاشة للظهور (`visibilitychange` و `focus`).
 *  3. طبقة إسناد احتياطية (Zero-Asset Video Stream) للمتصفحات أو الأجهزة التي تقيد WakeLock.
 *  4. فحص دوري لنبض الاستيقاظ كل 30 ثانية لضمان استمرار عمل الشاشة دون انقطاع.
 */

import { useEffect, useRef, useState } from "react";

export interface WakeLockState {
  isLocked: boolean;
  isSupported: boolean;
}

let activeSentinels: any[] = [];
let pendingRequest: Promise<boolean> | null = null;
let fallbackVideoEl: HTMLVideoElement | null = null;
let fallbackActive = false;
let listenersAttached = false;
let globalRefCount = 0;

/** هل تدعم بيئة المتصفح الحالية واجهة قفل استيقاظ الشاشة؟ */
export function isWakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

/** تشغيل قناة فيديو صامتة مصغرة (1px) كطبقة إسناد إضافية مع التحقق من نجاح التشغيل */
function ensureFallbackVideoStream(): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  if (fallbackVideoEl && fallbackActive && !fallbackVideoEl.paused) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "rgba(0,0,0,0.01)";
        ctx.fillRect(0, 0, 1, 1);
      }
      const stream = (canvas as any).captureStream ? (canvas as any).captureStream(1) : null;
      if (!stream) {
        fallbackActive = false;
        resolve(false);
        return;
      }

      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.loop = true;
      v.srcObject = stream;
      v.setAttribute("aria-hidden", "true");
      v.style.position = "fixed";
      v.style.width = "1px";
      v.style.height = "1px";
      v.style.top = "-10px";
      v.style.left = "-10px";
      v.style.opacity = "0.001";
      v.style.pointerEvents = "none";
      v.style.zIndex = "-99999";
      document.body.appendChild(v);

      const playPromise = v.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise
          .then(() => {
            fallbackVideoEl = v;
            fallbackActive = true;
            resolve(true);
          })
          .catch(() => {
            cleanupFallbackVideoStream();
            fallbackActive = false;
            resolve(false);
          });
      } else {
        fallbackVideoEl = v;
        fallbackActive = true;
        resolve(true);
      }
    } catch {
      cleanupFallbackVideoStream();
      fallbackActive = false;
      resolve(false);
    }
  });
}

/** إيقاف قناة الفيديو الاحتياطية */
function cleanupFallbackVideoStream(): void {
  fallbackActive = false;
  if (fallbackVideoEl) {
    try {
      fallbackVideoEl.pause();
      if (fallbackVideoEl.parentNode) {
        fallbackVideoEl.parentNode.removeChild(fallbackVideoEl);
      }
    } catch {
      // تجاهل أخطاء الإزالة
    }
    fallbackVideoEl = null;
  }
}

/** طلب تنشيط قفل استيقاظ الشاشة لمنع تحولها إلى شاشة سوداء مع تسلسل الطلبات */
export async function requestScreenWakeLock(): Promise<boolean> {
  if (typeof document === "undefined") return false;

  // تشغيل الإسناد الاحتياطي بالتوازي والتحقق من حالته
  const fallbackPromise = ensureFallbackVideoStream();

  if (!isWakeLockSupported()) {
    return fallbackPromise;
  }

  // إذا كان هناك قفل نشط وغير مُحرر
  if (activeSentinels.some((s) => !s.released)) {
    return true;
  }

  // تجنب تسابق الطلبات المتزامنة (In-Flight Request Serialization)
  if (pendingRequest) {
    return pendingRequest;
  }

  pendingRequest = (async () => {
    try {
      const sentinel = await (navigator as any).wakeLock.request("screen");
      activeSentinels.push(sentinel);

      sentinel.addEventListener("release", () => {
        activeSentinels = activeSentinels.filter((s) => s !== sentinel);
        // إعادة الطلب فورا إن كانت الصفحة مرئية وهناك حاجة للاستيقاظ
        if (globalRefCount > 0 && document.visibilityState === "visible") {
          void requestScreenWakeLock();
        }
      });

      return true;
    } catch {
      // في حال تعذر Wake Lock API نعتمد على نتيجة طبقة الإسناد
      return await fallbackPromise;
    } finally {
      pendingRequest = null;
    }
  })();

  return pendingRequest;
}

/** تحرير قفل الاستيقاظ عند إغلاق الشاشة بالكامل */
export async function releaseScreenWakeLock(): Promise<void> {
  pendingRequest = null;
  const sentinels = activeSentinels.slice();
  activeSentinels = [];

  for (let i = 0; i < sentinels.length; i++) {
    try {
      await sentinels[i].release();
    } catch {
      // تجاهل أخطاء التحرير
    }
  }

  cleanupFallbackVideoStream();
}

/** إرفاق مستمعات الأحداث التلقائية لإعادة القفل عند عودة التركيز أو الرؤية */
function setupWakeLockListeners(): () => void {
  if (typeof window === "undefined" || listenersAttached) return () => {};
  listenersAttached = true;

  const onResume = () => {
    if (globalRefCount > 0 && document.visibilityState === "visible") {
      void requestScreenWakeLock();
    }
  };

  document.addEventListener("visibilitychange", onResume);
  window.addEventListener("focus", onResume);
  window.addEventListener("pointerdown", onResume, { passive: true });
  window.addEventListener("keydown", onResume, { passive: true });

  // فحص نبض دوري كل ٣٠ ثانية لضمان عدم سقوط القفل في فترات الخمول الطويلة
  const intervalId = setInterval(() => {
    if (globalRefCount > 0 && document.visibilityState === "visible") {
      const hasActive = activeSentinels.some((s) => !s.released);
      if (!hasActive) {
        void requestScreenWakeLock();
      }
    }
  }, 30_000);

  return () => {
    listenersAttached = false;
    document.removeEventListener("visibilitychange", onResume);
    window.removeEventListener("focus", onResume);
    window.removeEventListener("pointerdown", onResume);
    window.removeEventListener("keydown", onResume);
    clearInterval(intervalId);
  };
}

/**
 * خطّاف React لإدارة استيقاظ الشاشة تلقائياً في شاشات الكشك وقارئ الأسعار.
 */
export function useScreenWakeLock(enabled: boolean = true): WakeLockState {
  const [locked, setLocked] = useState(false);
  const supported = isWakeLockSupported();
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;

    globalRefCount++;
    cleanupListenersRef.current = setupWakeLockListeners();

    let mounted = true;
    const acquire = async () => {
      const ok = await requestScreenWakeLock();
      if (mounted) {
        setLocked(ok);
      }
    };

    void acquire();

    return () => {
      mounted = false;
      globalRefCount = Math.max(0, globalRefCount - 1);
      if (globalRefCount === 0) {
        void releaseScreenWakeLock();
        if (cleanupListenersRef.current) {
          cleanupListenersRef.current();
          cleanupListenersRef.current = null;
        }
      }
    };
  }, [enabled]);

  return { isLocked: locked, isSupported: supported };
}

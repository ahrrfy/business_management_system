// كشف الاتصال — الشريحة ١ من خطة العمل ثنائي الاتجاه (أونلاين/أوفلاين).
// آلة حالة واحدة للنظام كلّه تُستهلك عبر useConnectivity()، تغذّيها ثلاثة مصادر بترتيب الموثوقية:
//   ١) نتيجة نداء شبكي فعلي (الأصدق): وصول أي ردّ HTTP — ولو 4xx/5xx — يعني أن الشبكة والخادم
//      موصولان؛ رفض fetch نفسه (TypeError بلا ردّ) يعني انقطاعاً.
//   ٢) مسبار ‎/healthz الدوري أثناء الانقطاع (كل ٢٠ ثانية + فوراً عند حدث online أو عودة رؤية التبويب).
//   ٣) حدثا المتصفح online/offline: تلميح سريع غير موثوق (شبكة Wi-Fi بلا إنترنت تبقى «online» عند
//      المتصفح) — لذلك حدث online لا يعيد الحالة إلى "online" مباشرة بل إلى "reconnecting" حتى
//      ينجح المسبار أو نداء فعلي.
// حالة "syncing" محجوزة لمحرّك طابور المبيعات الأوفلايني (الشريحة ٣): تفريغ الطابور بعد عودة الاتصال.

import { useSyncExternalStore } from "react";

export type ConnState = "online" | "offline" | "reconnecting" | "syncing";

/** منفصلة عن أي واجهة متصفح ⇒ قابلة للاختبار في بيئة node (vitest environment: "node"). */
export class ConnectivityMachine {
  private state: ConnState;
  private listeners = new Set<(s: ConnState) => void>();

  constructor(initiallyOnline = true) {
    this.state = initiallyOnline ? "online" : "offline";
  }

  get = (): ConnState => this.state;

  subscribe = (cb: (s: ConnState) => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private set(next: ConnState) {
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((cb) => cb(next));
  }

  /** وصل ردّ HTTP فعلاً (ولو بحالة خطأ) ⇒ الاتصال قائم. */
  noteSuccess() {
    // أثناء تفريغ الطابور تبقى "syncing" (أدقّ للمستخدم) — الطابور نفسه يعيدها إلى online عند الفراغ.
    if (this.state === "syncing") return;
    this.set("online");
  }

  /** فشل نقل (رفض fetch بلا ردّ). إلغاءات AbortError تُرشَّح عند المصدر ولا تصل هنا. */
  noteFailure() {
    this.set("offline");
  }

  /** حدث المتصفح online: تلميح فقط — نعبر بـ"reconnecting" حتى يتحقق المسبار. */
  noteBrowserOnline() {
    if (this.state === "offline") this.set("reconnecting");
  }

  noteBrowserOffline() {
    this.set("offline");
  }

  /** لمحرّك الطابور (الشريحة ٣): تفعيل أثناء التفريغ، وإطفاء يعيدنا إلى online. */
  setSyncing(on: boolean) {
    if (on && (this.state === "online" || this.state === "reconnecting")) this.set("syncing");
    else if (!on && this.state === "syncing") this.set("online");
  }
}

export const connectivity = new ConnectivityMachine(
  typeof navigator === "undefined" ? true : navigator.onLine,
);

export const noteRequestSuccess = () => connectivity.noteSuccess();
export const noteRequestFailure = () => connectivity.noteFailure();

/** مقطوع فعلياً أو قيد التحقق من العودة — الحالتان تعنيان «لا تعتمد على الخادم الآن». */
export const isDisconnected = (s: ConnState) => s === "offline" || s === "reconnecting";

export function useConnectivity(): ConnState {
  return useSyncExternalStore(connectivity.subscribe, connectivity.get, connectivity.get);
}

const PROBE_INTERVAL_MS = 20_000;

/** أي ردّ غير ok (قاعدة معطوبة مثلاً) يُعامل كتعذّر — لا نعلن العودة إلا بصحة كاملة. */
async function probeServer(): Promise<boolean> {
  try {
    const res = await fetch("/healthz", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * الربط بالمتصفح — تُستدعى مرة واحدة من main.tsx.
 * onBackOnline: يُنفَّذ عند كل انتقال فعلي من انقطاع إلى online (لإنعاش الاستعلامات، ولاحقاً
 * لإطلاق تفريغ الطابور في الشريحة ٣).
 */
export function initConnectivity(opts?: {
  onBackOnline?: () => void;
  probe?: () => Promise<boolean>;
}) {
  if (typeof window === "undefined") return;
  const probe = opts?.probe ?? probeServer;
  let timer: number | null = null;
  let probing = false;

  const runProbe = async () => {
    if (probing) return;
    probing = true;
    try {
      if (await probe()) connectivity.noteSuccess();
      else connectivity.noteFailure();
    } finally {
      probing = false;
    }
  };

  const ensureTimer = () => {
    if (timer !== null) return;
    timer = window.setInterval(() => {
      void runProbe();
    }, PROBE_INTERVAL_MS);
  };
  const clearTimer = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  let prev = connectivity.get();
  connectivity.subscribe((s) => {
    if (s === "online" || s === "syncing") clearTimer();
    else ensureTimer();
    if (s === "online" && (prev === "offline" || prev === "reconnecting")) opts?.onBackOnline?.();
    prev = s;
  });

  window.addEventListener("online", () => {
    connectivity.noteBrowserOnline();
    void runProbe();
  });
  window.addEventListener("offline", () => connectivity.noteBrowserOffline());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isDisconnected(connectivity.get())) {
      void runProbe();
    }
  });

  if (isDisconnected(connectivity.get())) ensureTimer();
}

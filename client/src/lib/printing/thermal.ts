// ناقل WebUSB للطابعات الحرارية. مُغلّف بحراسة قدرات المتصفّح؛ يعمل في Chrome/Edge
// فوق HTTPS أو localhost وبإذن المستخدم.
//
// **طابعتان بدورين:** "receipt" (إيصالات الكاشير — Epson، الدور الافتراضي) و"label"
// (ملصقات الباركود — HPRT). كل دور يحفظ جهازه ومنفذه ومعرّفه المحفوظ مستقلاً ⇒ ترسل
// الإيصالات لطابعة الإيصالات والملصقات لطابعة الملصقات في آنٍ واحد. كل الدوال تأخذ الدور
// كوسيط أخير افتراضه "receipt" ⇒ المنادون القدامى (الكاشير) بلا تغيير سلوك.
//
// الربط التلقائي: WebUSB يحفظ إذن الجهاز للأصل (origin) بعد أوّل ربط يدوي. لذا
// `navigator.usb.getDevices()` يُرجِع الطابعة المُصرَّح بها سابقاً **بلا نافذة اختيار** —
// نستعملها في tryReconnectPrinter() ليُعاد الربط صامتاً. نحفظ vendorId/productId لكل دور
// في localStorage لاختيار الجهاز الصحيح عند تعدّد الأجهزة المُصرَّح بها.

export type PrinterRole = "receipt" | "label";

interface Slot {
  device: any;
  endpointOut: number | null;
}

const slots: Record<PrinterRole, Slot> = {
  receipt: { device: null, endpointOut: null },
  label: { device: null, endpointOut: null },
};

// المفتاح "thermalPrinter.default" مُبقىً للإيصالات للتوافق الخلفي (طابعة مربوطة سابقاً).
const LS_KEY: Record<PrinterRole, string> = {
  receipt: "thermalPrinter.default",
  label: "thermalPrinter.label",
};

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).usb;
}

export function isPaired(role: PrinterRole = "receipt"): boolean {
  const s = slots[role];
  return !!s.device && s.endpointOut != null;
}

function rememberDevice(role: PrinterRole, dev: any): void {
  try {
    localStorage.setItem(LS_KEY[role], JSON.stringify({ vendorId: dev.vendorId, productId: dev.productId }));
  } catch {
    /* localStorage غير متاح ⇒ نتجاهل (الربط يبقى يعمل لهذه الجلسة) */
  }
}

function readRemembered(role: PrinterRole): { vendorId: number; productId: number } | null {
  try {
    const raw = localStorage.getItem(LS_KEY[role]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** هل هذا الجهاز مربوط أصلاً في الدور الآخر؟ (نمنع ادّعاء نفس الطابعة لدورين). */
function claimedByOtherRole(role: PrinterRole, dev: any): boolean {
  const other = role === "receipt" ? "label" : "receipt";
  return slots[other].device === dev;
}

/** يفتح الجهاز ويُهيّئ منفذ الإخراج (bulk OUT). يضبط slot الدور عند النجاح. */
async function claimDevice(role: PrinterRole, dev: any): Promise<boolean> {
  await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);

  let out: number | null = null;
  for (const iface of dev.configuration.interfaces) {
    const alt = iface.alternate ?? iface.alternates?.[0];
    const ep = alt?.endpoints?.find((e: any) => e.direction === "out" && e.type === "bulk");
    if (ep) {
      await dev.claimInterface(iface.interfaceNumber);
      out = ep.endpointNumber;
      break;
    }
  }
  if (out == null) {
    try { await dev.close(); } catch { /* تجاهل */ }
    return false;
  }
  slots[role].device = dev;
  slots[role].endpointOut = out;
  return true;
}

/** يطلب من المستخدم اختيار طابعة USB للدور المحدّد ويُهيّئها. يُستدعى ضمن تفاعل مستخدم. */
export async function pairPrinter(role: PrinterRole = "receipt"): Promise<boolean> {
  if (!isWebUsbSupported()) {
    throw new Error("المتصفّح لا يدعم WebUSB — استخدم Chrome أو Edge");
  }
  const usb = (navigator as any).usb;
  const dev = await usb.requestDevice({ filters: [] });
  if (!(await claimDevice(role, dev))) {
    throw new Error("لم يُعثر على منفذ طباعة USB مناسب على هذا الجهاز");
  }
  rememberDevice(role, dev);
  return true;
}

/**
 * إعادة ربط صامتة بلا نافذة اختيار: يفحص الأجهزة المُصرَّح بها سابقاً ويربط طابعة الدور.
 * - "receipt" (سلوك قديم): يفضّل المحفوظة، وإلا يربط أوّل جهاز ذي منفذ طباعة صالح.
 * - "label": يربط **فقط** الجهاز المطابق للمحفوظ (لئلا يخطف طابعة الإيصالات) ⇒ يلزم ربط يدوي أوّلاً.
 * يُرجِع false بهدوء إن لا جهاز مناسب — لا يرمي.
 */
export async function tryReconnectPrinter(role: PrinterRole = "receipt"): Promise<boolean> {
  if (!isWebUsbSupported()) return false;
  if (isPaired(role)) return true;
  let devices: any[] = [];
  try {
    devices = await (navigator as any).usb.getDevices();
  } catch {
    return false;
  }
  if (!devices.length) return false;

  const remembered = readRemembered(role);
  const requireRemembered = role === "label"; // الملصقات: لا نربط جهازاً عشوائياً

  // رتّب الأجهزة: المطابق للمحفوظ أولاً.
  if (remembered) {
    devices.sort((a, b) => {
      const am = a.vendorId === remembered.vendorId && a.productId === remembered.productId ? 0 : 1;
      const bm = b.vendorId === remembered.vendorId && b.productId === remembered.productId ? 0 : 1;
      return am - bm;
    });
  }

  for (const dev of devices) {
    const matches = remembered && dev.vendorId === remembered.vendorId && dev.productId === remembered.productId;
    if (requireRemembered && !matches) continue; // لا تربط إلا المطابق
    if (claimedByOtherRole(role, dev)) continue; // الجهاز مأخوذ للدور الآخر
    try {
      if (await claimDevice(role, dev)) {
        rememberDevice(role, dev); // ثبّت الافتراضية على أوّل ربط ناجح
        return true;
      }
    } catch {
      /* جرّب الجهاز التالي */
    }
  }
  return false;
}

export async function sendBytes(bytes: Uint8Array, role: PrinterRole = "receipt"): Promise<void> {
  const s = slots[role];
  if (!s.device || s.endpointOut == null) throw new Error("لا توجد طابعة حرارية مربوطة");
  await s.device.transferOut(s.endpointOut, bytes);
}

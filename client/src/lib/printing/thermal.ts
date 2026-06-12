// ناقل WebUSB للطابعات الحرارية. مُغلّف بحراسة قدرات المتصفّح؛ يعمل في Chrome/Edge
// فوق HTTPS أو localhost وبإذن المستخدم.
//
// الربط التلقائي: WebUSB يحفظ إذن الجهاز للأصل (origin) بعد أوّل ربط يدوي. لذا
// `navigator.usb.getDevices()` يُرجِع الطابعة المُصرَّح بها سابقاً **بلا نافذة اختيار** —
// نستعملها في tryReconnectPrinter() عند فتح الكاشير ليُعاد الربط صامتاً. نحفظ
// vendorId/productId لآخر طابعة في localStorage لاختيار «الافتراضية» عند تعدّد الأجهزة.

let device: any = null;
let endpointOut: number | null = null;

const LS_KEY = "thermalPrinter.default"; // { vendorId, productId }

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).usb;
}

export function isPaired(): boolean {
  return !!device && endpointOut != null;
}

function rememberDevice(dev: any): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ vendorId: dev.vendorId, productId: dev.productId }));
  } catch {
    /* localStorage غير متاح ⇒ نتجاهل (الربط يبقى يعمل لهذه الجلسة) */
  }
}

function readRemembered(): { vendorId: number; productId: number } | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** يفتح الجهاز ويُهيّئ منفذ الإخراج (bulk OUT). يضبط device/endpointOut عند النجاح. */
async function claimDevice(dev: any): Promise<boolean> {
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
  device = dev;
  endpointOut = out;
  return true;
}

/** يطلب من المستخدم اختيار طابعة USB ويُهيّئها. يُستدعى ضمن تفاعل مستخدم. */
export async function pairPrinter(): Promise<boolean> {
  if (!isWebUsbSupported()) {
    throw new Error("المتصفّح لا يدعم WebUSB — استخدم Chrome أو Edge");
  }
  const usb = (navigator as any).usb;
  const dev = await usb.requestDevice({ filters: [] });
  if (!(await claimDevice(dev))) {
    throw new Error("لم يُعثر على منفذ طباعة USB مناسب على هذا الجهاز");
  }
  rememberDevice(dev);
  return true;
}

/**
 * إعادة ربط صامتة بلا نافذة اختيار: يفحص الأجهزة المُصرَّح بها سابقاً ويربط الطابعة
 * الافتراضية (المحفوظة) أو أوّل جهاز ذي منفذ طباعة صالح. يُرجِع false بهدوء إن لا جهاز
 * (لم يُربط بعد) — لا يرمي. يُستدعى عند فتح الكاشير.
 */
export async function tryReconnectPrinter(): Promise<boolean> {
  if (!isWebUsbSupported()) return false;
  if (isPaired()) return true;
  let devices: any[] = [];
  try {
    devices = await (navigator as any).usb.getDevices();
  } catch {
    return false;
  }
  if (!devices.length) return false;

  // رتّب الأجهزة: الافتراضية المحفوظة أولاً.
  const remembered = readRemembered();
  if (remembered) {
    devices.sort((a, b) => {
      const am = a.vendorId === remembered.vendorId && a.productId === remembered.productId ? 0 : 1;
      const bm = b.vendorId === remembered.vendorId && b.productId === remembered.productId ? 0 : 1;
      return am - bm;
    });
  }

  for (const dev of devices) {
    try {
      if (await claimDevice(dev)) {
        rememberDevice(dev); // ثبّت الافتراضية على أوّل ربط ناجح
        return true;
      }
    } catch {
      /* جرّب الجهاز التالي */
    }
  }
  return false;
}

export async function sendBytes(bytes: Uint8Array): Promise<void> {
  if (!device || endpointOut == null) throw new Error("لا توجد طابعة حرارية مربوطة");
  await device.transferOut(endpointOut, bytes);
}

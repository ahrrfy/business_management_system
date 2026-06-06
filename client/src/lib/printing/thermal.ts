// ناقل WebUSB للطابعات الحرارية. مُغلّف بحراسة قدرات المتصفّح؛ يعمل في Chrome/Edge
// فوق HTTPS أو localhost وبإذن المستخدم. تعذّر التحقّق منه بلا طابعة حقيقية.

let device: any = null;
let endpointOut: number | null = null;

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).usb;
}

export function isPaired(): boolean {
  return !!device && endpointOut != null;
}

/** يطلب من المستخدم اختيار طابعة USB ويُهيّئها. يُستدعى ضمن تفاعل مستخدم. */
export async function pairPrinter(): Promise<boolean> {
  if (!isWebUsbSupported()) {
    throw new Error("المتصفّح لا يدعم WebUSB — استخدم Chrome أو Edge");
  }
  const usb = (navigator as any).usb;
  device = await usb.requestDevice({ filters: [] });
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);

  endpointOut = null;
  for (const iface of device.configuration.interfaces) {
    const alt = iface.alternate ?? iface.alternates?.[0];
    const out = alt?.endpoints?.find((e: any) => e.direction === "out" && e.type === "bulk");
    if (out) {
      await device.claimInterface(iface.interfaceNumber);
      endpointOut = out.endpointNumber;
      break;
    }
  }
  if (endpointOut == null) {
    try { await device.close(); } catch {}
    device = null;
    throw new Error("لم يُعثر على منفذ طباعة USB مناسب على هذا الجهاز");
  }
  return true;
}

export async function sendBytes(bytes: Uint8Array): Promise<void> {
  if (!device || endpointOut == null) throw new Error("لا توجد طابعة حرارية مربوطة");
  await device.transferOut(endpointOut, bytes);
}

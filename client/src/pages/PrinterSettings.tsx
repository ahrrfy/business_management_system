import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EscPos } from "@/lib/printing/escpos";
import {
  isWebUsbSupported,
  isPairedProfile,
  pairPrinterProfile,
  tryReconnectProfile,
  sendBytesProfile,
} from "@/lib/printing/thermal";
import {
  isLocalBridgeAvailable,
  listBridgePrinters,
  sendRawToBridge,
  getBridgeToken,
  setBridgeToken,
  type BridgePrinter,
} from "@/lib/printing/localBridge";
import {
  listProfiles,
  upsertProfile,
  removeProfile,
  getAssignment,
  setAssignment,
  ALL_PURPOSES,
  PURPOSE_LABEL_AR,
  type PrinterProfile,
  type PrintTransport,
  type PrintOutputFormat,
  type PrintPurpose,
} from "@/lib/printing/printerProfiles";
import { useEffect, useState } from "react";
import { Link } from "wouter";

const TRANSPORT_LABEL: Record<PrintTransport, string> = {
  webusb: "USB مباشر (WebUSB)",
  bridge: "الجسر المحلي (بالاسم)",
  browser: "حوار المتصفّح",
};

const FORMAT_LABEL: Record<PrintOutputFormat, string> = {
  escpos: "ESC/POS (حراري نقطي)",
  zpl: "ZPL (Zebra) — لاحقاً",
  epl: "EPL/TSPL — لاحقاً",
};

/** بايتات اختبار اتصال عامّة (تهيئة + تغذية + قطع) — تعمل مع أي طابعة ESC/POS بلا افتراض موديل. */
function connectivityTestBytes(): Uint8Array {
  return new EscPos().init().feed(4).cut().bytes();
}

export default function PrinterSettings() {
  const usbSupported = isWebUsbSupported();

  const [profiles, setProfiles] = useState<PrinterProfile[]>(() => listProfiles());
  const [assign, setAssign] = useState(() => getAssignment());
  const [pairedIds, setPairedIds] = useState<Set<string>>(new Set());

  const [bridgeUp, setBridgeUp] = useState(false);
  const [bridgePrinters, setBridgePrinters] = useState<BridgePrinter[]>([]);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [token, setToken] = useState(() => getBridgeToken());

  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // نموذج إضافة طابعة
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<PrintTransport>("bridge");
  const [bridgeName, setBridgeName] = useState("");
  const [outputFormat, setOutputFormat] = useState<PrintOutputFormat>("escpos");

  function refresh() {
    setProfiles(listProfiles());
    setAssign(getAssignment());
  }

  function flash(ok: string) {
    setError("");
    setInfo(ok);
  }
  function fail(e: unknown) {
    setInfo("");
    setError(e instanceof Error ? e.message : String(e));
  }

  // فحص الجسر + إعادة ربط صامتة لملفّات USB لعكس الحالة.
  async function probeBridge() {
    setBridgeBusy(true);
    try {
      const up = await isLocalBridgeAvailable(true);
      setBridgeUp(up);
      if (up) {
        try {
          setBridgePrinters(await listBridgePrinters());
        } catch {
          setBridgePrinters([]);
        }
      } else {
        setBridgePrinters([]);
      }
    } finally {
      setBridgeBusy(false);
    }
  }

  useEffect(() => {
    probeBridge();
    // أعد ربط ملفّات USB صامتاً لعكس حالة «مربوطة».
    (async () => {
      const next = new Set<string>();
      for (const p of listProfiles()) {
        if (p.transport === "webusb") {
          try {
            // eslint-disable-next-line no-await-in-loop
            if (await tryReconnectProfile(p)) next.add(p.id);
          } catch {
            /* تجاهل */
          }
        }
      }
      setPairedIds(next);
    })();
  }, []);

  function saveToken() {
    setBridgeToken(token);
    flash("حُفظ رمز الجسر ✓");
    probeBridge();
  }

  async function addProfile() {
    setError("");
    setInfo("");
    const nm = name.trim();
    if (!nm) {
      fail("أدخل اسماً للطابعة");
      return;
    }
    try {
      if (transport === "webusb") {
        if (!usbSupported) {
          fail("المتصفّح لا يدعم WebUSB — استخدم Chrome/Edge أو اختر الجسر المحلي");
          return;
        }
        const prof = upsertProfile({ name: nm, transport: "webusb", outputFormat });
        try {
          const usb = await pairPrinterProfile(prof.id);
          upsertProfile({ ...prof, usb });
          setPairedIds((s) => new Set(s).add(prof.id));
          flash(`أُضيفت «${nm}» ورُبطت طابعة USB ✓`);
        } catch (e) {
          removeProfile(prof.id); // تراجع إن أُلغي الاختيار/فشل الربط
          throw e;
        }
      } else if (transport === "bridge") {
        if (!bridgeName) {
          fail("اختر طابعة من قائمة الجسر");
          return;
        }
        upsertProfile({ name: nm, transport: "bridge", bridgePrinterName: bridgeName, outputFormat });
        flash(`أُضيفت «${nm}» (جسر: ${bridgeName}) ✓`);
      } else {
        upsertProfile({ name: nm, transport: "browser", outputFormat: "escpos" });
        flash(`أُضيفت «${nm}» (حوار المتصفّح) ✓`);
      }
      setName("");
      setBridgeName("");
      refresh();
    } catch (e) {
      fail(e);
    }
  }

  async function repair(p: PrinterProfile) {
    setError("");
    setInfo("");
    try {
      const usb = await pairPrinterProfile(p.id);
      upsertProfile({ ...p, usb });
      setPairedIds((s) => new Set(s).add(p.id));
      flash(`أُعيد ربط «${p.name}» ✓`);
      refresh();
    } catch (e) {
      fail(e);
    }
  }

  async function testProfile(p: PrinterProfile) {
    setError("");
    setInfo("");
    try {
      const bytes = connectivityTestBytes();
      if (p.transport === "webusb") {
        if (!isPairedProfile(p.id)) await tryReconnectProfile(p);
        if (!isPairedProfile(p.id)) {
          fail("الطابعة غير مربوطة — اضغط «ربط» أوّلاً");
          return;
        }
        await sendBytesProfile(p.id, bytes);
        flash(`أُرسل اختبار الاتصال إلى «${p.name}» (تغذية + قطع) ✓`);
      } else if (p.transport === "bridge" && p.bridgePrinterName) {
        await sendRawToBridge(p.bridgePrinterName, bytes, p.outputFormat);
        flash(`أُرسل اختبار الاتصال إلى «${p.name}» عبر الجسر ✓`);
      } else {
        fail("اختبار الاتصال متاح للطابعات الحرارية (USB/جسر). مستندات المتصفّح تُختبر من شاشاتها.");
      }
    } catch (e) {
      fail(e);
    }
  }

  function del(p: PrinterProfile) {
    removeProfile(p.id);
    setPairedIds((s) => {
      const n = new Set(s);
      n.delete(p.id);
      return n;
    });
    flash(`حُذف «${p.name}»`);
    refresh();
  }

  function assignPurpose(purpose: PrintPurpose, profileId: string) {
    setAssignment(purpose, profileId || null);
    setAssign(getAssignment());
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إدارة الطابعات</h1>
        <Link href="/barcode-labels" className="text-sm text-muted-foreground">ملصقات الباركود ←</Link>
      </div>
      <p className="text-sm text-muted-foreground">
        إعداد <span className="font-medium">محلي لهذا الجهاز</span>: عرّف طابعاتك وسمِّها وأسنِد كل مهمة لطابعة.
        يعمل مع أي ماركة/موديل عبر <span className="font-medium">الجسر المحلي</span> (طباعة RAW بالاسم) أو
        <span className="font-medium"> USB مباشر</span>، وآخر ملاذ <span className="font-medium">حوار المتصفّح</span>.
      </p>

      {/* حالة الجسر المحلي */}
      <Card>
        <CardHeader><CardTitle className="text-base">الجسر المحلي</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            {bridgeUp ? (
              <span className="text-sm text-emerald-600">متصل ✓ ({bridgePrinters.length} طابعة)</span>
            ) : (
              <span className="text-sm text-muted-foreground">غير متصل (شغّل تطبيق الجسر على هذا الجهاز).</span>
            )}
            <Button type="button" variant="outline" size="sm" onClick={probeBridge} disabled={bridgeBusy}>
              {bridgeBusy ? "جارٍ الفحص…" : "إعادة الفحص"}
            </Button>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="space-y-1">
              <Label className="text-xs">رمز الجسر (token)</Label>
              <Input className="h-8 w-64" value={token} onChange={(e) => setToken(e.target.value)} placeholder="يُكتب مرّة عند تثبيت الجسر" dir="ltr" />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={saveToken}>حفظ الرمز</Button>
          </div>
          {bridgeUp && bridgePrinters.length > 0 && (
            <div className="text-xs text-muted-foreground">
              طابعات النظام: {bridgePrinters.map((p) => p.name).join("، ")}
            </div>
          )}
        </CardContent>
      </Card>

      {/* الطابعات المُعرّفة */}
      <Card>
        <CardHeader><CardTitle className="text-base">الطابعات المُعرّفة ({profiles.length})</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {profiles.length === 0 && (
            <p className="text-sm text-muted-foreground">لا طابعات بعد — أضِف طابعة أدناه.</p>
          )}
          {profiles.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 border rounded-md p-2 flex-wrap">
              <div className="space-y-0.5">
                <div className="font-medium text-sm">
                  {p.name}
                  {p.transport === "webusb" && (
                    <span className={`ms-2 text-xs ${pairedIds.has(p.id) ? "text-emerald-600" : "text-muted-foreground"}`}>
                      {pairedIds.has(p.id) ? "● مربوطة" : "○ غير مربوطة"}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {TRANSPORT_LABEL[p.transport]}
                  {p.transport === "bridge" && p.bridgePrinterName ? ` · ${p.bridgePrinterName}` : ""}
                  {p.transport !== "browser" ? ` · ${FORMAT_LABEL[p.outputFormat]}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {p.transport === "webusb" && (
                  <Button type="button" variant="outline" size="sm" onClick={() => repair(p)}>ربط/تغيير</Button>
                )}
                {p.transport !== "browser" && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => testProfile(p)}>اختبار</Button>
                )}
                <Button type="button" variant="ghost" size="sm" onClick={() => del(p)}>✕</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* إضافة طابعة */}
      <Card>
        <CardHeader><CardTitle className="text-base">إضافة طابعة</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">الاسم</Label>
              <Input className="h-9" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: كاشير ١ — حراري" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">الناقل</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={transport}
                onChange={(e) => setTransport(e.target.value as PrintTransport)}
              >
                <option value="bridge">{TRANSPORT_LABEL.bridge}</option>
                <option value="webusb" disabled={!usbSupported}>{TRANSPORT_LABEL.webusb}{!usbSupported ? " (غير مدعوم)" : ""}</option>
                <option value="browser">{TRANSPORT_LABEL.browser}</option>
              </select>
            </div>

            {transport === "bridge" && (
              <div className="space-y-1">
                <Label className="text-xs">طابعة النظام (من الجسر)</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={bridgeName}
                  onChange={(e) => setBridgeName(e.target.value)}
                  disabled={!bridgeUp}
                >
                  <option value="">{bridgeUp ? "— اختر —" : "الجسر غير متصل —"}</option>
                  {bridgePrinters.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}{p.default ? " (افتراضية)" : ""}</option>
                  ))}
                </select>
              </div>
            )}

            {transport !== "browser" && (
              <div className="space-y-1">
                <Label className="text-xs">صيغة الإخراج</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={outputFormat}
                  onChange={(e) => setOutputFormat(e.target.value as PrintOutputFormat)}
                >
                  <option value="escpos">{FORMAT_LABEL.escpos}</option>
                  <option value="zpl" disabled>{FORMAT_LABEL.zpl}</option>
                  <option value="epl" disabled>{FORMAT_LABEL.epl}</option>
                </select>
              </div>
            )}
          </div>
          <Button type="button" onClick={addProfile}>
            {transport === "webusb" ? "إضافة وربط USB" : "إضافة"}
          </Button>
          {transport === "webusb" && (
            <p className="text-xs text-muted-foreground">
              عند الإضافة ستظهر نافذة المتصفّح لاختيار طابعة USB. (يلزم تعريف WinUSB عبر Zadig على Windows للطباعة المباشرة، أو استخدم الجسر المحلي بلا أي تعريف خاص.)
            </p>
          )}
        </CardContent>
      </Card>

      {/* إسناد المهام */}
      <Card>
        <CardHeader><CardTitle className="text-base">إسناد المهام للطابعات</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {ALL_PURPOSES.map((purpose) => (
            <div key={purpose} className="flex items-center justify-between gap-2">
              <span className="text-sm">{PURPOSE_LABEL_AR[purpose]}</span>
              <select
                className="h-9 w-64 rounded-md border bg-background px-2 text-sm"
                value={assign[purpose] ?? ""}
                onChange={(e) => assignPurpose(purpose, e.target.value)}
              >
                <option value="">{purpose === "DOCUMENT" ? "حوار المتصفّح (افتراضي)" : "تلقائي / حوار المتصفّح"}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            مستندات A4 تُطبع عبر حوار الطباعة (vector بأعلى دقّة) — يختار المستخدم الطابعة من الحوار.
          </p>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && <p className="text-sm text-emerald-600">{info}</p>}
    </div>
  );
}

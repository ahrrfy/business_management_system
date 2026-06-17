import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr as money } from "@/lib/money";
import { code128Svg, internalBarcode } from "@/lib/printing/barcode";
import {
  printLabel, isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter,
  getLabelSize, setLabelSize, LABEL_PRESETS, presetIdFor,
  type LabelSize, type LabelRenderItem,
} from "@/lib/printing/print";
import { labelDocHtml } from "@/lib/printing/labelDesign";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";

const PX_PER_MM = 96 / 25.4; // ≈3.78 بكسل/مم @96dpi
const PREVIEW_ZOOM = 2.4; // تكبير المعاينة بصرياً للوضوح (المقاس الفعليّ صغير)

type PosRow = RouterOutputs["catalog"]["posList"][number];
type QueueItem = {
  key: number;
  productUnitId: number;
  productName: string;
  unitName: string;
  sku: string;
  barcode: string; // قد يكون مولّداً داخلياً
  price: string | null;
  saved: boolean; // هل الباركود محفوظ في القاعدة؟
  count: number;
};

export default function BarcodeLabels() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [seq, setSeq] = useState(1);
  const [showName, setShowName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  // مسوّدات نصّية لحقول عدد النسخ (تسمح بالإفراغ/التحرير الطبيعي ثم تُحصَر عند الـblur).
  const [countDraft, setCountDraft] = useState<Record<number, string>>({});

  // مقاس الملصق (محفوظ محلياً، مشترك مع باقي شاشات الطباعة).
  const [size, setSize] = useState<LabelSize>(() => getLabelSize());
  const [wStr, setWStr] = useState(() => String(size.widthMm));
  const [hStr, setHStr] = useState(() => String(size.heightMm));
  const activePreset = presetIdFor(size);

  // معاينة حيّة بنفس تصميم الطباعة (نفس labelDocHtml ⇒ ما تراه هو ما يُطبع) — أوّل صنف في القائمة
  // أو عيّنة عند الفراغ، متفاعلةً مع المقاس وخياري الاسم/السعر. تُحسَب مرّةً (useMemo) فلا تُعاد
  // بناؤها مع كل ضغطة بحث؛ تُعرَض في iframe بمقاس مليمتريّ فعليّ ثمّ تُكبَّر بصرياً للوضوح.
  const previewHtml = useMemo(() => {
    const previewItem: LabelRenderItem = queue.length
      ? { name: `${queue[0].productName} — ${queue[0].unitName}`, sku: queue[0].sku, price: queue[0].price, barcode: queue[0].barcode }
      : { name: "اسم منتج تجريبي للمعاينة", sku: "PR-BLU", price: "500", barcode: "6212442744532" };
    return labelDocHtml([previewItem], size, { showName, showPrice }, false);
  }, [queue, size, showName, showPrice]);
  const pxW = Math.round(size.widthMm * PX_PER_MM);
  const pxH = Math.round(size.heightMm * PX_PER_MM);

  // طابعة الملصقات (WebUSB، دور "label" منفصل عن طابعة الكاشير).
  const usbSupported = isWebUsbSupported();
  const [labelPrinterReady, setLabelPrinterReady] = useState(() => isPaired("label"));

  useEffect(() => {
    const refresh = () => setLabelPrinterReady(isPaired("label"));
    tryReconnectPrinter("label").then((ok) => { if (ok) setLabelPrinterReady(true); }).catch(() => { /* تجاهل */ });
    if (!usbSupported) return;
    const usb = (navigator as { usb?: { addEventListener?: (t: string, h: () => void) => void; removeEventListener?: (t: string, h: () => void) => void } }).usb;
    if (!usb?.addEventListener) return;
    const onConnect = () => { tryReconnectPrinter("label").then(refresh).catch(() => { /* تجاهل */ }); };
    const onDisconnect = () => refresh(); // مستمع thermal يصفّر الدور أولاً ⇒ يعكس isPaired الواقع
    usb.addEventListener("connect", onConnect);
    usb.addEventListener("disconnect", onDisconnect);
    return () => {
      usb.removeEventListener?.("connect", onConnect);
      usb.removeEventListener?.("disconnect", onDisconnect);
    };
  }, [usbSupported]);

  function applySize(next: LabelSize) {
    const saved = setLabelSize(next);
    setSize(saved);
    setWStr(String(saved.widthMm));
    setHStr(String(saved.heightMm));
  }
  function commitCustom() {
    applySize({ widthMm: Number(wStr) || size.widthMm, heightMm: Number(hStr) || size.heightMm });
  }
  async function pairLabelPrinter() {
    setError(""); setInfo("");
    try {
      await pairPrinter("label");
      setLabelPrinterReady(true);
      setInfo("تم ربط طابعة الملصقات ✓");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر ربط طابعة الملصقات");
    }
  }
  async function testPrint() {
    setError(""); setInfo("");
    const r = await printLabel(
      [{ name: "ملصق تجريبي — الرؤية العربية", sku: "TEST", price: "1000", barcode: "ALR0000001" }],
      { showName, showPrice },
      size,
    );
    if (r.via === "thermal") setInfo("طُبع ملصق تجريبي عبر الطابعة المربوطة ✓");
    else if (r.ok) setInfo("فُتحت نافذة طباعة الملصق التجريبي.");
    else setError("تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع.");
  }

  const results = trpc.catalog.posList.useQuery(
    { branchId, tier: "RETAIL", query: search, limit: 12 },
    { enabled: search.trim().length > 0 }
  );

  const assign = trpc.catalog.assignBarcode.useMutation({
    onError: (e) => setError(e.message),
  });

  function addRow(row: PosRow) {
    setError("");
    setQueue((prev) => {
      if (prev.some((q) => q.productUnitId === row.productUnitId)) return prev;
      const hasBarcode = !!row.barcode;
      return [
        ...prev,
        {
          key: seq,
          productUnitId: row.productUnitId,
          productName: row.productName,
          unitName: row.unitName,
          sku: row.sku,
          barcode: row.barcode ?? internalBarcode(row.productUnitId),
          price: row.price,
          saved: hasBarcode,
          count: 1,
        },
      ];
    });
    setSeq((s) => s + 1);
    setSearch("");
  }

  const patch = (key: number, p: Partial<QueueItem>) =>
    setQueue((prev) => prev.map((q) => (q.key === key ? { ...q, ...p } : q)));
  const remove = (key: number) => setQueue((prev) => prev.filter((q) => q.key !== key));
  function commitCount(key: number) {
    const raw = countDraft[key];
    if (raw !== undefined) patch(key, { count: Math.max(1, Math.trunc(Number(raw) || 1)) });
    setCountDraft((d) => { const rest = { ...d }; delete rest[key]; return rest; });
  }

  async function saveBarcode(item: QueueItem) {
    setError("");
    try {
      await assign.mutateAsync({ productUnitId: item.productUnitId, barcode: item.barcode });
      patch(item.key, { saved: true });
      await Promise.all([utils.catalog.posList.invalidate(), utils.catalog.byBarcode.invalidate()]);
    } catch {
      /* الخطأ يُعرض عبر onError */
    }
  }

  async function printLabels() {
    setError(""); setInfo("");
    if (!queue.length) { setError("أضِف صنفاً واحداً على الأقل."); return; }
    const expanded = queue.flatMap(item =>
      Array.from({ length: item.count }, () => ({
        name: `${item.productName} — ${item.unitName}`,
        sku: item.sku,
        price: item.price,
        barcode: item.barcode,
      }))
    );
    // نفس تقنية الكاشير: WebUSB(label) إن رُبطت الطابعة، وإلا نافذة المتصفّح بمقاس الملصق.
    const r = await printLabel(expanded, { showName, showPrice }, size);
    if (r.via === "thermal") setInfo(`تم إرسال ${expanded.length} ملصق للطابعة المربوطة ✓`);
    else if (r.ok) setInfo(`فُتحت نافذة الطباعة (${expanded.length} ملصق).`);
    else setError("تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع، أو اربط طابعة الملصقات.");
  }

  const totalLabels = queue.reduce((s, q) => s + q.count, 0);

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">طباعة ملصقات الباركود</h1>
        <Link href="/products" className="text-sm text-muted-foreground">المنتجات ←</Link>
      </div>
      <p className="text-sm text-muted-foreground">
        ابحث عن صنف وأضفه. للأصناف بلا باركود مصنّعي يُولَّد باركود داخلي (ALR…) — احفظه ليصبح قابلاً للمسح في الكاشير، ثم اطبع الملصقات.
      </p>

      {/* مقاس الملصق + طابعة الملصقات */}
      <Card>
        <CardHeader><CardTitle className="text-base">مقاس الملصق والطابعة</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm">المقاس (عرض الطابعة الأقصى 58مم)</Label>
            <div className="flex flex-wrap gap-2">
              {LABEL_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  variant={activePreset === p.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => applySize(p.size)}
                >
                  {p.label}
                </Button>
              ))}
              <span className={`inline-flex items-center px-2 text-xs rounded-md border ${activePreset === "custom" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>
                مخصّص:
              </span>
              <div className="flex items-center gap-1" dir="ltr">
                <Input className="h-8 w-16 text-center" inputMode="numeric" value={wStr}
                  onChange={(e) => setWStr(e.target.value)} onBlur={commitCustom}
                  onKeyDown={(e) => { if (e.key === "Enter") commitCustom(); }} aria-label="العرض مم" />
                <span className="text-muted-foreground text-sm">×</span>
                <Input className="h-8 w-16 text-center" inputMode="numeric" value={hStr}
                  onChange={(e) => setHStr(e.target.value)} onBlur={commitCustom}
                  onKeyDown={(e) => { if (e.key === "Enter") commitCustom(); }} aria-label="الارتفاع مم" />
                <span className="text-muted-foreground text-sm">مم</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">المقاس الحالي: {size.widthMm} × {size.heightMm} مم (يُطبَّق في كل شاشات الطباعة).</p>
          </div>

          {/* معاينة حيّة بنفس تصميم الطباعة تماماً (HTML/SVG مباشر بلا تحويل لصورة) */}
          <div className="flex items-start gap-4 flex-wrap border-t pt-3">
            <div
              className="shrink-0 rounded bg-white"
              style={{ width: pxW * PREVIEW_ZOOM, height: pxH * PREVIEW_ZOOM, outline: "1px dashed #94a3b8" }}
            >
              <iframe
                title="معاينة الملصق"
                srcDoc={previewHtml}
                scrolling="no"
                style={{
                  width: pxW, height: pxH, border: 0, display: "block", background: "#fff",
                  transform: `scale(${PREVIEW_ZOOM})`, transformOrigin: "top left",
                }}
              />
            </div>
            <div className="text-xs text-muted-foreground space-y-1 min-w-[12rem] flex-1">
              <p className="font-medium text-foreground">معاينة فعلية بمقاس الملصق (مكبّرة ×{PREVIEW_ZOOM})</p>
              <p>التصميم نفسه الذي يُطبع تماماً: اسمٌ يتكيّف مع طوله، قضبان تملأ العرض، وخطوط ثقيلة واضحة بلا خطوط رفيعة.</p>
              <p>تُطبع مباشرةً (HTML/SVG) بلا تحويلٍ إلى صورة. عدّل المقاس أو خياري الاسم/السعر لتُحدَّث المعاينة فوراً.</p>
            </div>
          </div>

          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              {!usbSupported ? (
                <span className="text-xs text-muted-foreground">المتصفّح لا يدعم الطباعة المباشرة (WebUSB) — ستُفتح نافذة الطباعة. استخدم Chrome/Edge للطباعة الصامتة.</span>
              ) : labelPrinterReady ? (
                <>
                  <span className="text-sm text-emerald-600">طابعة الملصقات مربوطة ✓</span>
                  <Button type="button" variant="outline" size="sm" onClick={pairLabelPrinter}>تغيير الطابعة</Button>
                </>
              ) : (
                <>
                  <span className="text-sm text-muted-foreground">طابعة الملصقات غير مربوطة (ستُفتح نافذة الطباعة عبر تعريف Windows).</span>
                  <Button type="button" variant="outline" size="sm" onClick={pairLabelPrinter}>ربط طابعة الملصقات</Button>
                </>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={testPrint}>طباعة ملصق تجريبي</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              للملصقات المقصوصة (die-cut): الأفضل تركها <span className="font-medium">غير مربوطة</span> لتُطبع عبر تعريف Windows الذي يحاذي فجوات الملصقات تلقائياً. اربط الطابعة (WebUSB) للورق المتّصل (continuous) أو للطباعة الصامتة السريعة.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">إضافة أصناف</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم/SKU/الباركود…" />
            {search.trim() && (results.data?.length ?? 0) > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow max-h-72 overflow-auto">
                {results.data!.map((row) => (
                  <button
                    key={row.productUnitId}
                    className="block w-full text-right px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => addRow(row)}
                  >
                    {row.productName} <span className="text-muted-foreground">({row.unitName})</span>
                    <span className="text-xs text-muted-foreground font-mono" dir="ltr"> — {row.sku}{row.barcode ? ` · ${row.barcode}` : " · بلا باركود"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> اسم الصنف</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> السعر</label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">قائمة الطباعة ({totalLabels} ملصق)</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الصنف</th>
                <th className="p-2">الباركود</th>
                <th className="p-2 text-left">السعر</th>
                <th className="p-2 w-24 text-center">عدد الملصقات</th>
                <th className="p-2 text-center">معاينة</th>
                <th className="p-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((q) => {
                let preview = "";
                try {
                  preview = code128Svg(q.barcode, { moduleWidth: 1.4, height: 34, showText: false }).svg;
                } catch {
                  preview = "";
                }
                return (
                  <tr key={q.key} className="border-t align-middle">
                    <td className="p-2">{q.productName}<span className="text-muted-foreground"> — {q.unitName}</span></td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <CopyInline value={q.barcode} />
                        {!q.saved && (
                          <Button variant="outline" size="sm" disabled={assign.isPending} onClick={() => saveBarcode(q)}>
                            حفظ الباركود
                          </Button>
                        )}
                        {q.saved && <span className="text-xs text-emerald-600">محفوظ ✓</span>}
                      </div>
                    </td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{q.price != null ? money(q.price) : "—"}</td>
                    <td className="p-2">
                      <Input dir="ltr" inputMode="numeric" className="h-8 text-center"
                        value={countDraft[q.key] ?? String(q.count)}
                        onChange={(e) => setCountDraft((d) => ({ ...d, [q.key]: e.target.value }))}
                        onBlur={() => commitCount(q.key)}
                        onKeyDown={(e) => { if (e.key === "Enter") commitCount(q.key); }} />
                    </td>
                    <td className="p-2 text-center" dangerouslySetInnerHTML={{ __html: preview }} />
                    <td className="p-2 text-center"><Button variant="ghost" size="sm" onClick={() => remove(q.key)}>✕</Button></td>
                  </tr>
                );
              })}
              {queue.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">ابحث أعلاه لإضافة أصناف للطباعة.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && <p className="text-sm text-emerald-600">{info}</p>}
      <div className="flex gap-2">
        <Button onClick={printLabels} disabled={queue.length === 0}>طباعة {totalLabels} ملصق</Button>
        <Button variant="outline" onClick={() => setQueue([])} disabled={queue.length === 0}>تفريغ القائمة</Button>
      </div>
    </div>
  );
}

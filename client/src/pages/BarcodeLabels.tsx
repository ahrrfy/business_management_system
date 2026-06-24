import { CopyInline } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
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
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, X } from "lucide-react";
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
  const searchRef = useRef<HTMLInputElement>(null);
  // التركيز التلقائي ⇒ الماسح يكتب في الحقل مباشرةً بدل تسريب الضربات للوثيقة (وفتح Ctrl+K/`/`).
  useEffect(() => { searchRef.current?.focus(); }, []);
  // بحث ذكي: تأجيل ١٨٠ms لطلب واحد بعد استقرار الكتابة (مطابق POS).
  const debouncedSearch = useDebouncedValue(search, 180);
  const term = debouncedSearch.trim();
  const canSearch = term.length >= 2;
  // تحميل كسول غير محدود: نبدأ بصفحة ونزيدها بالتمرير ⇒ لا قصّ صامت لنتائج البحث.
  const SEARCH_PAGE = 200;
  const [searchLimit, setSearchLimit] = useState(SEARCH_PAGE);
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

  // معاينة حيّة بنفس تصميم الطباعة (نفس labelDocHtml ⇒ ما تراه هو ما يُطبع) — أوّل منتج في القائمة
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
      setInfo("تم ربط طابعة الملصقات");
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
    if (r.via === "thermal") setInfo("طُبع ملصق تجريبي عبر الطابعة المربوطة");
    else if (r.ok) setInfo("فُتحت نافذة طباعة الملصق التجريبي.");
    else setError("تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع.");
  }

  const results = trpc.catalog.posList.useQuery(
    { branchId, tier: "RETAIL", query: term, limit: searchLimit },
    { enabled: canSearch, placeholderData: keepPreviousData, staleTime: 15_000 }
  );
  const maybeMoreSearch = (results.data?.length ?? 0) >= searchLimit;
  function handleSearchScroll(e: React.UIEvent<HTMLDivElement>) {
    if (results.isFetching || !maybeMoreSearch) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
      setSearchLimit((l) => l + SEARCH_PAGE);
    }
  }

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
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  // Enter في حقل البحث: نتيجة وحيدة ⇒ تُضاف، وإلا نحاول حلّ الباركود حرفياً.
  async function tryResolveBarcode(code: string) {
    const looksLikeBarcode = /^[0-9A-Za-z_-]{4,}$/.test(code);
    if (!looksLikeBarcode) return false;
    try {
      const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier: "RETAIL" });
      if (row) { addRow(row); return true; }
      setError(`الباركود غير معروف: ${code}`);
    } catch {
      setError("تعذّر الاتصال بالخادم");
    }
    return false;
  }
  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const data = results.data;
      // النتائج مطابقة للنص المستقر ⇒ نتيجة وحيدة = إضافة مباشرة بأمان.
      if (term === search.trim() && data && data.length === 1 && !results.isFetching) {
        addRow(data[0]);
        return;
      }
      const code = search.trim();
      if (code) void tryResolveBarcode(code);
    } else if (e.key === "Escape") {
      setSearch("");
    }
  }
  // الماسح يضرب على document حين لا يكون الحقل مركَّزاً ⇒ نمرّر الكود للحقل ثم نحلّه.
  useBarcodeScanner((raw) => {
    setSearch(raw);
    void tryResolveBarcode(raw);
  });

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
    if (!(await confirm({
      variant: "warning",
      title: "حفظ الباركود",
      description: `حفظ الباركود «${item.barcode}» للمنتج «${item.productName} — ${item.unitName}» يجعله قابلاً للمسح وقد يستبدل باركوداً قائماً. متابعة؟`,
      confirmText: "حفظ الباركود",
    }))) return;
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
    if (!queue.length) { setError("أضِف منتجاً واحداً على الأقل."); return; }
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
    if (r.via === "thermal") setInfo(`تم إرسال ${expanded.length} ملصق للطابعة المربوطة`);
    else if (r.ok) setInfo(`فُتحت نافذة الطباعة (${expanded.length} ملصق).`);
    else setError("تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع، أو اربط طابعة الملصقات.");
  }

  const totalLabels = queue.reduce((s, q) => s + q.count, 0);

  return (
    <div className="space-y-4 max-w-4xl">
      <PageHeader
        title="طباعة ملصقات الباركود"
        description="ابحث عن منتج وأضفه. للمنتجات بلا باركود مصنّعي يُولَّد باركود داخلي (ALR…) — احفظه ليصبح قابلاً للمسح في الكاشير، ثم اطبع الملصقات."
        actions={<Link href="/products" className="text-sm text-muted-foreground">المنتجات ←</Link>}
      />

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
            {/* dir="ltr" + position:relative ⇒ يُثبَّت iframe في الزاوية العليا اليسرى للحاوية حتى داخل
                مستندٍ RTL؛ بدونه كان iframe (block أضيق) يُحاذى لليمين فيُسرّب التكبير محتواه خارج
                الحدّ الأيمن وتُقَصّ المعاينة بصرياً. overflow:hidden احترازي على الحوافّ الكسرية. */}
            <div
              dir="ltr"
              className="shrink-0 rounded bg-white relative overflow-hidden"
              style={{ width: pxW * PREVIEW_ZOOM, height: pxH * PREVIEW_ZOOM, outline: "1px dashed var(--border)" }}
            >
              <iframe
                title="معاينة الملصق"
                srcDoc={previewHtml}
                scrolling="no"
                style={{
                  width: pxW, height: pxH, border: 0, display: "block", background: "#fff",
                  position: "absolute", top: 0, left: 0,
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
                  <span className="text-sm text-money-positive inline-flex items-center gap-1"><Check aria-hidden className="size-4" />طابعة الملصقات مربوطة</span>
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
        <CardHeader><CardTitle className="text-base">إضافة منتجات</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSearchLimit(SEARCH_PAGE); }}
              onKeyDown={onSearchKeyDown}
              placeholder="ابحث بالاسم/SKU أو امسح الباركود — Enter يحلّ الباركود حرفياً"
              autoFocus
            />
            {search.trim() && (
              <div
                className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow max-h-72 overflow-auto"
                onScroll={handleSearchScroll}
              >
                {!canSearch && (
                  <div className="px-3 py-2 text-center text-xs text-muted-foreground">اكتب حرفين فأكثر للبحث…</div>
                )}
                {canSearch && (results.data?.length ?? 0) === 0 && (
                  <div className="px-3 py-2 text-center text-xs text-muted-foreground">
                    {results.isFetching ? "جارٍ البحث…" : <>لا نتائج لـ «{search.trim()}» — جرّب اسماً أقصر أو امسح الباركود</>}
                  </div>
                )}
                {(results.data ?? []).map((row) => (
                  <button
                    key={row.productUnitId}
                    type="button"
                    className="block w-full text-right px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => addRow(row)}
                  >
                    {row.productName} <span className="text-muted-foreground">({row.unitName})</span>
                    <span className="text-xs text-muted-foreground font-mono" dir="ltr"> — {row.sku}{row.barcode ? ` · ${row.barcode}` : " · بلا باركود"}</span>
                  </button>
                ))}
                {canSearch && (results.data?.length ?? 0) > 0 && (
                  <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                    {maybeMoreSearch
                      ? (results.isFetching ? "جارٍ تحميل المزيد…" : "مرّر لأسفل لتحميل المزيد…")
                      : `كل النتائج (${results.data!.length})`}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> اسم المنتج</label>
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
                <th className="p-2">المنتج</th>
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
                        {q.saved && <span className="text-xs text-money-positive inline-flex items-center gap-1"><Check aria-hidden className="size-3.5" />محفوظ</span>}
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
                    <td className="p-2 text-center"><Button variant="ghost" size="sm" onClick={() => remove(q.key)} aria-label="حذف"><X aria-hidden className="size-4" /></Button></td>
                  </tr>
                );
              })}
              {queue.length === 0 && (
                <TableEmptyRow colSpan={6} message="ابحث أعلاه لإضافة منتجات للطباعة." />
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && <p className="text-sm text-money-positive">{info}</p>}
      <div className="flex gap-2">
        <Button onClick={printLabels} disabled={queue.length === 0}>طباعة {totalLabels} ملصق</Button>
        <Button
          variant="outline"
          onClick={async () => {
            if (!(await confirm({
              variant: "warning",
              title: "تفريغ قائمة الطباعة",
              description: `تفريغ كل قائمة الطباعة (${queue.length} منتج / ${totalLabels} ملصق)؟`,
              confirmText: "تفريغ القائمة",
            }))) return;
            setQueue([]);
          }}
          disabled={queue.length === 0}
        >
          تفريغ القائمة
        </Button>
      </div>
    </div>
  );
}

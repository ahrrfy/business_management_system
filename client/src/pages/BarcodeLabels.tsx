import { CopyInline } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
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
import { labelName, toLabelItem, TIER_NAME, type LabelTier } from "@/lib/printing/labelItem";
import { labelContentOf, solveLabelLayout, PART_LABEL_AR } from "@/lib/printing/labelLayout";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Info, Layers, Tag, TriangleAlert, X } from "lucide-react";
import { Link } from "wouter";

const PX_PER_MM = 96 / 25.4; // ≈3.78 بكسل/مم @96dpi
const PREVIEW_ZOOM = 2.4; // تكبير المعاينة بصرياً للوضوح (المقاس الفعليّ صغير)

type PosRow = RouterOutputs["catalog"]["posList"][number];
type QueueItem = {
  key: number;
  productId: number;
  productUnitId: number;
  productName: string;
  // اللون/القياس: كانا مُهمَلين فتخرج ملصقات ألوان المنتج الواحد **متطابقةً نصّياً**
  // (أزرق وأحمر بنفس السطر تماماً). يُدمجان في اسم الملصق عبر `labelName`.
  color: string | null;
  // لون بنك الألوان «#RRGGBB» — يُغذّي رمز اللون في التخطيط المنظّم (null ⇒ لا رمز).
  colorHex: string | null;
  size: string | null;
  unitName: string;
  // معامل التحويل للوحدة الأساس — «عدد النسخ = المخزون» يقسم عليه، وإلّا طبعنا ١٢٠ ملصق
  // «درزن» لرصيدٍ = ١٢٠ قطعة (= ١٠ درزن فقط).
  conversionFactor: string;
  sku: string;
  barcode: string; // الباركود المطبوع فعلاً — قد يكون مولّداً داخلياً أو بديلاً اختاره المستخدم
  primaryBarcode: string | null; // الأساسيّ المحفوظ (يبقى خياراً حتى بعد اختيار بديل)
  price: string | null; // سعر الفئة المختارة (الأصليّ، قبل أيّ عرض)
  // الفئة التي حُسِب بها `price`/`promoPrice` فعلاً. تبديل الفئة يجعل هذا ≠ `tier` المختارة ⇒
  // الصفّ «قديم التسعير». نُعيد تسعير القديم فقط، ونمنع الطباعة قبل اكتمال التسعير (لا ملصق يكذب).
  pricedTier: LabelTier;
  // سعر العرض السَّاري لهذه الوحدة إن وُجد. طباعة `price` وحده تجعل الملصق يكذب أثناء العرض.
  promoPrice: string | null;
  promotionName: string | null;
  stockBase: number; // رصيد المتغيّر بالوحدة الأساس — يغذّي «عدد النسخ = المخزون»
  saved: boolean; // هل الباركود محفوظ في القاعدة (⇒ قابل للمسح في الكاشير)؟
  count: number;
};

/** يبني عنصر قائمة الطباعة من صفّ الكتالوج — نقطة واحدة تلتقط كل حقوله ذات الأثر على الملصق.
 *  `rowTier` = الفئة التي جُلب بها هذا الصفّ فعلاً (يُثبَّت في `pricedTier`). */
function queueItemFromRow(row: PosRow, key: number, rowTier: LabelTier): QueueItem {
  return {
    key,
    productId: row.productId,
    productUnitId: row.productUnitId,
    productName: row.productName,
    color: row.color,
    colorHex: row.colorHex,
    size: row.size,
    unitName: row.unitName,
    conversionFactor: row.conversionFactor,
    sku: row.sku,
    barcode: row.barcode ?? internalBarcode(row.productUnitId),
    primaryBarcode: row.barcode,
    price: row.price,
    pricedTier: rowTier,
    promoPrice: row.promotionEffectivePrice,
    promotionName: row.promotionName,
    stockBase: row.stockBase,
    saved: !!row.barcode,
    count: 1,
  };
}

/**
 * عدد ملصقات «كامل المخزون» لهذه الوحدة = الرصيد (بالوحدة الأساس) ÷ معامل التحويل.
 * ليس مبلغاً ⇒ حساب عدديّ عاديّ (قيد decimal في §٥ على الأموال وحدها).
 */
/** أقصى نسخ لصفٍّ واحد — حاجزٌ ضدّ تجميد المتصفّح بمصفوفةٍ عملاقة، لا قيدٌ تشغيليّ فعليّ. */
const MAX_COPIES_PER_ROW = 2000;

/** يحصر عدد النسخ في [1, MAX] بعد تقريبه لصحيحٍ موجب. */
function clampCount(n: number): number {
  return Math.min(MAX_COPIES_PER_ROW, Math.max(1, Math.trunc(n) || 1));
}

function stockCopies(q: QueueItem): number {
  const factor = Number(q.conversionFactor) || 1;
  return Math.min(MAX_COPIES_PER_ROW, Math.max(0, Math.floor(q.stockBase / factor)));
}

/** عنصر الملصق المطبوع لصفٍّ من القائمة — مصدر واحد للمعاينة والطباعة معاً. */
function renderItemFor(q: QueueItem, tier: LabelTier): LabelRenderItem {
  return toLabelItem(
    {
      productName: q.productName,
      color: q.color,
      colorHex: q.colorHex,
      size: q.size,
      unitName: q.unitName,
      sku: q.sku,
      price: q.price,
      promotionEffectivePrice: q.promoPrice,
    },
    q.barcode,
    tier,
  );
}

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
  // مرآة حيّة للقائمة تُقرأ تزامنياً داخل المعالجات (انظر `addRows`). تُحدَّث في كل رسم.
  const queueRef = useRef<QueueItem[]>(queue);
  queueRef.current = queue;
  // مفتاح الصفّ: عدّادٌ في ref لا حالة — لا يحتاج رسماً، ولا يتصادم عند نداءين في نفس اللحظة.
  const seqRef = useRef(1);
  const [showName, setShowName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  // فئة السعر المطبوع. كانت مسمَّرةً على RETAIL ⇒ تعذّرت طباعة ملصق رفٍّ بسعر جملة/حكومي
  // رغم أنّ `productPrices` يحمل سعراً صريحاً لكل (وحدة × فئة) والعقد يقبل الفئة أصلاً.
  const [tier, setTier] = useState<LabelTier>("RETAIL");
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
  // عنصر المعاينة (أوّل منتج أو عيّنة) — مصدرٌ واحد للمعاينة الحيّة ولتقرير الملاءمة معاً.
  const previewItem = useMemo<LabelRenderItem>(
    () =>
      queue.length
        ? renderItemFor(queue[0], tier)
        : {
            name: "قلم جاف أزرق — درزن",
            sku: "PR-BLU",
            price: "500",
            barcode: "6212442744532",
            // عيّنة بخصائص منظّمة لتُظهر المعاينة التخطيط الاحترافي + رمز اللون على المقاسات الواسعة.
            attrs: { baseName: "قلم جاف", tags: ["أزرق"], colorHex: "#1D4ED8", unitName: "درزن" },
          },
    [queue, tier],
  );
  const previewHtml = useMemo(
    () => labelDocHtml([previewItem], size, { showName, showPrice }, false),
    [previewItem, size, showName, showPrice],
  );
  // تقرير ملاءمة المقاس — **نفس الحلّال الذي يقرّر ما يظهر فعلياً** على الملصق ⇒ نُنذر المستخدم
  // بما سيُخفى (بدل قصٍّ صامت يُفاجئه باختفاء الاسم) ونقترح ارتفاعاً يُظهر الكلّ.
  const previewFit = useMemo(
    () => solveLabelLayout(size, labelContentOf(previewItem), { name: showName, price: showPrice }),
    [previewItem, size, showName, showPrice],
  );
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
    { branchId, tier, query: term, limit: searchLimit },
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

  // تبديل الفئة يُبطل أسعار ما أُضيف سلفاً ⇒ نُعيد تسعير الصفوف «قديمة التسعير» من الخادم على
  // **نفس خطّ الكاشير** (فئة ← تعاقديّ ← بكج ← عروض). بلا هذا تُطبع أسعار الفئة السابقة صامتاً.
  //
  // الأثر يتتبّع `stalePricingKey` (معرّفات الصفوف التي `pricedTier ≠ tier`) لا `queue` كاملةً:
  // تعديلٌ لا يُدخل صفّاً قديم التسعير (تغيير عدد نسخة، اختيار باركود) لا يُعيد تشغيل الجلب ولا يُلغيه
  // (كان الحارس السابق يُلغيه نهائياً فتبقى الأسعار عالقةً صامتاً — أمسكته المراجعة العدائية).
  const staleTargets = queue.filter((q) => q.pricedTier !== tier);
  const stalePricingKey = staleTargets.map((q) => q.productUnitId).join(",");
  const isRepricing = staleTargets.length > 0;
  useEffect(() => {
    if (!stalePricingKey) return;
    const ids = stalePricingKey.split(",").map(Number);
    let cancelled = false;
    void (async () => {
      try {
        const rows = await utils.catalog.byUnitIds.fetch({ branchId, tier, productUnitIds: ids });
        if (cancelled) return;
        const byUnit = new Map(rows.map((r) => [r.productUnitId, r]));
        setQueue((prev) =>
          prev.map((q) => {
            if (q.pricedTier === tier) return q;
            const r = byUnit.get(q.productUnitId);
            return r
              ? { ...q, price: r.price, promoPrice: r.promotionEffectivePrice, promotionName: r.promotionName, pricedTier: tier }
              : q;
          })
        );
      } catch {
        if (!cancelled) setError("تعذّر إعادة تسعير بعض الأصناف لهذه الفئة — بدّل الفئة ثانيةً لإعادة المحاولة.");
      }
    })();
    return () => { cancelled = true; };
  }, [stalePricingKey, tier, branchId, utils]);

  /**
   * يُدرج صفوفاً في القائمة متخطّياً المكرّر، ويعيد عدد المُضاف **فعلاً**.
   *
   * العدّ يُحسَب من `queueRef` تزامنياً لا من داخل مُحدِّث `setQueue`: المُحدِّث يُنفَّذ لاحقاً
   * (بعد رجوع الدالّة) ⇒ كان العدّاد يعود صفراً دائماً فتقول رسالةُ «كل الألوان» «مضافة أصلاً»
   * بينما أضافت أربعة صفوف — كذبةٌ أمسكتها الجولة الحيّة.
   */
  function addRows(rows: PosRow[], rowTier: LabelTier): number {
    const seen = new Set(queueRef.current.map((q) => q.productUnitId));
    const fresh: QueueItem[] = [];
    for (const row of rows) {
      if (seen.has(row.productUnitId)) continue;
      seen.add(row.productUnitId);
      fresh.push(queueItemFromRow(row, seqRef.current++, rowTier));
    }
    if (!fresh.length) return 0;
    // نُقدّم المرآة تزامنياً كي يدَعمَ نداءان متتاليان في نفس اللحظة إزالةَ التكرار بينهما.
    queueRef.current = [...queueRef.current, ...fresh];
    setQueue(queueRef.current);
    return fresh.length;
  }

  function addRow(row: PosRow) {
    setError("");
    // `row` جاء من نتائج البحث المجلوبة بالفئة الحاليّة ⇒ نُثبّتها فئةَ تسعيره.
    addRows([row], tier);
    setSearch("");
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  /** «أضِف كلّ الألوان/الوحدات»: كلّ صفوف (متغيّر × وحدة) لهذا المنتج دفعةً واحدة. */
  async function addWholeProduct(row: PosRow) {
    setError(""); setInfo("");
    // نلتقط الفئة وقت الطلب: لو بدّلها المستخدم أثناء الجلب، نُثبّت الصفوف بفئة جلبها الحقيقيّة
    // فيلتقطها أثر إعادة التسعير لاحقاً بدل وسمها بفئةٍ لم تُسعَّر بها.
    const fetchTier = tier;
    try {
      const rows = await utils.catalog.byProductIds.fetch({ branchId, tier: fetchTier, productIds: [row.productId] });
      const added = addRows(rows, fetchTier);
      setInfo(added ? `أُضيف ${added} صفّاً من «${row.productName}» (كلّ الألوان والوحدات).` : "كلّ صفوف هذا المنتج مضافة أصلاً.");
    } catch {
      setError("تعذّر جلب ألوان/وحدات المنتج — تحقّق من الاتصال.");
    }
    setSearch("");
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  // Enter في حقل البحث: نتيجة وحيدة ⇒ تُضاف، وإلا نحاول حلّ الباركود حرفياً.
  async function tryResolveBarcode(code: string) {
    const looksLikeBarcode = /^[0-9A-Za-z_-]{4,}$/.test(code);
    if (!looksLikeBarcode) return false;
    try {
      const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier });
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

  /** خيارات الباركود المطبوع: الأساسيّ + البدائل + القيمة الحاليّة (الداخليّ المولَّد) إن لم تكن منها. */
  function barcodeOptions(q: QueueItem): Array<{ code: string; label: string }> {
    const alts = aliasMap[q.productUnitId] ?? [];
    const opts: Array<{ code: string; label: string }> = [];
    if (q.primaryBarcode) opts.push({ code: q.primaryBarcode, label: "أساسيّ" });
    for (const a of alts) opts.push({ code: a.barcode, label: a.note?.trim() || "بديل" });
    if (!opts.some((o) => o.code === q.barcode)) {
      opts.unshift({ code: q.barcode, label: q.saved ? "محفوظ" : "داخليّ غير محفوظ" });
    }
    return opts;
  }

  /** اختيار الباركود المطبوع. `saved` يتبع الواقع: البديل محفوظٌ في القاعدة ⇒ يمسحه الكاشير. */
  function pickBarcode(q: QueueItem, code: string) {
    const alts = aliasMap[q.productUnitId] ?? [];
    const inDb = code === q.primaryBarcode || alts.some((a) => a.barcode === code);
    patch(q.key, { barcode: code, saved: inDb });
  }
  const remove = (key: number) => setQueue((prev) => prev.filter((q) => q.key !== key));
  function commitCount(key: number) {
    const raw = countDraft[key];
    // سقفٌ لكل صفّ: إدخالٌ يدويّ ضخم (٩٩٩٩٩) كان يبني مصفوفةً عملاقة ويُنقّط كل عنصر ⇒ تجميد
    // المتصفّح. صفّ مطبعةٍ نادراً ما يتجاوز بضع مئات؛ نحصر بحدٍّ آمنٍ عالٍ بلا إعاقة الاستعمال.
    if (raw !== undefined) patch(key, { count: clampCount(Number(raw) || 1) });
    setCountDraft((d) => { const rest = { ...d }; delete rest[key]; return rest; });
  }

  /** «عدد النسخ = المخزون». تُمسَح المسوّدة النصّية أيضاً، وإلّا ظلّ الحقل يعرض القيمة القديمة. */
  function setCountToStock(q: QueueItem) {
    const n = stockCopies(q);
    if (n < 1) return;
    setCountDraft((d) => { const rest = { ...d }; delete rest[q.key]; return rest; });
    patch(q.key, { count: n });
  }

  /** ملء أعداد القائمة كلّها من المخزون — تدفّق «وصلت شحنة ⇒ اطبع ملصقات كل ما فيها». */
  function setAllCountsToStock() {
    setCountDraft({});
    setQueue((prev) => prev.map((q) => { const n = stockCopies(q); return n >= 1 ? { ...q, count: n } : q; }));
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
      // الحفظ يجعله الأساسيّ فعلاً ⇒ نُحدّث الأساسيّ المحلّي وإلّا بقي منتقي الباركود يعرض حالةً قديمة.
      patch(item.key, { saved: true, primaryBarcode: item.barcode });
      await Promise.all([utils.catalog.posList.invalidate(), utils.catalog.byBarcode.invalidate()]);
    } catch {
      /* الخطأ يُعرض عبر onError */
    }
  }

  async function printLabels() {
    setError(""); setInfo("");
    if (!queue.length) { setError("أضِف منتجاً واحداً على الأقل."); return; }
    // حاجز الصحّة: لا نطبع وبعض الأصناف ما زالت بسعر الفئة السابقة (إعادة تسعيرٍ جارية) —
    // وإلّا خرج ملصقٌ بسعرٍ لا يطابق الكاشير. الأثر أعلاه يُنهي التسعير فيرفع الحظر.
    if (isRepricing) { setError("جارٍ تحديث الأسعار للفئة المختارة — انتظر لحظةً ثم اطبع."); return; }
    const expanded = queue.flatMap((item) => {
      const rendered = renderItemFor(item, tier);
      return Array.from({ length: item.count }, () => rendered);
    });
    // نفس تقنية الكاشير: WebUSB(label) إن رُبطت الطابعة، وإلا نافذة المتصفّح بمقاس الملصق.
    const r = await printLabel(expanded, { showName, showPrice }, size);
    if (r.via === "thermal") setInfo(`تم إرسال ${expanded.length} ملصق للطابعة المربوطة`);
    else if (r.ok) setInfo(`فُتحت نافذة الطباعة (${expanded.length} ملصق).`);
    else setError("تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع، أو اربط طابعة الملصقات.");
  }

  const totalLabels = queue.reduce((s, q) => s + q.count, 0);

  // بدائل الباركود لكلّ وحدات القائمة في **استعلامٍ واحد**: الوحدة قد تحمل عدّة باركودات لنفس
  // السلعة (مصنّعيّ + داخليّ)، والملصق كان يطبع الأساسيّ حصراً بلا خيار. الوحدات بلا بدائل تغيب
  // عن الخريطة ⇒ لا يظهر منتقٍ حيث لا خيار.
  const queueUnitIds = useMemo(() => queue.map((q) => q.productUnitId), [queue]);
  const aliasesQ = trpc.catalog.listUnitBarcodesMany.useQuery(
    { productUnitIds: queueUnitIds },
    { enabled: queueUnitIds.length > 0, staleTime: 60_000 }
  );
  const aliasMap = aliasesQ.data ?? {};

  return (
    // عرض كامل ديناميكي (بلا max-w): الإعدادات والمعاينة جنباً إلى جنب على الشاشات الواسعة،
    // وقائمة الطباعة بعرض كامل ⇒ توزيع أفقيّ يقلّل الطول والتمرير. يتراصف عمودياً على الموبايل.
    <div className="space-y-4">
      <PageHeader
        title="طباعة ملصقات الباركود"
        description="ابحث عن منتج وأضفه. للمنتجات بلا باركود مصنّعي يُولَّد باركود داخلي (ALR…) — احفظه ليصبح قابلاً للمسح في الكاشير، ثم اطبع الملصقات."
        actions={<Link href="/products" className="text-sm text-muted-foreground">المنتجات ←</Link>}
      />

      {/* الإعدادات | المعاينة — عمودان على ≥lg */}
      <div className="grid gap-4 lg:grid-cols-2 items-start">
        {/* مقاس الملصق + خيارات المحتوى + الطابعة */}
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

            {/* فئة السعر المطبوع — تُعيد تسعير قائمة الطباعة كاملةً فوراً */}
            <div className="space-y-2 border-t pt-3">
              <Label className="text-sm">فئة السعر المطبوع</Label>
              <div className="flex flex-wrap gap-2">
                {(["RETAIL", "WHOLESALE", "GOVERNMENT"] as const).map((t) => (
                  <Button
                    key={t}
                    type="button"
                    variant={tier === t ? "default" : "outline"}
                    size="sm"
                    onClick={() => setTier(t)}
                  >
                    {TIER_NAME[t]}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                يُطبع سعر هذه الفئة لكلّ وحدة. تبديلها يُعيد تسعير القائمة كاملةً، وتُوسَم ملصقات الجملة/الحكومي بشارة الفئة كي لا تُخلَط بملصق الرفّ.
              </p>
            </div>

            {/* خيارات محتوى الملصق (تتفاعل مع المعاينة) */}
            <div className="flex flex-wrap gap-4 border-t pt-3 text-sm">
              <label className="flex items-center gap-1"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> اسم المنتج</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> السعر</label>
            </div>

            {/* طابعة الملصقات */}
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

        {/* معاينة حيّة بنفس تصميم الطباعة تماماً (HTML/SVG مباشر بلا تحويل لصورة) */}
        <Card>
          <CardHeader><CardTitle className="text-base">معاينة حيّة</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-start gap-4 flex-wrap">
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

            {/* المجموعة الإلزامية (الاسم/اللون/الوحدة/السعر/الباركود) لا تختفي أبداً — نطمئن المستخدم
                بذلك، ونُبلّغه بلطف بما يُخفى (رقم الباركود/الرمز فقط) وبأصغر ارتفاعٍ مريح. إنذارٌ كهرمانيّ
                فقط في الحالة القصوى النادرة (مقاسٌ ضئيلٌ جداً قد يقتطع طرف الاسم). */}
            {previewFit.overflow ? (
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
              >
                <TriangleAlert aria-hidden className="size-4 shrink-0 mt-0.5" />
                <p>
                  المقاس {size.widthMm}×{size.heightMm}مم ضئيلٌ جداً — قد يُقتطع طرف الاسم الطويل. استخدم ارتفاعاً ≥{" "}
                  {previewFit.minHeightMmForAll}مم أو ملصقاً أعرض ليظهر كلّ شيء كاملاً.
                </p>
              </div>
            ) : (
              (previewFit.tiny || previewFit.dropped.length > 0) && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                >
                  <Info aria-hidden className="size-4 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="text-foreground">
                      كلّ المعلومات الأساسية ظاهرة: الاسم واللون والوحدة والسعر والباركود
                      {previewFit.tiny ? " (بخطٍّ مصغّر مقروء)" : ""}.
                    </p>
                    {previewFit.dropped.length > 0 && (
                      <p>
                        على هذا المقاس يُخفى فقط {previewFit.dropped.map((p) => PART_LABEL_AR[p]).join("، ")} — والباركود
                        نفسه يبقى قابلاً للمسح. لعرضٍ أوسع استخدم ارتفاعاً ≥ {previewFit.minHeightMmForAll}مم.
                      </p>
                    )}
                    {previewFit.dropped.length === 0 && previewFit.tiny && (
                      <p>لوضوحٍ أكبر استخدم ارتفاعاً ≥ {previewFit.minHeightMmForAll}مم.</p>
                    )}
                  </div>
                </div>
              )
            )}
          </CardContent>
        </Card>
      </div>

      {/* منطقة العمل: بحث + قائمة الطباعة — بعرض كامل */}
      <Card>
        <CardHeader><CardTitle className="text-base">قائمة الطباعة ({totalLabels} ملصق)</CardTitle></CardHeader>
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
                  <div key={row.productUnitId} className="flex items-center gap-1 px-1 hover:bg-accent">
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-right px-2 py-2 text-sm"
                      onClick={() => addRow(row)}
                    >
                      {/* نفس `labelName` ⇒ ما تراه في المنسدلة هو ما يُطبع (بحارس تكرار اللون نفسه). */}
                      {labelName({ productName: row.productName, color: row.color, size: row.size })}
                      <span className="text-muted-foreground"> ({row.unitName})</span>
                      <span className="text-xs text-muted-foreground font-mono" dir="ltr"> — {row.sku}{row.barcode ? ` · ${row.barcode}` : " · بلا باركود"}</span>
                    </button>
                    {/* شحنة وصلت ⇒ ملصقات كلّ ألوانها بضغطةٍ واحدة بدل بحثٍ يدويٍّ صفّاً صفّاً. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-xs gap-1"
                      title={`أضِف كلّ ألوان ووحدات «${row.productName}»`}
                      onClick={() => void addWholeProduct(row)}
                    >
                      <Layers aria-hidden className="size-3.5" />كل الألوان
                    </Button>
                  </div>
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

          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-right">المنتج</th>
                  <th className="p-2 text-right">الباركود</th>
                  <th className="p-2 text-right">السعر</th>
                  <th className="p-2 text-right w-48">عدد الملصقات</th>
                  <th className="p-2 text-center">معاينة</th>
                  <th className="p-2 w-10 text-center"></th>
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
                      <td className="p-2">
                        <div>{q.productName}</div>
                        <div className="text-xs text-muted-foreground">
                          {[q.color, q.size, q.unitName].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <CopyInline value={q.barcode} />
                          {!q.saved && (
                            <Button variant="outline" size="sm" disabled={assign.isPending} onClick={() => saveBarcode(q)}>
                              حفظ الباركود
                            </Button>
                          )}
                          {q.saved && <span className="text-xs text-money-positive inline-flex items-center gap-1"><Check aria-hidden className="size-3.5" />محفوظ</span>}
                          {/* وحدةٌ بعدّة باركودات (مصنّعيّ + داخليّ) ⇒ اختر أيّها يُطبع. يظهر فقط حين يوجد خيار. */}
                          {barcodeOptions(q).length > 1 && (
                            <select
                              dir="ltr"
                              className="h-8 rounded-md border bg-background px-1 text-xs font-mono"
                              value={q.barcode}
                              onChange={(e) => pickBarcode(q, e.target.value)}
                              aria-label={`الباركود المطبوع لـ${q.productName}`}
                              title="اختر أيّ باركود يُطبع على الملصق"
                            >
                              {barcodeOptions(q).map((o) => (
                                <option key={o.code} value={o.code}>{o.code} — {o.label}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                      {/* عرضٌ سارٍ ⇒ المطبوع هو السعر الفعّال والأصليّ مشطوب (الملصق لا يكذب على الزبون). */}
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {q.promoPrice != null && q.price != null ? (
                          <span className="inline-flex items-center gap-1" title={q.promotionName ?? "عرض سارٍ"}>
                            <s className="text-muted-foreground text-xs">{money(q.price)}</s>
                            <span className="text-money-positive font-medium">{money(q.promoPrice)}</span>
                            <Tag aria-hidden className="size-3 text-money-positive" />
                          </span>
                        ) : q.price != null ? (
                          money(q.price)
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          <Input dir="ltr" inputMode="numeric" className="h-8 w-16 text-center"
                            value={countDraft[q.key] ?? String(q.count)}
                            onChange={(e) => setCountDraft((d) => ({ ...d, [q.key]: e.target.value }))}
                            onBlur={() => commitCount(q.key)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitCount(q.key); }} />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs whitespace-nowrap"
                            disabled={stockCopies(q) < 1}
                            title={`رصيد الفرع بوحدة «${q.unitName}»: ${stockCopies(q)}`}
                            onClick={() => setCountToStock(q)}
                          >
                            = المخزون ({stockCopies(q)})
                          </Button>
                        </div>
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
          </ScrollTableShell>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {info && <p className="text-sm text-money-positive">{info}</p>}
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button onClick={printLabels} disabled={queue.length === 0 || isRepricing}>
              {isRepricing ? "جارٍ تحديث الأسعار…" : `طباعة ${totalLabels} ملصق`}
            </Button>
            <Button variant="outline" onClick={setAllCountsToStock} disabled={queue.length === 0}>
              عدد الكلّ = المخزون
            </Button>
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
        </CardContent>
      </Card>
    </div>
  );
}

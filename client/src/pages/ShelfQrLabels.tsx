/**
 * شاشة ومولّد ملصقات QR للرفوف (Shelf QR Labels & Poster Hub).
 *
 * تتيح لمدراء النظام والفروع توليد ملصقات احترافية عالية الدقة لرموز QR
 * الخاصة بقارئ أسعار الرفوف للزبائن، وطباعتها بأربعة مقاسات قياسية لمعارض التجزئة:
 *  - شريط الرف الفردي (60×35 مم) لطابعات الباركود الحرارية وحوامل الرفوف.
 *  - شيت A4 مجمّع (24 ملصق) للطباعة السريعة على ورق الملصقات المقسّم.
 *  - بطاقة ستاند الأكريليك (A5) لطاولات ومنصات العرض المركزية.
 *  - لافتة إرشادية جدارية (A4) لمداخل الممرات والأعمدة.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { shelfLookupUrl } from "@/lib/siteHosts";
import {
  printShelfQrDocument,
  type ShelfQrPrintOptions,
  type ShelfQrTemplateType,
} from "@/lib/printing/shelfQrPrint";
import {
  Printer,
  Download,
  Copy,
  Check,
  ExternalLink,
  QrCode,
  Store,
  Layers,
  Sparkles,
  Smartphone,
  Eye,
  Info,
} from "lucide-react";

const TEMPLATES: { id: ShelfQrTemplateType; label: string; desc: string; sizeHint: string }[] = [
  {
    id: "shelf-strip",
    label: "شريط حافة الرف (فردي)",
    desc: "ملصق أفقي مضغوط لحوامل الرفوف البلاستيكية أو طابعات الباركود الحرارية (Zebra / Xprinter).",
    sizeHint: "60 × 35 مم",
  },
  {
    id: "a4-sheet",
    label: "شيت ملصقات مجمّع (A4)",
    desc: "شبكة ملصقات مكررة للطباعة المجمعة على ورق A4 اللاصق وتقطيعه أو استخدامه مباشرة.",
    sizeHint: "A4 — 24 ملصق بالصفحة",
  },
  {
    id: "table-stand",
    label: "ستاند طاولة / كارت عرض (A5)",
    desc: "بطاقة عمودية أنيقة لحوامل الأكريليك على طاولات الكتب ومنصات العرض المركزية.",
    sizeHint: "A5 — 148 × 210 مم",
  },
  {
    id: "poster-a4",
    label: "بوستر إرشادي جداري (A4)",
    desc: "لافتة إرشادية كبيرة مع خطوات واضحة تعلق على أعمدة المعرض ومداخل الممرات.",
    sizeHint: "A4 — 210 × 297 مم",
  },
];

export default function ShelfQrLabels() {
  const branchesQ = trpc.branches.list.useQuery();
  const branches = branchesQ.data ?? [];

  // الفرع المختار: فارغ = عام لكافة الفروع
  const [selectedBranchId, setSelectedBranchId] = useState<string>("");
  const [template, setTemplate] = useState<ShelfQrTemplateType>("shelf-strip");
  const [title, setTitle] = useState("الرؤية العربية");
  const [subtitle, setSubtitle] = useState("امسح لمعرفة السعر والعروض");
  const [customNote, setCustomNote] = useState("");
  const [sheetCount, setSheetCount] = useState("24");

  // الرابط المشفر في الرمز
  const targetBranchId = selectedBranchId ? Number(selectedBranchId) : null;
  const targetUrl = useMemo(() => shelfLookupUrl(targetBranchId), [targetBranchId]);
  const branchName = useMemo(() => {
    if (!targetBranchId) return null;
    return branches.find((b) => b.id === targetBranchId)?.name ?? null;
  }, [branches, targetBranchId]);

  // توليد صورة الـ QR بدقة فائقة
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(targetUrl, {
      margin: 1,
      width: 600,
      errorCorrectionLevel: "H",
      color: { dark: "#0D3B2E", light: "#FFFFFF" },
    })
      .then((url) => {
        if (alive) setQrDataUrl(url);
      })
      .catch(() => {
        if (alive) setQrDataUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [targetUrl]);

  // نسخ الرابط
  const handleCopyLink = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard
        .writeText(targetUrl)
        .then(() => {
          setCopied(true);
          notify.ok("نُسخ الرابط إلى الحافظة بنجاح");
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => notify.err("تعذّر نسخ الرابط"));
    }
  }, [targetUrl]);

  // تنفيذ الطباعة المباشرة عبر محرك الطباعة القياسي
  const handlePrint = useCallback(() => {
    if (!qrDataUrl) {
      notify.err("رمز الاستجابة السريعة قيد التوليد");
      return;
    }

    const opts: ShelfQrPrintOptions = {
      template,
      qrDataUrl,
      targetUrl,
      branchName,
      title: title.trim() || "الرؤية العربية",
      subtitle: subtitle.trim() || "امسح لمعرفة السعر",
      customNote: customNote.trim() || undefined,
      sheetCount: template === "a4-sheet" ? Number(sheetCount) || 24 : undefined,
    };

    const ok = printShelfQrDocument(opts);
    if (!ok) {
      notify.err("حجب المتصفح نافذة الطباعة المنبثقة. يُرجى السماح بالنوافذ المنبثقة.");
    }
  }, [qrDataUrl, template, targetUrl, branchName, title, subtitle, customNote, sheetCount]);

  // تنزيل رمز QR كصورة PNG عالية الدقة (1000×1000)
  const handleDownloadPng = useCallback(() => {
    if (!targetUrl) return;
    QRCode.toDataURL(targetUrl, {
      margin: 2,
      width: 1024,
      errorCorrectionLevel: "H",
      color: { dark: "#0D3B2E", light: "#FFFFFF" },
    })
      .then((hiResUrl) => {
        const link = document.createElement("a");
        const suffix = branchName ? `-${branchName.replace(/\s+/g, "_")}` : "-general";
        link.download = `shelf-qr-lookup${suffix}.png`;
        link.href = hiResUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        notify.ok("تم تنزيل رمز QR عالي الدقة (1024×1024)");
      })
      .catch(() => notify.err("تعذّر تنزيل الصورة"));
  }, [targetUrl, branchName]);

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="ملصقات QR للرفوف (للهواتف)"
        description="توليد وطباعة ملصقات وبوسترات رمز الاستجابة السريعة (QR) للأرفف والمعارض لتمكين الزبائن من مسح الباركود بهواتفهم ومعرفة الأسعار والعروض فوراً."
      />

      <div className="grid gap-6 lg:grid-cols-12 items-start">
        {/* عمود خيارات التوليد والإعدادات (5 أعمدة) */}
        <div className="space-y-4 lg:col-span-5">
          {/* نطاق الفرع والرابط */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Store aria-hidden className="size-4 text-primary" />
                <span>نطاق الفرع والرابط الذكي</span>
              </CardTitle>
              <CardDescription>
                اختر ما إذا كان الرمز عاماً لجميع الفروع أم مخصصاً لفرع معين.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="branch-select">فرع المعرض</Label>
                <AppSelect
                  id="branch-select"
                  value={selectedBranchId}
                  onValueChange={setSelectedBranchId}
                  className="w-full"
                >
                  <option value="">عام — كل الفروع (موصى به للرفوف العامة)</option>
                  {branches.map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.name}
                    </option>
                  ))}
                </AppSelect>
              </div>

              <div className="space-y-1.5 pt-1">
                <Label>الرابط المشفر في الرمز</Label>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    dir="ltr"
                    value={targetUrl}
                    className="font-mono text-xs bg-muted/40 select-all"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyLink}
                    title="نسخ الرابط"
                    className="shrink-0"
                  >
                    {copied ? (
                      <Check aria-hidden className="size-4 text-[var(--status-active)]" />
                    ) : (
                      <Copy aria-hidden className="size-4" />
                    )}
                  </Button>
                  <a
                    href={targetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center p-2 rounded-md border text-muted-foreground hover:text-foreground shrink-0"
                    title="فتح الرابط لتجربته"
                  >
                    <ExternalLink aria-hidden className="size-4" />
                  </a>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* نوع القالب ومقاس الطباعة */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Layers aria-hidden className="size-4 text-primary" />
                <span>نمط الملصق ومقاس الطباعة</span>
              </CardTitle>
              <CardDescription>اختر المقاس والتصميم المناسب لمكان العرض في المعرض.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                {TEMPLATES.map((t) => (
                  <label
                    key={t.id}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      template === t.id
                        ? "border-primary bg-primary/5 shadow-xs"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <input
                      type="radio"
                      name="template-choice"
                      className="mt-1"
                      checked={template === t.id}
                      onChange={() => setTemplate(t.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm">{t.label}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted font-medium text-muted-foreground shrink-0">
                          {t.sizeHint}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 leading-normal">{t.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              {template === "a4-sheet" && (
                <div className="pt-2 border-t space-y-1.5">
                  <Label htmlFor="sheet-count">عدد الملصقات في الصفحة</Label>
                  <AppSelect
                    id="sheet-count"
                    value={sheetCount}
                    onValueChange={setSheetCount}
                    className="w-full"
                  >
                    <option value="12">12 ملصق (3 أعمدة × 4 صفوف)</option>
                    <option value="18">18 ملصق (3 أعمدة × 6 صفوف)</option>
                    <option value="24">24 ملصق (3 أعمدة × 8 صفوف — قياسي)</option>
                    <option value="36">36 ملصق (4 أعمدة × 9 صفوف)</option>
                  </AppSelect>
                </div>
              )}
            </CardContent>
          </Card>

          {/* تخصيص النصوص */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles aria-hidden className="size-4 text-primary" />
                <span>تخصيص العبارات والنصوص</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="title-input">العنوان الرئيسي</Label>
                <Input
                  id="title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="الرؤية العربية"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sub-input">النص التوجيهي</Label>
                <Input
                  id="sub-input"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="امسح لمعرفة السعر والعروض"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="note-input">تنويه إضافي (اختياري)</Label>
                <Input
                  id="note-input"
                  value={customNote}
                  onChange={(e) => setCustomNote(e.target.value)}
                  placeholder="مثال: خصم 10% عند الشراء بالبطاقة"
                />
              </div>
            </CardContent>
          </Card>

          {/* أزرار الإجراءات والطباعة */}
          <div className="flex flex-col gap-2 pt-2">
            <Button
              size="lg"
              className="w-full inline-flex items-center justify-center gap-2 font-bold shadow-sm"
              onClick={handlePrint}
            >
              <Printer aria-hidden className="size-5" />
              <span>طباعة المستند الآن</span>
            </Button>

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="inline-flex items-center justify-center gap-1.5"
                onClick={handleDownloadPng}
              >
                <Download aria-hidden className="size-4" />
                <span>تنزيل PNG فائق الدقة</span>
              </Button>
              <Button
                variant="outline"
                className="inline-flex items-center justify-center gap-1.5"
                onClick={handleCopyLink}
              >
                {copied ? (
                  <Check aria-hidden className="size-4 text-[var(--status-active)]" />
                ) : (
                  <Copy aria-hidden className="size-4" />
                )}
                <span>نسخ الرابط</span>
              </Button>
            </div>
          </div>
        </div>

        {/* عمود المعاينة الحية والتجربة الفورية (7 أعمدة) */}
        <div className="space-y-4 lg:col-span-7">
          <Card className="border-primary/30 shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Eye aria-hidden className="size-4 text-primary" />
                  <span>معاينة حية للملصق قبل الطباعة</span>
                </CardTitle>
                <CardDescription>
                  المعاينة مطابقة تماماً للمستند المطبوع. يمكنك تجربة مسح الرمز من شاشتك بهاتفك الآن.
                </CardDescription>
              </div>
              <span className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary font-bold">
                {TEMPLATES.find((t) => t.id === template)?.sizeHint}
              </span>
            </CardHeader>

            <CardContent className="flex flex-col items-center justify-center p-6 bg-muted/20 min-h-[460px] border-t">
              {qrDataUrl ? (
                <div className="w-full max-w-md transition-all duration-200">
                  {/* معاينة شريط الرف */}
                  {template === "shelf-strip" && (
                    <div className="bg-[#F0F9F5] border-2 border-[#0D6B52] rounded-md p-3.5 flex items-center gap-3.5 shadow-sm text-right">
                      <div className="bg-white p-1 rounded border border-gray-300 shrink-0 shadow-2xs">
                        <img
                          src={qrDataUrl}
                          alt="QR"
                          className="size-24 block object-contain"
                          draggable={false}
                        />
                      </div>
                      <div className="flex-1 flex flex-col justify-between self-stretch py-0.5">
                        <div className="flex items-center gap-1.5">
                          <Smartphone aria-hidden className="size-3.5 text-[#0D6B52]" />
                          <span className="text-xs font-bold text-[#0D6B52]">
                            {title || "الرؤية العربية"}
                          </span>
                        </div>
                        <div className="text-sm font-extrabold text-gray-900 leading-snug">
                          {subtitle || "امسح لمعرفة السعر"}
                        </div>
                        <div className="flex items-center justify-between gap-1 pt-1 border-t border-[#CFE7DE]">
                          <span className="text-[10px] font-semibold bg-[#0D6B52] text-white px-1.5 py-0.5 rounded">
                            {branchName || "كل الفروع"}
                          </span>
                          <span className="text-[9px] text-gray-500">قارئ الرفوف</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* معاينة شيت A4 */}
                  {template === "a4-sheet" && (
                    <div className="bg-white border rounded-lg p-3 shadow-sm space-y-2 text-right">
                      <div className="text-xs text-muted-foreground pb-1 border-b flex justify-between">
                        <span>نموذج عينة لشيت A4 (مكرر {sheetCount} مرة)</span>
                        <span className="font-semibold text-primary">ورق لاصق مقسم</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {[1, 2].map((i) => (
                          <div
                            key={i}
                            className="bg-[#FCFCFA] border border-dashed border-gray-400 rounded p-2 flex items-center gap-2"
                          >
                            <img src={qrDataUrl} alt="QR" className="size-14 block shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] font-bold text-[#0D6B52] truncate">
                                {title || "الرؤية العربية"}
                              </div>
                              <div className="text-[11px] font-extrabold text-gray-900 truncate">
                                {subtitle || "امسح لمعرفة السعر"}
                              </div>
                              <span className="text-[9px] bg-gray-200 px-1 rounded text-gray-700">
                                {branchName || "عام"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <p className="text-[11px] text-center text-muted-foreground pt-1">
                        ... وباقي الملصقات تمتد تلقائياً بكامل الصفحة بحسب العدد المحدد.
                      </p>
                    </div>
                  )}

                  {/* معاينة ستاند طاولة A5 */}
                  {template === "table-stand" && (
                    <div className="bg-gradient-to-b from-[#F0F9F5] to-white border-2 border-[#0D6B52] rounded-xl p-5 text-center shadow-md space-y-3">
                      <div className="inline-flex items-center gap-1.5 bg-[#CFE7DE] px-3 py-1 rounded-full text-xs font-bold text-[#0D6B52]">
                        <Store aria-hidden className="size-3.5" />
                        <span>{branchName ? `فرع ${branchName}` : "المعرض الذكي"}</span>
                      </div>
                      <div>
                        <h3 className="text-base font-extrabold text-gray-900">{title}</h3>
                        <p className="text-xs text-gray-600 mt-0.5">{subtitle}</p>
                      </div>
                      <div className="inline-block p-2 bg-white rounded-lg border-2 border-[#0D6B52] shadow-sm">
                        <img src={qrDataUrl} alt="QR" className="size-36 block" />
                      </div>
                      <div className="text-xs font-bold text-[#0D6B52]">
                        امسح الرمز بكاميرا هاتفك للبدء
                      </div>
                      <div className="grid grid-cols-3 gap-1 pt-2 border-t text-[10px] text-gray-600">
                        <div className="p-1 bg-gray-50 rounded">1. امسح الرمز</div>
                        <div className="p-1 bg-gray-50 rounded">2. وجّه للباركود</div>
                        <div className="p-1 bg-gray-50 rounded">3. اعرف السعر</div>
                      </div>
                    </div>
                  )}

                  {/* معاينة بوستر A4 */}
                  {template === "poster-a4" && (
                    <div className="bg-gradient-to-b from-[#F0F9F5] to-white border-2 border-[#0D6B52] rounded-xl p-6 text-center shadow-lg space-y-4">
                      <span className="inline-block text-xs font-bold bg-[#CFE7DE] text-[#0D6B52] px-3 py-1 rounded-full">
                        خدمة التسوق الذكي
                      </span>
                      <div>
                        <h2 className="text-lg font-black text-[#0D3B2E]">{title}</h2>
                        <p className="text-xs text-gray-600 max-w-xs mx-auto mt-1">{subtitle}</p>
                      </div>
                      <div className="inline-block p-3 bg-white rounded-xl border border-gray-200 shadow-md">
                        <img src={qrDataUrl} alt="QR" className="size-44 block" />
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-right pt-2 border-t">
                        <div className="p-2 bg-gray-50 rounded border text-center">
                          <span className="font-bold text-xs text-[#0D6B52] block">1. امسح</span>
                          <span className="text-[10px] text-gray-500">افتح الكاميرا</span>
                        </div>
                        <div className="p-2 bg-gray-50 rounded border text-center">
                          <span className="font-bold text-xs text-[#0D6B52] block">2. وجّه</span>
                          <span className="text-[10px] text-gray-500">نحو الباركود</span>
                        </div>
                        <div className="p-2 bg-gray-50 rounded border text-center">
                          <span className="font-bold text-xs text-[#0D6B52] block">3. استعلم</span>
                          <span className="text-[10px] text-gray-500">السعر والعروض</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <QrCode aria-hidden className="size-10 animate-pulse text-primary/40" />
                  <span className="text-xs">جاري تجهيز رمز الاستجابة السريعة...</span>
                </div>
              )}

              {/* بطاقة توجيه مسح الكاميرا */}
              <div className="mt-5 max-w-md w-full bg-background rounded-lg border p-3 flex items-start gap-2.5 text-xs text-muted-foreground">
                <Info aria-hidden className="size-4 text-primary mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <strong className="text-foreground block">اختبار فوري للمسح:</strong>
                  <p>
                    وجّه كاميرا هاتفك المحمول نحو الرمز الظاهر بالمعاينة أعلاه مباشرة للتأكد من سرعة
                    الاستجابة وتوجيهه للفرع المطلوب قبل بدء الطباعة.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

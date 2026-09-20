import { useState, useMemo, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import {
  Printer,
  Eye,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  FileText,
  Package,
  Layers,
  CheckCircle2,
  AlertTriangle,
  MapPin,
  Barcode,
  Building2,
  DollarSign,
  Receipt,
  FileCheck,
} from "lucide-react";
import { buildOnlineOrderThermalDoc } from "@/lib/printing/onlineOrder";
import { docToHtml } from "@/lib/printing/render";
import {
  shippingLabelHtml,
  printShippingLabel,
  type ShippingLabelData,
} from "@/lib/printing/shippingLabel";
import {
  buildShiftOpenHtml,
  printShiftOpenBrowser,
  buildShiftCloseHtml,
  printShiftCloseBrowser,
  buildBrowserReceiptHtml,
  printBrowserReceipt,
  type ShiftOpenData,
  type ShiftCloseData,
  type ReceiptBrowserData,
} from "@/lib/printing/printTemplates";
import { useSearch } from "wouter";
import { openPrintWindow } from "@/lib/printing/brand";

type DocType = "online_order" | "shipping_label" | "shift_open" | "shift_close" | "pos_receipt";

export default function PrintStudio() {
  const searchStr = useSearch();
  const searchDoc = useMemo(() => {
    try {
      const params = new URLSearchParams(searchStr);
      return (params.get("doc") as DocType) || null;
    } catch {
      return null;
    }
  }, [searchStr]);

  const [activeDoc, setActiveDoc] = useState<DocType>(searchDoc || "shipping_label");

  useEffect(() => {
    if (searchDoc && searchDoc !== activeDoc) {
      setActiveDoc(searchDoc);
    }
  }, [searchDoc]);

  const handleTabChange = (val: string) => {
    const nextDoc = val as DocType;
    setActiveDoc(nextDoc);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("doc", nextDoc);
      window.history.replaceState(null, "", url.toString());
    } catch {
      // ignore
    }
  };

  const [isReprint, setIsReprint] = useState<boolean>(false);
  const [isPrepaid, setIsPrepaid] = useState<boolean>(false);
  const [hasLongNotes, setHasLongNotes] = useState<boolean>(false);
  const [hasLocationCoords, setHasLocationCoords] = useState<boolean>(true);
  const [shippingSize, setShippingSize] = useState<"80x120" | "120x80" | "80x50">("80x120");
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [generatedHtml, setGeneratedHtml] = useState<string>("");
  const [isBuilding, setIsBuilding] = useState<boolean>(false);

  // 1. بيانات نموذج طلبية المتجر الإلكتروني
  const sampleOnlineOrder = useMemo(() => {
    return {
      orderNumber: "ORD-2026-8942",
      status: "CONFIRMED",
      createdAt: new Date("2026-09-19T14:30:00"),
      customerName: hasLongNotes
        ? "الأستاذ عبد الرحمن سعد الدين محمد علي الجبوري"
        : "عبد الرحمن سعد الجبوري",
      customerPhone: "07701234567",
      governorate: "بغداد - الكرخ",
      addressText: hasLongNotes
        ? "حي الجامعة - محلة 629 - زقاق 14 - دار 22 / قرب جامع الملا حويش، العمارة البيضاء مقابل صيدلية النور"
        : "حي الجامعة - شارع الربيع - قرب تقاطع الكندي",
      notes: hasLongNotes
        ? "يرجى الاتصال قبل الوصول بنصف ساعة، الطرد يحتوي على مواد قرطاسية وهدايا حساسة لا تقبل الكسر أو الضغط الزائد."
        : "التسليم في الفترة المسائية حصراً",
      latitude: hasLocationCoords ? "33.3218" : null,
      longitude: hasLocationCoords ? "44.3312" : null,
      subtotal: "48500",
      deliveryFee: "5000",
      discount: "3500",
      total: isPrepaid ? "0" : "50000",
      items: [
        {
          productName: "دفتر جامعي سلك فاخر A4 غلاف مقوى كلاسيك 200 ورقة مسطر",
          variantLabel: "أزرق كلاسيكي",
          imageUrl: null,
          unitName: "دفتر",
          quantity: "3",
          unitPrice: "4500",
          total: "13500",
        },
        {
          productName: "طقم أقلام حبر جاف ياباني يوني بول 0.7 مم (أسود، أزرق، أحمر)",
          variantLabel: "عبوة مكتبية",
          imageUrl: null,
          unitName: "علبة",
          quantity: "2",
          unitPrice: "7500",
          total: "15000",
        },
        {
          productName: "آلة حاسبة علمية كاسيو الأصلية fx-991ARX ثنائية اللغة",
          variantLabel: "إصدار الشرق الأوسط",
          imageUrl: null,
          unitName: "قطعة",
          quantity: "1",
          unitPrice: "20000",
          total: "20000",
        },
      ],
      isReprint,
      reprintedBy: isReprint ? "أحمد المشرف" : undefined,
      reprintedAt: isReprint ? new Date() : undefined,
    };
  }, [isReprint, isPrepaid, hasLongNotes, hasLocationCoords]);

  // 2. بيانات نموذج بوليصة الشحن
  const sampleShippingLabel: ShippingLabelData = useMemo(() => {
    return {
      orderNumber: "ORD-2026-8942",
      barcodeValue: "ORD-2026-8942",
      customerName: hasLongNotes
        ? "الأستاذ عبد الرحمن سعد الدين محمد علي الجبوري"
        : "عبد الرحمن سعد الجبوري",
      customerPhone: "07701234567",
      governorate: "بغداد",
      addressText: hasLongNotes
        ? "حي الجامعة - محلة 629 - زقاق 14 - دار 22 / قرب جامع الملا حويش، العمارة البيضاء مقابل صيدلية النور"
        : "حي الجامعة - شارع الربيع - قرب تقاطع الكندي",
      latitude: hasLocationCoords ? "33.3218" : null,
      longitude: hasLocationCoords ? "44.3312" : null,
      notes: hasLongNotes
        ? "يرجى الاتصال قبل الوصول بنصف ساعة. الطرد يحتوي هدايا حساسة."
        : "التسليم مساءً",
      total: isPrepaid ? "0" : "50000",
      paymentState: isPrepaid ? "PREPAID" : "COD",
      deliveryPartyName: "شركة اليمامة إكسبريس للتوصيل السريع",
      externalTrackingRef: "TRK-9982410",
      createdAt: new Date("2026-09-19T14:30:00"),
      items: [
        {
          productName: "دفتر جامعي سلك فاخر A4 (200 ورقة)",
          unitName: "دفتر",
          quantity: "3",
        },
        {
          productName: "طقم أقلام حبر جاف ياباني يوني بول 0.7 مم",
          unitName: "علبة",
          quantity: "2",
        },
        {
          productName: "آلة حاسبة علمية كاسيو الأصلية fx-991ARX",
          unitName: "قطعة",
          quantity: "1",
        },
      ],
      isReprint,
      reprintedBy: isReprint ? "مسؤول المستودع" : undefined,
      reprintedAt: isReprint ? new Date() : undefined,
    };
  }, [isReprint, isPrepaid, hasLongNotes, hasLocationCoords]);

  // 3. بيانات نموذج فتح الوردية
  const sampleShiftOpen: ShiftOpenData = useMemo(() => {
    return {
      shiftId: 1048,
      openingBalance: 250000,
      cashierName: "حسين علي محمد",
      branchName: "فرع العامرية الرئيسي",
      openedAt: new Date("2026-09-19T08:00:00"),
      departmentName: "قسم الكاشير والتجزئة",
    };
  }, []);

  // 4. بيانات نموذج إغلاق الوردية Z-Report
  const sampleShiftClose: ShiftCloseData = useMemo(() => {
    return {
      shiftId: 1048,
      openedAt: new Date("2026-09-19T08:00:00"),
      closedAt: new Date("2026-09-19T16:00:00"),
      cashierName: "حسين علي محمد",
      branchName: "فرع العامرية الرئيسي",
      departmentName: "قسم الكاشير والتجزئة",
      openingBalance: "250000",
      invoiceCount: 42,
      salesTotal: "1285000",
      discountsTotal: "15000",
      returnsTotal: "25000",
      payments: [
        { method: "CASH", direction: "IN", count: 35, total: "985000" },
        { method: "CARD", direction: "IN", count: 7, total: "300000" },
      ],
      expectedCash: "1210000",
      countedCash: "1210000",
      variance: "0",
      treasuryReturn: {
        amount: "960000",
        referenceNumber: "TR-2026-0919-01",
      },
    };
  }, []);

  // 5. بيانات نموذج إيصال التجزئة POS
  const samplePosReceipt: ReceiptBrowserData = useMemo(() => {
    return {
      receiptNumber: "REC-2026-00489",
      date: "2026-09-19",
      time: "11:15",
      cashierName: "حسين علي محمد",
      customerName: hasLongNotes ? "الأستاذ عبد الرحمن سعد الدين" : undefined,
      items: [
        {
          name: "قلم حبر باركر فيكتور أصلي أزرق معدني",
          quantity: 1,
          price: 25000,
          total: 25000,
        },
        {
          name: "مفكرة جلدية فاخرة A5 مؤرخة 2026",
          quantity: 1,
          price: 15000,
          total: 15000,
        },
        {
          name: "علبة أقلام تمييز زيبرا مايلدلاينر 5 ألوان",
          quantity: 1,
          price: 12000,
          total: 12000,
        },
      ],
      subtotal: 52000,
      discount: 2000,
      total: 50000,
      paymentMethod: isPrepaid ? "بطاقة دفع إلكتروني (كي كارد)" : "CASH",
      paid: 50000,
      change: 0,
      shiftId: 1048,
    };
  }, [hasLongNotes, isPrepaid]);

  // بناء كود HTML الفعلي للمستند بناءً على النوع المختار
  useEffect(() => {
    let active = true;
    setIsBuilding(true);

    const generate = async () => {
      try {
        let html = "";
        if (activeDoc === "online_order") {
          const doc = buildOnlineOrderThermalDoc(sampleOnlineOrder);
          html = await docToHtml(doc);
        } else if (activeDoc === "shipping_label") {
          const size =
            shippingSize === "80x120"
              ? { widthMm: 80, heightMm: 120, name: "٨٠×١٢٠مم (طولي قياسي)" }
              : shippingSize === "120x80"
                ? { widthMm: 120, heightMm: 80, name: "١٢٠×٨٠مم (عرضي)" }
                : { widthMm: 80, heightMm: 50, name: "٨٠×٥٠مم (مضغوط)" };
          html = await shippingLabelHtml(sampleShippingLabel, size);
        } else if (activeDoc === "shift_open") {
          html = buildShiftOpenHtml(sampleShiftOpen);
        } else if (activeDoc === "shift_close") {
          html = buildShiftCloseHtml(sampleShiftClose);
        } else if (activeDoc === "pos_receipt") {
          html = buildBrowserReceiptHtml(samplePosReceipt);
        }

        if (active) {
          setGeneratedHtml(html);
          setIsBuilding(false);
        }
      } catch (err) {
        if (active) {
          setIsBuilding(false);
        }
      }
    };

    void generate();
    return () => {
      active = false;
    };
  }, [
    activeDoc,
    shippingSize,
    sampleOnlineOrder,
    sampleShippingLabel,
    sampleShiftOpen,
    sampleShiftClose,
    samplePosReceipt,
  ]);

  // دالة الطباعة التجريبية
  const handlePrint = async () => {
    if (activeDoc === "online_order") {
      const doc = buildOnlineOrderThermalDoc(sampleOnlineOrder);
      const html = await docToHtml(doc);
      openPrintWindow(html, "width=420,height=750");
    } else if (activeDoc === "shipping_label") {
      const size =
        shippingSize === "80x120"
          ? { widthMm: 80, heightMm: 120 }
          : shippingSize === "120x80"
            ? { widthMm: 120, heightMm: 80 }
            : { widthMm: 80, heightMm: 50 };
      await printShippingLabel(sampleShippingLabel, { size });
    } else if (activeDoc === "shift_open") {
      printShiftOpenBrowser(sampleShiftOpen);
    } else if (activeDoc === "shift_close") {
      printShiftCloseBrowser(sampleShiftClose);
    } else if (activeDoc === "pos_receipt") {
      printBrowserReceipt(samplePosReceipt);
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <PageHeader
        title="استوديو المطبوعات والهوية البصرية"
        description="معاينة وفحص كافة مطبوعات النظام (حرارية 80مم، بوالص شحن 80×120مم، تقارير الورديات) بدقة 100% بتصميم أحادي اللون أسود وأبيض عالي التباين، جداول كاملة الحدود، باركود وكيو آر وتفقيط مالي."
        actions={
          <div className="flex items-center gap-2">
            {/* تحكم الزوم */}
            <div className="flex items-center border rounded-lg p-1 bg-background shadow-xs">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => setZoomLevel((z) => Math.max(z - 10, 50))}
                title="تصغير المعاينة"
              >
                <ZoomOut className="size-3.5" />
              </Button>
              <span className="text-xs font-mono px-2 min-w-[42px] text-center font-bold">
                {zoomLevel}%
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => setZoomLevel((z) => Math.min(z + 10, 150))}
                title="تكبير المعاينة"
              >
                <ZoomIn className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground"
                onClick={() => setZoomLevel(100)}
                title="إعادة ضبط الحجم الطبيعي 100%"
              >
                <RotateCcw className="size-3" />
              </Button>
            </div>

            <Button onClick={handlePrint} className="gap-2 font-bold shadow-md">
              <Printer className="size-4" />
              طباعة تجريبية الآن
            </Button>
          </div>
        }
      />

      {/* شريط اختيار المستند المطلوب فحصه */}
      <Tabs
        value={activeDoc}
        onValueChange={handleTabChange}
        className="w-full"
      >
        <TabsList className="grid grid-cols-2 md:grid-cols-5 w-full h-auto p-1.5 gap-1.5 bg-muted/60">
          <TabsTrigger value="pos_receipt" className="gap-2 py-2 text-xs font-bold">
            <Receipt className="size-4" />
            إيصال التجزئة POS
          </TabsTrigger>
          <TabsTrigger value="shift_close" className="gap-2 py-2 text-xs font-bold">
            <FileText className="size-4" />
            Z-Report إغلاق الوردية
          </TabsTrigger>
          <TabsTrigger value="shift_open" className="gap-2 py-2 text-xs font-bold">
            <DollarSign className="size-4" />
            فتح الوردية (80مم)
          </TabsTrigger>
          <TabsTrigger value="shipping_label" className="gap-2 py-2 text-xs font-bold">
            <Barcode className="size-4" />
            بوليصة الشحن (80×120)
          </TabsTrigger>
          <TabsTrigger value="online_order" className="gap-2 py-2 text-xs font-bold">
            <Package className="size-4" />
            طلبية المتجر (80مم)
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* منطقة المعاينة ولوحة السيناريوهات */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* لوحة تحكم سيناريوهات الفحص الميداني */}
        <div className="lg:col-span-4 space-y-4">
          <Card className="border-border/80 shadow-xs">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Layers className="size-4 text-primary" />
                سيناريوهات الاختبار الميداني
              </CardTitle>
              <CardDescription className="text-xs">
                تغيير المعطيات لاختبار الجداول، التفقيط، حالات الدفع، وتدقيق إعادة الطباعة
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 pt-0 text-xs">
              {/* تبديل حالة الأصل / إعادة الطباعة */}
              <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/30">
                <div>
                  <div className="font-semibold text-foreground">حالة المستند (Audit)</div>
                  <div className="text-[11px] text-muted-foreground">
                    {isReprint ? "إعادة استخراج رسمية مع ختم التدقيق" : "نسخة أصلية أولى"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={isReprint ? "default" : "outline"}
                  onClick={() => setIsReprint((v) => !v)}
                  className="h-7 text-xs px-2.5"
                >
                  {isReprint ? "إعادة طباعة" : "أصلي"}
                </Button>
              </div>

              {/* طريقة الدفع: نقدي COD مقابل مدفوع مسبقاً */}
              <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/30">
                <div>
                  <div className="font-semibold text-foreground">طريقة الدفع</div>
                  <div className="text-[11px] text-muted-foreground">
                    {isPrepaid ? "مدفوع مسبقاً (إلغاء التحصيل)" : "دفع عند الاستلام (COD 50,000 د.ع)"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={isPrepaid ? "secondary" : "default"}
                  onClick={() => setIsPrepaid((v) => !v)}
                  className="h-7 text-xs px-2.5"
                >
                  {isPrepaid ? "مدفوع" : "دفع عند الاستلام"}
                </Button>
              </div>

              {/* قياس ورقة ملصق الشحن */}
              {activeDoc === "shipping_label" && (
                <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/30">
                  <div>
                    <div className="font-semibold text-foreground">مقاس ورقة الملصق</div>
                    <div className="text-[11px] text-muted-foreground">
                      {shippingSize === "80x120"
                        ? "80×120مم (طولي قياسي لطابعات الطرود)"
                        : shippingSize === "120x80"
                          ? "120×80مم (عرضي)"
                          : "80×50مم (مضغوط)"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant={shippingSize === "80x120" ? "default" : "outline"}
                      onClick={() => setShippingSize("80x120")}
                      className="h-7 text-xs px-1.5"
                    >
                      80×120
                    </Button>
                    <Button
                      size="sm"
                      variant={shippingSize === "120x80" ? "default" : "outline"}
                      onClick={() => setShippingSize("120x80")}
                      className="h-7 text-xs px-1.5"
                    >
                      120×80
                    </Button>
                    <Button
                      size="sm"
                      variant={shippingSize === "80x50" ? "default" : "outline"}
                      onClick={() => setShippingSize("80x50")}
                      className="h-7 text-xs px-1.5"
                    >
                      80×50
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* بطاقة المواصفات القياسية والمعايير المطبقة */}
          <Card className="border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-bold flex items-center gap-1.5 text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-primary" />
                المعايير المعتمدة في المطبوعات
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground pt-0">
              <div className="flex items-start gap-2">
                <div className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                <div>
                  <strong className="text-foreground">طباعة أحادية اللون (Black & White):</strong> تباين فائق 100% بدون تدرجات رمادية أو ألوان مشوشة لضمان أقصى وضوح على الرؤوس الحرارية.
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                <div>
                  <strong className="text-foreground">جداول واضحة الحدود والفواصل:</strong> تنظيم البيانات داخل خلايا بحدود صريحة (1px - 2px) تمنع التشتت وتفصل الأعمدة والصفوف بدقة.
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                <div>
                  <strong className="text-foreground">تكامل الباركود والكيو آر:</strong> باركود Code 128 لقراءة المسدس الليزري، ورمز QR للملاحة عبر خرائط Google.
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                <div>
                  <strong className="text-foreground">تفقيط المبالغ بالدينار العراقي:</strong> تحويل الأرقام إلى كلمات عربية رسمية لضمان عدم التلاعب وإحكام المطابقة المالية.
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                <div>
                  <strong className="text-foreground">قائمة فحص الأصناف والتجهيز:</strong> مربعات تدقيق [ ] لموظف التجهيز والمندوب لمنع أخطاء الشحن.
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* مساحة المعاينة الحية */}
        <div className="lg:col-span-8 flex flex-col items-center">
          <div className="w-full mb-3 flex items-center justify-between text-xs text-muted-foreground px-2">
            <span className="flex items-center gap-1.5 font-medium">
              <Eye className="size-4 text-primary" />
              معاينة مطابقة تماماً للمخرجات الفعلية (Scale: {zoomLevel}%)
            </span>
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="text-[11px] font-mono">
                {activeDoc === "shipping_label"
                  ? shippingSize === "80x120"
                    ? "80mm × 120mm Label (Portrait)"
                    : shippingSize === "120x80"
                      ? "120mm × 80mm Label (Landscape)"
                      : "80mm × 50mm Label (Compact)"
                  : "80mm Thermal Receipt (72mm Print Area)"}
              </Badge>
              {isBuilding && <span className="text-primary font-semibold">{L.refreshing}</span>}
            </div>
          </div>

          {/* محاكاة الورق الحراري وظلال سطح المكتب */}
          <div
            className="w-full flex justify-center overflow-x-auto p-6 bg-muted/40 rounded-xl border border-dashed border-border/80 min-h-[620px]"
            style={{
              direction: "ltr",
            }}
          >
            <div
              style={{
                transform: `scale(${zoomLevel / 100})`,
                transformOrigin: "top center",
                transition: "transform 0.15s ease-out",
                width:
                  activeDoc === "shipping_label"
                    ? shippingSize === "120x80"
                      ? "460px"
                      : "320px"
                    : "320px",
              }}
              className="bg-white text-black shadow-2xl rounded-sm border border-neutral-400 relative overflow-hidden"
            >
              {/* إطار محاكاة أعلى ورقة الإيصال */}
              <div className="h-1.5 bg-neutral-900 w-full" />

              {/* الـ iframe الذي يحوي كود HTML الحقيقي المعزول تماماً */}
              <iframe
                title="Print Document Live Preview"
                srcDoc={generatedHtml}
                className="w-full border-0 block"
                style={{
                  height:
                    activeDoc === "shipping_label"
                      ? shippingSize === "80x120"
                        ? "480px"
                        : shippingSize === "120x80"
                          ? "310px"
                          : "205px"
                      : "840px",
                  backgroundColor: "#ffffff",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

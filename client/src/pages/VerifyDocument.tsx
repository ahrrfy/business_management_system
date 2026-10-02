import { useState } from "react";
import { useRoute, useSearch, useLocation } from "wouter";
import {
  CheckCircle2,
  ShieldCheck,
  AlertTriangle,
  FileText,
  Calendar,
  DollarSign,
  Building2,
  QrCode,
  Tag,
  Search,
  User,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmt, D } from "@/lib/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ACTION_LABELS } from "@shared/actionLabels";
import { docTypeLabel } from "@shared/barcodeTypes";
import { invoiceStatusBadgeVariant, invoiceStatusLabel } from "@shared/invoiceStatus";
import { orderStatusBadgeVariant, orderStatusLabel } from "@shared/onlineOrderStatus";
import { workOrderStatusLabel } from "@shared/workOrderStatus";

function getDocumentStatusBadge(docType?: string, status?: string | null) {
  if (!status) return null;

  if (docType === "INV") {
    return {
      label: invoiceStatusLabel(status),
      variant: invoiceStatusBadgeVariant(status),
    };
  }

  if (docType === "ORD") {
    return {
      label: orderStatusLabel(status),
      variant: orderStatusBadgeVariant(status),
    };
  }

  if (docType === "WO") {
    const isCompleted = status === "READY" || status === "DELIVERED";
    return {
      label: workOrderStatusLabel(status),
      variant: isCompleted ? ("success" as const) : ("secondary" as const),
    };
  }

  return {
    label: status,
    variant: "outline" as const,
  };
}

export default function VerifyDocument(props?: { params?: { id?: string } }) {
  const [match, routeParams] = useRoute("/verify/:id");
  const searchStr = useSearch();
  const searchParams = new URLSearchParams(searchStr);
  const [, setLocation] = useLocation();

  // 1. استخراج المعرّف من مسار wouter أولاً ثم معلمات الاستعلام الشائعة (?ref=, ?id=, ?payload=, ?p=, ?number=)
  const rawInput = (
    props?.params?.id ||
    (match && routeParams?.id ? routeParams.id : "") ||
    searchParams.get("ref") ||
    searchParams.get("id") ||
    searchParams.get("payload") ||
    searchParams.get("p") ||
    searchParams.get("number") ||
    ""
  ).trim();

  // 2. معالجة وتفكيك الرابط في حال قام الماسح بتمرير URL كامل بدلاً من المعرّف
  let docIdentifier = rawInput;
  if (docIdentifier.startsWith("http://") || docIdentifier.startsWith("https://")) {
    try {
      const u = new URL(docIdentifier);
      const qVal =
        u.searchParams.get("ref") ||
        u.searchParams.get("id") ||
        u.searchParams.get("payload") ||
        u.searchParams.get("p") ||
        u.searchParams.get("number");

      if (qVal) {
        docIdentifier = qVal.trim();
      } else {
        const segments = u.pathname.split("/").filter(Boolean);
        const verifyIdx = segments.indexOf("verify");
        if (verifyIdx !== -1 && segments[verifyIdx + 1]) {
          docIdentifier = segments[verifyIdx + 1].trim();
        }
      }
    } catch {
      // إبقاء القيمة كما هي عند تعذر التحليل
    }
  }

  if (docIdentifier.includes("%")) {
    try {
      docIdentifier = decodeURIComponent(docIdentifier).trim();
    } catch {
      // إبقاء القيمة كما هي
    }
  }

  const [manualCode, setManualCode] = useState("");

  const handleManualSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = manualCode.trim();
    if (!clean) return;
    setLocation(`/verify/${encodeURIComponent(clean)}`);
  };

  // 3. استدعاء tRPC للتحقق العام
  const q = trpc.barcode.verify.useQuery(
    { payload: docIdentifier },
    { enabled: docIdentifier.length > 0 },
  );

  const statusBadge = q.data?.valid ? getDocumentStatusBadge(q.data.docType, q.data.status) : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 p-4 md:p-8" dir="rtl">
      <div className="mx-auto max-w-md space-y-6 pt-6">
        {/* ترويسة النظام */}
        <div className="text-center space-y-2">
          <div className="inline-flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-2 shadow-sm">
            <ShieldCheck className="size-8" />
          </div>
          <h2 className="text-xl font-black">نظام الرؤية العربية</h2>
          <p className="text-xs text-muted-foreground">بوابة التحقق الرقمي من أصالة المستندات والفواتير</p>
        </div>

        {!docIdentifier ? (
          /* حالة 1: لا يوجد رمز أو معرّف مدخل */
          <Card className="text-center border-border/60 shadow-sm">
            <CardContent className="space-y-4 pt-6">
              <QrCode className="mx-auto size-12 text-muted-foreground opacity-60" />
              <div className="space-y-1">
                <h3 className="text-sm font-bold">لا يوجد رمز تحقق</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  يرجى مسح رمز QR المطبوع على الفاتورة أو الإيصال بكاميرا الهاتف للتحقق من أصالته مباشرة، أو كتابة رقم المستند أدناه.
                </p>
              </div>

              {/* نموذج إدخال يدوي للتحقق المباشر */}
              <form onSubmit={handleManualSearch} className="flex gap-2 pt-2">
                <input
                  type="text"
                  placeholder="مثال: ORD-100009 أو INV-..."
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  className="flex-1 px-3 py-2 text-xs rounded-lg border bg-background font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                  dir="ltr"
                />
                <button
                  type="submit"
                  disabled={!manualCode.trim()}
                  className="px-4 py-2 text-xs font-bold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                >
                  <Search className="size-3.5" />
                  <span>تحقق</span>
                </button>
              </form>
            </CardContent>
          </Card>
        ) : q.isLoading ? (
          /* حالة 2: جارٍ التحقق من المستند والسجلات */
          <Card className="text-center border-border/60 shadow-sm">
            <CardContent className="space-y-3 py-8">
              <div className="mx-auto size-9 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <div className="space-y-1">
                <p className="text-sm font-bold text-foreground">{ACTION_LABELS.verifying}</p>
                <p className="text-xs text-muted-foreground">جارٍ مطابقة التوقيع الرقمي والسجلات المركزية…</p>
              </div>
            </CardContent>
          </Card>
        ) : q.data?.valid ? (
          /* حالة 3: المستند أصيل ومعتمد بنجاح */
          <Card className="border-[var(--sem-pos)]/30 shadow-lg relative overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-1.5 bg-[var(--sem-pos)]" />
            <CardContent className="space-y-5 pt-6">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-full bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] flex items-center justify-center shrink-0">
                  <CheckCircle2 className="size-6" />
                </div>
                <div>
                  <h2 className="text-base font-extrabold text-[var(--sem-pos)]">وثيقة أصلية ومعتمدة</h2>
                  <p className="text-xs text-muted-foreground">تم التحقق من صحة المستند وسجلاته بنجاح</p>
                </div>
              </div>

              <div className="divide-y divide-border/60 rounded-xl border bg-muted/20 p-3 text-sm space-y-2.5">
                {/* نوع المستند */}
                <div className="flex items-center justify-between pt-1">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FileText className="size-3.5" /> نوع المستند
                  </span>
                  <span className="font-bold">
                    {docTypeLabel(q.data.docType)}
                  </span>
                </div>

                {/* رقم المستند */}
                <div className="flex items-center justify-between pt-2">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Tag className="size-3.5" /> رقم المستند
                  </span>
                  <span className="font-mono font-bold" dir="ltr">
                    {q.data.number}
                  </span>
                </div>

                {/* تاريخ الإصدار */}
                {q.data.date && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Calendar className="size-3.5" /> تاريخ الإصدار
                    </span>
                    <span className="font-mono text-xs" dir="ltr">
                      {q.data.date}
                    </span>
                  </div>
                )}

                {/* المبلغ الإجمالي بالدينار العراقي */}
                {q.data.amount && D(q.data.amount).greaterThan(0) && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <DollarSign className="size-3.5" /> المبلغ الإجمالي
                    </span>
                    <span className="font-bold text-primary font-mono" dir="ltr">
                      {fmt(q.data.amount)} د.ع
                    </span>
                  </div>
                )}

                {/* الفرع المُصدِر */}
                {q.data.branchId != null && q.data.branchId > 0 && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Building2 className="size-3.5" /> الفرع المُصدِر
                    </span>
                    <span className="text-xs font-medium">فرع #{q.data.branchId}</span>
                  </div>
                )}

                {/* حالة المستند */}
                {statusBadge && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <ShieldCheck className="size-3.5" /> حالة المستند
                    </span>
                    <Badge variant={statusBadge.variant}>
                      {statusBadge.label}
                    </Badge>
                  </div>
                )}

                {/* اسم العميل / المستلم إن وُجد */}
                {q.data.customerName && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <User className="size-3.5" /> العميل / المستلم
                    </span>
                    <span className="text-xs font-medium">{q.data.customerName}</span>
                  </div>
                )}
              </div>

              {/* شريط الضمان والتأكيد */}
              <div className="rounded-lg bg-[var(--sem-pos-bg)]/60 border border-[var(--sem-pos)]/20 p-2.5 text-center text-[11px] text-[var(--sem-pos)] font-medium leading-relaxed">
                هذه الوثيقة صادرة رسمياً من نظام الرؤية العربية وسجلاتها الإلكترونية مطابقة للنظام المركزي.
              </div>
            </CardContent>
          </Card>
        ) : (
          /* حالة 4: فشل التحقق من صحة المستند (Verbatim: فشل التحقق من صحة الوثيقة) */
          <Card className="border-destructive/30 shadow-lg text-center">
            <CardContent className="space-y-4 pt-6">
              <div className="mx-auto size-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
                <AlertTriangle className="size-7" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-extrabold text-destructive">فشل التحقق من صحة الوثيقة</h2>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  رمز التحقق غير صالح أو قد يكون قد تم التلاعب ببيانات المستند أو أن الرقم غير مسجل في النظام.
                </p>
              </div>
              <div className="rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground font-mono break-all" dir="ltr">
                {docIdentifier.length > 80 ? docIdentifier.slice(0, 80) + "…" : docIdentifier}
              </div>

              {/* إمكانية البحث عن مستند آخر */}
              <form onSubmit={handleManualSearch} className="flex gap-2 pt-2">
                <input
                  type="text"
                  placeholder="جرب رقماً آخر (مثال: ORD-100009)..."
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  className="flex-1 px-3 py-2 text-xs rounded-lg border bg-background font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                  dir="ltr"
                />
                <button
                  type="submit"
                  disabled={!manualCode.trim()}
                  className="px-4 py-2 text-xs font-bold rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                >
                  <Search className="size-3.5" />
                  <span>فحص</span>
                </button>
              </form>
            </CardContent>
          </Card>
        )}

        <div className="text-center text-[11px] text-muted-foreground">
          جميع الحقوق محفوظة © {new Date().getFullYear()} — نظام إدارة أعمال الرؤية العربية
        </div>
      </div>
    </div>
  );
}

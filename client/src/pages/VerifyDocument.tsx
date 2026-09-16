import { useSearch } from "wouter";
import { CheckCircle2, ShieldCheck, AlertTriangle, FileText, Calendar, DollarSign, Building2, QrCode } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmt } from "@/lib/money";
import { Card, CardContent } from "@/components/ui/card";

const DOC_TYPE_AR: Record<string, string> = {
  INV: "فاتورة مبيعات",
  WO: "أمر شغل / طلب خدمة",
  PO: "أمر شراء",
  CUST: "ملف عميل",
};

export default function VerifyDocument() {
  const searchStr = useSearch();
  const params = new URLSearchParams(searchStr);
  const payload = (params.get("payload") || params.get("p") || "").trim();

  const q = trpc.barcode.verify.useQuery(
    { payload },
    { enabled: payload.length > 0 },
  );

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

        {!payload ? (
          <Card className="text-center">
            <CardContent className="space-y-3 pt-6">
              <QrCode className="mx-auto size-12 text-muted-foreground opacity-60" />
              <h2 className="text-sm font-bold">لا يوجد رمز تحقق</h2>
              <p className="text-xs text-muted-foreground leading-relaxed">
                يرجى مسح رمز QR المطبوع على الفاتورة أو الإيصال بكاميرا الهاتف للتحقق من أصالته مباشرة.
              </p>
            </CardContent>
          </Card>
        ) : q.isLoading ? (
          <Card className="text-center">
            <CardContent className="space-y-3 py-8">
              <div className="mx-auto size-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-sm font-bold text-muted-foreground">جارٍ التحقق من التوقيع الرقمي للمستند…</p>
            </CardContent>
          </Card>
        ) : q.data?.valid ? (
          <Card className="border-[var(--sem-pos)]/30 shadow-lg relative overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-1.5 bg-[var(--sem-pos)]" />
            <CardContent className="space-y-5 pt-6">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-full bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] flex items-center justify-center shrink-0">
                  <CheckCircle2 className="size-6" />
                </div>
                <div>
                  <h2 className="text-base font-extrabold text-[var(--sem-pos)]">وثيقة أصلية ومعتمدة</h2>
                  <p className="text-xs text-muted-foreground">تم التحقق من التوقيع الرقمي المشفر بنجاح</p>
                </div>
              </div>

            <div className="divide-y divide-border/60 rounded-xl border bg-muted/20 p-3 text-sm space-y-2.5">
              <div className="flex items-center justify-between pt-1">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="size-3.5" /> نوع المستند
                </span>
                <span className="font-bold">
                  {DOC_TYPE_AR[q.data.docType ?? ""] ?? q.data.docType ?? "مستند نظام"}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="size-3.5" /> رقم المستند
                </span>
                <span className="font-mono font-bold" dir="ltr">
                  {q.data.number}
                </span>
              </div>

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

              {q.data.amount && Number(q.data.amount) > 0 && (
                <div className="flex items-center justify-between pt-2">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <DollarSign className="size-3.5" /> المبلغ الإجمالي
                  </span>
                  <span className="font-bold text-primary font-mono" dir="ltr">
                    {fmt(q.data.amount)} د.ع
                  </span>
                </div>
              )}

              {q.data.branchId != null && q.data.branchId > 0 && (
                <div className="flex items-center justify-between pt-2">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Building2 className="size-3.5" /> الفرع المُصدِر
                  </span>
                  <span className="text-xs font-medium">فرع #{q.data.branchId}</span>
                </div>
              )}
            </div>

            <div className="rounded-lg bg-[var(--sem-pos-bg)]/60 border border-[var(--sem-pos)]/20 p-2.5 text-center text-[11px] text-[var(--sem-pos)] font-medium">
              هذه الوثيقة صادرة رسمياً من نظام الرؤية العربية وتوقيعها الإلكتروني سليم وغير قابل للتزوير.
            </div>
          </CardContent>
        </Card>
        ) : (
          <Card className="border-destructive/30 shadow-lg text-center">
            <CardContent className="space-y-4 pt-6">
              <div className="mx-auto size-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
                <AlertTriangle className="size-7" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-extrabold text-destructive">فشل التحقق من صحة الوثيقة</h2>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  رمز التحقق غير صالح أو قد يكون قد تم التلاعب ببيانات المستند أو أن الرابط غير مكتمل.
                </p>
              </div>
              <div className="rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground font-mono break-all" dir="ltr">
                {payload.length > 50 ? payload.slice(0, 50) + "…" : payload}
              </div>
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

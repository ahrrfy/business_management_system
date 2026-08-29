/**
 * CommissionComparisonReport — تقرير مقارنة العمولة (Slice K، ٢٩/٨/٢٦).
 *
 * الغرض: مساعدة المالك على اتّخاذ قرار تفعيل H2 لكلّ جهةٍ ماكنة. Slice H يخزّن العمولة
 * التقديريّة على كلّ توريد؛ هذه الشاشة تجمعها بالمقارنة مع الأجرة الفعليّة المدفوعة.
 *
 * الأعمدة:
 *  - الجهة (+ شارة «مُفعَّل» إن كان H2 مُشغَّلاً عليها)
 *  - عدد التوريدات (النافذة الزمنيّة)
 *  - إجمالي الأجرة (المدفوع فعلاً)
 *  - إجمالي العمولة (لو فُعِّل H2)
 *  - الفرق (وفر متوقَّع للمكتبة عند التفعيل)
 *
 * ⚠️ الفرق تقديريّ لا محقَّق: يعتمد على القاعدة الحاليّة، وتغييرُها يُغيّره أثراً رجعياً.
 */
import { useState } from "react";
import { Banknote, Info, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS as L } from "@shared/actionLabels";

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function CommissionComparisonReport() {
  const [fromDate, setFromDate] = useState(daysAgo(30));
  const [toDate, setToDate] = useState(today());
  const q = trpc.delivery.commissionComparison.useQuery({ fromDate, toDate });

  const rows = q.data ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      fees: acc.fees + Number(r.feesTotal),
      commission: acc.commission + Number(r.commissionTotal),
      delta: acc.delta + Number(r.delta),
      // Codex P2 #8 (٢٩/٨): العدّاد صار إرساليّات متمايزة لا سطور توريد ⇒ رقمٌ صادقٌ لعدد الطرود.
      count: acc.count + r.consignmentCount,
    }),
    { fees: 0, commission: 0, delta: 0, count: 0 },
  );

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="مقارنة الأجرة والعمولة"
        description="مقارنةُ ما دُفع فعلاً بأجرة التوصيل لكلّ جهة، مقابل ما كان سيُدفع لو فُعِّل H2 (استبدال الأجرة بالعمولة). الفرقُ الموجب = وفرٌ متوقَّع للمكتبة عند التفعيل."
        icon={<TrendingUp className="size-5" aria-hidden />}
      />

      <div className="rounded-lg border bg-[var(--sem-info-bg)] p-3 text-xs text-[var(--sem-info)]">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-bold">كيف يُحسَب هذا التقرير:</p>
            <p>
              الأجرةُ المدفوعة تُقرأ من كل إرسالية مُسلَّمة في النافذة (بلا احتساب تكرار توريدٍ جزئيّ).
              العمولة تُحسَب بتطبيق <b>قاعدة الجهة الحاليّة</b> على أجرةِ كل إرسالية — بنفس معاملات H2
              في التسوية الفعليّة. تعديلُ القاعدة يُغيّر النتيجة لكلّ الإرساليّات السابقة والحاليّة في
              هذا التقرير (الحساب فوريّ لا لقطاتٍ تاريخيّة). الجهاتُ بلا قاعدةٍ فعّالة لا تظهر.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="from-date" className="text-xs">من تاريخ</Label>
            <Input id="from-date" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} dir="ltr" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to-date" className="text-xs">إلى تاريخ</Label>
            <Input id="to-date" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} dir="ltr" />
          </div>
        </div>
      </div>

      {q.isError ? (
        // Codex P2 #3 (٢٩/٨): تمييز الفشل (403/شبكة/قاعدة) عن نافذةٍ فارغة فعلاً.
        <ErrorState
          onRetry={() => void q.refetch()}
          message={q.error instanceof Error ? q.error.message : "تعذّرت قراءة التقرير — أعد المحاولة"}
        />
      ) : q.isLoading ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">{L.loading}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Banknote}
          title="لا بياناتٍ في هذه النافذة"
          description="لا إرساليّات مُسلَّمة لجهاتٍ ذاتِ قاعدةِ عمولةٍ فعّالة في الفترة المُختارة. أَضِف قاعدة عمولة من «قاعدة العمولة» في بطاقة الجهة كي تُحسَب."
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">الجهة</TableHead>
                <TableHead className="text-center">الإرساليّات</TableHead>
                <TableHead className="text-left">الأجرة المدفوعة</TableHead>
                <TableHead className="text-left">العمولة التقديريّة</TableHead>
                <TableHead className="text-left">الفرق (وفر متوقَّع)</TableHead>
                <TableHead className="text-center">H2</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.partyId}>
                  <TableCell className="font-bold">{r.partyName}</TableCell>
                  <TableCell className="text-center tabular-nums">{r.consignmentCount}</TableCell>
                  <TableCell className="text-left tabular-nums" dir="ltr">{fmt(r.feesTotal)}</TableCell>
                  <TableCell className="text-left tabular-nums text-[var(--sem-info)]" dir="ltr">{fmt(r.commissionTotal)}</TableCell>
                  <TableCell className="text-left font-bold tabular-nums" dir="ltr">
                    <span className={Number(r.delta) > 0 ? "text-[var(--sem-pos)]" : Number(r.delta) < 0 ? "text-[var(--sem-warn)]" : ""}>
                      {Number(r.delta) > 0 ? "+" : ""}{fmt(r.delta)}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {/* Codex P2 #9 (٢٩/٨): «مُفعَّل» تعني H2 يعمل فعلاً = العلَم + قاعدة فعّالة.
                        العلَم بلا قاعدة = «مطلوب قاعدة» — لا كذبٌ بيصريّ. */}
                    {r.effectiveActive
                      ? <Badge variant="secondary" className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]">مُفعَّل</Badge>
                      : r.useCommissionFlag && !r.hasActiveRule
                        ? <Badge variant="outline" className="border-[var(--sem-warn)] text-[var(--sem-warn)]" title="العلَم TRUE لكنّ القاعدة الفعّالة مفقودة">مطلوب قاعدة</Badge>
                        : <Badge variant="outline">خامل</Badge>}
                  </TableCell>
                </TableRow>
              ))}
              {/* صفّ الإجماليّات */}
              <TableRow className="border-t-2 border-t-primary/40 bg-muted/40 font-black">
                <TableCell>الإجماليّ</TableCell>
                <TableCell className="text-center tabular-nums">{totals.count}</TableCell>
                <TableCell className="text-left tabular-nums" dir="ltr">{fmt(totals.fees.toFixed(2))}</TableCell>
                <TableCell className="text-left tabular-nums text-[var(--sem-info)]" dir="ltr">{fmt(totals.commission.toFixed(2))}</TableCell>
                <TableCell className="text-left tabular-nums" dir="ltr">
                  <span className={totals.delta > 0 ? "text-[var(--sem-pos)]" : totals.delta < 0 ? "text-[var(--sem-warn)]" : ""}>
                    {totals.delta > 0 ? "+" : ""}{fmt(totals.delta.toFixed(2))}
                  </span>
                </TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

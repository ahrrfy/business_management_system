import { iqd } from "@/lib/hr/ui";
import { Info, Lock, TriangleAlert } from "lucide-react";
import type { EmployeeStatementModel } from "./useEmployeeStatement";

export function AttendanceStatementSummary({
  model,
}: {
  model: EmployeeStatementModel;
}) {
  const { totalDue, snap } = model;
  const d = model.d!;
  return (
    <>
      {/*
       * الشهر المصروف (ق٣) — أوّل ما يُقرأ: كلُّ ما تحته تفصيلٌ يشرح كيف حُسِب، لا رقمٌ
       * يُنافس المصروف. ونُظهر الاشتقاق الحيّ **عند اختلافه فقط** ومسمّى بأنه لا يُصرف:
       * إخفاؤه يجعل الفرق يظهر لاحقاً بلا تفسير، وإظهارُه دائماً يُنافس الرقم المجمَّد.
       */}
      {snap && (
        <div className="rounded-md border border-[var(--sem-info,var(--primary))]/40 bg-primary/5 p-2.5 space-y-1.5">
          <div className="flex items-start gap-2 text-xs">
            <Lock aria-hidden className="size-4 mt-0.5 shrink-0 text-primary" />
            <span>
              <span className="font-medium text-primary">
                الشهر {snap.status === "paid" ? "مدفوع" : "معتمد"} — الأرقام
                مثبتة من مسيّر الرواتب.
              </span>{" "}
              لا تتغيّر بتعديلٍ لاحق على الراتب أو الجدول أو إعدادات الحضور.
              الجدول أدناه تفصيلٌ للاطّلاع.
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5 text-[11px]">
            {[
              { l: "الأجر الإجمالي", v: snap.gross },
              { l: "العمل الإضافي (أوفر تايم)", v: snap.overtime },
              { l: "العمولة", v: snap.commission },
              { l: "الاستقطاعات", v: snap.deductions },
              { l: "الصافي المصروف", v: snap.net, strong: true },
            ].map((x) => (
              <div key={x.l} className="rounded border bg-background p-1.5">
                <div className="text-muted-foreground">{x.l}</div>
                <div
                  className={`tabular-nums ${x.strong ? "font-bold" : ""}`}
                  dir="ltr"
                >
                  {iqd(x.v)}
                </div>
              </div>
            ))}
          </div>
          {Number(d.liveAmountDue) !== totalDue && (
            <div className="text-[11px] text-muted-foreground">
              الاشتقاق ببيانات اليوم يُعطي {iqd(d.liveAmountDue)} د.ع — الفرق
              أثرُ ما تغيّر بعد الاعتماد (ترقيةٌ أو تصحيحُ بصمة أو تبديلُ جدول)،{" "}
              <b>ولا يُصرف</b>.
            </div>
          )}
        </div>
      )}
      {d.employee.attendanceExempt && (
        <p className="text-xs rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 leading-relaxed">
          <span className="font-medium text-[var(--sem-warn)]">
            راتب ثابت — لا يخضع للحضور.
          </span>{" "}
          يُصرف راتبه ومخصّصاته كاملةً بلا احتساب ساعات. الجدول أدناه للاطّلاع
          فقط ولا يؤثّر في مسيّره.
        </p>
      )}
      {!d.attendancePayEnabled && !d.employee.attendanceExempt && (
        <p className="text-xs text-muted-foreground rounded-md border p-2">
          الأجر بالحضور غير مفعَّل — الكشف يعرض الساعات والأسعار للمراجعة، لكنّ
          المسيّر ما زال يحتسب الراتب الثابت.
        </p>
      )}
      {d.totals.openDays > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-2.5 text-xs">
          <TriangleAlert
            aria-hidden
            className="size-4 mt-0.5 shrink-0 text-[var(--sem-neg)]"
          />
          <span>
            <span className="font-medium text-[var(--sem-neg)]">
              {d.totals.openDays} يوم ببصمة دخولٍ بلا انصراف
            </span>{" "}
            — ساعاتها مجهولةٌ لا صفر، ولذلك تُعرَض «بصمة انصراف ناقصة» لا
            «غياب». صحّحها من زرّ «تصحيح» في صفّها؛{" "}
            <span className="font-medium">
              توليد مسيّر هذا الشهر متوقّف حتى تُحسم
            </span>{" "}
            كي لا يُخصَم أجر يومٍ كامل بلا وجه.
          </span>
        </div>
      )}
      {d.totals.reviewDays > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
          <TriangleAlert
            aria-hidden
            className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]"
          />
          <span>
            <span className="font-medium text-[var(--sem-warn)]">
              {d.totals.reviewDays} يوم يحتاج مراجعة
            </span>{" "}
            — بصمةُ خروجٍ ناقصة (أو عودةٌ لفترة ثانية بلا انصراف) أو ساعاتٌ
            تجاوزت السقف المعقول. اضغط «تصحيح» أمام اليوم لمراجعته وحسمه.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        {[
          {
            l: "ساعات الدوام المطلوبة",
            sub: "حسب جدول الموظف للشهر",
            v: `${d.totals.scheduledHours} س`,
          },
          {
            l: "الساعات المدفوعة المستحقّة",
            sub: "الداخلة في أجر الدوام الأساس",
            v: `${d.totals.payableHours} س`,
          },
          {
            l: "الساعات الإضافية (أوفر تايم)",
            sub: "ما زاد عن المطلوب اليومي",
            v: `${d.totals.overtimeHours} س`,
          },
          {
            l: "أيام الغياب",
            sub: "أيام عمل بلا حضور أو إجازة",
            v: `${d.totals.absentDays} يوم`,
          },
        ].map((x) => (
          <div key={x.l} className="rounded-md border p-2.5 bg-muted/15">
            <div className="text-xs font-medium text-foreground">{x.l}</div>
            <div className="text-[10px] text-muted-foreground mb-1">
              {x.sub}
            </div>
            <div className="tabular-nums font-bold text-base" dir="ltr">
              {x.v}
            </div>
          </div>
        ))}
      </div>

      {/* دليل مبسّط يوضّح المصطلحات والدوام المجزّأ والاستراحة/الزمنية */}
      <div className="rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Info aria-hidden className="size-3.5 text-primary" />
          توضيح الأعمدة:
        </span>
        <span>
          <b className="text-foreground">المطلوب:</b> ساعات اليوم في جدول الموظف
        </span>
        <span>
          <b className="text-foreground">صافي العمل:</b> ساعات الدوام الأساس بعد
          طرح أي استراحة/زمنية
        </span>
        <span>
          <b className="text-foreground">إضافي:</b> ما زاد عن المطلوب اليومي
        </span>
        <span>
          <b className="text-foreground">دوام فترتين (استراحة/زمنية):</b> عند
          الخروج والعودة في نفس اليوم تُجمع فترات العمل الفعلي وتُطرح الاستراحة
          تلقائياً
        </span>
      </div>
    </>
  );
}

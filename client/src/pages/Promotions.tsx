/* ============================================================================
 * شاشة الترقيات وإنهاء الخدمات — وحدة الموارد البشرية (client/src/pages/Promotions.tsx)
 * تبويبان: «الترقيات» (جدول + اعتماد المعلّقة + نافذة ترقية) و«إنهاء الخدمات»
 * (جدول + إكمال المعلّق + نافذة إنهاء). الموظف يُختار من trpc.employees.list،
 * والمبالغ تُعرض بـ iqd(). الموجّه مركَّب تحت trpc.promotions.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list/RowActions";
import { ListToolbar } from "@/components/list/ListToolbar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import {
  EMPTY_TERMINATION_SETTLEMENT,
  TERMINATION_PAYMENT_METHOD_LABEL,
  terminationEarnedNet,
  terminationSettlementTotal,
  validateTerminationSettlement,
  type TerminationSettlementBreakdown,
} from "@/lib/terminationSettlement";
import { printTerminationSettlement } from "@/lib/printing/printTerminationSettlement";
import { WagePackageFields, wageValueFromEmployee, type WagePackageValue } from "@/components/form/WagePackageFields";
import { TERMINATION_TYPES } from "@shared/hr";
import { describeWageDiff, type WageProfileShape } from "@shared/wageDiff";
import { CheckCircle2, Printer, RotateCcw, TrendingUp, UserMinus, Wallet } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";

const today = () => new Date().toISOString().slice(0, 10);
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const promoStatusCls: Record<string, string> = {
  approved: "badge-status-active",
  pending: "badge-status-pending",
};
const promoStatusLabel = (s: string) => (s === "approved" ? "معتمدة" : "قيد الاعتماد");
const termStatusCls: Record<string, string> = {
  completed: "badge-status-cancelled",
  pending: "badge-status-pending",
};
const termStatusLabel = (s: string) => (s === "completed" ? "مكتملة" : "قيد التنفيذ");
const eventTime = (value?: Date | string | null) =>
  value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY;
const terminationPaymentIsOutstanding = (t: {
  latestSettlementPaymentEventKind?: "SALARY_PAYMENT" | "SALARY_PAYMENT_RETURN" | null;
  settlementPaidAt?: Date | string | null;
  settlementPaymentReturnedAt?: Date | string | null;
}) =>
  t.latestSettlementPaymentEventKind != null
    ? t.latestSettlementPaymentEventKind === "SALARY_PAYMENT"
    : eventTime(t.settlementPaidAt) > eventTime(t.settlementPaymentReturnedAt);
const terminationFinancialStatus = (t: {
  status: string;
  recognizedAt?: Date | string | null;
  latestSettlementPaymentEventKind?: "SALARY_PAYMENT" | "SALARY_PAYMENT_RETURN" | null;
  settlementPaidAt?: Date | string | null;
  settlementPaymentReturnedAt?: Date | string | null;
  recognitionReversedAt?: Date | string | null;
}) => {
  if (t.status !== "completed") return "قيد التنفيذ";
  if (t.recognitionReversedAt) return "عُكس الاستحقاق";
  if (terminationPaymentIsOutstanding(t)) return "مصروفة";
  if (t.settlementPaymentReturnedAt) return "أُعيد مبلغ الصرف";
  if (t.recognizedAt) return "مثبتة — بانتظار الصرف";
  return "مكتملة تاريخياً — تحتاج مراجعة";
};

/**
 * تفصيل حزمة الأجر قبل/بعد — **شرطُ جدوى الاعتماد الثاني**: من يعتمد تغييراً أجرياً
 * دون رؤية قيمه القديمة والجديدة يُوقّع على ما لم يره، فتصير البوّابة إجراءً شكلياً
 * (مراجعة Codex P1 على PR #449 — كان الصفّ يعرض وسماً عامّاً «حزمة أجر» فحسب).
 */
function WageDiffList({ from, to }: { from: unknown; to: unknown }) {
  const rows = describeWageDiff(from as WageProfileShape | null, to as WageProfileShape | null);
  if (!rows.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[11px]">
      {rows.map((r, i) => (
        <li key={`${r.key}-${i}`} className="flex flex-wrap items-baseline justify-end gap-1">
          <span className="text-muted-foreground">{r.label}:</span>
          <span className="tabular-nums line-through text-muted-foreground" dir="auto">{r.before}</span>
          <span aria-hidden>←</span>
          <span className="tabular-nums font-medium text-money-positive" dir="auto">{r.after}</span>
        </li>
      ))}
    </ul>
  );
}

function EmpCell({ name, color, photoUrl }: { name: string; color?: string | null; photoUrl?: string | null }) {
  return (
    <div className="flex items-center gap-2">
      <EmpAvatar name={name} color={color} photoUrl={photoUrl} sizePx={28} />
      <span className="text-[13px] font-medium">{name}</span>
    </div>
  );
}

export default function Promotions() {
  // `sub` تُميَّز عن `tab` عمداً: الأخيرة يستهلكها `PageTabs` للـhub، فتسميةٌ واحدة
  // للاثنين تجعل تبويبَ الشاشة يبتلع تبويبَ الوحدة أو العكس.
  const search = useSearch();
  const [tab, setTab] = useState(() =>
    new URLSearchParams(search).get("sub") === "terminations" ? "terminations" : "promotions",
  );
  const [query, setQuery] = useState("");
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();

  const promotions = trpc.promotions.listPromotions.useQuery();
  const terminations = trpc.promotions.listTerminations.useQuery();
  const employees = trpc.employees.list.useQuery({ status: "active", limit: 200 });
  const activeEmps = employees.data?.rows ?? [];

  /* ===== نافذة الترقية ===== */
  const [promoOpen, setPromoOpen] = useState(false);
  const [pEmp, setPEmp] = useState("");
  const [pToTitle, setPToTitle] = useState("");
  const [pToSalary, setPToSalary] = useState("");
  const [pDate, setPDate] = useState(today());
  const [pReason, setPReason] = useState("");
  const selectedEmp = useMemo(() => activeEmps.find((e) => String(e.id) === pEmp), [activeEmps, pEmp]);

  /*
   * حزمة الأجر (0143): الترقية هي **المسار الوحيد** لتغيير أيّ حقلٍ حاملٍ للأجر بعد
   * التعيين لغير الأدمن — الراتب والبدلات وجدول الدوام وأسعار ساعات الأيام والإعفاء
   * من الحضور. كانت تحمل الراتب وحده، فبقيت البقية تُعدَّل من شاشة الموظف بفاعلٍ واحد.
   * القيم تُملأ من حالة الموظف المختار عبر نفس المُطبِّع الذي يستعمله نموذج الموظف.
   */
  const [pWageOn, setPWageOn] = useState(false);
  const [pWage, setPWage] = useState<WagePackageValue>(() => wageValueFromEmployee(null));

  const resetPromo = () => { setPEmp(""); setPToTitle(""); setPToSalary(""); setPDate(today()); setPReason(""); setPWageOn(false); setPWage(wageValueFromEmployee(null)); };
  const createPromo = trpc.promotions.createPromotion.useMutation({
    onSuccess: async () => { notify.ok("سُجّلت الترقية (قيد الاعتماد)"); setPromoOpen(false); resetPromo(); await utils.promotions.listPromotions.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const approvePromo = trpc.promotions.approvePromotion.useMutation({
    onSuccess: async () => { notify.ok("اعتُمدت الترقية وحُدّث الموظف"); await Promise.all([utils.promotions.listPromotions.invalidate(), utils.employees.list.invalidate()]); },
    onError: (e) => notify.err(e),
  });

  const submitPromo = () => {
    if (!pEmp) return notify.warn("اختر الموظف");
    // المسمّى لم يعد إلزامياً: تغييرٌ أجريٌّ بحت (جدول/أسعار) يبقي المسمّى الحاليّ —
    // لكن طلباً بلا مسمّى ولا حزمةٍ ولا راتبٍ لا يغيّر شيئاً فلا يُستهلَك عليه اعتماد.
    if (!pToTitle.trim() && !pWageOn && !pToSalary.trim()) {
      return notify.warn("حدّد مسمّى جديداً أو فعّل «تغيير حزمة الأجر»");
    }
    if (pWageOn && pWage.payType === "monthly" && !pWage.salary.trim()) {
      return notify.warn("الراتب الأساس مطلوب لذوي الراتب الشهري");
    }
    createPromo.mutate({
      employeeId: Number(pEmp),
      toTitle: pToTitle.trim() || undefined,
      // الراتب المستقلّ يُهمَل عند تفعيل الحزمة — الحزمة تحمله فلا مصدران متعارضان.
      toSalary: pWageOn ? undefined : pToSalary.trim() || undefined,
      effectiveDate: pDate,
      reason: pReason.trim() || undefined,
      wage: pWageOn
        ? {
            payType: pWage.payType,
            salary: pWage.payType === "monthly" ? pWage.salary.trim() || null : null,
            allowances: pWage.allowances.trim() || "0",
            attendanceExempt: pWage.payType === "monthly" && pWage.attendanceExempt,
            dayRates: pWage.payType === "hourly" ? pWage.dayRates : undefined,
            workSchedule: pWage.schedule,
          }
        : undefined,
    });
  };

  /* ===== نافذة إنهاء الخدمة ===== */
  const [termOpen, setTermOpen] = useState(false);
  const [tEmp, setTEmp] = useState("");
  const [tType, setTType] = useState<string>(TERMINATION_TYPES[0]);
  const [tLastDay, setTLastDay] = useState(today());
  const [tBreakdown, setTBreakdown] = useState<TerminationSettlementBreakdown>(
    EMPTY_TERMINATION_SETTLEMENT,
  );
  const [tPaymentMethod, setTPaymentMethod] = useState<"CASH" | "CARD" | "TRANSFER" | "WALLET">("CASH");
  const [tPaymentReference, setTPaymentReference] = useState("");
  const [tEvidenceNote, setTEvidenceNote] = useState("");
  const [tZeroAmountsAttested, setTZeroAmountsAttested] = useState(false);
  const [tReason, setTReason] = useState("");
  const selectedTermEmp = useMemo(() => activeEmps.find((e) => String(e.id) === tEmp), [activeEmps, tEmp]);
  /**
   * نيّةُ الإنهاء القادمة من بطاقة الموظف (Codex P2، ٣١/٨) — تُطبَّق على مرحلتين لأنّ
   * القائمة تصل لاحقاً: التبويب فوراً، وانتقاءُ الموظف بعد وصول `employees`.
   * `useSearch` تفاعليّ ⇒ يُطبَّق بلا remount أيضاً (نمط DeliveryHub، Codex P1 ٢٣/٨).
   */
  const subIntentRef = useRef<string | null>(null);
  const empIntentRef = useRef<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("sub") !== "terminations") return;
    if (subIntentRef.current !== search) { subIntentRef.current = search; setTab("terminations"); }
    const wanted = params.get("employee");
    if (!wanted || empIntentRef.current === search) return;
    // لا يُحكَم بالغياب قبل وصول القائمة، وإلّا صار كلّ رابطٍ «موظفاً غير مُدرَج».
    if (!employees.isSuccess) return;
    empIntentRef.current = search;
    const match = activeEmps.find((e) => String(e.id) === wanted);
    if (!match) {
      // ⛔ لا تُفتَح النافذة بموظفٍ غير مُنتقى: المستعمل جاء بنيّةِ «هذا الموظف»، ونافذةٌ
      // بقائمةٍ فارغة الاختيار تدعوه لانتقاء الاسم المجاور — وهو الخطر عينه الذي جاء
      // الرابط ليُغلقه. الغيابُ يُقال صراحةً (القائمة تقتصر على الفعّالين، ٢٠٠ سقفاً).
      notify.err("هذا الموظف غير مُدرَج في قائمة إنهاء الخدمة (تشمل الفعّالين فقط) — راجع حالته أو اختره يدوياً.");
      return;
    }
    setTEmp(String(match.id));
    setTermOpen(true);
  }, [search, employees.isSuccess, activeEmps]);
  const tSettlement = terminationSettlementTotal(tBreakdown);
  const tEarnedNet = terminationEarnedNet(tBreakdown);
  const advanceBalance = trpc.payroll.advanceBalance.useQuery(
    { employeeId: Number(tEmp) },
    { enabled: termOpen && !!tEmp },
  );

  /*
   * مطابقةُ أجر الشهر الأخير بمحرّك الحضور (بند ٤٣). الخادم يُنفّذها عند الالتزام؛ وهذه
   * معاينةٌ تُري الرقم **قبل** الإرسال بدل أن يُردّ النموذج بخطأ بعد ملئه كاملاً.
   * `employmentEndOverride` ضروريّ: بدونه يُحسب الشهر كاملاً فيُقارَن جزءُ شهرٍ بشهرٍ تامّ.
   */
  const wageStatement = trpc.attendance.employeeStatement.useQuery(
    { employeeId: Number(tEmp), period: tLastDay.slice(0, 7), employmentEndOverride: tLastDay },
    { enabled: Boolean(tEmp) && /^\d{4}-\d{2}-\d{2}$/.test(tLastDay) },
  );
  const expectedWage = wageStatement.data?.expectedEarnedGrossWages ?? null;
  const enteredWage = tBreakdown.earnedGrossWages.trim();
  const wageGap = expectedWage && enteredWage ? D(expectedWage).minus(D(enteredWage)).abs() : null;
  // نفس عتبة الخادم — مرآةٌ تمنع رحلةً بلا طائل، والإنفاذ يبقى خادمياً.
  const wageDiverged = wageGap != null && wageGap.gt(1000);
  // إنهاءٌ مخطَّط: بصماتُ الأيام الباقية لم تصل بعد فالاشتقاق ناقصٌ بطبيعته — يُعرَض ولا يُلزم.
  const wagePlannedAhead = tLastDay > new Date().toISOString().slice(0, 10);
  const wageEnforced = wageDiverged && !wagePlannedAhead && wageStatement.data?.dueBasis === "attendance";
  const [tWageReason, setTWageReason] = useState("");
  const [reverseTarget, setReverseTarget] = useState<{
    id: number;
    employeeName: string;
    mode: "payment" | "recognition" | "reissue";
  } | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseMethod, setReverseMethod] = useState<"CASH" | "CARD" | "TRANSFER" | "WALLET">("CASH");
  const [reverseReference, setReverseReference] = useState("");
  const [reverseDate, setReverseDate] = useState(today());

  const resetTerm = () => {
    setTEmp(""); setTType(TERMINATION_TYPES[0]); setTLastDay(today());
    setTBreakdown(EMPTY_TERMINATION_SETTLEMENT);
    setTPaymentMethod("CASH"); setTPaymentReference(""); setTEvidenceNote("");
    setTZeroAmountsAttested(false); setTReason("");
  };
  const createTerm = trpc.promotions.createTermination.useMutation({
    onSuccess: async () => { notify.ok("سُجّل إجراء إنهاء الخدمة (قيد التنفيذ)"); setTermOpen(false); resetTerm(); await utils.promotions.listTerminations.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const completeTerm = trpc.promotions.completeTermination.useMutation({
    onSuccess: async (data) => {
      // الأثران الأمنيّان يُصرَّح بهما بدل أن يمرّا صامتين — الخدمة تُرجعهما فعلاً.
      const sideEffects = [
        data?.userDisabled ? "وعُطِّل حساب دخوله للنظام" : null,
        data?.deviceLinksReleased ? `وحُدَّ ربطه بجهاز الحضور بيوم العمل الأخير (${data.deviceLinksReleased})` : null,
      ].filter(Boolean).join(" ");
      const suffix = sideEffects ? ` — ${sideEffects}` : "";
      if (data?.settlementVoucher) {
        // تسوية المستحقات صارت سند صرفٍ مُعلَّق يعتمده مديرٌ آخر (فصل مهام #٦) — أبلِغ المستخدم بوجهة الفعل.
        notify.ok(`اكتمل إنهاء الخدمة${suffix}. تسوية المستحقات صُدِّرت كسند صرف مُعلَّق (${data.settlementVoucher.voucherNumber}) — يعتمده مديرٌ آخر من شاشة السندات.`);
      } else {
        notify.ok(`اكتمل إنهاء الخدمة وأُنهيت خدمة الموظف${suffix}`);
      }
      await Promise.all([utils.promotions.listTerminations.invalidate(), utils.employees.list.invalidate()]);
    },
    onError: (e) => notify.err(e),
  });
  const reversePayment = trpc.promotions.reverseTerminationPayment.useMutation({
    onSuccess: async (data) => {
      notify.ok(data.replacementVoucher
        ? `سُجّلت إعادة المبلغ وأعيد فتح الالتزام. أُنشئ طلب صرف بديل (${data.replacementVoucher.voucherNumber}) لاعتماد مالك آخر.`
        : "إعادة مبلغ التسوية مسجّلة مسبقاً.");
      setReverseTarget(null); setReverseReason("");
      await utils.promotions.listTerminations.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const reverseRecognition = trpc.promotions.reverseTerminationRecognition.useMutation({
    onSuccess: async () => {
      notify.ok("عُكس استحقاق التسوية بقيد مستقل وأعيد مخصص نهاية الخدمة إلى مصادره.");
      setReverseTarget(null); setReverseReason("");
      await utils.promotions.listTerminations.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const reissuePayment = trpc.promotions.reissueTerminationPayment.useMutation({
    onSuccess: async (data) => {
      notify.ok(data.replayed
        ? `طلب الصرف ما زال معلقاً (${data.voucherNumber}).`
        : `أُعيد إصدار طلب صرف مستقل (${data.voucherNumber}) لاعتماد مالك آخر.`);
      setReverseTarget(null); setReverseReason("");
      await utils.promotions.listTerminations.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const submitTerm = () => {
    if (!tEmp) return notify.warn("اختر الموظف");
    const breakdownError = validateTerminationSettlement(tBreakdown);
    if (breakdownError) return notify.warn(breakdownError);
    if (
      advanceBalance.data &&
      D(tBreakdown.advanceRecovery || 0).gt(advanceBalance.data.balance)
    ) {
      return notify.warn(
        `استرداد السلفة يتجاوز الرصيد النشط ${iqd(advanceBalance.data.balance)} د.ع.`,
      );
    }
    if (tPaymentMethod !== "CASH" && !tPaymentReference.trim()) {
      return notify.warn("رقم مرجع التحويل/البطاقة/المحفظة إلزامي للتسوية غير النقدية.");
    }
    if (tPaymentMethod === "CARD" && !/^\d{4}$/.test(tPaymentReference.trim())) {
      return notify.warn("مرجع البطاقة يجب أن يكون آخر أربعة أرقام منها.");
    }
    if (tEvidenceNote.trim().length < 10) {
      return notify.warn("اكتب مرجع المراجعة البشرية ومصدر القيم (10 أحرف على الأقل).");
    }
    if (!tZeroAmountsAttested) {
      return notify.warn("يجب الإقرار بأن القيم الصفرية مقصودة ومراجعة.");
    }
    createTerm.mutate({
      employeeId: Number(tEmp),
      terminationType: tType as (typeof TERMINATION_TYPES)[number],
      lastDay: tLastDay,
      breakdown: {
        earnedGrossWages: tBreakdown.earnedGrossWages.trim() || undefined,
        wageReductions: tBreakdown.wageReductions.trim() || undefined,
        advanceRecovery: tBreakdown.advanceRecovery.trim() || undefined,
        incomeTax: tBreakdown.incomeTax.trim() || undefined,
        employeeSocialSecurity: tBreakdown.employeeSocialSecurity.trim() || undefined,
        employerSocialSecurity: tBreakdown.employerSocialSecurity.trim() || undefined,
        leaveCompensation: tBreakdown.leaveCompensation.trim() || undefined,
        noticeCompensation: tBreakdown.noticeCompensation.trim() || undefined,
        eosBenefit: tBreakdown.eosBenefit.trim() || undefined,
        otherSettlement: tBreakdown.otherSettlement.trim() || undefined,
        otherSettlementLabel: tBreakdown.otherSettlementLabel.trim() || undefined,
      },
      paymentMethod: tPaymentMethod,
      paymentReference: tPaymentReference.trim() || undefined,
      settlementEvidenceNote: tEvidenceNote.trim(),
      zeroAmountsAttested: true,
      reason: tReason.trim() || undefined,
      wageDivergenceReason: tWageReason.trim() || undefined,
    });
  };

  const submitReversal = () => {
    if (!reverseTarget || reverseReason.trim().length < 5) {
      return notify.warn("اكتب سبباً واضحاً للعكس (خمسة أحرف على الأقل).");
    }
    if (reverseTarget.mode === "payment") {
      if (reverseMethod !== "CASH" && !reverseReference.trim()) {
        return notify.warn("مرجع إعادة المبلغ إلزامي للطريقة غير النقدية.");
      }
      if (reverseMethod === "CARD" && !/^\d{4}$/.test(reverseReference.trim())) {
        return notify.warn("مرجع البطاقة يجب أن يكون آخر أربعة أرقام منها.");
      }
      reversePayment.mutate({
        id: reverseTarget.id,
        reason: reverseReason.trim(),
        paymentMethod: reverseMethod,
        referenceNumber: reverseReference.trim() || undefined,
        reversalDate: reverseDate,
      });
    } else if (reverseTarget.mode === "recognition") {
      reverseRecognition.mutate({ id: reverseTarget.id, reason: reverseReason.trim() });
    } else {
      reissuePayment.mutate({ id: reverseTarget.id, reason: reverseReason.trim() });
    }
  };

  const promoRows = promotions.data ?? [];
  const termRows = terminations.data ?? [];
  const filteredPromos = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? promoRows.filter((p) => [p.employeeName, p.fromTitle, p.toTitle, p.reason, promoStatusLabel(p.status)].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : promoRows;
  }, [promoRows, query]);
  const filteredTerms = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? termRows.filter((t) => [t.employeeName, t.terminationType, t.reason, termStatusLabel(t.status)].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : termRows;
  }, [termRows, query]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="الترقيات وإنهاء الخدمات"
        description="ترقيات المسمّى والراتب، وإجراءات إنهاء الخدمة مع التسوية النهائية للمستحقات."
        actions={
          tab === "promotions" ? (
            <Button onClick={() => setPromoOpen(true)}><TrendingUp className="size-4 ml-1" /> ترقية موظف</Button>
          ) : (
            <Button className="bg-destructive text-white hover:bg-destructive/90" onClick={() => setTermOpen(true)}><UserMinus className="size-4 ml-1" /> إنهاء خدمة</Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="promotions">الترقيات ({promoRows.length})</TabsTrigger>
          <TabsTrigger value="terminations">إنهاء الخدمات ({termRows.length})</TabsTrigger>
        </TabsList>

        {/* ===== الترقيات ===== */}
        <TabsContent value="promotions">
          <Card>
            <CardHeader>
              <ListToolbar
                title="سجل الترقيات"
                count={filteredPromos.length}
                loading={promotions.isLoading}
                search={{ value: query, onChange: setQuery, placeholder: "الموظف، المسمّى، السبب أو الحالة…" }}
                onResetFilters={() => setQuery("")}
                onRefresh={() => void promotions.refetch()}
                refreshing={promotions.isFetching}
                onPrint={() => window.print()}
                exportSpec={{
                  filename: "ترقيات-الموظفين",
                  rows: filteredPromos,
                  formats: ["xlsx", "csv"],
                  columns: [
                    { key: "employeeName", header: "الموظف" }, { key: "fromTitle", header: "من مسمّى" },
                    { key: "toTitle", header: "إلى مسمّى" }, { key: "fromSalary", header: "الراتب السابق", money: true },
                    { key: "toSalary", header: "الراتب الجديد", money: true }, { key: "effectiveDate", header: "التاريخ" },
                    { key: "reason", header: "السبب" }, { key: "status", header: "الحالة", map: (p) => promoStatusLabel(p.status) },
                  ],
                }}
              />
            </CardHeader>
            <CardContent className="p-0">
              <ScrollTableShell bordered={false}>
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2">الموظف</th>
                      <th className="p-2">من مسمّى</th>
                      <th className="p-2">إلى مسمّى</th>
                      <th className="p-2 text-right">تغيّر الراتب</th>
                      <th className="p-2 text-center">التاريخ</th>
                      <th className="p-2">السبب</th>
                      <th className="p-2 text-center">الحالة</th>
                      <th className="p-2 text-center">إجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPromos.map((p) => (
                      <tr key={p.id} className="border-t hover:bg-accent/40">
                        <td className="p-2"><EmpCell name={p.employeeName} color={p.colorTag} photoUrl={p.photoUrl} /></td>
                        <td className="p-2 text-xs text-muted-foreground">{p.fromTitle ?? "—"}</td>
                        {/* مسمّى فارغ = تغييرٌ أجريٌّ بحت لا ترقيةَ مسمّى. */}
                        <td className="p-2 text-[13px] font-medium">{p.toTitle || "—"}</td>
                        <td className="p-2 text-right tabular-nums text-xs" dir="ltr">
                          <span className="text-muted-foreground">{iqd(p.fromSalary)}</span> → <span className="font-medium text-money-positive">{p.toSalary != null ? iqd(p.toSalary) : "—"}</span>
                          {/* «الراتب لم يتغيّر» لا يعني «الأجر لم يتغيّر»: الجدول وأسعار الساعات
                              تُغيّر المدفوع فعلياً، فيلزم أن يراها المعتمِد قبل الاعتماد. */}
                          {p.toWage != null && (
                            <div dir="rtl">
                              <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                                <Wallet aria-hidden className="size-3" /> حزمة أجر
                              </span>
                              <WageDiffList from={p.fromWage} to={p.toWage} />
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-center text-xs tabular-nums" dir="ltr">{p.effectiveDate}</td>
                        <td className="p-2 text-xs">{p.reason ?? "—"}</td>
                        <td className="p-2 text-center"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${promoStatusCls[p.status] ?? "bg-muted text-muted-foreground"}`}>{promoStatusLabel(p.status)}</span></td>
                        <td className="p-2 text-center">
                          {p.status === "pending" ? (
                            <RowActions
                              mode="inline"
                              actions={[{
                                key: "approve",
                                kind: "approve",
                                label: "اعتماد",
                                gate: { module: "hr", level: "FULL" },
                                disabled: approvePromo.isPending,
                                disabledReason: "جارٍ اعتماد الترقية",
                                onSelect: async () => {
                                  // الحوار يسرد التغييرات بقيمها لا بوصفٍ عامّ — المعتمِد يقرّ ما يراه.
                                  const diff = describeWageDiff(p.fromWage as WageProfileShape | null, p.toWage as WageProfileShape | null);
                                  const wageNote = diff.length
                                    ? `\n\nتغييرات حزمة الأجر:\n${diff.map((r) => `• ${r.label}: ${r.before} ← ${r.after}`).join("\n")}`
                                    : "";
                                  const titleNote = p.toTitle ? ` إلى «${p.toTitle}»` : "";
                                  if (!(await confirm({ variant: "warning", title: "اعتماد الترقية", description: `اعتماد طلب «${p.employeeName}»${titleNote} يحدّث بيانات الموظف المالية.${wageNote}`, confirmText: "اعتماد" }))) return;
                                  approvePromo.mutate({ id: p.id });
                                },
                              }]}
                            />
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                    {promotions.isLoading && (
                      <tr><td colSpan={8}><LoadingState /></td></tr>
                    )}
                    {promotions.isError && (
                      <tr><td colSpan={8}><ErrorState message="تعذّر تحميل الترقيات." onRetry={() => promotions.refetch()} /></td></tr>
                    )}
                    {!promotions.isLoading && !promotions.isError && filteredPromos.length === 0 && (
                      <TableEmptyRow colSpan={8} message="لا ترقيات مسجّلة بعد." />
                    )}
                  </tbody>
                </table>
              </ScrollTableShell>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===== إنهاء الخدمات ===== */}
        <TabsContent value="terminations">
          {terminations.isError ? (
            <Card><CardContent className="p-0">
              <ErrorState message="تعذّر تحميل إنهاءات الخدمة." onRetry={() => terminations.refetch()} />
            </CardContent></Card>
          ) : !terminations.isLoading && termRows.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">
              <CheckCircle2 className="size-8 mx-auto mb-2 opacity-50" />
              <div>لا إجراءات إنهاء خدمة.</div>
            </CardContent></Card>
          ) : (
            <Card>
              <CardHeader>
                <ListToolbar
                  title="سجل إنهاء الخدمات"
                  count={filteredTerms.length}
                  loading={terminations.isLoading}
                  search={{ value: query, onChange: setQuery, placeholder: "الموظف، نوع الإنهاء، السبب أو الحالة…" }}
                  onResetFilters={() => setQuery("")}
                  onRefresh={() => void terminations.refetch()}
                  refreshing={terminations.isFetching}
                  onPrint={() => window.print()}
                  exportSpec={{
                    filename: "إنهاء-الخدمات",
                    rows: filteredTerms,
                    formats: ["xlsx", "csv"],
                    columns: [
                      { key: "employeeName", header: "الموظف" }, { key: "terminationType", header: "نوع الإنهاء" },
                      { key: "lastDay", header: "آخر يوم" },
                      { key: "earnedGrossWages", header: "إجمالي أجور مكتسبة", money: true },
                      { key: "wageReductions", header: "تخفيضات الأجر", money: true },
                      { key: "advanceRecovery", header: "استرداد سلفة", money: true },
                      { key: "remainingAdvanceAtRecognition", header: "رصيد السلفة بعد التسوية", money: true },
                      { key: "currentRemainingAdvanceBalance", header: "رصيد السلفة الحالي", money: true },
                      { key: "incomeTax", header: "ضريبة دخل", money: true },
                      { key: "employeeSocialSecurity", header: "ضمان الموظف", money: true },
                      { key: "employerSocialSecurity", header: "ضمان الشركة", money: true },
                      { key: "leaveCompensation", header: "بدل إجازات", money: true },
                      { key: "noticeCompensation", header: "بدل إشعار", money: true },
                      { key: "eosBenefit", header: "نهاية الخدمة", money: true },
                      { key: "otherSettlement", header: "مستحق آخر", money: true },
                      { key: "otherSettlementLabel", header: "تصنيف الآخر" },
                      { key: "settlementEvidenceNote", header: "مرجع المراجعة" },
                      { key: "settlement", header: "إجمالي التسوية", money: true },
                      { key: "eosProvisionConsumed", header: "المخصص المستخدم", money: true },
                      { key: "eosProvisionReleased", header: "المخصص المحرر", money: true },
                      { key: "eosExpenseRecognized", header: "فرق المصروف", money: true },
                      { key: "reason", header: "السبب" },
                      { key: "status", header: "الحالة المالية", map: (t) => terminationFinancialStatus(t) },
                    ],
                  }}
                />
              </CardHeader>
              <CardContent className="p-0">
                <ScrollTableShell bordered={false}>
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2">الموظف</th>
                        <th className="p-2">نوع الإنهاء</th>
                        <th className="p-2 text-center">آخر يوم عمل</th>
                        <th className="p-2 text-right">التسوية النهائية</th>
                        <th className="p-2">السبب</th>
                        <th className="p-2 text-center">الحالة</th>
                        <th className="p-2 text-center">إجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTerms.map((t) => (
                        <tr key={t.id} className="border-t hover:bg-accent/40">
                          <td className="p-2"><EmpCell name={t.employeeName} color={t.colorTag} photoUrl={t.photoUrl} /></td>
                          <td className="p-2 text-[13px]">{t.terminationType}</td>
                          <td className="p-2 text-center text-xs tabular-nums" dir="ltr">{t.lastDay}</td>
                          <td className="p-2 text-right">
                            <div className="tabular-nums font-medium" dir="ltr">{iqd(t.settlement)}</div>
                            <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
                              إجمالي أجر {iqd(t.earnedGrossWages)} · تخفيض {iqd(t.wageReductions)} · سلفة {iqd(t.advanceRecovery)}<br />
                              ضريبة {iqd(t.incomeTax)} · ضمان موظف {iqd(t.employeeSocialSecurity)} · ضمان شركة {iqd(t.employerSocialSecurity)}<br />
                              رصيد السلفة بعد التسوية {iqd(t.remainingAdvanceAtRecognition)}<br />
                              <span className="text-muted-foreground">الرصيد الحالي وقت العرض {iqd(t.currentRemainingAdvanceBalance)}</span><br />
                              إجازات {iqd(t.leaveCompensation)} · إشعار {iqd(t.noticeCompensation)}<br />
                              نهاية خدمة {iqd(t.eosBenefit)} · آخر {iqd(t.otherSettlement)}
                            </div>
                            {t.recognizedAt && (
                              <div className="mt-1 text-[10px] text-muted-foreground">
                                من المخصص {iqd(t.eosProvisionConsumed)} · محرر {iqd(t.eosProvisionReleased)} · فرق مصروف {iqd(t.eosExpenseRecognized)}
                              </div>
                            )}
                          </td>
                          <td className="p-2 text-xs text-muted-foreground">{t.reason ?? "—"}</td>
                          <td className="p-2 text-center"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${termStatusCls[t.status] ?? "bg-muted text-muted-foreground"}`}>{terminationFinancialStatus(t)}</span></td>
                          <td className="p-2 text-center">
                            <RowActions
                              mode="menu"
                              actions={[
                                {
                                  key: "print",
                                  kind: "print",
                                  label: "طباعة بيان التفكيك",
                                  icon: Printer,
                                  gate: { module: "hr", level: "READ" },
                                  onSelect: () => printTerminationSettlement({
                                    id: t.id,
                                    employeeName: t.employeeName,
                                    terminationType: t.terminationType,
                                    lastDay: t.lastDay,
                                    earnedGrossWages: t.earnedGrossWages,
                                    wageReductions: t.wageReductions,
                                    advanceRecovery: t.advanceRecovery,
                                    incomeTax: t.incomeTax,
                                    employeeSocialSecurity: t.employeeSocialSecurity,
                                    employerSocialSecurity: t.employerSocialSecurity,
                                    leaveCompensation: t.leaveCompensation,
                                    noticeCompensation: t.noticeCompensation,
                                    eosBenefit: t.eosBenefit,
                                    otherSettlement: t.otherSettlement,
                                    otherSettlementLabel: t.otherSettlementLabel,
                                    evidenceNote: t.settlementEvidenceNote,
                                    remainingAdvanceAtRecognition: t.remainingAdvanceAtRecognition,
                                    total: t.settlement,
                                    paymentMethod: TERMINATION_PAYMENT_METHOD_LABEL[t.settlementPaymentMethod] ?? t.settlementPaymentMethod,
                                    status: terminationFinancialStatus(t),
                                    reason: t.reason,
                                    snapshotHash: t.settlementSnapshotHash,
                                  }),
                                },
                                ...(t.status === "pending" ? [{
                                  key: "complete",
                                  kind: "approve" as const,
                                  label: "إكمال",
                                  gate: { module: "hr" as const, level: "FULL" as const },
                                  disabled: completeTerm.isPending || me.data?.isOwner !== true || Number(me.data?.id) === Number(t.createdBy),
                                  disabledReason: completeTerm.isPending
                                    ? "جارٍ إكمال إنهاء الخدمة"
                                    : me.data?.isOwner !== true
                                      ? "إثبات الاستحقاق يتطلب مالكاً نشطاً"
                                      : "منشئ الإجراء لا يجوز أن يثبت استحقاقه",
                                  onSelect: async () => {
                                    if (!(await confirm({ variant: "danger", title: "إكمال إنهاء الخدمة", description: `إنهاء خدمة «${t.employeeName}» نهائي، سيُستثنى الموظف من المسيّرات. اكتب «إنهاء الخدمة» للتأكيد.`, confirmText: "إنهاء الخدمة", requireText: "إنهاء الخدمة" }))) return;
                                    completeTerm.mutate({ id: t.id });
                                  },
                                }] : []),
                                ...(t.status === "completed" && terminationPaymentIsOutstanding(t) && !t.recognitionReversedAt ? [{
                                  key: "reverse-payment",
                                  kind: "reverse" as const,
                                  label: "عكس الصرف وإعادة الالتزام",
                                  icon: RotateCcw,
                                  gate: { module: "hr" as const, level: "FULL" as const },
                                  disabled: me.data?.isOwner !== true || Number(me.data?.id) === Number(t.createdBy) || Number(me.data?.id) === Number(t.recognizedBy),
                                  disabledReason: me.data?.isOwner !== true
                                    ? "عكس الصرف يتطلب مالكاً نشطاً"
                                    : "يلزم مالك مستقل عن منشئ ومثبت التسوية",
                                  onSelect: () => {
                                    setReverseTarget({ id: t.id, employeeName: t.employeeName, mode: "payment" });
                                    setReverseReason(""); setReverseMethod("CASH"); setReverseReference(""); setReverseDate(today());
                                  },
                                }] : []),
                                ...(t.status === "completed" && t.recognizedAt && D(t.settlement).gt(0) && !terminationPaymentIsOutstanding(t) && !t.recognitionReversedAt ? [{
                                  key: "reissue-payment",
                                  kind: "pay" as const,
                                  label: "إعادة إصدار طلب الصرف",
                                  icon: Wallet,
                                  gate: { module: "hr" as const, level: "FULL" as const },
                                  disabled: me.data?.isOwner !== true,
                                  disabledReason: "إعادة الإصدار تتطلب مالكاً نشطاً",
                                  onSelect: () => {
                                    setReverseTarget({ id: t.id, employeeName: t.employeeName, mode: "reissue" });
                                    setReverseReason("");
                                  },
                                }] : []),
                                ...(t.status === "completed" && t.recognizedAt && t.recognitionEventId && !terminationPaymentIsOutstanding(t) && !t.recognitionReversedAt ? [{
                                  key: "reverse-recognition",
                                  kind: "reverse" as const,
                                  label: "عكس إثبات الاستحقاق",
                                  icon: RotateCcw,
                                  gate: { module: "hr" as const, level: "FULL" as const },
                                  disabled: me.data?.isOwner !== true || Number(me.data?.id) === Number(t.createdBy) || Number(me.data?.id) === Number(t.recognizedBy),
                                  disabledReason: me.data?.isOwner !== true
                                    ? "عكس الاستحقاق يتطلب مالكاً نشطاً"
                                    : "يلزم مالك مستقل عن منشئ ومثبت التسوية",
                                  onSelect: () => {
                                    setReverseTarget({ id: t.id, employeeName: t.employeeName, mode: "recognition" });
                                    setReverseReason("");
                                  },
                                }] : []),
                              ]}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollTableShell>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ===== نافذة الترقية ===== */}
      <Dialog open={promoOpen} onOpenChange={(o) => { setPromoOpen(o); if (!o) resetPromo(); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>ترقية / تغيير أجر</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="p-emp">الموظف</Label>
              <select
                id="p-emp"
                className={selectCls}
                value={pEmp}
                onChange={(e) => {
                  setPEmp(e.target.value);
                  // تعبئة الحزمة من حالة الموظف الحالية: الطلب يُخزَّن **هدفاً كاملاً**،
                  // فبدءُ التحرير من قيمه الفعلية يمنع تصفير جدولٍ لم يُقصَد تغييره.
                  setPWage(wageValueFromEmployee(activeEmps.find((x) => String(x.id) === e.target.value) ?? null));
                }}
              >
                <option value="">— اختر موظفاً —</option>
                {activeEmps.map((e) => <option key={e.id} value={String(e.id)}>{e.fullName}{e.position ? ` — ${e.position}` : ""}</option>)}
              </select>
              {selectedEmp && (
                <div className="text-xs text-muted-foreground" dir="ltr">
                  المسمّى الحالي: <span dir="rtl">{selectedEmp.position ?? "—"}</span> · الراتب الحالي: <span className="tabular-nums">{iqd(selectedEmp.salary)}</span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label htmlFor="p-title">المسمّى الجديد</Label><Input id="p-title" value={pToTitle} onChange={(e) => setPToTitle(e.target.value)} placeholder="اتركه فارغاً ليبقى كما هو" /></div>
              {!pWageOn && (
                <div className="space-y-1"><Label htmlFor="p-salary">الراتب الجديد (د.ع)</Label><MoneyInput id="p-salary" value={pToSalary} onChange={setPToSalary} decimals={0} placeholder="1,100,000" /></div>
              )}
            </div>

            {/* حزمة الأجر — المسار المزدوج الاعتماد لتغيير ما لا تسمح به شاشة الموظف. */}
            <div className="rounded-md border p-3 space-y-3">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="size-4 mt-0.5" checked={pWageOn} disabled={!pEmp} onChange={(ev) => setPWageOn(ev.target.checked)} />
                <span>
                  <span className="font-medium flex items-center gap-1"><Wallet aria-hidden className="size-4" /> تغيير حزمة الأجر</span>
                  <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    الراتب والبدلات وجدول الدوام وأسعار ساعات الأيام والإعفاء من الحضور — كلُّها تُغيَّر من هنا
                    فقط (باعتماد مديرٍ آخر)، لأنها تحدّد المبلغ المدفوع فعلياً لا الراتب وحده.
                    {!pEmp && <span className="block mt-0.5">اختر الموظف أولاً لتُملأ حزمته الحالية.</span>}
                  </span>
                </span>
              </label>
              {pWageOn && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t pt-3">
                  <div className="space-y-1">
                    <Label htmlFor="p-paytype">طريقة الأجر</Label>
                    <select id="p-paytype" className={selectCls} value={pWage.payType} onChange={(ev) => setPWage((w) => ({ ...w, payType: ev.target.value as "monthly" | "hourly" }))}>
                      <option value="monthly">راتب شهري</option>
                      <option value="hourly">بالساعة</option>
                    </select>
                  </div>
                  <div className="hidden md:block" aria-hidden />
                  <div className="hidden md:block" aria-hidden />
                  <WagePackageFields value={pWage} onChange={(patch) => setPWage((w) => ({ ...w, ...patch }))} />
                </div>
              )}
            </div>

            <div className="space-y-1"><Label htmlFor="p-date">تاريخ النفاذ</Label><Input id="p-date" type="date" dir="ltr" value={pDate} onChange={(e) => setPDate(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="p-reason">سبب الترقية / التغيير</Label><Textarea id="p-reason" rows={2} value={pReason} onChange={(e) => setPReason(e.target.value)} placeholder="أداء متميز، إكمال فترة تدريب، تعديل جدول دوام…" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoOpen(false)}>إلغاء</Button>
            <Button disabled={createPromo.isPending} onClick={submitPromo}>{createPromo.isPending ? "جارٍ…" : "حفظ الترقية"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== نافذة إنهاء الخدمة ===== */}
      <Dialog open={termOpen} onOpenChange={(o) => { setTermOpen(o); if (!o) resetTerm(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>إنهاء خدمة موظف</DialogTitle></DialogHeader>
          <div className="rounded-md p-3 mb-1 text-xs flex items-start gap-2 bg-destructive/10 text-destructive">
            <UserMinus className="size-4 mt-0.5 shrink-0" />
            <span>إجراء حسّاس: عند الإكمال يُستثنى الموظف من المسيّرات ويُحسب رصيده النهائي. تبقى سجلّاته للأرشيف.</span>
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="t-emp">الموظف</Label>
              <select id="t-emp" className={selectCls} value={tEmp} onChange={(e) => setTEmp(e.target.value)}>
                <option value="">— اختر موظفاً —</option>
                {activeEmps.map((e) => <option key={e.id} value={String(e.id)}>{e.fullName}{e.position ? ` — ${e.position}` : ""}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="t-type">نوع الإنهاء</Label>
                <select id="t-type" className={selectCls} value={tType} onChange={(e) => setTType(e.target.value)}>
                  {TERMINATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-1"><Label htmlFor="t-lastday">آخر يوم عمل</Label><Input id="t-lastday" type="date" dir="ltr" value={tLastDay} onChange={(e) => setTLastDay(e.target.value)} /></div>
            </div>
            {selectedTermEmp && (selectedTermEmp.userId != null || selectedTermEmp.deviceLinked) && (
              <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs space-y-1" data-testid="termination-preflight">
                <div className="font-medium text-[var(--sem-warn)]">سيُنفَّذ تلقائياً عند إكمال الإجراء (لا عند تسجيله):</div>
                <ul className="list-disc ps-4 space-y-0.5 text-muted-foreground">
                  {selectedTermEmp.userId != null && <li>تعطيل حساب دخوله للنظام وإنهاء جلساته المفتوحة فوراً.</li>}
                  {selectedTermEmp.deviceLinked && (
                    // حدٌّ لا قطع (0207): الإكمال يقع بعد يوم العمل الأخير، فقطعُ الربط
                    // يمحو نسبةَ بصمات ذلك اليوم إن لم تُطوَ بعد — وهو يومُ أجرٍ كامل.
                    <li>حدُّ ربطه بجهاز الحضور بيوم العمل الأخير ({tLastDay}) — بصماتُ ذلك اليوم تُنسَب إليه، وما بعده لا يُنسب. أيام حضوره المسجّلة تبقى.</li>
                  )}
                </ul>
              </div>
            )}
            <div className="rounded-md border p-3 space-y-3" data-testid="termination-breakdown">
              <div>
                <div className="text-sm font-medium">تفكيك التسوية اليدوي المعتمد</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  لا يحسب النظام نسبة أو استحقاقاً قانونياً تلقائياً. تُدخل الموارد البشرية القيم
                  التي حُسبت وراجعتها الجهة المختصة، ثم يعتمدها مستخدم آخر عند الإكمال.
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="t-earned-gross">إجمالي الأجور المكتسبة حتى آخر يوم (د.ع)</Label>
                  <MoneyInput id="t-earned-gross" value={tBreakdown.earnedGrossWages} onChange={(value) => setTBreakdown((current) => ({ ...current, earnedGrossWages: value }))} decimals={2} placeholder="0" />
                  {expectedWage != null && (
                    <div className={`text-[11px] rounded-md border p-2 leading-relaxed ${wageDiverged ? "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]" : "text-muted-foreground"}`}>
                      <span className="font-medium">سجلّ الحضور يقول {iqd(expectedWage)} د.ع</span>
                      {" "}حتى {tLastDay} (بتركيب بند المسيّر: أساس + مخصّصات + أوفر تايم).
                      {wageDiverged && (
                        <> الفارق <b dir="ltr">{iqd(wageGap!.toFixed(2))}</b> د.ع.
                          {wagePlannedAhead
                            ? " إنهاءٌ مخطَّط — بصماتُ الأيام الباقية لم تصل بعد، فالاشتقاق ناقصٌ ولا يُلزمك."
                            : wageEnforced
                              ? " صحّح الرقم أو اذكر سبب الاختلاف أدناه."
                              : " أساسُ أجر هذا الموظف ليس الحضور، فالمقارنة للاطّلاع."}
                        </>
                      )}
                    </div>
                  )}
                  {wageEnforced && (
                    <div className="space-y-1">
                      <Label htmlFor="t-wage-reason">سبب اختلاف الأجر عن سجلّ الحضور</Label>
                      <Input
                        id="t-wage-reason"
                        value={tWageReason}
                        onChange={(e) => setTWageReason(e.target.value)}
                        placeholder="مثال: بدل إجازةٍ غير مسجّل، أو تصحيحُ بصمةٍ لم يُطوَ بعد"
                      />
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-wage-reductions">تخفيضات الأجر المعتمدة (د.ع)</Label>
                  <MoneyInput id="t-wage-reductions" value={tBreakdown.wageReductions} onChange={(value) => setTBreakdown((current) => ({ ...current, wageReductions: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-advance-recovery">استرداد السلفة من الأجر (د.ع)</Label>
                  <MoneyInput id="t-advance-recovery" value={tBreakdown.advanceRecovery} onChange={(value) => setTBreakdown((current) => ({ ...current, advanceRecovery: value }))} decimals={2} placeholder="0" />
                  <div className="text-[11px] text-muted-foreground">
                    الرصيد النشط: {advanceBalance.isLoading ? "جارٍ التحميل…" : iqd(advanceBalance.data?.balance ?? "0")} د.ع؛ يبقى غير المسترد ذمةً على الموظف.
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-income-tax">ضريبة الدخل المعتمدة (د.ع)</Label>
                  <MoneyInput id="t-income-tax" value={tBreakdown.incomeTax} onChange={(value) => setTBreakdown((current) => ({ ...current, incomeTax: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-ss-employee">حصة الموظف من الضمان (د.ع)</Label>
                  <MoneyInput id="t-ss-employee" value={tBreakdown.employeeSocialSecurity} onChange={(value) => setTBreakdown((current) => ({ ...current, employeeSocialSecurity: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-ss-employer">حصة الشركة من الضمان (د.ع)</Label>
                  <MoneyInput id="t-ss-employer" value={tBreakdown.employerSocialSecurity} onChange={(value) => setTBreakdown((current) => ({ ...current, employerSocialSecurity: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-leave">تعويض رصيد الإجازات (د.ع)</Label>
                  <MoneyInput id="t-leave" value={tBreakdown.leaveCompensation} onChange={(value) => setTBreakdown((current) => ({ ...current, leaveCompensation: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-notice">تعويض مدة الإشعار (د.ع)</Label>
                  <MoneyInput id="t-notice" value={tBreakdown.noticeCompensation} onChange={(value) => setTBreakdown((current) => ({ ...current, noticeCompensation: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-eos">استحقاق نهاية الخدمة المعتمد (د.ع)</Label>
                  <MoneyInput id="t-eos" value={tBreakdown.eosBenefit} onChange={(value) => setTBreakdown((current) => ({ ...current, eosBenefit: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-other">مستحق آخر مصنّف (د.ع)</Label>
                  <MoneyInput id="t-other" value={tBreakdown.otherSettlement} onChange={(value) => setTBreakdown((current) => ({ ...current, otherSettlement: value }))} decimals={2} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="t-other-label">تصنيف المستحق الآخر</Label>
                  <Input id="t-other-label" value={tBreakdown.otherSettlementLabel} onChange={(event) => setTBreakdown((current) => ({ ...current, otherSettlementLabel: event.target.value }))} placeholder="مثال: مكافأة تعاقدية معتمدة" />
                </div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">صافي الأجور بعد التخفيض والسلفة والضريبة وحصة الموظف</span>
                <span className="tabular-nums font-semibold" dir="ltr">{iqd(tEarnedNet)}</span>
              </div>
              <div className="rounded-md bg-muted/60 px-3 py-2 flex items-center justify-between gap-3">
                <Label htmlFor="t-settle">إجمالي التسوية المشتق</Label>
                <MoneyInput id="t-settle" className="max-w-48 text-left font-semibold" value={tSettlement} onChange={() => undefined} decimals={2} disabled />
              </div>
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="t-evidence">مرجع المراجعة البشرية ومصدر القيم</Label>
                <Textarea id="t-evidence" rows={2} value={tEvidenceNote} onChange={(event) => setTEvidenceNote(event.target.value)} placeholder="مثال: كشف المحاسب رقم… ومراجعة الموارد البشرية بتاريخ…" />
              </div>
              <label className="flex items-start gap-2 text-xs leading-5">
                <Checkbox checked={tZeroAmountsAttested} onCheckedChange={(checked) => setTZeroAmountsAttested(checked === true)} />
                <span>أقرّ بأن جميع القيم، بما فيها الأصفار، أُدخلت عمداً بعد مراجعة بشرية ولا تمثل احتساباً قانونياً تلقائياً.</span>
              </label>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="t-payment-method">طريقة صرف التسوية بعد الاعتماد</Label>
                <select id="t-payment-method" className={selectCls} value={tPaymentMethod} onChange={(event) => setTPaymentMethod(event.target.value as typeof tPaymentMethod)}>
                  {Object.entries(TERMINATION_PAYMENT_METHOD_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="t-payment-reference">مرجع وسيلة الدفع</Label>
                <Input id="t-payment-reference" value={tPaymentReference} onChange={(event) => setTPaymentReference(event.target.value)} disabled={tPaymentMethod === "CASH"} inputMode={tPaymentMethod === "CARD" ? "numeric" : undefined} maxLength={tPaymentMethod === "CARD" ? 4 : undefined} placeholder={tPaymentMethod === "CASH" ? "لا يلزم للدفع النقدي" : tPaymentMethod === "CARD" ? "آخر 4 أرقام" : "إلزامي قبل الحفظ"} />
              </div>
            </div>
            <div className="space-y-1"><Label htmlFor="t-reason">السبب / ملاحظات</Label><Textarea id="t-reason" rows={2} value={tReason} onChange={(e) => setTReason(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTermOpen(false)}>إلغاء</Button>
            <Button className="bg-destructive text-white hover:bg-destructive/90" disabled={createTerm.isPending} onClick={submitTerm}>{createTerm.isPending ? "جارٍ…" : "حفظ إجراء الإنهاء"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* عكس الصرف مستقل عن عكس الاستحقاق: يُعاد المال أولاً ثم يُتاح عكس القيد. */}
      <Dialog open={reverseTarget !== null} onOpenChange={(open) => { if (!open) { setReverseTarget(null); setReverseReason(""); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{reverseTarget?.mode === "payment"
              ? "عكس صرف تسوية نهاية الخدمة"
              : reverseTarget?.mode === "reissue"
                ? "إعادة إصدار طلب صرف التسوية"
                : "عكس إثبات استحقاق نهاية الخدمة"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5">
              {reverseTarget?.mode === "payment"
                ? `ستُسجّل إعادة المبلغ من «${reverseTarget.employeeName}» بإيصال قبض وقيد مستقل، ويُعاد فتح الالتزام قبل السماح بعكس الاستحقاق.`
                : reverseTarget?.mode === "reissue"
                  ? `سيُنشأ طلب صرف جديد للالتزام المفتوح الخاص بـ«${reverseTarget.employeeName}». لا يُعاد إثبات الاستحقاق، ويجب أن يعتمده مالك آخر.`
                  : `سيُعكس قيد الاستحقاق الخاص بـ«${reverseTarget?.employeeName ?? "الموظف"}» بقيد مستقل مع إبقاء سجل إنهاء الخدمة؛ لا يُعاد تفعيل حساب الموظف تلقائياً.`}
            </div>
            {reverseTarget?.mode === "payment" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="termination-reversal-method">طريقة إعادة المبلغ</Label>
                  <select id="termination-reversal-method" className={selectCls} value={reverseMethod} onChange={(event) => setReverseMethod(event.target.value as typeof reverseMethod)}>
                    {Object.entries(TERMINATION_PAYMENT_METHOD_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="termination-reversal-date">تاريخ إعادة المبلغ</Label>
                  <Input id="termination-reversal-date" type="date" dir="ltr" value={reverseDate} onChange={(event) => setReverseDate(event.target.value)} />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="termination-reversal-reference">مرجع وسيلة الدفع</Label>
                  <Input id="termination-reversal-reference" value={reverseReference} onChange={(event) => setReverseReference(event.target.value)} disabled={reverseMethod === "CASH"} placeholder={reverseMethod === "CASH" ? "لا يلزم للإعادة النقدية" : "إلزامي"} />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="termination-reversal-reason">سبب العكس الموثق</Label>
              <Textarea id="termination-reversal-reason" rows={3} value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="سبب واضح يظهر في الأثر التدقيقي" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>إلغاء</Button>
            <Button variant={reverseTarget?.mode === "reissue" ? "default" : "destructive"} disabled={reversePayment.isPending || reverseRecognition.isPending || reissuePayment.isPending} onClick={submitReversal}>
              {reversePayment.isPending || reverseRecognition.isPending || reissuePayment.isPending
                ? "جارٍ التسجيل…"
                : reverseTarget?.mode === "reissue" ? "إصدار طلب جديد" : "تسجيل العكس"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

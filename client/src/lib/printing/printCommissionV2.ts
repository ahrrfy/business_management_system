/* ============================================================================
 * كشف عمولة موظف — A4 بالتصميم المرجعي V2 (وحدة الأهداف والعمولات، S4).
 *
 * ملف مستقل عن printTemplatesV2.ts عمداً (ملكية شريحة العمولات — مساعدات docHtml
 * المشتركة كلها مُصدَّرة). يُستدعى من شاشة تشغيلات العمولة لكل سطر معتمد/مسودة.
 * ========================================================================== */
import {
  docTableV2,
  grandTotalBar,
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  tafqitLine,
  wrapA4Doc,
  type CompanySettings,
} from "./docHtml";
import { esc, fmt, openPrintWindow } from "./brand";
import { formatArabicMoneyWords } from "./tafqit";

export interface CommissionStatementV2Data {
  runId: number;
  period: string; // YYYY-MM
  statusLabel: string; // «مسودة» | «معتمدة»
  employeeName: string;
  position?: string | null;
  branchName?: string | null;
  planName: string;
  tierMode: "TARGET_PCT" | "AMOUNT_SLAB";
  baseSales: string;
  baseReturns: string;
  carryIn: string;
  effectiveBase: string;
  targetAmount?: string | null;
  achievementPct?: string | null;
  tierApplied: boolean;
  tierThreshold?: string | null;
  ratePct: string;
  fixedBonus: string;
  commissionAmount: string;
  carryOut: string;
  computedAt?: string | null;
  settings?: CompanySettings;
}

export function printCommissionStatementV2(d: CommissionStatementV2Data): boolean {
  const header = pageHeader(
    {
      title: "كشف عمولة مبيعات",
      subtitle: "احتساب شهري من دفتر المبيعات — صافي المبيعات بعد المرتجعات والمرحَّل",
      fields: [
        { label: "رقم التشغيلة", value: `CR-${d.runId}` },
        { label: "الشهر", value: d.period },
        ...(d.computedAt ? [{ label: "تاريخ الاحتساب", value: d.computedAt }] : []),
      ],
      badge: { label: d.statusLabel, color: d.statusLabel === "معتمدة" ? "#0D6B52" : "#B7791F" },
    },
    d.settings,
  );

  const cards = infoCards([
    {
      title: "الموظف",
      variant: "green",
      fields: [
        { label: "الاسم", value: d.employeeName },
        { label: "الوظيفة", value: d.position || "—" },
        { label: "الفرع", value: d.branchName || "—" },
      ],
    },
    {
      title: "خطة العمولة",
      variant: "gray",
      fields: [
        { label: "الخطة", value: d.planName },
        { label: "النمط", value: d.tierMode === "TARGET_PCT" ? "شرائح بنسبة تحقيق الهدف" : "شرائح بمبلغ المبيعات" },
        {
          label: "الشريحة المطبَّقة",
          value: d.tierApplied ? `من ${fmt(d.tierThreshold ?? "0")}${d.tierMode === "TARGET_PCT" ? "٪" : " د.ع"} ← ${Number(d.ratePct)}٪` : "لم تُبلغ أي شريحة",
        },
      ],
    },
  ]);

  const table = docTableV2(
    [
      { key: "sales", label: "المبيعات", width: 100 },
      { key: "returns", label: "المرتجعات (−)", width: 100, color: "#B42318" },
      { key: "carryIn", label: "مرحَّل سابق", width: 90 },
      { key: "base", label: "القاعدة الفعلية", width: 110, emphasize: true },
      { key: "target", label: "الهدف", width: 100 },
      { key: "ach", label: "الإنجاز", width: 70 },
      { key: "rate", label: "النسبة", width: 60 },
      { key: "bonus", label: "مكافأة", width: 80 },
    ],
    [
      {
        sales: fmt(d.baseSales),
        returns: Number(d.baseReturns) > 0 ? `−${fmt(d.baseReturns)}` : "—",
        carryIn: Number(d.carryIn) !== 0 ? fmt(d.carryIn) : "—",
        base: fmt(d.effectiveBase),
        target: d.targetAmount != null ? fmt(d.targetAmount) : "—",
        ach: d.achievementPct != null ? `${Number(d.achievementPct)}٪` : "—",
        rate: d.tierApplied ? `${Number(d.ratePct)}٪` : "—",
        bonus: Number(d.fixedBonus) > 0 ? fmt(d.fixedBonus) : "—",
      },
    ],
    { hideIndex: true },
  );

  const carryNote =
    Number(d.carryOut) !== 0
      ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #B42318;border-radius:4px;background:#FEF3F2">
          <span style="font-size:10.75px;font-weight:800;color:#B42318">مرحَّل للشهر التالي: </span>
          <span style="font-size:12.25px;font-weight:800;color:#B42318;direction:ltr;unicode-bidi:isolate">${esc(fmt(d.carryOut))} د.ع</span>
          <span style="font-size:10.25px;color:#000"> — عجز الشهر (مرتجعات تفوق المبيعات) يُخصم من وعاء الأشهر القادمة، لا من الراتب.</span>
        </div>`
      : "";

  const grand = grandTotalBar("العمولة المستحقّة عن الشهر", fmt(d.commissionAmount), { big: true });
  const tafqit = tafqitLine(formatArabicMoneyWords(d.commissionAmount));

  const signatures = `<div style="margin-top:30px;display:flex;justify-content:space-between;gap:24px">
    ${["الموظف", "المحاسب", "المدير المفوَّض"]
      .map(
        (l) => `<div style="flex:1;text-align:center">
          <div style="height:34px"></div>
          <div style="border-top:1px solid #0F1613;padding-top:5px;font-size:10.25px;color:#000;font-weight:600">${esc(l)}</div>
        </div>`,
      )
      .join("")}
  </div>
  <div style="margin-top:10px;font-size:9.75px;color:#8B8E89">الصرف عبر مسيّر الرواتب الشهري — هذا الكشف بيان احتساب لا سند صرف.</div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${carryNote}${grand}${tafqit}${signatures}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF CR-${d.runId}/${d.period}` })}`;
  return openPrintWindow(wrapA4Doc(`كشف عمولة ${d.employeeName} — ${d.period}`, body));
}

/**
 * إيصال تسوية كشف شركة توصيل حراري (80mm)
 * يُطبع عند توريد نقد كشف شركة التوصيل لإثبات المبالغ المسددة، الاستقطاعات، والصافي المورّد للدرج.
 */
import { CO, esc, fmt, logoUrl, openPrintWindow } from "./brand";
import { wrapReceiptDoc } from "./docHtml";
import { code128Svg } from "./barcode";
import { qrCodeSvgSync } from "./qr";
import { fmtDateTime } from "../date";

export interface CompanyStatementReceiptData {
  companyName: string;
  statementNumber: string;
  remittanceNumber: string | null;
  deliveriesConfirmed: number;
  collectedTotal: string;
  deductionsTotal?: string | null;
  netRemitted: string;
  remainingOpenCount?: number;
  remainingOpenAmount?: string;
  settledAt?: Date | string;
  notes?: string | null;
}

export function printCompanyStatementReceipt(d: CompanyStatementReceiptData): boolean {
  const logo = logoUrl();
  const collectedNum = Number(d.collectedTotal || 0);
  const deductionsNum = Number(d.deductionsTotal || 0);
  const netNum = Number(d.netRemitted || 0);

  let barSvg = "";
  try {
    const bc = code128Svg(d.statementNumber, { moduleWidth: 1.35, height: 45, showText: true });
    barSvg = bc.svg;
  } catch {
    /* ignore */
  }

  const qrPayload = d.statementNumber
    ? `https://alarabiya.online/stmt/${encodeURIComponent(d.statementNumber)}`
    : `REMIT:${d.remittanceNumber ?? ""}`;
  const qrSvg = qrCodeSvgSync(qrPayload, { size: 125, margin: 1 });

  const body = `
  <div style="text-align:center;margin-bottom:2mm;">
    ${logo ? `<img src="${logo}" style="height:44px;margin-bottom:1.5mm;" onerror="this.style.display='none'">` : ""}
    <div style="font-size:15px;font-weight:900;color:#000;">${esc(CO.name)}</div>
    <div style="font-size:11px;font-weight:800;color:#000;">${esc(CO.sub)}</div>
  </div>

  <div style="border-top:2.5px solid #000;border-bottom:2.5px solid #000;padding:2mm 0;text-align:center;margin:2.5mm 0;background:#000;color:#fff;">
    <span style="font-size:13.5px;font-weight:900;letter-spacing:0.5px;">إيصال تسوية كشف شركة توصيل</span>
  </div>

  ${barSvg ? `
  <div style="text-align:center;margin:3mm 0;overflow:hidden;">
    <div style="display:inline-block;max-width:100%;">${barSvg}</div>
  </div>` : ""}

  <div style="margin:2.5mm 0;font-size:11px;color:#000;">
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">شركة التوصيل:</span>
      <span style="font-weight:900;font-size:12px;">${esc(d.companyName)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">رقم كشف الشركة:</span>
      <span style="font-weight:900;direction:ltr;font-size:12px;">${esc(d.statementNumber)}</span>
    </div>
    ${d.remittanceNumber ? `
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">رقم سند التوريد:</span>
      <span style="font-weight:900;direction:ltr;font-size:12px;">${esc(d.remittanceNumber)}</span>
    </div>` : ""}
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">تاريخ التسوية:</span>
      <span style="font-weight:800;">${fmtDateTime(d.settledAt ?? new Date())}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">عدد الطرود المسلّمة:</span>
      <span style="font-weight:900;font-size:12px;">${d.deliveriesConfirmed} طرد</span>
    </div>
  </div>

  <!-- الحسابات المالية للكشف -->
  <div style="margin:3mm 0;border:2px solid #000;border-radius:5px;padding:2.5mm;background:#fff;color:#000;">
    <div style="display:flex;justify-content:space-between;font-size:11.5px;padding:1mm 0;">
      <span style="font-weight:800;">إجمالي مبالغ الطرود (COD):</span>
      <span style="font-weight:900;">${fmt(collectedNum)} د.ع</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11.5px;padding:1mm 0;border-top:1.5px dashed #000;margin-top:1mm;padding-top:1mm;">
      <span style="font-weight:800;">استقطاعات الشركة (أجور/عمولات):</span>
      <span style="font-weight:900;">- ${fmt(deductionsNum)} د.ع</span>
    </div>

    <!-- صافي المقبوض -->
    <div style="border-top:2.5px solid #000;margin-top:2mm;padding-top:2mm;text-align:center;background:#f5f5f5;border-radius:4px;padding-bottom:1.5mm;">
      <div style="font-size:11.5px;font-weight:900;color:#000;">صافي النقد المورّد للدرج / الصندوق</div>
      <div style="font-size:20px;font-weight:900;color:#000;margin-top:1mm;letter-spacing:0.5px;">
        ${fmt(netNum)} د.ع
      </div>
    </div>
  </div>

  ${d.remainingOpenCount != null && d.remainingOpenCount > 0 ? `
  <div style="margin:2.5mm 0;border:2px solid #000;border-radius:5px;padding:2mm;font-size:10.5px;background:#fff;color:#000;">
    <div style="font-weight:900;font-size:11.5px;margin-bottom:1mm;border-bottom:1.5px solid #000;padding-bottom:0.5mm;">الطرود المتبقية بذمة الشركة:</div>
    <div style="display:flex;justify-content:space-between;padding:0.5mm 0;">
      <span style="font-weight:800;">عدد الطرود المتبقية:</span>
      <span style="font-weight:900;">${d.remainingOpenCount} طرد</span>
    </div>
    ${d.remainingOpenAmount ? `
    <div style="display:flex;justify-content:space-between;padding:0.5mm 0;">
      <span style="font-weight:800;">إجمالي القيمة المعلقة:</span>
      <span style="font-weight:900;">${fmt(d.remainingOpenAmount)} د.ع</span>
    </div>` : ""}
  </div>` : ""}

  ${d.notes ? `
  <div style="margin:2.5mm 0;font-size:10.5px;font-weight:800;border:1.5px dashed #000;padding:2mm;border-radius:4px;background:#fafafa;color:#000;">
    <b>ملاحظات:</b> ${esc(d.notes)}
  </div>` : ""}

  <!-- رمز QR عريض وفائق الوضوح للتحقق والمسح السريع -->
  <div style="text-align:center;margin:3.5mm 0 2mm 0;border:2px solid #000;border-radius:5px;padding:2.5mm;background:#fff;">
    <div style="font-weight:900;font-size:11px;margin-bottom:1.5mm;color:#000;">
      رمز التحقق والمطابقة السريع (QR)
    </div>
    <div style="display:inline-block;padding:2px;background:#fff;">
      ${qrSvg}
    </div>
    <div style="font-size:9.5px;font-weight:800;color:#000;margin-top:1.5mm;">
      امسح الرمز للتحقق من قيد التسوية في النظام
    </div>
  </div>

  <!-- التواقيع -->
  <div style="margin-top:4mm;display:flex;justify-content:space-between;font-size:11px;font-weight:900;border-top:2px dashed #000;padding-top:2.5mm;color:#000;">
    <div style="text-align:center;width:48%;">
      <div>توقيع الكاشير / أمين الصندوق</div>
      <div style="height:9mm;"></div>
      <div style="border-top:1.5px solid #000;margin:0 3mm;"></div>
    </div>
    <div style="text-align:center;width:48%;">
      <div>توقيع ممثل شركة التوصيل</div>
      <div style="height:9mm;"></div>
      <div style="border-top:1.5px solid #000;margin:0 3mm;"></div>
    </div>
  </div>

  <div style="margin-top:3.5mm;text-align:center;font-size:10px;font-weight:800;color:#000;border-top:1.5px solid #000;padding-top:2mm;line-height:1.4;">
    سند تسوية مالي موثق بنظام إدارة أعمال الرؤية العربية.<br>
    ${CO.phones.length > 0 ? `هاتف الإدارة: ${CO.phones[0].n}` : ""}
  </div>
  `;

  const html = wrapReceiptDoc(`تسوية ${d.statementNumber}`, body);
  return openPrintWindow(html);
}

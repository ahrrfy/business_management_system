/**
 * طباعة وحدة الأصول: ملصق الأصل (QR، مقاس ملصق 80×100مم) + إقرار استلام عهدة (A4 رسمي).
 * يعيد استخدام بنية الطباعة القائمة (brand/qr/docHtml) — تصميم موحّد عبر كل المستندات.
 */
import { CAIRO_FONT, CO, esc, logoUrl, openPrintWindow } from "@/lib/printing/brand";
import { docFooter, docHeader, docTable, wrapA4Doc } from "@/lib/printing/docHtml";
import { qrCodeSvg } from "@/lib/printing/qr";
import { fmtInt } from "@/lib/money";

export interface AssetLabelData {
  code: string;
  name: string;
  serial?: string | null;
  branchName?: string | null;
  category?: string | null;
}

/** ملصق أصل بمقاس 80×100مم مع رمز QR — يُطبع تلقائياً. */
export async function printAssetLabel(a: AssetLabelData): Promise<void> {
  const qrSvg = await qrCodeSvg(a.code, { size: 150, margin: 1 }).catch(() => "");
  const logo = logoUrl();
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق ${esc(a.code)}</title>
  ${CAIRO_FONT}
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    @page{size:80mm 100mm;margin:0}
    body{font-family:'Cairo',sans-serif;width:80mm;height:100mm;background:#fff;color:#000;direction:rtl;
      display:flex;flex-direction:column;align-items:center;padding:4mm 3mm;text-align:center;}
    .brand{display:flex;align-items:center;gap:1.5mm;justify-content:center;}
    .brand img{width:7mm;height:7mm;object-fit:contain;}
    .brand span{font-size:10px;font-weight:800;}
    .name{font-size:12px;font-weight:700;margin:1.5mm 0;line-height:1.3;max-height:11mm;overflow:hidden;}
    .qr{width:42mm;height:42mm;margin:1mm auto;}
    .qr svg{width:100%;height:100%;}
    .code{font-size:16px;font-weight:900;letter-spacing:0.5px;direction:ltr;margin-top:1mm;}
    .meta{font-size:8.5px;color:#333;margin-top:1mm;line-height:1.5;}
    .meta b{font-weight:700;}
    .divider{width:100%;border-top:1px dashed #999;margin:1.5mm 0;}
  </style></head>
  <body>
    <div class="brand"><img src="${logo}" alt="" onerror="this.style.display='none'"><span>${esc(CO.sub)}</span></div>
    <div class="divider"></div>
    <div class="name">${esc(a.name)}</div>
    <div class="qr">${qrSvg}</div>
    <div class="code">${esc(a.code)}</div>
    <div class="meta">
      ${a.serial ? `<div>الرقم التسلسلي: <b dir="ltr">${esc(a.serial)}</b></div>` : ""}
      ${a.branchName ? `<div>الفرع: <b>${esc(a.branchName)}</b></div>` : ""}
    </div>
  </body></html>`;
  openPrintWindow(html, "width=340,height=460");
}

export interface CustodyAckData {
  employeeName: string;
  date?: string;
  items: { code: string; name: string; serial?: string | null; bookValue: number }[];
}

/** إقرار استلام عهدة رسمي (A4) — جدول أصول الموظف + توقيعان. */
export function printCustodyAck(d: CustodyAckData): void {
  const cols = [
    { key: "code", label: "الرمز", width: "24mm" },
    { key: "name", label: "الأصل" },
    { key: "serial", label: "الرقم التسلسلي", width: "32mm" },
    { key: "value", label: "القيمة الدفترية", width: "28mm", align: "left" as const, bold: true },
  ];
  const rows = d.items.map((i) => ({
    code: i.code,
    name: i.name,
    serial: i.serial ?? "—",
    value: fmtInt(i.bookValue),
  }));
  const total = d.items.reduce((s, i) => s + Number(i.bookValue || 0), 0);

  const intro = `<div style="font-size:10.5px;line-height:1.9;margin-bottom:4mm;">
    أُقِرّ أنا الموظّف <b>${esc(d.employeeName)}</b> باستلامي العُهدة المبيّنة أدناه بحالتها السليمة،
    وأتعهّد بالمحافظة عليها واستخدامها لأغراض العمل، وإعادتها عند الطلب أو انتهاء الخدمة، وأكون مسؤولاً
    عن أي فقدان أو تلف ناتج عن الإهمال.
  </div>`;
  const totalRow = `<div style="display:flex;justify-content:space-between;background:#f4f4f5;border:1px solid #e4e4e7;
    border-radius:0 0 4px 4px;padding:2.5mm 3mm;font-size:11px;font-weight:800;margin-top:-1mm;margin-bottom:5mm;">
    <span>إجمالي القيمة الدفترية للعهدة (${d.items.length} أصل)</span><span dir="ltr">${fmtInt(total)} د.ع</span></div>`;
  const signatures = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14mm;margin-top:12mm;">
    <div style="text-align:center;border-top:1px solid #999;padding-top:2mm;font-size:10px;color:#555;">توقيع الموظف المُستلِم</div>
    <div style="text-align:center;border-top:1px solid #999;padding-top:2mm;font-size:10px;color:#555;">توقيع المسؤول / الموارد البشرية</div>
  </div>`;

  const body = [
    docHeader("إقرار استلام عهدة", undefined, d.date ?? new Date().toLocaleDateString("en-GB"), [{ label: "الموظف", value: d.employeeName }]),
    intro,
    docTable(cols, rows),
    totalRow,
    signatures,
    docFooter(),
  ].join("");
  openPrintWindow(wrapA4Doc(`إقرار عهدة — ${d.employeeName}`, body));
}

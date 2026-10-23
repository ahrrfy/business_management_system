import React from "react";
import type { RouterOutputs } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";

type Consignment = RouterOutputs["delivery"]["consignments"]["rows"][number];
type FinancialDetails = Pick<
  Consignment,
  | "codAmount"
  | "collectedAmount"
  | "counterSettledAmount"
  | "shortfallAssigned"
  | "deliveryFee"
  | "dispatchedAt"
  | "courierDeliveredAt"
  | "remittanceNumber"
>;

export function CompanyConsignmentFinancials({
  row,
}: {
  row: FinancialDetails;
}) {
  const money = [
    ["قيمة COD", row.codAmount],
    ["سوي بالتوريد", row.collectedAmount],
    ["سوي في المكتبة", row.counterSettledAmount],
    ["عجز محمل", row.shortfallAssigned],
    ["أجرة التوصيل", row.deliveryFee],
  ];
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        تفاصيل التسوية والإرسال
      </summary>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 pt-2">
        {money.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words tabular-nums">{fmt(value)} د.ع</dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="text-muted-foreground">الإرسال</dt>
          <dd className="break-words">
            {row.dispatchedAt ? fmtDate(row.dispatchedAt) : "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">الوصول للعميل</dt>
          <dd className="break-words">
            {row.courierDeliveredAt ? fmtDate(row.courierDeliveredAt) : "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">التوريد</dt>
          <dd className="break-all">{row.remittanceNumber ?? "—"}</dd>
        </div>
      </dl>
    </details>
  );
}

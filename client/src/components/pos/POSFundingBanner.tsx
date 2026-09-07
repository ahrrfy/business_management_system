/**
 * لافتة عهدة نقدية بانتظار استلام الكاشير
 * مستخرجة من POS.tsx لصيانة سقف حجم الصفحة ومنع تضخم الكود
 */

import { Link } from "wouter";
import { fmt, type PosColors as C } from "./posShared";

export interface FundingRequestItem {
  requestReceiptId: number;
  amount: string | number;
}

export interface POSFundingBannerProps {
  C: C;
  posFundingRequests: FundingRequestItem[];
  isPending: boolean;
  onAccept: (requestReceiptId: number) => void;
}

export function POSFundingBanner({ C, posFundingRequests, isPending, onAccept }: POSFundingBannerProps) {
  if (!posFundingRequests.length) return null;

  return (
    <div
      data-testid="pos-shift-funding-banner"
      style={{
        margin: "6px 8px 0",
        border: `1px solid ${C.amber}`,
        background: C.amberSoft,
        borderRadius: 8,
        padding: "8px 10px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 13 }}>عهدة نقدية بانتظار استلامك</div>
        <div style={{ fontSize: 12, color: C.mutedFg }}>
          لا تُضاف إلى الدرج إلا بعد عدّ النقد فعلياً وتأكيد الاستلام.
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {posFundingRequests.map((request) => (
          <div key={request.requestReceiptId} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 13 }}>{fmt(Number(request.amount))} د.ع</span>
            <button
              type="button"
              disabled={isPending}
              onClick={() => onAccept(request.requestReceiptId)}
              style={{
                border: 0,
                borderRadius: 6,
                padding: "6px 10px",
                background: C.success,
                color: "white",
                fontWeight: 900,
                cursor: isPending ? "not-allowed" : "pointer",
              }}
            >
              {isPending ? "جارٍ التثبيت…" : "استلمت النقد"}
            </button>
          </div>
        ))}
        <Link
          href="/shifts"
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "6px 10px",
            color: C.fg,
            fontSize: 12,
            fontWeight: 800,
            textDecoration: "none",
            background: C.card,
          }}
        >
          مراجعة الطلب أو رفضه
        </Link>
      </div>
    </div>
  );
}

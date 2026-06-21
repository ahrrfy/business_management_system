import { fmtAr } from "@/lib/money";
import { Clock, User } from "lucide-react";
import { Link } from "wouter";

interface OpenShiftCard {
  shiftId: number;
  branchId: number;
  branchName: string;
  userId: number;
  userName: string;
  openingBalance: string;
  expectedCash: string;
  cashIn: string;
  cashOut: string;
  openedAt: string;
}

interface OpenShiftsPanelProps {
  shifts: OpenShiftCard[];
  loading?: boolean;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "للتوّ";
  if (minutes < 60) return `منذ ${minutes.toLocaleString("ar-IQ-u-nu-latn")} د`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours.toLocaleString("ar-IQ-u-nu-latn")} س`;
  const days = Math.floor(hours / 24);
  return `منذ ${days.toLocaleString("ar-IQ-u-nu-latn")} يوم`;
}

export function OpenShiftsPanel({ shifts, loading }: OpenShiftsPanelProps) {
  if (loading) {
    return (
      <div className="rounded-md border bg-card p-4 animate-pulse">
        <div className="h-3 w-32 bg-muted rounded mb-3" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-muted/60 rounded mb-2" />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">الورديات المفتوحة الآن</h3>
        <span className="text-xs text-muted-foreground tabular-nums" dir="ltr">
          {shifts.length}
        </span>
      </div>
      {shifts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground bg-muted/30 rounded py-8">
          لا ورديات مفتوحة الآن.
        </div>
      ) : (
        <div className="space-y-2 overflow-y-auto max-h-[400px] pr-1">
          {shifts.map((s) => (
            <Link
              key={s.shiftId}
              href="/shifts"
              className="block rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium truncate">
                    <User className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="truncate">{s.userName}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{s.branchName}</div>
                </div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1 flex-shrink-0">
                  <Clock className="h-3 w-3" />
                  <span>{relativeTime(s.openedAt)}</span>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <div className="text-muted-foreground">الافتتاحي</div>
                  <div className="tabular-nums font-medium" dir="ltr">
                    {fmtAr(s.openingBalance)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">المتوقّع</div>
                  <div className="tabular-nums font-semibold text-primary" dir="ltr">
                    {fmtAr(s.expectedCash)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">صافي اليوم</div>
                  <div className="tabular-nums font-medium" dir="ltr">
                    {fmtAr(Number(s.cashIn) - Number(s.cashOut))}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

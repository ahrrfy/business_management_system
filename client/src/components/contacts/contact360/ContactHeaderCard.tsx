import { MapPin, Phone, Users, Wallet } from "lucide-react";
import { PRICE_TIER_LABELS as TIER_LABEL } from "@shared/terms";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { fmt } from "@/lib/money";
import type { Contact360Data } from "./types";
function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {Icon && (
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className="min-w-0 break-words text-foreground">{value}</span>
    </div>
  );
}

export function ContactHeaderCard({
  data,
  canViewMoney,
}: {
  data: Contact360Data;
  canViewMoney: boolean;
}) {
  if (data.kind === "customer") {
    const c = data.customer;
    return (
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="info">عميل</Badge>
              <span className="font-bold text-lg min-w-0 break-words">
                {c.name}
              </span>
            </div>
            <WhatsAppShare
              whatsapp={c.whatsapp}
              phone={c.phone}
              alternativePhones={[c.phone2, c.phone3]}
              label="واتساب"
              message={buildOperationalContactMessage({
                entityLabel: "حساب عميل",
                reference: String(c.id),
                partyName: c.name,
                title: "متابعة خدمة العملاء والحساب",
              })}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <InfoRow
              icon={Phone}
              label="الهاتف"
              value={c.phone ? <span dir="ltr">{c.phone}</span> : "—"}
            />
            <InfoRow icon={MapPin} label="المدينة" value={c.city || "—"} />
            <InfoRow
              icon={Users}
              label="نوع العميل"
              value={c.customerType || "—"}
            />
            <InfoRow
              label="فئة السعر"
              value={
                TIER_LABEL[c.defaultPriceTier as keyof typeof TIER_LABEL] ??
                c.defaultPriceTier
              }
            />
            <InfoRow
              icon={Wallet}
              label="الرصيد الحالي"
              value={
                <span className="tabular-nums" dir="ltr">
                  {canViewMoney ? fmt(c.currentBalance) : "محجوب"}
                </span>
              }
            />
            <InfoRow
              label="حدّ الائتمان"
              value={
                !canViewMoney ? (
                  "محجوب"
                ) : c.creditLimit == null ? (
                  "بلا حد"
                ) : (
                  <span className="tabular-nums" dir="ltr">
                    {fmt(c.creditLimit)}
                  </span>
                )
              }
            />
          </div>
        </CardContent>
      </Card>
    );
  }
  const s = data.supplier;
  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="warning">مورّد</Badge>
            <span className="font-bold text-lg min-w-0 break-words">
              {s.name}
            </span>
          </div>
          <WhatsAppShare
            whatsapp={s.whatsapp}
            phone={s.phone}
            alternativePhones={[s.phone2, s.phone3]}
            label="واتساب"
            message={buildOperationalContactMessage({
              entityLabel: "حساب مورّد",
              reference: String(s.id),
              partyName: s.name,
              title: "متابعة التوريد والحساب",
            })}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <InfoRow
            icon={Phone}
            label="الهاتف"
            value={s.phone ? <span dir="ltr">{s.phone}</span> : "—"}
          />
          <InfoRow icon={MapPin} label="المدينة" value={s.city || "—"} />
          <InfoRow label="التصنيف" value={s.supplierCategory || "—"} />
          <InfoRow label="شروط الدفع" value={s.paymentTerms || "—"} />
          <InfoRow
            icon={Wallet}
            label="الرصيد الحالي"
            value={
              <span className="tabular-nums" dir="ltr">
                {canViewMoney ? fmt(s.currentBalance) : "محجوب"}
              </span>
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

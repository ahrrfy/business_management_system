import { useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "./ContactSection";
type Consent = "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
const CONSENT_META: Record<
  Consent,
  { label: string; variant: "neutral" | "success" | "danger" }
> = {
  UNKNOWN: { label: "غير معروف", variant: "neutral" },
  OPTED_IN: { label: "موافِق", variant: "success" },
  OPTED_OUT: { label: "ملغى", variant: "danger" },
};
export function WaConsentCard({
  customerId,
  consent,
  canWrite,
}: {
  customerId: number;
  consent: string;
  canWrite: boolean;
}) {
  const utils = trpc.useUtils();
  const mutation = trpc.contacts.waConsent.set.useMutation();
  const [pending, setPending] = useState(false);
  const lock = useRef(false),
    allowed = useRef(canWrite);
  allowed.current = canWrite;
  const current = consent in CONSENT_META ? (consent as Consent) : "UNKNOWN";
  async function update(value: Consent) {
    if (lock.current || !allowed.current || value === current) return;
    lock.current = true;
    setPending(true);
    try {
      await mutation.mutateAsync({ customerId, consent: value });
      void utils.contacts.contact360.invalidate({
        kind: "customer",
        id: customerId,
      });
      notify.ok("تم تحديث حالة الموافقة التسويقية");
    } catch (error) {
      notify.err(error);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <SectionCard icon={MessageSquare} title="الموافقة التسويقية (واتساب)">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={CONSENT_META[current].variant}>
          {CONSENT_META[current].label}
        </Badge>
        {canWrite && (
          <div className="flex flex-wrap gap-1">
            {(Object.keys(CONSENT_META) as Consent[]).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={value === current ? "default" : "outline"}
                disabled={pending || value === current}
                onClick={() => void update(value)}
              >
                {CONSENT_META[value].label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

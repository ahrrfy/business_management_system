import { trpc } from "@/lib/trpc";
import { errMsg } from "@/lib/notify";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { LoadingState, ErrorState } from "@/components/PageState";
import { ContactHeaderCard } from "./contact360/ContactHeaderCard";
import {
  InvoicesCard,
  ConversationsCard,
} from "./contact360/ContactActivityCards";
import { ContactPersonsCard } from "./contact360/ContactPersonsCard";
import { DuplicatesCard } from "./contact360/ContactDuplicatesCard";
import { WaConsentCard } from "./contact360/WaConsentCard";
import { useContactAccess } from "./contact360/useContactAccess";
import type { ContactPanelProps } from "./contact360/types";
export function Contact360Panel(props: ContactPanelProps) {
  return <ContactSession key={`${props.kind}:${props.id}`} {...props} />;
}
function ContactSession({
  kind,
  id,
  onClose,
  onOpenContact,
}: ContactPanelProps) {
  const access = useContactAccess(kind);
  const canRead = access.canRead("contacts.contact360");
  const query = trpc.contacts.contact360.useQuery(
    { kind, id },
    { enabled: canRead },
  );
  const data =
    canRead &&
    !query.isError &&
    query.data?.kind === kind &&
    (query.data.kind === "customer"
      ? query.data.customer.id
      : query.data.supplier.id) === id
      ? query.data
      : undefined;
  const name =
    data?.kind === "customer"
      ? data.customer.name
      : data?.kind === "supplier"
        ? data.supplier.name
        : "بطاقة 360°";
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        dir="rtl"
        className="w-full min-w-0 overflow-hidden sm:max-w-xl"
      >
        <SheetHeader className="min-w-0 shrink-0 pe-12">
          <SheetTitle className="break-words">{name}</SheetTitle>
          <SheetDescription>
            {kind === "customer" ? "بطاقة عميل موحّدة" : "بطاقة مورّد موحّدة"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6">
          {access.loading || (canRead && query.isLoading) ? (
            <LoadingState />
          ) : !canRead ? (
            <p role="alert" className="text-sm text-muted-foreground">
              لا تملك صلاحية عرض بطاقة جهة الاتصال.
            </p>
          ) : query.isError ? (
            <ErrorState
              message={errMsg(query.error)}
              onRetry={() => query.refetch()}
            />
          ) : null}
          {data && (
            <>
              <ContactHeaderCard
                data={data}
                canViewMoney={access.canViewMoney}
              />
              {data.kind === "customer" && (
                <WaConsentCard
                  customerId={id}
                  consent={data.customer.waConsent}
                  canWrite={access.canWrite("contacts.waConsent.set")}
                />
              )}
              {data.kind === "customer" && (
                <InvoicesCard invoices={data.invoices} />
              )}
              <ConversationsCard conversations={data.conversations} />
              <ContactPersonsCard
                partyKind={kind}
                partyId={id}
                access={access}
              />
              <DuplicatesCard
                kind={kind}
                id={id}
                canRead={access.canRead("contacts.findDuplicates")}
                onOpenContact={onOpenContact}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

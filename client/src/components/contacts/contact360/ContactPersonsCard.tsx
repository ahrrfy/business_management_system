import { useEffect, useRef, useState } from "react";
import { Ban, Pencil, Plus, Star, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/PageState";
import { SectionCard } from "./ContactSection";
import { PersonFormDialog } from "./PersonFormDialog";
import type { PartyKind, PersonRow } from "./types";
import type { ContactAccess } from "./useContactAccess";
export function ContactPersonsCard({
  partyKind,
  partyId,
  access,
}: {
  partyKind: PartyKind;
  partyId: number;
  access: ContactAccess;
}) {
  const utils = trpc.useUtils();
  const input =
    partyKind === "customer"
      ? { customerId: partyId }
      : { supplierId: partyId };
  const canRead = access.canRead("contacts.persons.list"),
    canCreate = access.canWrite("contacts.persons.create");
  const canUpdate = access.canWrite("contacts.persons.update"),
    canDeactivate = access.canWrite("contacts.persons.setInactive");
  const list = trpc.contacts.persons.list.useQuery(input, { enabled: canRead });
  const [dialog, setDialog] = useState<{
    key: number;
    person: PersonRow | null;
  } | null>(null);
  const sequence = useRef(0),
    mounted = useRef(true),
    allowed = useRef(canDeactivate),
    lock = useRef(false);
  const [pending, setPending] = useState(false);
  allowed.current = canDeactivate;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const inactive = trpc.contacts.persons.setInactive.useMutation();
  async function deactivate(person: PersonRow) {
    if (lock.current || !allowed.current) return;
    lock.current = true;
    setPending(true);
    try {
      const ok = await confirm({
        variant: "warning",
        title: "تعطيل شخص الاتصال",
        description: `تعطيل «${person.name}»؟ يبقى في السجلّ التاريخي (بلا حذف نهائي).`,
        confirmText: "تعطيل",
      });
      if (!ok || !mounted.current || !allowed.current) return;
      await inactive.mutateAsync({ id: person.id });
      void utils.contacts.persons.list.invalidate(input);
      if (mounted.current) notify.ok("تم تعطيل شخص الاتصال");
    } catch (error) {
      if (mounted.current) notify.err(error);
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  }
  const rows = canRead && !list.isError ? (list.data ?? []) : [];
  const open = (person: PersonRow | null) =>
    setDialog({ key: ++sequence.current, person });
  const canSubmit = dialog?.person ? canRead && canUpdate : canCreate;
  return (
    <SectionCard
      icon={Users}
      title="أشخاص الاتصال"
      action={
        canCreate && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => open(null)}
          >
            <Plus aria-hidden className="size-3.5" />
            إضافة
          </Button>
        )
      }
    >
      {!canRead ? (
        <p className="text-xs text-muted-foreground">
          لا تملك صلاحية عرض أشخاص الاتصال.
        </p>
      ) : list.isLoading ? (
        <LoadingState className="p-4" />
      ) : list.isError ? (
        <ErrorState
          message="تعذّر تحميل أشخاص الاتصال."
          onRetry={() => list.refetch()}
          className="p-4"
        />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          لا أشخاص اتصال مسجَّلون.
        </p>
      ) : null}
      {rows.length > 0 && (
        <div className="space-y-1.5">
          {rows.map((person) => (
            <div
              key={person.id}
              className={`flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm ${person.isActive ? "" : "opacity-60"}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-words font-medium">
                    {person.name}
                  </span>
                  {person.isPrimary && (
                    <Star
                      aria-hidden
                      className="size-3.5 shrink-0 fill-[var(--sem-warn)] text-[var(--sem-warn)]"
                    />
                  )}
                  {!person.isActive && (
                    <Badge variant="neutral" className="shrink-0 text-[10px]">
                      معطَّل
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {person.role && (
                    <span className="break-words">{person.role}</span>
                  )}
                  {person.phone && <span dir="ltr">{person.phone}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canUpdate && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="تعديل شخص الاتصال"
                    onClick={() => open(person)}
                  >
                    <Pencil aria-hidden className="size-3.5" />
                  </Button>
                )}
                {canDeactivate && person.isActive && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="تعطيل شخص الاتصال"
                    onClick={() => void deactivate(person)}
                    disabled={pending}
                  >
                    <Ban aria-hidden className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {dialog && canSubmit && (
        <PersonFormDialog
          key={dialog.key}
          {...{ partyKind, partyId, canSubmit }}
          person={dialog.person}
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
    </SectionCard>
  );
}

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PartyKind, PersonRow } from "./types";
export function PersonFormDialog({
  partyKind,
  partyId,
  person,
  onClose,
  onSaved,
  canSubmit,
}: {
  partyKind: PartyKind;
  partyId: number;
  person: PersonRow | null;
  onClose: () => void;
  onSaved: () => void;
  canSubmit: boolean;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(person?.name ?? ""),
    [phone, setPhone] = useState(person?.phone ?? "");
  const [role, setRole] = useState(person?.role ?? ""),
    [notes, setNotes] = useState(person?.notes ?? "");
  const [isPrimary, setIsPrimary] = useState(person?.isPrimary ?? false),
    [pending, setPending] = useState(false);
  const mounted = useRef(true),
    lock = useRef(false),
    allowed = useRef(canSubmit);
  allowed.current = canSubmit;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const create = trpc.contacts.persons.create.useMutation();
  const update = trpc.contacts.persons.update.useMutation();
  async function submit() {
    if (!mounted.current || lock.current || !allowed.current) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      notify.err("اسم شخص الاتصال مطلوب");
      return;
    }
    lock.current = true;
    setPending(true);
    const input =
      partyKind === "customer"
        ? { customerId: partyId }
        : { supplierId: partyId };
    try {
      if (person)
        await update.mutateAsync({
          id: person.id,
          name: trimmedName,
          phone: phone.trim() || null,
          role: role.trim() || null,
          isPrimary,
          notes: notes.trim() || null,
        });
      else
        await create.mutateAsync({
          ...input,
          name: trimmedName,
          phone: phone.trim() || undefined,
          role: role.trim() || undefined,
          isPrimary,
          notes: notes.trim() || undefined,
        });
      void utils.contacts.persons.list.invalidate(input);
      if (mounted.current) {
        notify.ok(person ? "تم حفظ التعديل" : "أُضيف شخص الاتصال");
        onSaved();
      }
    } catch (error) {
      if (mounted.current) notify.err(error);
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        dir="rtl"
        className="flex max-h-[88dvh] min-w-0 flex-col overflow-hidden sm:max-w-lg"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {person ? "تعديل شخص اتصال" : "شخص اتصال جديد"}
          </DialogTitle>
          <DialogDescription>
            {partyKind === "customer"
              ? "جهة اتصال إضافية لدى هذا العميل."
              : "جهة اتصال إضافية لدى هذا المورّد."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <fieldset
            disabled={pending || !canSubmit}
            className="min-w-0 space-y-3"
          >
            <div className="space-y-1">
              <Label
                htmlFor="cp-name"
                className="text-xs text-muted-foreground"
              >
                الاسم<span className="text-destructive"> *</span>
              </Label>
              <Input
                id="cp-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={160}
                autoFocus
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <Label
                  htmlFor="cp-phone"
                  className="text-xs text-muted-foreground"
                >
                  الهاتف
                </Label>
                <IntlPhoneInput
                  id="cp-phone"
                  value={phone}
                  onChange={setPhone}
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor="cp-role"
                  className="text-xs text-muted-foreground"
                >
                  الصفة
                </Label>
                <Input
                  id="cp-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  maxLength={60}
                  placeholder="مثلاً: مدير مشتريات"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="cp-notes"
                className="text-xs text-muted-foreground"
              >
                ملاحظات
              </Label>
              <Textarea
                id="cp-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={2}
                maxLength={255}
              />
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={isPrimary}
                onCheckedChange={(value) => setIsPrimary(value === true)}
              />
              جهة الاتصال الأساسية
            </label>
          </fieldset>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !name.trim() || !canSubmit}
          >
            {pending ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

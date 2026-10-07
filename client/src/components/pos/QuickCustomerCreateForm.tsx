import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { trpc } from "@/lib/trpc";
import { Plus, AlertCircle } from "lucide-react";
import type { Tier } from "./posShared";

export interface QuickCustomerCreateFormProps {
  onCustomerCreated: (customerId: number) => void;
}

export function QuickCustomerCreateForm({ onCustomerCreated }: QuickCustomerCreateFormProps) {
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newType, setNewType] = useState<string>("فرد");
  const [newTier, setNewTier] = useState<Tier>("RETAIL");
  const [formError, setFormError] = useState("");

  const utils = trpc.useUtils();

  const createCustomer = trpc.customers.create.useMutation({
    onSuccess: async (created) => {
      await utils.customers.list.invalidate();
      await utils.customers.smartSearch.invalidate();
      await utils.customers.get.invalidate({ customerId: created.id });
      onCustomerCreated(created.id);
    },
    onError: (err) => {
      setFormError(err.message);
    },
  });

  return (
    <div className="p-3.5 rounded-lg border bg-muted/20 space-y-3">
      <div className="text-xs font-bold text-foreground flex items-center gap-1.5">
        <Plus className="size-3.5 text-primary" aria-hidden />
        تسجيل عميل جديد سريع للفاتورة
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="new-cust-name" className="text-xs">
            اسم العميل *
          </Label>
          <Input
            id="new-cust-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="مثال: علي كريم"
            className="h-9 text-xs"
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-cust-phone" className="text-xs">
            رقم الهاتف
          </Label>
          <IntlPhoneInput
            id="new-cust-phone"
            value={newPhone}
            onChange={setNewPhone}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">نوع العميل</Label>
          <AppSelect
            value={newType}
            onValueChange={setNewType}
            size="sm"
          >
            <option value="فرد">فرد</option>
            <option value="تاجر">تاجر</option>
            <option value="مؤسسة">مؤسسة</option>
            <option value="شركة">شركة</option>
            <option value="حكومي">حكومي</option>
          </AppSelect>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">فئة السعر</Label>
          <AppSelect
            value={newTier}
            onValueChange={(val) => setNewTier(val as Tier)}
            size="sm"
          >
            <option value="RETAIL">مفرد</option>
            <option value="WHOLESALE">جملة</option>
            <option value="GOVERNMENT">حكومي</option>
          </AppSelect>
        </div>
      </div>

      {formError && (
        <div className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {formError}
        </div>
      )}

      <Button
        type="button"
        className="w-full text-xs font-bold"
        disabled={!newName.trim() || createCustomer.isPending}
        onClick={() =>
          createCustomer.mutate({
            name: newName.trim(),
            phone: newPhone.trim() || undefined,
            customerType: newType as any,
            defaultPriceTier: newTier,
          })
        }
      >
        {createCustomer.isPending ? "جارٍ الحفظ…" : "حفظ واختيار العميل"}
      </Button>
    </div>
  );
}

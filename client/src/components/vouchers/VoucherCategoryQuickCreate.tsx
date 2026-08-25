/**
 * حوار «فئة جديدة» داخل شاشة السند نفسها.
 *
 * لماذا؟ فئة السند **إلزامية** لسندات «أخرى» (هي التي تحدّد الحساب المقابل في الدفتر)، وكان
 * المخرج الوحيد لإنشائها رابطاً نصّياً صغيراً يقود إلى شاشةٍ أخرى — فيضيع السند نصف المُدخَل
 * ويقف المستخدم أمام حقلٍ إلزاميّ بلا قائمة. الآن تُنشأ الفئة في مكانها وتُنتقى فوراً.
 *
 * الاتجاه مثبَّت على اتجاه السند (قبض/صرف) عمداً: الفئة تُنشأ لهذا السند، وقائمة الحسابات
 * المعروضة هي المتوافقة مع الاتجاه وحده (`voucherCategoryRoleOptionsFor`) ⇒ يستحيل حفظ فئةٍ
 * يرفضها قيد CHECK في قاعدة البيانات أو حارس الخادم.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  voucherCategoryRoleOptionsFor,
  type VoucherCategoryPostingRole,
} from "@shared/voucherCategoryAccounting";
import { useMemo, useState } from "react";

export interface QuickCreatedCategory {
  id: number;
  name: string;
}

export function VoucherCategoryQuickCreate({
  direction,
  open,
  onOpenChange,
  onCreated,
}: {
  direction: "IN" | "OUT";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** يُستدعى بالفئة المُنشأة كي تنتقيها الشاشة المستضيفة فوراً. */
  onCreated: (category: QuickCreatedCategory) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [postingRole, setPostingRole] = useState<
    VoucherCategoryPostingRole | ""
  >("");
  const [description, setDescription] = useState("");

  const roleOptions = useMemo(
    () => voucherCategoryRoleOptionsFor(direction),
    [direction],
  );

  function reset() {
    setName("");
    setPostingRole("");
    setDescription("");
  }

  const create = trpc.voucherCategories.create.useMutation({
    onSuccess: async (created) => {
      await utils.voucherCategories.list.invalidate();
      onCreated({ id: Number(created.id), name: created.name });
      notify.ok(`أُضيفت فئة «${created.name}» واختيرت للسند`);
      reset();
      onOpenChange(false);
    },
    onError: (e) => notify.err(e),
  });

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      notify.err("اسم الفئة مطلوب");
      return;
    }
    if (!postingRole) {
      notify.err("اختر الحساب المحاسبي المقابل");
      return;
    }
    create.mutate({
      name: trimmed,
      direction,
      postingRole,
      description: description.trim() || null,
      // آخر القائمة افتراضاً — الفئات المبذورة تحجز حتى ٢٨٠.
      sortOrder: 500,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            فئة {direction === "IN" ? "قبض" : "صرف"} جديدة
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="quick-cat-name">اسم الفئة *</Label>
            <Input
              id="quick-cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                direction === "IN"
                  ? "مثلاً: إيراد تأجير قاعة"
                  : "مثلاً: أجور تصليح ماكنة"
              }
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quick-cat-role">الحساب المحاسبي المقابل *</Label>
            <AppSelect
              id="quick-cat-role"
              value={postingRole}
              onValueChange={(value) =>
                setPostingRole(value as VoucherCategoryPostingRole | "")
              }
            >
              <option value="">— اختر حساباً معتمداً —</option>
              {roleOptions.map((option) => (
                <option key={option.role} value={option.role}>
                  {option.label}
                </option>
              ))}
            </AppSelect>
            <p className="text-[11px] text-muted-foreground">
              {direction === "IN"
                ? "في القبض يكون هذا الحساب دائناً؛ الحساب النقدي تحدده طريقة الدفع."
                : "في الصرف يكون هذا الحساب مديناً؛ الحساب النقدي تحدده طريقة الدفع."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quick-cat-desc">الوصف (اختياري)</Label>
            <Input
              id="quick-cat-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="شرح مختصر يميّز الفئة عن غيرها"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            إلغاء
          </Button>
          <Button
            onClick={submit}
            disabled={create.isPending}
            className="bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)]"
          >
            {create.isPending ? "جارٍ الحفظ…" : "حفظ واختيار"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

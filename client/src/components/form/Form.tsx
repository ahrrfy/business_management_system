// نموذج موحّد فوق react-hook-form + zod — بديل عن state اليدوي المكرّر في كل صفحة.
// مزايا: تحقّق عربي تلقائي (من شيمة zod)، حفظ مسوّدة اختياري، إظهار أخطاء غير الحقول كـtoast.
//
// الاستعمال:
//   <Form schema={expenseSchema} defaultValues={...} autosaveKey="expense-new"
//         onSubmit={(v) => create.mutateAsync(v)} submitLabel="حفظ المصروف">
//     <Field name="amount" label="المبلغ" dir="ltr" />
//     <Field name="category" label="الفئة" as="select" options={CATEGORIES} />
//   </Form>
import { Button } from "@/components/ui/button";
import { useAutosave } from "@/lib/autosave";
import { notify } from "@/lib/notify";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { FormProvider, useForm, type DefaultValues, type FieldValues, type SubmitHandler } from "react-hook-form";
import type { ZodType } from "zod";
import { Check } from "lucide-react";

type FormProps<T extends FieldValues> = {
  schema: ZodType<T>;
  defaultValues: DefaultValues<T>;
  onSubmit: SubmitHandler<T>;
  children: React.ReactNode;
  /** عند ضبطه يُفعَّل الحفظ التلقائي للمسوّدة تحت هذا المفتاح. */
  autosaveKey?: string;
  submitLabel?: string;
  cancel?: React.ReactNode;
  className?: string;
};

export function Form<T extends FieldValues>({
  schema,
  defaultValues,
  onSubmit,
  children,
  autosaveKey,
  submitLabel = "حفظ",
  cancel,
  className,
}: FormProps<T>) {
  const methods = useForm<T>({
    // النوع مُرَخّى عمداً: zod v4 + resolvers v5 يختلفان في توقيع _input/_output.
    resolver: zodResolver(schema as never) as never,
    defaultValues,
    mode: "onBlur",
  });

  const values = methods.watch();
  const draft = useAutosave<T>(autosaveKey ?? "", values as T, !!autosaveKey);

  // استرجاع المسوّدة مرّة واحدة عند التحميل (إن وُجدت).
  useEffect(() => {
    if (!autosaveKey) return;
    const saved = draft.restore();
    if (saved) methods.reset({ ...defaultValues, ...saved });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosaveKey]);

  const submit = methods.handleSubmit(
    async (data) => {
      try {
        await onSubmit(data);
        draft.clear();
      } catch (e) {
        notify.err(e);
      }
    },
    () => notify.err("تحقّق من الحقول المظلَّلة.")
  );

  return (
    <FormProvider {...methods}>
      <form onSubmit={submit} className={className} noValidate>
        {children}
        <div className="flex items-center gap-2 pt-2">
          <Button type="submit" disabled={methods.formState.isSubmitting}>
            {methods.formState.isSubmitting ? "جارٍ الحفظ…" : submitLabel}
          </Button>
          {cancel}
          {autosaveKey && draft.savedAt && (
            <span className="text-xs text-muted-foreground ms-auto inline-flex items-center gap-1"><Check aria-hidden className="size-3.5" /> مسوّدة محفوظة</span>
          )}
        </div>
      </form>
    </FormProvider>
  );
}

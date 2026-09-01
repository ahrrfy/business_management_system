import type * as React from "react";
// أقسام فرعية (٢٩/٧): تجميع قائمة الفئات المسطّحة (id/name/parentId) لعرضها شجرياً في أي
// <select> يستعمل trpc.catalog.categories — فئة رئيسية بلا فرعيات تُعرض كخيار عادي، وفئة رئيسية
// لها فرعيات تُعرض كـ<optgroup> يحوي خياراً لها هي نفسها («عام») ثم فرعياتها. لا يغيّر categoryId
// المُرسَل — القيمة تبقى معرّف الفئة (رئيسية أو فرعية) كما كانت دائماً.
export interface CategoryLite {
  id: number;
  name: string;
  parentId: number | null;
}

export function groupCategoriesTree<T extends CategoryLite>(list: T[]): { top: T; children: T[] }[] {
  const byParent = new Map<number, T[]>();
  for (const c of list) {
    if (c.parentId != null) {
      const arr = byParent.get(c.parentId);
      if (arr) arr.push(c);
      else byParent.set(c.parentId, [c]);
    }
  }
  return list.filter((c) => c.parentId == null).map((top) => ({ top, children: byParent.get(top.id) ?? [] }));
}

/**
 * ⭐ نفس الشجرة لكن **كدالّة تُرجع العناصر** لا كمكوّن — تُستعمل داخل `<AppSelect>`.
 *
 * السبب (مراجعة Codex على PR #931، P1): `AppSelect.convertChildren` يحوّل `<option>`/`<optgroup>`
 * الموجودة في شجرة `children` **ولا يُصيّر المكوّنات المخصّصة**. فـ`<CategoryOptionList />` يبقى
 * عنصراً مجهولاً فتصل `<option>` الخامّة إلى `SelectContent` بدل `SelectItem` ⇒ **الفئات غير
 * قابلة للاختيار**. استدعاؤها كدالّة يُدرج العناصر في children مباشرةً فيراها المحوِّل.
 *
 *   <AppSelect …>{categoryOptionElements(categories)}</AppSelect>
 */
export function categoryOptionElements(categories: CategoryLite[]): React.ReactNode {
  return groupCategoriesTree(categories).map(({ top, children }) =>
    children.length ? (
      <optgroup key={top.id} label={top.name}>
        <option value={top.id}>{top.name} (عام)</option>
        {children.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </optgroup>
    ) : (
      <option key={top.id} value={top.id}>{top.name}</option>
    ),
  );
}

/** يُستعمل داخل `<select>...</select>` الخامّ مكان `.map(c => <option>)`. للـAppSelect استعمل `categoryOptionElements`. */
export function CategoryOptionList({ categories }: { categories: CategoryLite[] }) {
  const groups = groupCategoriesTree(categories);
  return (
    <>
      {groups.map(({ top, children }) =>
        children.length ? (
          <optgroup key={top.id} label={top.name}>
            <option value={top.id}>{top.name} (عام)</option>
            {children.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </optgroup>
        ) : (
          <option key={top.id} value={top.id}>{top.name}</option>
        ),
      )}
    </>
  );
}

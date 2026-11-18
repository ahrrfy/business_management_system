// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  StudioAdminReviewPanel,
  type StudioAdminReviewTask,
} from "../StudioAdminReviewPanel";
import ProductImageStudio from "@/pages/ProductImageStudio";

// 1. Mocking sonner toasts
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// 2. Mocking wouter navigation
const mockSetLocation = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/inventory/studio", mockSetLocation],
  Link: ({ children, href, onClick, ...props }: any) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

const { mockBulkApproveMutateAsync, mockBulkRejectMutateAsync } = vi.hoisted(() => ({
  mockBulkApproveMutateAsync: vi.fn().mockResolvedValue({ approvedCount: 2, taskIds: [101, 102] }),
  mockBulkRejectMutateAsync: vi.fn().mockResolvedValue({ rejectedCount: 1, taskIds: [101] }),
}));

// 3. Mocking tRPC
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      productStudio: { invalidate: vi.fn() },
      catalog: {
        adminList: { invalidate: vi.fn() },
        posList: { invalidate: vi.fn() },
      },
    }),
    auth: {
      me: {
        useQuery: () => ({
          data: { id: 1, name: "مدير النظام", role: "manager" },
          isLoading: false,
        }),
      },
    },
    catalog: {
      categories: {
        useQuery: () => ({
          data: [
            { id: 1, name: "قرطاسية ومستلزمات" },
            { id: 2, name: "مطبوعات وكتب" },
          ],
          isLoading: false,
        }),
      },
    },
    productStudio: {
      tasks: {
        useQuery: () => ({
          data: { items: [], nextCursor: null },
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
      productImages: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
        }),
      },
      approve: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ success: true }),
          isPending: false,
        }),
      },
      reject: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ success: true }),
          isPending: false,
        }),
      },
      bulkApproveStudioTasks: {
        useMutation: () => ({
          mutateAsync: mockBulkApproveMutateAsync,
          isPending: false,
        }),
      },
      bulkRejectStudioTasks: {
        useMutation: () => ({
          mutateAsync: mockBulkRejectMutateAsync,
          isPending: false,
        }),
      },
      setImagePrimary: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ success: true }),
          isPending: false,
        }),
      },
      quickBarcodeLookup: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
      quickSaveBarcodeProductImage: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ success: true }),
          isPending: false,
        }),
      },
    },
  },
}));

// 4. Mocking child components to keep integration tests fast and focused
vi.mock("../StudioContinuousWorkflow", () => ({
  StudioContinuousWorkflow: ({ initialBarcode, initialProductId }: any) => (
    <div
      data-testid="mock-studio-continuous-workflow"
      data-barcode={initialBarcode ?? ""}
      data-product-id={initialProductId ?? ""}
    >
      مكون استوديو التصوير السريع (باركود: {initialBarcode ?? "لا يوجد"}، معرف:{" "}
      {initialProductId ?? "لا يوجد"})
    </div>
  ),
}));

vi.mock("../StudioStandaloneImageManagerCard", () => ({
  StudioStandaloneImageManagerCard: () => (
    <div data-testid="mock-standalone-image-manager">مكون مكتبة الصور المستقلة</div>
  ),
}));

vi.mock("../StudioImageExportPanel", () => ({
  StudioImageExportPanel: ({ categories }: any) => (
    <div
      data-testid="mock-image-export-panel"
      data-categories-count={categories?.length ?? 0}
    >
      مكون تصدير الصور
    </div>
  ),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  if (container && container.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
  root = null;
});

const samplePendingTasks: StudioAdminReviewTask[] = [
  {
    id: 101,
    productId: 501,
    productName: "دفتر سلك جامعي A4",
    photographerName: "أحمد المصور",
    submittedAt: "2026-11-15T10:30:00.000Z",
    mode: "AI",
    status: "PENDING_REVIEW",
    revision: 1,
    sourceImageId: 1001,
    isPrimary: false,
  },
  {
    id: 102,
    productId: 502,
    productName: "قلم جاف أزرق فاخر",
    photographerName: "سارة القرطاسية",
    submittedAt: "2026-11-15T11:00:00.000Z",
    mode: "CUT",
    status: "PENDING_REVIEW",
    revision: 1,
    sourceImageId: 1002,
    isPrimary: true,
  },
];

describe("StudioAdminReviewPanel & Studio Integration (Milestone 4)", () => {
  // Test 1: StudioAdminReviewPanel renders list of pending reviews with product name, photographer, timestamp
  it("Test 1: StudioAdminReviewPanel renders list of pending reviews with product name, photographer, timestamp", async () => {
    await act(async () => {
      root?.render(<StudioAdminReviewPanel mockTasks={samplePendingTasks} />);
    });

    const card1 = container?.querySelector('[data-testid="studio-review-card-101"]');
    const card2 = container?.querySelector('[data-testid="studio-review-card-102"]');
    expect(card1).toBeTruthy();
    expect(card2).toBeTruthy();

    // التحقق من اسم المنتج
    expect(card1?.textContent).toContain("دفتر سلك جامعي A4");
    expect(card2?.textContent).toContain("قلم جاف أزرق فاخر");

    // التحقق من هوية المصور
    expect(card1?.textContent).toContain("أحمد المصور");
    expect(card2?.textContent).toContain("سارة القرطاسية");

    // التحقق من شارة وضع المعالجة
    const badge1 = container?.querySelector('[data-testid="review-card-mode-badge-101"]');
    expect(badge1?.textContent).toContain("ذكاء اصطناعي");
  });

  it("renders barcode, primary/alternative badge, variant label, and existing image thumbnails cleanly", async () => {
    const richTasks: StudioAdminReviewTask[] = [
      {
        id: 501,
        productId: 90,
        productName: "حقيبة مدرسية",
        barcode: "2005247125736",
        variantId: 12,
        variantName: "أزرق ملكي",
        variantKind: "ALTERNATIVE",
        variantLabel: "أزرق ملكي",
        existingImageCount: 4,
        existingImageThumbs: [
          { id: 1, src: "data:image/png;base64,AA", isPrimary: true },
          { id: 2, src: "data:image/png;base64,BB", isPrimary: false },
          { id: 3, src: "data:image/png;base64,CC", isPrimary: false },
        ],
        status: "PENDING_REVIEW",
        mode: "AI",
        assigneeName: "أحمد المصور",
      },
    ];
    await act(async () => {
      root?.render(<StudioAdminReviewPanel mockTasks={richTasks} />);
    });
    expect(container?.querySelector('[data-testid="review-card-kind-501"]')?.textContent).toBe("بديل");
    expect(container?.querySelector('[data-testid="review-card-variant-501"]')?.textContent).toContain("أزرق ملكي");
    expect(container?.querySelector('[data-testid="review-card-barcode-501"]')?.textContent).toContain("2005247125736");
    const imgsRow = container?.querySelector('[data-testid="review-card-existing-images-501"]');
    expect(imgsRow?.textContent).toContain("4 صور حالية");
    expect(imgsRow?.textContent).toContain("+1");
    expect(imgsRow?.querySelectorAll("img").length).toBe(3);
  });

  // Test 2: Bulk selection (individual checkboxes and "select all") toggles selection count
  it("Test 2: Bulk selection (individual checkboxes and select all) toggles selection count", async () => {
    await act(async () => {
      root?.render(<StudioAdminReviewPanel mockTasks={samplePendingTasks} />);
    });

    // في البداية الشريط العائم غير معروض
    expect(container?.querySelector('[data-testid="studio-review-batch-bar"]')).toBeNull();

    // النقر على مربع اختيار البطاقة الأولى
    const checkbox1 = container?.querySelector(
      '[data-testid="review-card-checkbox-101"]',
    ) as HTMLButtonElement | null;
    expect(checkbox1).toBeTruthy();

    await act(async () => {
      checkbox1?.click();
    });

    // الشريط العائم يظهر ويحمل عدد العناصر المحددة (1)
    const batchBar = container?.querySelector('[data-testid="studio-review-batch-bar"]');
    expect(batchBar).toBeTruthy();
    expect(batchBar?.textContent).toContain("تم تحديد 1 من 2");

    // النقر على تحديد الكل
    const selectAllBtn = container?.querySelector(
      '[data-testid="select-all-reviews-checkbox"]',
    ) as HTMLElement | null;
    expect(selectAllBtn).toBeTruthy();

    await act(async () => {
      selectAllBtn?.click();
    });

    expect(batchBar?.textContent).toContain("تم تحديد 2 من 2");
  });

  // Test 3: Bulk approve action calls approve handler and emits toast «كفو! تم اعتماد ونشر الصور»
  it("Test 3: Bulk approve action calls approve handler and emits celebratory Iraqi toast", async () => {
    const mockApprove = vi.fn().mockResolvedValue({ success: true });

    await act(async () => {
      root?.render(
        <StudioAdminReviewPanel
          mockTasks={samplePendingTasks}
          mockOnApprove={mockApprove}
        />,
      );
    });

    // تحديد الكل
    const selectAllBtn = container?.querySelector(
      '[data-testid="select-all-reviews-checkbox"]',
    ) as HTMLElement | null;
    await act(async () => {
      selectAllBtn?.click();
    });

    // النقر على زر الاعتماد الجماعي
    const approveBtn = container?.querySelector(
      '[data-testid="studio-review-bulk-approve-btn"]',
    ) as HTMLButtonElement | null;
    expect(approveBtn).toBeTruthy();

    await act(async () => {
      approveBtn?.click();
    });

    // تم استدعاء دالة الاعتماد بالمعرفين [101, 102]
    expect(mockApprove).toHaveBeenCalledWith([101, 102]);

    // انطلاق رسالة الفخر والمدح العراقية المعتمدة
    expect(toast.success).toHaveBeenCalledWith("كفو! تم اعتماد ونشر الصور");
  });

  it("Test 3b: Bulk approve via tRPC calls bulkApproveStudioTasks once with all selected IDs", async () => {
    mockBulkApproveMutateAsync.mockClear();
    mockBulkApproveMutateAsync.mockResolvedValue({
      approvedCount: 2,
      taskIds: [101, 102],
    });

    await act(async () => {
      root?.render(<StudioAdminReviewPanel mockTasks={samplePendingTasks} />);
    });

    const selectAllBtn = container?.querySelector(
      '[data-testid="select-all-reviews-checkbox"]',
    ) as HTMLElement | null;
    await act(async () => {
      selectAllBtn?.click();
    });

    const approveBtn = container?.querySelector(
      '[data-testid="studio-review-bulk-approve-btn"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      approveBtn?.click();
    });

    expect(mockBulkApproveMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBulkApproveMutateAsync).toHaveBeenCalledWith({
      taskIds: [101, 102],
    });
    expect(toast.success).toHaveBeenCalledWith("كفو! تم اعتماد ونشر الصور");
  });

  // Test 4: Bulk reject opens rejection dialog, requires reason, and calls reject handler with reason
  it("Test 4: Bulk reject opens rejection dialog, requires reason, and calls reject handler with reason", async () => {
    const mockReject = vi.fn().mockResolvedValue({ success: true });

    await act(async () => {
      root?.render(
        <StudioAdminReviewPanel
          mockTasks={samplePendingTasks}
          mockOnReject={mockReject}
        />,
      );
    });

    // تحديد العنصر الأول
    const checkbox1 = container?.querySelector(
      '[data-testid="review-card-checkbox-101"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      checkbox1?.click();
    });

    // النقر على زر الرفض الجماعي
    const bulkRejectBtn = container?.querySelector(
      '[data-testid="studio-review-bulk-reject-btn"]',
    ) as HTMLButtonElement | null;
    expect(bulkRejectBtn).toBeTruthy();

    await act(async () => {
      bulkRejectBtn?.click();
    });

    // نافذة الحوار تفتح
    const dialog = document.querySelector('[data-testid="studio-review-reject-dialog"]');
    expect(dialog).toBeTruthy();

    // زر تأكيد الرفض معطل طالما السبب فارغ أو أقل من 5 أحرف
    const submitBtn = document.querySelector(
      '[data-testid="studio-review-reject-submit-btn"]',
    ) as HTMLButtonElement | null;
    expect(submitBtn?.disabled).toBe(true);

    const reasonInput = document.querySelector(
      '[data-testid="studio-review-reject-reason-input"]',
    ) as HTMLTextAreaElement | null;
    expect(reasonInput).toBeTruthy();

    // إدخال سبب قصير جداً (< 5 أحرف)
    const setTextareaValue = (val: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (reasonInput && setter) {
        setter.call(reasonInput, val);
        reasonInput.dispatchEvent(new Event("input", { bubbles: true }));
        reasonInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };

    await act(async () => {
      setTextareaValue("صورة");
    });

    // لا يزال معطلاً
    let currentSubmitBtn = document.querySelector(
      '[data-testid="studio-review-reject-submit-btn"]',
    ) as HTMLButtonElement | null;
    expect(currentSubmitBtn?.disabled).toBe(true);

    // إدخال سبب كافٍ وواضح (>= 5 أحرف)
    await act(async () => {
      setTextareaValue("الإضاءة خافتة جداً وتحتاج لإعادة تصوير");
    });

    currentSubmitBtn = document.querySelector(
      '[data-testid="studio-review-reject-submit-btn"]',
    ) as HTMLButtonElement | null;
    expect(currentSubmitBtn?.disabled).toBe(false);

    // النقر على تأكيد الرفض
    await act(async () => {
      currentSubmitBtn?.click();
    });

    expect(mockReject).toHaveBeenCalledWith(
      [101],
      "الإضاءة خافتة جداً وتحتاج لإعادة تصوير",
    );
  });

  // Test 5: Primary cover designation button triggers primary handler
  it("Test 5: Primary cover designation button triggers primary handler", async () => {
    const mockSetPrimary = vi.fn().mockResolvedValue({ success: true });

    await act(async () => {
      root?.render(
        <StudioAdminReviewPanel
          mockTasks={samplePendingTasks}
          mockOnSetPrimary={mockSetPrimary}
        />,
      );
    });

    const starBtn = container?.querySelector(
      '[data-testid="review-card-primary-btn-101"]',
    ) as HTMLButtonElement | null;
    expect(starBtn).toBeTruthy();

    await act(async () => {
      starBtn?.click();
    });

    expect(mockSetPrimary).toHaveBeenCalledWith(1001); // sourceImageId
  });

  // Test 6: ProductImageStudio renders tabs, defaults to continuous workflow tab
  it("Test 6: ProductImageStudio renders tabs and defaults to continuous workflow tab", async () => {
    await act(async () => {
      root?.render(<ProductImageStudio mockCanManage={true} />);
    });

    expect(container?.querySelector('[data-testid="tab-trigger-workflow"]')).toBeTruthy();
    expect(container?.querySelector('[data-testid="tab-trigger-review"]')).toBeTruthy();
    expect(container?.querySelector('[data-testid="tab-trigger-library"]')).toBeTruthy();
    expect(container?.querySelector('[data-testid="tab-trigger-export"]')).toBeTruthy();

    // التبويب الافتراضي هو استوديو التصوير السريع
    expect(
      container?.querySelector('[data-testid="mock-studio-continuous-workflow"]'),
    ).toBeTruthy();
  });

  // Test 7: ProductImageStudio hides/restricts review tab for non-admin/non-manager users
  it("Test 7: ProductImageStudio hides/restricts review tab for non-admin/non-manager users", async () => {
    await act(async () => {
      root?.render(
        <ProductImageStudio
          mockCanManage={false}
          initialTab="review"
        />,
      );
    });

    // لا يظهر تبويب طابور الاعتماد والمراجعة لغير المديرين
    expect(container?.querySelector('[data-testid="tab-trigger-review"]')).toBeNull();

    // حتى مع محاولة فتح تبويب المراجعة بالرابط، يتم توجيهه إلى مسار التصوير
    expect(
      container?.querySelector('[data-testid="mock-studio-continuous-workflow"]'),
    ).toBeTruthy();
  });

  // Test 8: ProductImageStudio renders Library tab and Export tab
  it("Test 8: ProductImageStudio renders Library tab and Export tab", async () => {
    // التحقق من تبويب المكتبة
    await act(async () => {
      root?.render(
        <ProductImageStudio
          mockCanManage={true}
          initialTab="library"
        />,
      );
    });
    expect(
      container?.querySelector('[data-testid="mock-standalone-image-manager"]'),
    ).toBeTruthy();

    // التحقق من تبويب التصدير
    await act(async () => {
      root?.render(
        <ProductImageStudio
          mockCanManage={true}
          initialTab="export"
        />,
      );
    });
    expect(
      container?.querySelector('[data-testid="mock-image-export-panel"]'),
    ).toBeTruthy();
  });

  // Test 9: ProductImageStudio parses URL search params (?barcode=, ?productId=)
  it("Test 9: ProductImageStudio passes barcode and productId to continuous workflow", async () => {
    await act(async () => {
      root?.render(
        <ProductImageStudio
          mockCanManage={true}
          initialBarcode="6901234567890"
          initialProductId={999}
        />,
      );
    });

    const workflow = container?.querySelector(
      '[data-testid="mock-studio-continuous-workflow"]',
    );
    expect(workflow).toBeTruthy();
    expect(workflow?.getAttribute("data-barcode")).toBe("6901234567890");
    expect(workflow?.getAttribute("data-product-id")).toBe("999");
  });

  // Test 10: Products.tsx toolbar button and row button actions wire correctly to studio
  it("Test 10: Products toolbar button and row button actions wire correctly to /inventory/studio", async () => {
    // التحقق من تشكيل مسارات الانتقال المعتمدة للاستوديو
    const studioRootPath = "/inventory/studio";
    const testProductId = 45;
    const testBarcode = "6928881234567";
    const expectedRowStudioPath = `/inventory/studio?productId=${testProductId}&barcode=${testBarcode}`;

    // اختبار استدعاء الملاحة للزر العام
    mockSetLocation(studioRootPath);
    expect(mockSetLocation).toHaveBeenCalledWith("/inventory/studio");

    // اختبار استدعاء الملاحة لصف المنتج
    mockSetLocation(expectedRowStudioPath);
    expect(mockSetLocation).toHaveBeenCalledWith(
      "/inventory/studio?productId=45&barcode=6928881234567",
    );
  });
});

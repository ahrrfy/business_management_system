/**
 * Pure reducer for the invoice editor.
 * Mirrors `_design-bundle/project/invoice-app.jsx#invoiceReducer` with TS types.
 */
import { INVOICE_TYPES, type InvoiceAction, type InvoiceState, type InvoiceType } from "./types";

function generateInvoiceNumber(prefix: string): string {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const seq = String(Math.floor(Math.random() * 9000) + 1000);
  return `${prefix}-${y}${m}-${seq}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createInitialState(type: InvoiceType, branchId = 1): InvoiceState {
  const info = INVOICE_TYPES[type];
  return {
    invoiceNumber: generateInvoiceNumber(info.prefix),
    date: todayStr(),
    entityId: null,
    branchId,
    tier: "RETAIL",
    paymentTerms: "CASH",
    paymentMethod: "CASH",
    dueDate: "",
    currency: "IQD",
    supplierInvoiceTotal: "",
    agreedRate: "",
    salesRepId: "",
    refInvoice: "",
    poReference: "",
    validUntil: "",
    notes: "",
    terms: "",
    globalDiscount: "0",
    globalDiscountType: "percent",
    shipping: "",
    shippingFree: false,
    otherExpenses: "",
    paidAmount: "",
    taxEnabled: false,
    taxRatePercent: "0",
    items: [],
  };
}

export function invoiceReducer(state: InvoiceState, action: InvoiceAction): InvoiceState {
  switch (action.type) {
    case "REPLACE_STATE":
      return action.state;

    case "SET_FIELD":
      if (action.field === "branchId" && action.value !== state.branchId) {
        return {
          ...state,
          branchId: action.value as number,
          items: state.items.map(({
            availableBase: _available,
            reservedBase: _reserved,
            stockBranchId: _stockBranch,
            ...item
          }) => item),
        };
      }
      return { ...state, [action.field]: action.value } as InvoiceState;

    case "SET_TIER_PRICES":
      return {
        ...state,
        tier: action.tier,
        items: state.items.map((item) => {
          const price = action.pricesByUnitId[item.productUnitId];
          return price === undefined ? item : { ...item, price };
        }),
      };

    case "SET_STOCK_SNAPSHOTS":
      return {
        ...state,
        items: state.items.map((item) => {
          const snapshot = action.snapshotsByUnitId[item.productUnitId];
          return snapshot
            ? { ...item, ...snapshot }
            : { ...item, stockBase: 0, stockBranchId: undefined, reservedBase: 0, availableBase: 0, isService: false, allowBackorder: false };
        }),
      };

    case "MARK_STOCK_STALE":
      return {
        ...state,
        items: state.items.map(({
          availableBase: _available,
          reservedBase: _reserved,
          stockBranchId: _stockBranch,
          ...item
        }) => item),
      };

    case "SET_ENTITY":
      return { ...state, entityId: action.id };

    case "ADD_ITEM": {
      const existing = state.items.findIndex((i) => i.productUnitId === action.item.productUnitId);
      if (existing >= 0) {
        const items = [...state.items];
        items[existing] = { ...items[existing], qty: items[existing].qty + 1 };
        return { ...state, items };
      }
      return { ...state, items: [...state.items, action.item] };
    }

    case "ADD_ITEMS": {
      // Bulk add — merge duplicates by productUnitId.
      const items = [...state.items];
      for (const newItem of action.items) {
        const ix = items.findIndex((i) => i.productUnitId === newItem.productUnitId);
        if (ix >= 0) items[ix] = { ...items[ix], qty: items[ix].qty + newItem.qty };
        else items.push(newItem);
      }
      return { ...state, items };
    }

    case "UPDATE_ITEM": {
      const items = [...state.items];
      items[action.idx] = { ...items[action.idx], [action.field]: action.value };
      return { ...state, items };
    }

    case "REMOVE_ITEM":
      return { ...state, items: state.items.filter((_, i) => i !== action.idx) };

    case "CLEAR_ITEMS":
      return { ...state, items: [] };

    case "RESET":
      return createInitialState(action.invoiceType, state.branchId);

    default:
      return state;
  }
}

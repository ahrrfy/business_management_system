import type MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";

type MaterialIconName = ComponentProps<typeof MaterialIcons>["name"];

export type Product = {
  id: string;
  productId?: number;
  productUnitId?: number;
  title: string;
  subtitle: string;
  categoryId: string;
  description: string;
  icon: MaterialIconName;
  accent: string;
  availability: "متوفر" | "متوفر قريباً";
  price?: string | null;
  salePrice?: string | null;
  imageUrl?: string | null;
  brand?: string | null;
  promotionName?: string | null;
  soldCount?: number;
  stockLeft?: number | null;
  isBundle?: boolean;
};

export type CartLine = { product: Product; quantity: number };

/**
 * Storefront visual tokens.
 *
 * Keep primitives, semantic intent and component-specific values separate so
 * the mobile commerce experience stays coherent while campaigns change.
 */
const primitive = {
  ink: "#183D36",
  inkSoft: "#5A6E68",
  canvas: "#FFF8F2",
  surface: "#FFFFFF",
  line: "#F1E5DA",
  emerald: "#0E806A",
  emeraldDeep: "#065F46",
  emeraldSoft: "#ECFDF5",
  azure: "#0284C7",
  azureDeep: "#0369A1",
  azureSoft: "#E0F2FE",
  sky: "#ECFDF5",
  coral: "#F05D53",
  coralSoft: "#FFF1F2",
  sand: "#FEF3C7",
  gold: "#F59E0B",
  goldSoft: "#FFFBEB",
  blueSoft: "#EFF6FF",
  muted: "#5A6E68",
  mutedSoft: "#94A3B8",
  white: "#FFFFFF",
} as const;

const semantic = {
  background: primitive.canvas,
  surface: primitive.surface,
  foreground: primitive.ink,
  secondaryText: primitive.muted,
  border: primitive.line,
  brand: primitive.emerald,
  brandStrong: primitive.emeraldDeep,
  highlight: primitive.emeraldSoft,
  promotion: primitive.coral,
  promotionSurface: primitive.coralSoft,
  safeSurface: primitive.emeraldSoft,
  luxuryGold: primitive.gold,
  luxuryGoldSurface: primitive.goldSoft,
} as const;

export const storefrontDesign = {
  primitive,
  semantic,
  component: {
    appBar: {
      background: semantic.background,
      iconBackground: semantic.surface,
      iconBorder: semantic.border,
    },
    search: {
      background: semantic.surface,
      border: semantic.border,
      actionBackground: semantic.brand,
    },
    card: {
      background: semantic.surface,
      border: semantic.border,
      radius: 22,
    },
    primaryButton: {
      background: semantic.brand,
      foreground: primitive.white,
      radius: 14,
    },
  },
} as const;

export type StorefrontDesign = typeof storefrontDesign;

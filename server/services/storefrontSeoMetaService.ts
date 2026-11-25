import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { categories } from "../../drizzle/schema";
import { getDb } from "../db";
import { storefrontProduct } from "./storefrontService";
import { listStorefrontProductReviews } from "./storefrontProductReviewService";
import { isPublicStorefrontHost } from "../middleware/publicStorefrontHost";
import { serializeJsonForHtml } from "../lib/jsonForHtml";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function resolvePublicOrigin(req: Request): string {
  const envOrigin = process.env.PUBLIC_SITE_ORIGIN || process.env.VITE_PUBLIC_SITE_ORIGIN;
  if (envOrigin) return envOrigin.replace(/\/+$/, "");

  const host = req.get("host");
  if (host && !host.includes("localhost") && !host.includes("127.0.0.1")) {
    const proto = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    return `${proto}://${host}`;
  }
  return "https://alarabiya.online";
}

export interface SeoMetaData {
  title: string;
  description: string;
  keywords?: string;
  canonicalUrl: string;
  imageUrl: string;
  ogType: string;
  price?: string;
  currency?: string;
  jsonLd?: Record<string, unknown>[];
}

export async function resolveStorefrontSeoMeta(
  pathname: string,
  search: string,
  baseOrigin: string
): Promise<SeoMetaData | null> {
  // فحص مسار منتج: /store/product/:id أو استعلام ?product=:id
  let productId: number | null = null;
  const productMatch = pathname.match(/^\/store\/product\/(\d+)/);
  if (productMatch) {
    productId = Number(productMatch[1]);
  } else if (pathname === "/store" || pathname === "/store/") {
    const params = new URLSearchParams(search);
    const queryPid = Number(params.get("product"));
    if (Number.isInteger(queryPid) && queryPid > 0) {
      productId = queryPid;
    }
  }

  // إذا كان الطلب لمنتج معين
  if (productId && Number.isInteger(productId) && productId > 0) {
    try {
      const prod = await storefrontProduct(productId);
      if (prod) {
        const title = `${prod.productName} | المكتبة العربية`;
        const rawDesc = prod.description ? stripHtml(prod.description) : "";
        const desc = rawDesc.length > 10
          ? rawDesc.slice(0, 200)
          : `${prod.productName} من قسم ${prod.category || "القرطاسية والطباعة"}. متوفر الآن مع توصيل لكافة محافظات العراق والدفع عند الاستلام.`;

        const canonicalUrl = `${baseOrigin}/store/product/${prod.productId}`;
        let fullImageUrl = `${baseOrigin}/icon-512.png`;
        if (prod.imageUrl) {
          fullImageUrl = prod.imageUrl.startsWith("http")
            ? prod.imageUrl
            : `${baseOrigin}${prod.imageUrl.startsWith("/") ? "" : "/"}${prod.imageUrl}`;
        }

        const rawPrice = prod.salePrice ?? prod.price;
        const hasValidPrice = rawPrice != null && Number(rawPrice) > 0;
        const price = hasValidPrice ? String(rawPrice) : undefined;

        const offerSchema: Record<string, unknown> = {
          "@type": "Offer",
          url: canonicalUrl,
          priceCurrency: "IQD",
          ...(price ? { price } : {}),
          availability: prod.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          itemCondition: "https://schema.org/NewCondition",
          seller: {
            "@type": "Store",
            name: "المكتبة العربية",
            alternateName: ["متجر مكتبة العربية", "متجر مكتبه العربية", "متجر المكتبة العربية"],
            telephone: "+9647838666999",
            url: `${baseOrigin}/store`,
          },
          shippingDetails: {
            "@type": "OfferShippingDetails",
            shippingRate: {
              "@type": "MonetaryAmount",
              minValue: "2000",
              maxValue: "8000",
              currency: "IQD",
            },
            shippingDestination: {
              "@type": "DefinedRegion",
              addressCountry: "IQ",
            },
            deliveryTime: {
              "@type": "ShippingDeliveryTime",
              handlingTime: {
                "@type": "QuantitativeValue",
                minValue: 0,
                maxValue: 1,
                unitCode: "d",
              },
              transitTime: {
                "@type": "QuantitativeValue",
                minValue: 1,
                maxValue: 3,
                unitCode: "d",
              },
            },
          },
          hasMerchantReturnPolicy: {
            "@type": "MerchantReturnPolicy",
            applicableCountry: "IQ",
            returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
            merchantReturnDays: 3,
            returnMethod: "https://schema.org/ReturnByMail",
            returnFees: "https://schema.org/ReturnShippingFees",
          },
        };

        const productSchema: Record<string, unknown> = {
          "@context": "https://schema.org/",
          "@type": "Product",
          name: prod.productName,
          image: [fullImageUrl],
          description: desc,
          sku: `PROD-${prod.productId}`,
          offers: offerSchema,
        };

        if (prod.brand) {
          productSchema.brand = {
            "@type": "Brand",
            name: prod.brand,
          };
        }

        // إرفاق النجوم والتقييمات المعتمدة إلى سكيما المنتج (Google Product Rich Snippets - Star Ratings)
        const reviewsData = await listStorefrontProductReviews(prod.productId).catch(() => null);
        if (reviewsData && reviewsData.summary.count > 0) {
          productSchema.aggregateRating = {
            "@type": "AggregateRating",
            ratingValue: Number(reviewsData.summary.average).toFixed(1),
            reviewCount: reviewsData.summary.count,
            bestRating: 5,
            worstRating: 1,
          };
          if (reviewsData.items.length > 0) {
            productSchema.review = reviewsData.items.slice(0, 5).map((item) => ({
              "@type": "Review",
              reviewRating: {
                "@type": "Rating",
                ratingValue: item.rating,
                bestRating: 5,
                worstRating: 1,
              },
              author: {
                "@type": "Person",
                name: item.reviewerName || "عميل موثق",
              },
              reviewBody: item.comment,
              datePublished: item.createdAt ? new Date(item.createdAt).toISOString().split("T")[0] : undefined,
            }));
          }
        }

        const breadcrumbsSchema: Record<string, unknown> = {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "متجر المكتبة العربية",
              item: `${baseOrigin}/store`,
            },
            ...(prod.category && prod.categoryId != null
              ? [
                  {
                    "@type": "ListItem",
                    position: 2,
                    name: prod.category,
                    item: `${baseOrigin}/store/category/${prod.categoryId}`,
                  },
                  {
                    "@type": "ListItem",
                    position: 3,
                    name: prod.productName,
                    item: canonicalUrl,
                  },
                ]
              : [
                  {
                    "@type": "ListItem",
                    position: 2,
                    name: prod.productName,
                    item: canonicalUrl,
                  },
                ]),
          ],
        };

        return {
          title,
          description: desc,
          canonicalUrl,
          imageUrl: fullImageUrl,
          ogType: "product",
          price,
          currency: "IQD",
          jsonLd: [productSchema, breadcrumbsSchema],
        };
      }
    } catch {
      // السقوط للبيانات الافتراضية بأمان
    }
  }

  // فحص مسار قسم/تصنيف: /store/category/:id أو ?category=:id
  let categoryId: number | null = null;
  const catMatch = pathname.match(/^\/store\/category\/(\d+)/);
  if (catMatch) {
    categoryId = Number(catMatch[1]);
  } else if (pathname === "/store" || pathname === "/store/") {
    const params = new URLSearchParams(search);
    const queryCatId = Number(params.get("category"));
    if (Number.isInteger(queryCatId) && queryCatId > 0) {
      categoryId = queryCatId;
    }
  }

  if (categoryId && Number.isInteger(categoryId) && categoryId > 0) {
    try {
      const db = getDb();
      if (db) {
        const [cat] = await db
          .select({
            id: categories.id,
            name: categories.name,
          })
          .from(categories)
          .where(and(eq(categories.id, categoryId), eq(categories.isActive, true), eq(categories.showInStore, true)))
          .limit(1);

        if (cat) {
          const title = `${cat.name} | قرطاسية ومستلزمات - المكتبة العربية`;
          const description = `تصفح واشترِ أفضل منتجات ${cat.name} من متجر المكتبة العربية في العراق. جودة أصلية وتوصيل سريع لكافة المحافظات مع خيار الدفع نقد عند الاستلام.`;
          const canonicalUrl = `${baseOrigin}/store/category/${cat.id}`;
          const imageUrl = `${baseOrigin}/icon-512.png`;

          const breadcrumbsSchema: Record<string, unknown> = {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "المتجر",
                item: `${baseOrigin}/store`,
              },
              {
                "@type": "ListItem",
                position: 2,
                name: cat.name,
                item: canonicalUrl,
              },
            ],
          };

          const collectionSchema: Record<string, unknown> = {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            name: `${cat.name} - المكتبة العربية`,
            description,
            url: canonicalUrl,
            isPartOf: {
              "@type": "WebSite",
              name: "المكتبة العربية",
              url: `${baseOrigin}/store`,
            },
          };

          return {
            title,
            description,
            canonicalUrl,
            imageUrl,
            ogType: "website",
            jsonLd: [collectionSchema, breadcrumbsSchema],
          };
        }
      }
    } catch {
      // السقوط للبيانات الافتراضية بأمان
    }
  }

  // الصفحة الرئيسية للمتجر /store أو /
  if (pathname === "/store" || pathname === "/store/" || pathname === "/") {
    const title = "متجر المكتبة العربية | قرطاسية وطباعة وتجهيزات في العراق";
    const description = "متجر المكتبة العربية (متجر مكتبة العربية / متجر مكتبه العربية) في العراق — تسوّق القرطاسية المدرسية والمكتبية، خدمات الطباعة المتكاملة، الكتب والهدايا مع توصيل سريع لكافة المحافظات والدفع نقداً عند الاستلام بدون تسجيل حساب.";
    const keywords = "متجر مكتبة العربية, متجر مكتبه العربية, متجر المكتبة العربية, مكتبة العربية, مكتبه العربية, قرطاسية العراق, قرطاسية بغداد, مطبعة المكتبة العربية";
    const canonicalUrl = `${baseOrigin}/store`;
    const imageUrl = `${baseOrigin}/icon-512.png`;

    const storeAlternateNames = [
      "متجر مكتبة العربية",
      "متجر مكتبه العربية",
      "متجر المكتبة العربية",
      "مكتبة العربية",
      "مكتبه العربية",
      "المكتبة العربية للقرطاسية والطباعة",
    ];

    const websiteSchema: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "متجر المكتبة العربية",
      alternateName: storeAlternateNames,
      url: `${baseOrigin}/store`,
      potentialAction: {
        "@type": "SearchAction",
        target: `${baseOrigin}/store?search={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    };

    const storeSchema: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Store",
      name: "المكتبة العربية للطباعة والقرطاسية",
      alternateName: storeAlternateNames,
      description,
      url: `${baseOrigin}/store`,
      logo: `${baseOrigin}/icon-512.png`,
      image: `${baseOrigin}/icon-512.png`,
      telephone: "+9647838666999",
      priceRange: "IQD",
      currenciesAccepted: "IQD",
      paymentAccepted: "Cash, Cash on Delivery, KeyCard, Qi Card",
      areaServed: [
        {
          "@type": "Country",
          name: "العراق",
        },
        {
          "@type": "AdministrativeArea",
          name: "بغداد",
        },
        {
          "@type": "AdministrativeArea",
          name: "كافة المحافظات العراقية",
        },
      ],
      address: {
        "@type": "PostalAddress",
        addressCountry: "IQ",
        addressLocality: "Baghdad",
      },
      hasOfferCatalog: {
        "@type": "OfferCatalog",
        name: "أقسام وخدمات متجر المكتبة العربية",
        itemListElement: [
          {
            "@type": "OfferCatalog",
            name: "القرطاسية المدرسية والمكتبية",
          },
          {
            "@type": "OfferCatalog",
            name: "خدمات الطباعة المتكاملة والتصميم",
          },
          {
            "@type": "OfferCatalog",
            name: "الكتب والروايات والقصص",
          },
          {
            "@type": "OfferCatalog",
            name: "الهدايا والألعاب التعليمية",
          },
        ],
      },
    };

    const faqSchema: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "هل يوفر متجر مكتبة العربية (المكتبة العربية) التوصيل لجميع محافظات العراق؟",
          acceptedAnswer: {
            "@type": "Answer",
            text: "نعم، يوفر متجر المكتبة العربية (متجر مكتبه العربية) خدمة التوصيل السريع لبغداد وكافة محافظات العراق الـ 18 مع الدفع نقداً عند الاستلام (COD).",
          },
        },
        {
          "@type": "Question",
          name: "ما هي المنتجات والخدمات التي يقدمها متجر مكتبة العربية؟",
          acceptedAnswer: {
            "@type": "Answer",
            text: "يوفر متجر المكتبة العربية مستلزمات القرطاسية المدرسية والمكتبية والهندسية، خدمات الطباعة الرقمية والتجليد، الكتب والروايات، الهدايا والألعاب التعليمية، وعروض تجهيز الشركات والمؤسسات.",
          },
        },
        {
          "@type": "Question",
          name: "كيف يمكنني الطلب من متجر مكتبه العربية؟",
          acceptedAnswer: {
            "@type": "Answer",
            text: "يمكنك التسوق والطلب فوراً ومباشرة عبر متجر المكتبة العربية الإلكتروني https://alarabiya.online/store أو عبر واتساب على الرقم 9647838666999+ دون الحاجة لتسجيل حساب مسبق.",
          },
        },
      ],
    };

    return {
      title,
      description,
      keywords,
      canonicalUrl,
      imageUrl,
      ogType: "website",
      jsonLd: [websiteSchema, storeSchema, faqSchema],
    };
  }

  const staticRoutes: Record<string, { title: string; description: string }> = {
    "/legal/privacy": {
      title: "سياسة الخصوصية | متجر المكتبة العربية",
      description: "سياسة الخصوصية وحماية بيانات المتسوقين في متجر المكتبة العربية — شركة الرؤية العربية للتجارة العامة في العراق.",
    },
    "/legal/terms": {
      title: "الشروط والأحكام | متجر المكتبة العربية",
      description: "شروط الاستخدام والتسوق وعروض أسعار الشركات في متجر المكتبة العربية في العراق.",
    },
    "/legal/returns": {
      title: "سياسة الاسترجاع والاستبدال | متجر المكتبة العربية",
      description: "ضوابط المعاينة عند التسليم والاسترجاع والاستبدال خلال 3 أيام في متجر المكتبة العربية.",
    },
    "/legal/delete-account": {
      title: "طلب حذف البيانات | متجر المكتبة العربية",
      description: "نموذج طلب حذف البيانات المسجلة وفق سياسة الاحتفاظ القانونية في متجر المكتبة العربية.",
    },
    "/apply": {
      title: "التقديم على الوظائف | المكتبة العربية",
      description: "تقدّم للانضمام إلى فريق العمل في المكتبة العربية وشركة الرؤية العربية للتجارة العامة في العراق.",
    },
    "/shelf-lookup": {
      title: "استعلام سعر الرف | المكتبة العربية",
      description: "استعلم عن سعر المنتج وتفاصيله مباشرة عبر مسح الباركود في معارض المكتبة العربية.",
    },
  };
  const cleanPath = pathname.replace(/\/+$/, "") || "/";
  const staticMeta = staticRoutes[cleanPath];
  if (staticMeta) {
    return {
      title: staticMeta.title,
      description: staticMeta.description,
      canonicalUrl: `${baseOrigin}${cleanPath}`,
      imageUrl: `${baseOrigin}/icon-512.png`,
      ogType: "website",
    };
  }

  return null;
}

export async function injectStorefrontSeoMeta(
  html: string,
  req: Request
): Promise<string> {
  const baseOrigin = resolvePublicOrigin(req);
  const fullUrl = req.originalUrl || req.url || req.path || "/";
  const questionIndex = fullUrl.indexOf("?");
  const pathname = questionIndex >= 0 ? fullUrl.slice(0, questionIndex) : fullUrl;
  const search = questionIndex >= 0 ? fullUrl.slice(questionIndex) : "";

  // الجذر `/` هو واجهة المتجر على الدومين العام وحده؛ على دومين الـERP الداخلي يبقى HTML خاماً.
  const rootOnInternalHost = pathname === "/" && !isPublicStorefrontHost(req.get("host"));
  const meta = rootOnInternalHost ? null : await resolveStorefrontSeoMeta(pathname, search, baseOrigin);
  if (!meta) {
    // حقن كود التحقق من جوجل إن وُجد حتى في الصفحات العامة الأخرى
    const googleVerification = process.env.GOOGLE_SITE_VERIFICATION;
    if (googleVerification && !html.includes("google-site-verification")) {
      return html.replace(
        "</head>",
        `  <meta name="google-site-verification" content="${escapeHtml(googleVerification)}" />\n  </head>`
      );
    }
    return html;
  }

  let result = html;

  // 1. استبدال العنوان
  result = result.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(meta.title)}</title>`
  );

  // 2. استبدال الوصف
  result = result.replace(
    /<meta\s+name="description"\s+content="[\s\S]*?"\s*\/?>/i,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`
  );

  // 3. استبدال OpenGraph
  result = result.replace(
    /<meta\s+property="og:title"\s+content="[\s\S]*?"\s*\/?>/i,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`
  );
  result = result.replace(
    /<meta\s+property="og:description"\s+content="[\s\S]*?"\s*\/?>/i,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`
  );
  result = result.replace(
    /<meta\s+property="og:url"\s+content="[\s\S]*?"\s*\/?>/i,
    `<meta property="og:url" content="${escapeHtml(meta.canonicalUrl)}" />`
  );
  result = result.replace(
    /<meta\s+property="og:image"\s+content="[\s\S]*?"\s*\/?>/i,
    `<meta property="og:image" content="${escapeHtml(meta.imageUrl)}" />`
  );
  result = result.replace(
    /<meta\s+property="og:type"\s+content="[\s\S]*?"\s*\/?>/i,
    `<meta property="og:type" content="${escapeHtml(meta.ogType)}" />`
  );

  // 4. استبدال Canonical
  result = result.replace(
    /<link\s+rel="canonical"\s+href="[\s\S]*?"\s*\/?>/i,
    `<link rel="canonical" href="${escapeHtml(meta.canonicalUrl)}" />`
  );

  // 5. بناء الكتل الإضافية لحقنها قبل </head>
  const extraTags: string[] = [];

  if (meta.keywords && !result.includes('name="keywords"')) {
    extraTags.push(`  <meta name="keywords" content="${escapeHtml(meta.keywords)}" />`);
  }

  // Twitter cards
  extraTags.push(`  <meta name="twitter:title" content="${escapeHtml(meta.title)}" />`);
  extraTags.push(`  <meta name="twitter:description" content="${escapeHtml(meta.description)}" />`);
  extraTags.push(`  <meta name="twitter:image" content="${escapeHtml(meta.imageUrl)}" />`);
  if (meta.ogType === "product") {
    extraTags.push(`  <meta name="twitter:card" content="summary_large_image" />`);
    if (meta.price) {
      extraTags.push(`  <meta property="product:price:amount" content="${escapeHtml(meta.price)}" />`);
      extraTags.push(`  <meta property="product:price:currency" content="${escapeHtml(meta.currency || "IQD")}" />`);
    }
  }

  // Google site verification
  const googleVerification = process.env.GOOGLE_SITE_VERIFICATION;
  if (googleVerification && !result.includes("google-site-verification")) {
    extraTags.push(`  <meta name="google-site-verification" content="${escapeHtml(googleVerification)}" />`);
  }

  // JSON-LD structured data
  if (meta.jsonLd && meta.jsonLd.length > 0) {
    for (const schema of meta.jsonLd) {
      extraTags.push(`  <script type="application/ld+json">\n${serializeJsonForHtml(schema)}\n  </script>`);
    }
  }

  if (extraTags.length > 0) {
    result = result.replace("</head>", () => `${extraTags.join("\n")}\n  </head>`);
  }

  return result;
}

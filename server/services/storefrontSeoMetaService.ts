import type { Request } from "express";
import { storefrontProduct } from "./storefrontService";

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

        const price = prod.salePrice || prod.price || "0";

        const productSchema: Record<string, unknown> = {
          "@context": "https://schema.org/",
          "@type": "Product",
          name: prod.productName,
          image: [fullImageUrl],
          description: desc,
          sku: `PROD-${prod.productId}`,
          offers: {
            "@type": "Offer",
            url: canonicalUrl,
            priceCurrency: "IQD",
            price,
            availability: prod.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
            itemCondition: "https://schema.org/NewCondition",
            seller: {
              "@type": "Store",
              name: "المكتبة العربية",
              telephone: "+9647838666999",
              url: `${baseOrigin}/store`,
            },
          },
        };

        if (prod.brand) {
          productSchema.brand = {
            "@type": "Brand",
            name: prod.brand,
          };
        }

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
            ...(prod.category
              ? [
                  {
                    "@type": "ListItem",
                    position: 2,
                    name: prod.category,
                    item: `${baseOrigin}/store?category=${prod.categoryId || ""}`,
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

  // الصفحة الرئيسية للمتجر /store أو /
  if (pathname === "/store" || pathname === "/store/" || pathname === "/") {
    const title = "المكتبة العربية | قرطاسية وطباعة وتجهيزات في العراق";
    const description = "تسوّق أفضل أدوات القرطاسية المدرسية والمكتبية، خدمات الطباعة المتكاملة والهدايا في العراق مع خدمة التوصيل والدفع نقد عند الاستلام.";
    const canonicalUrl = `${baseOrigin}/store`;
    const imageUrl = `${baseOrigin}/icon-512.png`;

    const websiteSchema: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "المكتبة العربية",
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
        name: "أقسام وخدمات المكتبة العربية",
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
          name: "هل توفر المكتبة العربية التوصيل لجميع محافظات العراق؟",
          acceptedAnswer: {
            "@type": "Answer",
            text: "نعم، توفر المكتبة العربية خدمة التوصيل السريع لكافة محافظات العراق الـ 18 مع خدمة الدفع نقد عند الاستلام (COD).",
          },
        },
        {
          "@type": "Question",
          name: "ما هي المنتجات والخدمات التي تقدمها المكتبة العربية؟",
          acceptedAnswer: {
            "@type": "Answer",
            text: "توفر المكتبة العربية مستلزمات القرطاسية المدرسية والمكتبية والهندسية، خدمات الطباعة الرقمية والتجليد، الكتب والروايات، ومستلزمات الهدايا والألعاب التعليمية وتجهيز الشركات والمدارس.",
          },
        },
        {
          "@type": "Question",
          name: "كيف يمكنني الطلب من المكتبة العربية؟",
          acceptedAnswer: {
            "@type": "Answer",
            text: "يمكنك الشراء والطلب مباشرة عبر المتجر الإلكتروني https://alarabiya.online/store أو عبر طلب سريع من واتساب على الرقم 9647838666999+ دون الحاجة لتسجيل حساب مسبق.",
          },
        },
      ],
    };

    return {
      title,
      description,
      canonicalUrl,
      imageUrl,
      ogType: "website",
      jsonLd: [websiteSchema, storeSchema, faqSchema],
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

  const meta = await resolveStorefrontSeoMeta(pathname, search, baseOrigin);
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
      extraTags.push(`  <script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n  </script>`);
    }
  }

  if (extraTags.length > 0) {
    result = result.replace("</head>", `${extraTags.join("\n")}\n  </head>`);
  }

  return result;
}

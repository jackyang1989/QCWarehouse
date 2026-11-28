import type { MetadataRoute } from "next";
import { publicSiteOrigin } from "./public-seo";

export default function robots(): MetadataRoute.Robots {
  const origin = publicSiteOrigin();
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/zh",
          "/catalog",
          "/zh/catalog",
          "/categories",
          "/zh/categories",
          "/services/",
          "/zh/services/",
          "/how-it-works",
          "/zh/how-it-works",
          "/report-guide",
          "/zh/report-guide",
          "/pricing",
          "/zh/pricing",
          "/faq",
          "/zh/faq",
          "/contact",
          "/zh/contact",
          "/legal",
          "/zh/legal",
        ],
        disallow: [
          "/api/",
          "/admin",
          "/wh",
          "/account",
          "/orders",
          "/parcels",
          "/items",
          "/reports",
          "/shipments",
          "/support",
          "/actions",
          "/billing",
          "/notifications",
          "/checkout",
          "/login",
          "/signup",
          "/onboarding",
          "/staff",
          "/gone",
          "/r/",
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}

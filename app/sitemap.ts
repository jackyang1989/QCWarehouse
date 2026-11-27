import type { MetadataRoute } from "next";
import { PUBLIC_ROUTE_SEO_KEYS, publicSiteOrigin } from "./public-seo";
import { localizePublicPath } from "../packages/core/locale-contract";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicSiteOrigin();
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const basePath of PUBLIC_ROUTE_SEO_KEYS) {
    const enPath = localizePublicPath(basePath, "en-US");
    const zhPath = localizePublicPath(basePath, "zh-CN");
    const enUrl = enPath === "/" ? origin : `${origin}${enPath}`;
    const zhUrl = `${origin}${zhPath}`;
    const priority = basePath === "/" ? 1.0 : basePath.startsWith("/legal") ? 0.4 : 0.8;
    const changeFrequency = basePath.startsWith("/legal") ? "monthly" : "weekly";

    entries.push({
      url: enUrl,
      lastModified: now,
      changeFrequency,
      priority,
      alternates: {
        languages: {
          "en-US": enUrl,
          "zh-CN": zhUrl,
        },
      },
    });
    entries.push({
      url: zhUrl,
      lastModified: now,
      changeFrequency,
      priority,
      alternates: {
        languages: {
          "en-US": enUrl,
          "zh-CN": zhUrl,
        },
      },
    });
  }

  return entries;
}

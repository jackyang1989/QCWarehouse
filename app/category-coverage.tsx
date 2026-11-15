"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useLoad } from "./ui";

export type ShowcaseCategorySpec = {
  key: "apparel" | "footwear" | "bags" | "home" | "electronics";
  name: string;
  photo: string;
  fallbackState: "ACTIVE" | "PLANNED" | "RESTRICTED";
  slugs: readonly string[];
  labels: readonly string[];
  desc: string;
};

export const SHOWCASE_CATEGORIES: readonly ShowcaseCategorySpec[] = [
  {
    key: "apparel",
    name: "Apparel",
    photo: "/brand/apparel.webp",
    fallbackState: "ACTIVE",
    slugs: ["apparel"],
    labels: ["Apparel"],
    desc: "T-shirts, leggings, sportswear and dresses",
  },
  {
    key: "footwear",
    name: "Footwear",
    photo: "",
    fallbackState: "PLANNED",
    slugs: ["footwear"],
    labels: ["Footwear"],
    desc: "Shoes, sneakers and footwear",
  },
  {
    key: "bags",
    name: "Bags & Accessories",
    photo: "",
    fallbackState: "PLANNED",
    slugs: ["bags"],
    labels: ["Bags", "Bags & Accessories"],
    desc: "Handbags, backpacks and accessories",
  },
  {
    key: "home",
    name: "Home & Lifestyle",
    photo: "",
    fallbackState: "PLANNED",
    slugs: ["home", "home_goods"],
    labels: ["Home", "Home goods", "Home & Lifestyle"],
    desc: "Home textiles, decor and everyday goods",
  },
  {
    key: "electronics",
    name: "Electronics",
    photo: "",
    fallbackState: "RESTRICTED",
    slugs: ["electronics"],
    labels: ["Electronics"],
    desc: "Limited visual checks only; no electrical certification",
  },
] as const;

export type CategoryOffer = {
  category_id: string;
  category_slug?: string;
  category: { en: string };
};

export function matchShowcaseCategoryOffer(
  spec: Pick<ShowcaseCategorySpec, "key" | "slugs" | "labels">,
  offer: { category_id?: unknown; category_slug?: unknown; category?: { en?: unknown } | null },
  extraName?: string
): boolean {
  const offerCatId = String(offer.category_id ?? "").trim().toLowerCase();
  const offerSlug = String(offer.category_slug ?? "").trim().toLowerCase();
  const offerName = String(offer.category?.en ?? "").trim().toLowerCase();
  if (offerCatId && offerCatId === spec.key.toLowerCase()) return true;
  if (offerSlug && spec.slugs.some((s) => s.toLowerCase() === offerSlug)) return true;
  const candidateLabels = extraName ? [...spec.labels, extraName] : spec.labels;
  return Boolean(offerName) && candidateLabels.some((lbl) => lbl.toLowerCase() === offerName);
}

export function CategoryCoverage() {
  const { data } = useLoad("/catalog");
  return <CategoryTiles offers={data?.offers ?? []} />;
}

export function CategoryTiles({ offers }: { offers: CategoryOffer[] }) {
  return (
    <div className="land-categories">
      {SHOWCASE_CATEGORIES.map((category) => {
        const matched = offers.find((offer) => matchShowcaseCategoryOffer(category, offer));
        const categoryId = matched?.category_id;
        const href = categoryId
          ? "/categories?" + new URLSearchParams({ category: categoryId })
          : category.key === "apparel"
          ? "/categories"
          : "/contact?topic=category";
        const style = category.photo
          ? ({ "--category-photo": `url(${category.photo})` } as CSSProperties)
          : ({ background: "#14263f" } as CSSProperties);
        const stateText = categoryId
          ? "Open for Orders"
          : category.fallbackState === "RESTRICTED"
          ? "Restricted"
          : "Planned";
        return (
          <Link key={category.name} className="land-category" href={href} style={style}>
            <strong>{category.name}</strong>
            <span className={categoryId ? "available" : undefined}>{stateText}</span>
          </Link>
        );
      })}
    </div>
  );
}

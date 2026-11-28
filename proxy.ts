import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolvePortalRoute } from "./packages/core/portal-routes";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === "/" ||
    pathname === "/gone" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/brand/") ||
    pathname.startsWith("/marketing/") ||
    pathname.startsWith("/r/") ||
    pathname === "/icon.png" ||
    pathname === "/icon.svg" ||
    pathname === "/apple-icon.png" ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Known active public/customer/warehouse/admin portal route skips DB check
  if (resolvePortalRoute(pathname)) {
    return NextResponse.next();
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const checkUrl = new URL("/api/v1/public/route-status", request.nextUrl.origin);
    checkUrl.searchParams.set("path", pathname);
    const res = await fetch(checkUrl, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" },
    }).finally(() => clearTimeout(timer));

    if (res.ok) {
      const data = (await res.json()) as {
        found?: boolean;
        http_status?: number;
        redirect_to?: string | null;
      };
      const target = data?.redirect_to;
      if (
        data?.found &&
        data.http_status === 301 &&
        typeof target === "string" &&
        target.startsWith("/") &&
        !target.startsWith("//") &&
        !target.includes("\\")
      ) {
        return NextResponse.redirect(new URL(target, request.nextUrl.origin), 301);
      }
      if (data?.found && data.http_status === 410) {
        const goneUrl = new URL("/gone", request.nextUrl.origin);
        goneUrl.searchParams.set("from", pathname);
        return NextResponse.rewrite(goneUrl);
      }
    }
  } catch {
    // Fail-open to Next.js router / not-found.tsx if internal route check times out
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

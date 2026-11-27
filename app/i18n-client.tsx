"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { t } from "../packages/core/i18n/messages";
import { localizePublicPath, type EnabledLocale } from "../packages/core/locale-contract";
import { request } from "./ui";

type LocaleContextValue = {
  locale: EnabledLocale;
  saving: boolean;
  switchLocale: (next: EnabledLocale, options?: { publicRoutePath?: string }) => Promise<void>;
};

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en-US",
  saving: false,
  switchLocale: async () => {},
});

export function LocaleProvider({
  initialLocale,
  authenticated = false,
  children,
}: {
  initialLocale: EnabledLocale;
  authenticated?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [locale, setLocale] = useState<EnabledLocale>(initialLocale);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLocale(initialLocale);
  }, [initialLocale]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  async function switchLocale(
    next: EnabledLocale,
    options?: { publicRoutePath?: string },
  ) {
    if (next === locale && !options?.publicRoutePath) return;
    setSaving(true);
    try {
      if (authenticated) {
        await request("/me/locale-preferences", "PATCH", { ui_locale: next });
      } else {
        await request("/public/locale", "POST", { locale: next });
      }
      setLocale(next);
      if (options?.publicRoutePath) {
        const target = localizePublicPath(options.publicRoutePath, next);
        router.push(target);
        router.refresh();
      }
    } catch {
      // Preserve explicit UI stability if offline; navigation still updates SSR cookie on /zh routes.
      if (options?.publicRoutePath) {
        router.push(localizePublicPath(options.publicRoutePath, next));
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <LocaleContext.Provider value={{ locale, saving, switchLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function PublicLanguageSwitcher({
  path = "/",
  locale: propLocale,
}: {
  path?: string;
  authenticated?: boolean;
  locale?: EnabledLocale;
}) {
  const ctx = useLocale();
  const activeLocale = propLocale ?? ctx.locale;

  function onSelect(next: EnabledLocale) {
    if (ctx.saving) return;
    void ctx.switchLocale(next, { publicRoutePath: path });
  }

  return (
    <div className="lang-switch" role="group" aria-label={t(activeLocale, "lang.switchLabel")}>
      <button
        type="button"
        className={`button sm${activeLocale === "en-US" ? " primary" : ""}`}
        aria-pressed={activeLocale === "en-US"}
        disabled={ctx.saving}
        onClick={() => onSelect("en-US")}
      >
        EN
      </button>
      <button
        type="button"
        className={`button sm${activeLocale === "zh-CN" ? " primary" : ""}`}
        aria-pressed={activeLocale === "zh-CN"}
        disabled={ctx.saving}
        onClick={() => onSelect("zh-CN")}
      >
        中文
      </button>
    </div>
  );
}

export function WorkspaceLanguageSwitcher({
  locale: explicitLocale,
}: {
  locale?: EnabledLocale;
}) {
  const { locale, saving, switchLocale } = useLocale();
  const active = explicitLocale ?? locale;

  return (
    <div className="lang-switch workspace-lang-switch" role="group" aria-label={t(active, "lang.switchLabel")}>
      <button
        type="button"
        className={`button sm${active === "en-US" ? " primary" : ""}`}
        aria-pressed={active === "en-US"}
        disabled={saving}
        onClick={() => void switchLocale("en-US")}
      >
        EN
      </button>
      <button
        type="button"
        className={`button sm${active === "zh-CN" ? " primary" : ""}`}
        aria-pressed={active === "zh-CN"}
        disabled={saving}
        onClick={() => void switchLocale("zh-CN")}
      >
        中文
      </button>
    </div>
  );
}

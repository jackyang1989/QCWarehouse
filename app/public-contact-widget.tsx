"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { Actor } from "../packages/core/common";
import { localizePublicPath, type EnabledLocale } from "../packages/core/locale-contract";
import { useLocale } from "./i18n-client";
import { request } from "./ui";

type ContactConfig = {
  support_email: string;
  whatsapp_enabled: boolean;
  whatsapp_verified: boolean;
  whatsapp_number: string | null;
  whatsapp_url: string | null;
  business_hours_zh: string;
  business_hours_en: string;
  response_sla_zh: string;
  response_sla_en: string;
  timezone: string;
  widget_enabled: boolean;
  widget_notice_zh: string;
  widget_notice_en: string;
};

const FALLBACK_CONFIG: ContactConfig = {
  support_email: "support@qcwarehouse.com",
  whatsapp_enabled: false,
  whatsapp_verified: false,
  whatsapp_number: null,
  whatsapp_url: null,
  business_hours_zh: "周一至周六 09:00–18:00（北京时间 / Asia/Shanghai）",
  business_hours_en: "Mon–Sat 09:00–18:00 (Asia/Shanghai · UTC+8)",
  response_sla_zh: "工单与邮件通常于 1 个工作日内人工回复（非实时在线聊天）",
  response_sla_en: "Inquiries & tickets are reviewed within 1 business day (no live chat)",
  timezone: "Asia/Shanghai",
  widget_enabled: true,
  widget_notice_zh: "欢迎提交售前或物流质检咨询，我们会通过邮件与工单记录跟进。",
  widget_notice_en: "Submit pre-order or inspection questions anytime—we follow up via email and ticket threads.",
};

export function PublicContactWidget({
  locale: explicitLocale,
  actor,
}: {
  locale?: EnabledLocale;
  actor?: Actor | null;
}) {
  const { locale: ctxLocale } = useLocale();
  const locale: EnabledLocale = explicitLocale ?? ctxLocale;
  const isZh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<ContactConfig>(FALLBACK_CONFIG);
  const [loadFailed, setLoadFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();

  useEffect(() => {
    let active = true;
    request("/public/contact-config")
      .then((res) => {
        if (active && res && typeof res.support_email === "string") {
          setConfig(res as ContactConfig);
          setLoadFailed(false);
        }
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!config.widget_enabled) return null;

  const isCustomer = actor?.kind === "customer";
  const requestHref = isCustomer ? "/support" : localizePublicPath("/contact", locale);
  const faqHref = localizePublicPath("/faq", locale);
  const showWhatsApp = Boolean(config.whatsapp_enabled && config.whatsapp_verified && config.whatsapp_url && config.whatsapp_number);

  return (
    <div className="pub-contact-widget no-print" lang={locale}>
      {open && (
        <div
          id={panelId}
          className="pub-contact-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
        >
          <div className="pub-contact-head">
            <div>
              <p className="pub-contact-eyebrow">
                {isZh ? "非实时联系通道" : "ASYNC SUPPORT DESK"}
              </p>
              <h2 id={headingId}>
                {isZh ? "帮助与售前质检咨询" : "Questions & Pre-Order Help"}
              </h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="button sm"
              aria-label={isZh ? "收起联系面板" : "Close support panel"}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            >
              ×
            </button>
          </div>

          <p className="pub-contact-notice">
            {isZh ? config.widget_notice_zh : config.widget_notice_en}
          </p>

          <div className="pub-contact-links">
            <Link
              className="pub-contact-link"
              href={faqHref}
              onClick={() => setOpen(false)}
            >
              <strong>{isZh ? "帮助中心与常见问题 (FAQ)" : "Help Center & Buyer FAQ"}</strong>
              <span>{isZh ? "查看收货地址、复测规则与拒收边界" : "Receiving codes, re-measurements & scope rules"}</span>
            </Link>

            <Link
              className="pub-contact-link"
              href={requestHref}
              onClick={() => setOpen(false)}
            >
              <strong>{isCustomer ? (isZh ? "提交正式售后/订单工单" : "Submit Support Ticket") : (isZh ? "提交售前或定制咨询" : "Submit a Request")}</strong>
              <span>{isCustomer ? (isZh ? "已登录：关联客户账号与工单追踪" : "Signed in: tracked inside your ticket inbox") : (isZh ? "获取可追踪回执编号 · 非实时聊天" : "Tracked receipt number · Ticket follow-up")}</span>
            </Link>

            <a
              className="pub-contact-link"
              href={`mailto:${config.support_email}`}
            >
              <strong>{isZh ? "发送电子邮件" : "Email Us"}</strong>
              <span>{config.support_email}</span>
            </a>

            {showWhatsApp && (
              <a
                className="pub-contact-link"
                href={config.whatsapp_url!}
                target="_blank"
                rel="noopener noreferrer"
              >
                <strong>{isZh ? "已核验 WhatsApp 通道" : "Verified WhatsApp Channel"}</strong>
                <span>{config.whatsapp_number}</span>
              </a>
            )}
          </div>

          <div className="pub-contact-meta">
            <div>
              <strong>{isZh ? "服务时段：" : "Hours: "}</strong>
              <span>{isZh ? config.business_hours_zh : config.business_hours_en}</span>
            </div>
            <div>
              <strong>{isZh ? "回复时限：" : "Response target: "}</strong>
              <span>{isZh ? config.response_sla_zh : config.response_sla_en}</span>
            </div>
            {loadFailed && (
              <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
                {isZh ? "当前展示默认官方联系信息，提交表单仍可正常送达。" : "Showing verified default contact details; inquiry submission remains available."}
              </p>
            )}
          </div>
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        className="pub-contact-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5h16v11H9l-5 4V5Z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
        <span>{isZh ? (open ? "收起帮助" : "联系与帮助") : (open ? "Close Help" : "Help & Contact")}</span>
      </button>
    </div>
  );
}

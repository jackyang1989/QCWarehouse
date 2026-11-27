"use client";

import { useEffect, useRef, useState } from "react";
import { Action, ErrorBlock, Panel, request, Tag, type Row } from "./ui";
import type { AiPurposeCode } from "../packages/core/ai-contract";
import type { Actor } from "../packages/core/common";

export type BilingualFieldSpec = {
  field_key: string;
  label: string;
  source_text: string;
  source_revision?: number;
  placeholders?: string[];
};

const DYN_TONE: Record<string, "green" | "blue" | "yellow" | "red" | "gray"> = {
  published: "green",
  approved: "blue",
  pending_review: "yellow",
  human_draft: "blue",
  machine_draft: "yellow",
  queued: "yellow",
  stale: "red",
  failed: "red",
  untranslated: "gray",
};

export function BilingualEntityPanel({
  entityType,
  entityId,
  entityLabel,
  purposeCode = "KNOWLEDGE_TRANSLATION_DRAFT",
  sourceLocale = "zh-CN",
  targetLocale = "en-US",
  fields,
  actor,
}: {
  entityType: string;
  entityId: string;
  entityLabel: string;
  purposeCode?: AiPurposeCode;
  sourceLocale?: "zh-CN" | "en-US";
  targetLocale?: "en-US" | "zh-CN";
  fields: readonly BilingualFieldSpec[];
  actor?: Actor | Row | null;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [autoFillOnBlur, setAutoFillOnBlur] = useState(true);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastHashByKey = useRef<Record<string, string>>({});
  const loadSeq = useRef(0);
  const mounted = useRef(true);

  function clearPendingTimers() {
    for (const timer of Object.values(debounceTimers.current)) {
      clearTimeout(timer);
    }
    debounceTimers.current = {};
  }

  function clearDraftField(fieldKey: string) {
    setDraftEdits((prev) => {
      if (!(fieldKey in prev)) return prev;
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });
  }

  async function loadTranslations() {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        entity_type: entityType,
        entity_id: entityId,
        locale: targetLocale,
      });
      const res = (await request(`/staff/admin/i18n/translations?${qs.toString()}`)) as { translations: Row[] };
      if (!mounted.current || loadSeq.current !== seq) return;
      setRows(res.translations ?? []);
    } catch (e) {
      if (!mounted.current || loadSeq.current !== seq) return;
      setError(e);
    } finally {
      if (mounted.current && loadSeq.current === seq) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    clearPendingTimers();
    lastHashByKey.current = {};
    setDraftEdits({});
    setBanner(null);
    void loadTranslations();
    return () => {
      mounted.current = false;
      clearPendingTimers();
    };
  }, [entityType, entityId, targetLocale]);

  const latestByField = new Map<string, Row>();
  for (const r of rows) {
    const fk = String(r.field_key);
    const prev = latestByField.get(fk);
    if (!prev || Number(r.revision) > Number(prev.revision)) {
      latestByField.set(fk, r);
    }
  }

  function triggerDebouncedAutoBlur(f: BilingualFieldSpec) {
    if (!autoFillOnBlur || !f.source_text.trim()) return;
    const dedupeSig = `${entityId}:${f.field_key}:${f.source_revision ?? 1}:${f.source_text.trim()}`;
    if (lastHashByKey.current[f.field_key] === dedupeSig) return;
    const existingTimer = debounceTimers.current[f.field_key];
    if (existingTimer) clearTimeout(existingTimer);

    const capturedEntityId = entityId;
    debounceTimers.current[f.field_key] = setTimeout(async () => {
      delete debounceTimers.current[f.field_key];
      lastHashByKey.current[f.field_key] = dedupeSig;
      try {
        const res = (await request("/staff/admin/translations/request", "POST", {
          mode: "auto_blur",
          purpose_code: purposeCode,
          entity_type: entityType,
          entity_id: capturedEntityId,
          source_locale: sourceLocale,
          target_locale: targetLocale,
          fields: [
            {
              field_key: f.field_key,
              source_revision: f.source_revision ?? 1,
              source_text: f.source_text,
              placeholders: f.placeholders ?? [],
            },
          ],
        })) as { manual_fallback?: boolean; queued?: boolean; glossary_applied?: unknown[] };
        if (!mounted.current || capturedEntityId !== entityId) return;
        if (res.manual_fallback) {
          setBanner("AI 自动翻译未启用或未配置路由；已保持人工双语录入可用，不阻塞草稿保存。");
        } else if (res.glossary_applied?.length) {
          setBanner("已命中已审批双语术语词典，零外部调用直接复用权威译文。");
        } else if (res.queued) {
          setBanner(`已提交 ${f.label} 的去抖异步翻译任务。`);
        }
        await loadTranslations();
      } catch (e) {
        if (mounted.current && capturedEntityId === entityId) {
          setError(e);
        }
      }
    }, 600);
  }

  const canReview = actor?.kind === "staff" && Array.isArray(actor.roles) && (actor.roles.includes("reviewer") || actor.roles.includes("super_admin"));

  return (
    <Panel
      title={`动态双语工作区 · ${entityLabel}`}
      subtitle={`实体 ${entityType} (${entityId.slice(0, 8)}…) · 源语言 ${sourceLocale} -> 目标语言 ${targetLocale} · 业务编码/数值/价格保持单次维护`}
    >
      <div className="row flexwrap" style={{ gap: 10, marginBottom: 10, alignItems: "center" }}>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={autoFillOnBlur}
            onChange={(e) => setAutoFillOnBlur(e.target.checked)}
          />
          失焦去抖自动补全缺失译文（600ms去重，不覆盖人工锁）
        </label>
        <Action
          sm
          run={async () => {
            setError(null);
            const nonEmpty = fields.filter((f) => f.source_text.trim().length > 0);
            if (!nonEmpty.length) return;
            const res = (await request("/staff/admin/translations/request", "POST", {
              mode: "whole_form",
              purpose_code: purposeCode,
              entity_type: entityType,
              entity_id: entityId,
              source_locale: sourceLocale,
              target_locale: targetLocale,
              fields: nonEmpty.map((f) => ({
                field_key: f.field_key,
                source_revision: f.source_revision ?? 1,
                source_text: f.source_text,
                placeholders: f.placeholders ?? [],
              })),
            })) as { queued?: boolean; glossary_applied?: unknown[]; skipped_protected?: unknown[] };
            setBanner(
              `整表翻译：术语命中 ${res.glossary_applied?.length ?? 0} 项，跳过受保护字段 ${res.skipped_protected?.length ?? 0} 项，${res.queued ? "已入队异步翻译" : "无需重复调用 AI"}`,
            );
            await loadTranslations();
          }}
        >
          整表一键翻译
        </Action>
        {canReview && (
          <Action
            sm
            primary
            run={async () => {
              setError(null);
              await request("/staff/admin/translations/publish-entity", "POST", {
                entity_type: entityType,
                entity_id: entityId,
                required_fields: fields.map((f) => f.field_key),
                required_locales: [targetLocale],
              });
              setBanner("已通过双语完整性核验并发布全部目标语言字段。");
              await loadTranslations();
            }}
          >
            核验并发布整表译文
          </Action>
        )}
        <button type="button" className="button sm" onClick={() => void loadTranslations()} disabled={loading}>
          刷新状态
        </button>
      </div>

      {error ? <ErrorBlock error={error instanceof Error ? error.message : String(error)} /> : null}
      {banner && <div className="line-note" style={{ marginBottom: 10 }}>{banner}</div>}

      <div className="stack" style={{ gap: 12 }}>
        {fields.map((f) => {
          const cur = latestByField.get(f.field_key);
          const curStatus = String(cur?.status ?? "untranslated");
          const curText = String(cur?.translated_text ?? "");
          const candText = cur?.candidate_text ? String(cur.candidate_text) : "";
          const candStatus = cur?.candidate_status ? String(cur.candidate_status) : "";
          const editVal = draftEdits[f.field_key] ?? curText;

          return (
            <div key={f.field_key} style={{ border: "1px solid var(--line, #e2e8f0)", borderRadius: 8, padding: 12 }}>
              <div className="row flexwrap" style={{ justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                <div>
                  <strong>{f.label}</strong> (<code>{f.field_key}</code>)
                  {cur?.revision ? <span className="muted"> · rev.{String(cur.revision)}</span> : null}
                </div>
                <div className="row flexwrap" style={{ gap: 6 }}>
                  <Tag tone={DYN_TONE[curStatus] ?? "gray"}>{curStatus}</Tag>
                  {cur?.human_locked ? <Tag tone="blue">人工锁定</Tag> : null}
                  {curStatus === "stale" ? <Tag tone="red">源文已更新，待重审</Tag> : null}
                </div>
              </div>

              <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
                <strong>源文 ({sourceLocale})：</strong>{f.source_text || "（未填写源文）"}
              </div>

              {candText && (candStatus === "pending_apply" || candStatus === "stale_candidate") && (
                <div style={{ background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: 6, padding: 8, marginBottom: 8 }}>
                  <div>
                    <strong>AI 候选译文 ({candStatus === "stale_candidate" ? "已过期，仅作参考" : "待核对应用"})：</strong>
                    {candText}
                  </div>
                  <div className="row flexwrap" style={{ gap: 6, marginTop: 6 }}>
                    {candStatus === "pending_apply" && cur?.id && (
                      <Action
                        sm
                        run={async () => {
                          await request(`/staff/admin/translations/${cur.id}/apply-candidate`, "POST", {
                            expected_revision: Number(cur.revision),
                            confirm_overwrite_human_lock: Boolean(cur.human_locked),
                          });
                          clearDraftField(f.field_key);
                          setBanner(`已应用 ${f.label} 的候选译文生成新修订版。`);
                          await loadTranslations();
                        }}
                      >
                        应用候选（生成新修订版）
                      </Action>
                    )}
                    {cur?.id && (
                      <Action
                        sm
                        run={async () => {
                          await request(`/staff/admin/translations/${cur.id}/reject-candidate`, "POST", {});
                          clearDraftField(f.field_key);
                          setBanner(`已拒绝 ${f.label} 的候选译文。`);
                          await loadTranslations();
                        }}
                      >
                        拒绝候选
                      </Action>
                    )}
                  </div>
                </div>
              )}

              <div className="row flexwrap" style={{ gap: 8, alignItems: "center" }}>
                <input
                  style={{ flex: 1, minWidth: 260 }}
                  value={editVal}
                  placeholder={`输入 ${targetLocale} 译文（AI未配置亦可纯人工填写）`}
                  onChange={(e) => setDraftEdits((prev) => ({ ...prev, [f.field_key]: e.target.value }))}
                  onBlur={() => triggerDebouncedAutoBlur(f)}
                />
                <Action
                  sm
                  run={async () => {
                    await request("/staff/admin/i18n/translations", "POST", {
                      entity_type: entityType,
                      entity_id: entityId,
                      field_key: f.field_key,
                      locale: targetLocale,
                      source_locale: sourceLocale,
                      source_revision: f.source_revision ?? 1,
                      source_text: f.source_text || f.label,
                      translated_text: editVal,
                      translator_kind: "human",
                      submit_for_review: true,
                    });
                    clearDraftField(f.field_key);
                    setBanner(`已保存 ${f.label} 的人工译文草稿并提交审校。`);
                    await loadTranslations();
                  }}
                >
                  保存人工译文
                </Action>
                <Action
                  sm
                  run={async () => {
                    const res = (await request("/staff/admin/translations/request", "POST", {
                      mode: "single_field",
                      purpose_code: purposeCode,
                      entity_type: entityType,
                      entity_id: entityId,
                      source_locale: sourceLocale,
                      target_locale: targetLocale,
                      fields: [
                        {
                          field_key: f.field_key,
                          source_revision: f.source_revision ?? 1,
                          source_text: f.source_text,
                          placeholders: f.placeholders ?? [],
                        },
                      ],
                    })) as { queued?: boolean; glossary_applied?: unknown[] };
                    setBanner(res.glossary_applied?.length ? "已直接复用审批术语。" : "已加入单字段异步翻译队列。");
                    await loadTranslations();
                  }}
                >
                  翻译此字段
                </Action>
                {canReview && cur?.id && !["stale", "failed", "untranslated", "queued"].includes(curStatus) && (
                  <>
                    <Action
                      sm
                      run={async () => {
                        await request(`/staff/admin/i18n/translations/${cur.id}/decide`, "POST", { decision: "approve" });
                        setBanner(`已审核通过 ${f.label}。`);
                        await loadTranslations();
                      }}
                    >
                      SoD 审核通过
                    </Action>
                    <Action
                      sm
                      run={async () => {
                        await request(`/staff/admin/i18n/translations/${cur.id}/decide`, "POST", { decision: "lock_human" });
                        setBanner(`已锁定 ${f.label}（禁止任何 AI 自动覆盖）。`);
                        await loadTranslations();
                      }}
                    >
                      锁定人工译文
                    </Action>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

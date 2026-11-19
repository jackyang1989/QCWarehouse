"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

export const ORDER_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  draft: { label: "草稿待提交", tone: "gray" },
  awaiting_payment: { label: "待客户付款", tone: "yellow" },
  awaiting_samples: { label: "待样件到仓", tone: "yellow" },
  samples_ready: { label: "已核身待开检", tone: "blue" },
  queued: { label: "待安排质检", tone: "blue" },
  inspecting: { label: "质检进行中", tone: "blue" },
  qa_review: { label: "待 QA 复核", tone: "yellow" },
  report_ready: { label: "报告已发布", tone: "green" },
  action_pending: { label: "待客户处置", tone: "yellow" },
  closed: { label: "已完结", tone: "green" },
  on_hold: { label: "暂停阻塞中", tone: "red" },
  cancelled: { label: "已取消", tone: "gray" },
};

export const PAYMENT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  requires_payment: { label: "待付款", tone: "yellow" },
  processing: { label: "渠道确认中", tone: "blue" },
  succeeded: { label: "支付成功", tone: "green" },
  partially_refunded: { label: "部分退款", tone: "blue" },
  refunded: { label: "已全额退款", tone: "gray" },
  failed: { label: "支付失败", tone: "red" },
  canceled: { label: "已取消/超时", tone: "gray" },
  open: { label: "待付款", tone: "yellow" },
  paid: { label: "已付款", tone: "green" },
  void: { label: "已作废", tone: "gray" },
  reconciliation: { label: "待对账", tone: "red" },
  expired: { label: "报价已过期", tone: "gray" },
};

export const REFUND_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  requested: { label: "待独立审批", tone: "yellow" },
  approved: { label: "已批待渠道退款", tone: "blue" },
  succeeded: { label: "退款已成功", tone: "green" },
  rejected: { label: "已驳回", tone: "red" },
  failed: { label: "渠道退款失败", tone: "red" },
  none: { label: "未退款", tone: "gray" },
  refund_pending: { label: "退款审批/处理中", tone: "yellow" },
  partial_refund: { label: "已部分退款", tone: "blue" },
  full_refund: { label: "已全额退款", tone: "gray" },
  refund_closed: { label: "退款申请已结束", tone: "gray" },
};

export const RECON_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  reconciled: { label: "账实已对平", tone: "green" },
  pending_webhook: { label: "待回调确认", tone: "blue" },
  issue: { label: "存在对账异常", tone: "red" },
  disputed: { label: "渠道争议/拒付", tone: "red" },
  not_applicable: { label: "未入账无需对账", tone: "gray" },
};

export const PURPOSE_ZH: Record<string, string> = {
  inspection: "质检服务费",
  dispatch: "出库/退货代收运费",
  storage: "延期仓储费",
};

export const SERVICE_CODE_ZH: Record<string, string> = {
  inspection: "标准单品/多件质检",
  std: "标准质检",
  compare: "样品横向对比 (2–3件)",
  reference_match: "确认样一致核对",
};

export const USER_STATUS_ZH: Record<string, { label: string; tone: "green" | "yellow" | "red" | "gray" }> = {
  active: { label: "正常启用", tone: "green" },
  restricted: { label: "受限管控", tone: "yellow" },
  disabled: { label: "已停用", tone: "red" },
  closed: { label: "已注销", tone: "gray" },
};

export const TASK_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  PENDING: { label: "待条件就绪", tone: "gray" },
  READY: { label: "待领取开检", tone: "yellow" },
  ASSIGNED: { label: "已指派待检", tone: "blue" },
  IN_PROGRESS: { label: "检验执行中", tone: "blue" },
  SUBMITTED: { label: "已提交待 QA", tone: "yellow" },
  QA_APPROVED: { label: "QA 已通过", tone: "green" },
  VOID: { label: "已作废", tone: "gray" },
};

export const REPORT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  draft: { label: "草稿/退回修改", tone: "yellow" },
  submitted: { label: "已提交待 QA 复核", tone: "yellow" },
  qa_approved: { label: "QA 已批·待生成 PDF", tone: "blue" },
  published: { label: "已正式发布", tone: "green" },
  superseded: { label: "历史旧版本", tone: "gray" },
};

export const TICKET_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  open: { label: "待处理", tone: "red" },
  waiting_customer: { label: "待客户回复", tone: "yellow" },
  waiting_internal: { label: "待内部跟进", tone: "blue" },
  resolved: { label: "已解决", tone: "green" },
  closed: { label: "已关闭", tone: "gray" },
};

export const TICKET_CATEGORY_ZH: Record<string, string> = {
  identity_unclear: "未认领包裹审核",
  receipt_mismatch: "收货数量/品类不符",
  measurement_dispute: "质检结果异议",
  return_info_incomplete: "退货资料待补",
  damage_or_loss: "库内丢损与赔付",
  payment_refund: "付款/对账/退款",
  privacy_share: "隐私与分享请求",
  non_standard_quote: "非标/超规询价",
  recovery: "账号找回双人审批",
  delivery_issue: "派送/收件异常",
  tracking_exception: "物流追踪异常",
  disposal: "逾期/违禁处置",
};

export const INCIDENT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  open: { label: "待调查拟方案", tone: "red" },
  proposed: { label: "待独立财务审批", tone: "yellow" },
  approved_awaiting_customer: { label: "已批待客户确认", tone: "blue" },
  customer_rejected: { label: "客户驳回待重拟", tone: "red" },
  awaiting_payout: { label: "客户已确认·待打款", tone: "yellow" },
  resolved: { label: "已赔付结案", tone: "green" },
  closed: { label: "已关闭", tone: "gray" },
};

export const INCIDENT_KIND_ZH: Record<string, string> = {
  loss: "库内实物缺失",
  damage: "库内物理破损",
  wrong_inspection: "质检重大差错",
};

export const DISPOSAL_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  pending_approval: { label: "待独立审批", tone: "yellow" },
  approved: { label: "已审批待执行", tone: "blue" },
  executed: { label: "已执行归档", tone: "green" },
  cancelled: { label: "已取消", tone: "gray" },
};

export const STOCKTAKE_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  in_progress: { label: "盘点作业中", tone: "blue" },
  submitted: { label: "有差异待主管复核", tone: "yellow" },
  approved: { label: "差异已调账结案", tone: "green" },
  recount: { label: "退回重新复盘", tone: "red" },
};

export const BATCH_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  draft: { label: "客户组批草稿", tone: "gray" },
  confirmed: { label: "待称重计价", tone: "yellow" },
  quoted: { label: "已报价待付款", tone: "yellow" },
  paid: { label: "已付款待打包交接", tone: "blue" },
  completed: { label: "已出库交接", tone: "green" },
  cancelled: { label: "已取消", tone: "gray" },
};

export const DISPOSITION_ACTION_ZH: Record<string, string> = {
  to_forwarder: "发往集运仓",
  to_domestic_address: "发往国内指定地址",
  return_to_seller: "退回原卖家",
  retain: "延长库内保管",
  reserve_reference: "留存为确认样",
};

export const TRANSPORT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  unknown: { label: "待承运商揽收", tone: "gray" },
  in_transit: { label: "运输在途", tone: "blue" },
  out_for_delivery: { label: "派送中", tone: "blue" },
  delivered: { label: "承运商已签收", tone: "green" },
  returning: { label: "退回途中", tone: "yellow" },
  returned: { label: "已退回", tone: "gray" },
  exception: { label: "物流异常", tone: "red" },
};

export const SYNC_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  active: { label: "正常同步", tone: "green" },
  pending: { label: "待首次同步", tone: "gray" },
  needs_verification: { label: "待手机号核验", tone: "yellow" },
  needs_carrier: { label: "待识别承运商", tone: "yellow" },
  delayed: { label: "同步延迟", tone: "yellow" },
  provider_error: { label: "接口查询异常", tone: "red" },
  unsupported: { label: "暂不支持自动查询", tone: "gray" },
  no_record: { label: "暂无物流记录", tone: "gray" },
  stopped: { label: "已停止追踪", tone: "gray" },
};

export const TRACKING_ALERT_KIND_ZH: Record<string, string> = {
  delivered_unreceived: "已签收但仓库未入库",
  stale_transit: "长时间在途无更新",
  delivery_exception: "派送失败/拦截异常",
  returned_to_sender: "快件被退回寄件方",
  sync_failed: "渠道同步连续失败",
};

export const AUDIT_ACTION_ZH: Record<string, string> = {
  complete_registration: "客户完成注册并领取专属收件码",
  create_order: "创建质检草稿订单",
  submit_order: "客户同意条款并提交订单报价",
  issue_manual_quote: "人工核定并下发非标报价",
  payment_confirmed: "确认支付入账",
  payment_reconciliation_required: "标记延迟/重复付款待对账",
  payment_amount_mismatch: "拦截回调金额/币种不符",
  resolve_payment_dispute: "处理支付渠道争议冻结",
  request_refund: "发起原路退款申请",
  approve_refund: "独立复核批准退款",
  reject_refund: "独立复核驳回退款",
  refund_executed: "渠道退款执行完成",
  check_in_package: "仓库实收包裹登记",
  create_intake_items: "拆包生成逐件实物条码",
  assign_item: "实物绑定订单预期位置",
  identify_item: "确认实物 SKU/颜色/尺码核身",
  decide_intake_claim: "核验未认领包裹归属申诉",
  bind_unmatched_owner: "人工绑定未认领包裹客户",
  bind_unmatched_package: "人工绑定未认领包裹至客户档案",
  physical_check_in: "仓库扫码实收包裹入库",
  intake_items: "拆包登记逐件实物编码",
  advice_parcel: "客户登记卖家发运包裹预报",
  create_draft: "创建质检草稿订单",
  edit_draft: "编辑质检草稿订单",
  cancel_order: "取消质检订单",
  hold_order: "人工暂停订单流转 (Hold)",
  resume_order: "人工恢复订单流转 (Resume)",
  close_order: "完结并归档质检订单",
  start_task: "领取并开始单件质检任务",
  record_results: "保存质检实测与拍照证据",
  submit_task: "提交单件质检任务结果",
  publish_report: "正式生成并发布质检报告 PDF",
  authorize_disposition: "客户下达检后实物处置指令",
  plan_dispatch: "创建检后发运/退货出库批次",
  confirm_dispatch: "客户确认出库批次地址与清单",
  quote_batch: "仓库称重并签发出库运费报价",
  pack_shipment: "完成出库包裹打包称重",
  handover_shipment: "完成出库包裹承运商交接",
  create_ticket: "创建客户服务工单",
  issue_media_upload_url: "签发媒体凭证上传预签名地址",
  complete_media_upload: "完成媒体凭证文件上传校验",
  rejected_forbidden: "拦截越权或未授权访问请求 (403)",
  submit_report: "提交质检报告供 QA 复核",
  approve_report: "QA 独立复核批准报告",
  return_report: "QA 退回报告要求补正",
  create_incident: "登记库内丢损/异常事故",
  propose_incident_resolution: "拟定事故赔偿方案",
  approve_incident_resolution: "独立财务审批事故方案",
  customer_respond_incident: "客户响应事故赔偿方案",
  resolve_incident_compensation: "登记打款凭证并结案事故",
  create_disposal_case: "立项逾期/违禁件处置单",
  approve_disposal_case: "独立审批特殊处置单",
  execute_disposal_case: "登记完成物理处置归档",
  retry_failed_job: "人工重排失败后台作业",
  retry_email_delivery: "补发邮件投递尝试",
  update_user_roles: "调整员工系统角色权限",
  update_user_status: "变更用户账号启用状态",
  publish_terms_version: "正式发布法务协议版本",
  publish_template: "独立复核发布质检模板",
  publish_sku_price: "发布服务价格新版本",
  publish_shipping_rate: "发布运费费率新版本",
  create_warehouse_address: "新建仓库收货地址版本",
  set_default_address: "切换默认公共仓库地址",
  update_business_calendar: "更新工作日历与节假日",
  save_quote_policy: "更新报价与保管SLA策略",
  record_recovery_run: "登记备份恢复与对账演练",
  record_rehearsal_run: "归档实仓演练验证证据",
  configure_legal_entity: "更新运营法律主体信息",
  record_launch_signoff: "签署上线门禁与运行模式",
  ticket_claim: "员工领取工单",
  ticket_state_change: "调整工单指派人",
  ticket_message: "发送工单公开回复",
  ticket_internal_note: "记录工单内部备注",
  print_label: "生成并打印内部条码标签",
  verify_label_readback: "扫码回读校验内部条码标签",
  register: "客户完成账号注册",
  advise_parcel: "客户登记卖家运单预报",
  audit_projection_fixture: "安全审计投影校验记录",
  submit_tracking_translation: "提交物流轨迹英文译稿",
  approve_tracking_translation: "独立复核批准物流英文轨迹",
  correct_tracking: "受控更正运单号或承运商",
  move_item: "调整实物存放库位",
  create_storage_location: "新增仓库库位",
  set_storage_location_active: "启停仓库库位",
  link_parcel_order: "关联预报包裹至订单",
  unassign_item: "解除实物与订单绑定",
  identify_item_mismatch: "登记实物与预报不符",
  quarantine_package: "隔离异常/违禁包裹",
  quarantine_item: "隔离异常/违禁实物",
  record_partial_shipment: "登记分批到仓包裹",
  report_quantity_discrepancy: "申报收货数量差异",
  request_intake_claim: "客户提交无主包裹认领申诉",
  create_report_share: "创建报告外部分享链接",
  revoke_report_share: "撤销报告外部分享链接",
  record_task_shot: "上传质检机位实拍照片",
  translate_report_candidate: "提交质检报告英文译稿",
  amend_report: "创建质检报告修订版本",
  edit_report_revision: "编辑报告修订草稿",
  submit_revision: "提交报告修订版复核",
  create_report_dispute: "发起质检报告结果异议",
  retry_outbox: "重试失败后台任务",
  staff_update_user_status: "调整用户账号状态",
  staff_update_user_roles: "调整员工角色权限",
  accept_dispatch_quote: "客户确认出库运费报价",
  amend_dispatch_batch: "调整出库批次明细",
  cancel_disposition: "取消检后处置指令",
  handover: "完成出库承运商交接",
  quote_storage: "生成延期仓储费报价",
  receive_return: "登记退件回仓",
  reserve_reference: "留存实物为确认样",
  release_reference: "释放确认样留存",
  void_expired_fulfillment_charge: "作废超时未付履约费用",
  checkout_completed_pending_webhook: "结账回跳待回调确认",
  checkout_expired: "支付会话超时关闭",
  create_stocktake: "发起仓库库存盘点",
  submit_stocktake: "提交库存盘点结果",
  approve_stocktake: "复核批准盘点调账",
  recount_stocktake: "退回库存盘点复盘",
  stocktake_discrepancy_frozen: "盘点差异冻结实物",
  stocktake_item_recovered: "盘点找回遗失实物",
  stocktake_recount_required: "盘点差异触发二次复盘",
  staff_correct_tracking: "人工纠偏物流运单",
  correct_parcel_tracking: "客户更正预报运单",
  verify_tracking: "核验快递手机号后四位",
  request_tracking_query: "发起主动物流轨迹查询",
  update_tracking_alert: "更新物流异常告警",
  update_quote_policy: "更新报价与保管 SLA 策略",
  submit_template: "提交质检模板审核",
  create_category: "新增商品品类",
  update_category_status: "调整品类准入状态",
  publish_offer: "发布服务目录项目",
  update_offer_status: "调整服务目录启用状态",
  create_capability: "新增品类作业能力",
  approve_capability: "审批通过品类作业能力",
  revoke_capability: "撤销品类作业能力",
  activate_warehouse_address: "启用仓库收货地址",
  deactivate_warehouse_address: "停用仓库收货地址",
  set_disposal_execution_switch: "切换特殊处置执行开关",
  request_manual_quote: "提交非标订单人工询价",
  extend_order_arrival: "延长订单样件到仓期限",
  reconcile_quantity_shortage: "核销订单少件阻塞",
  request_order_after_sales: "发起订单售后申诉",
  respond_order_mismatch: "响应订单收货不符",
  propose_scope: "拟定服务范围变更",
  accept_scope: "确认服务范围变更",
  accept_upward_scope: "确认升级服务范围补差",
  renew_scope_supplement: "续期范围变更补差报价",
  convert_order_to_two: "拆分订单为两笔委托",
  export_privacy_data: "导出客户隐私数据",
  request_privacy_action: "提交隐私合规请求",
  customer_reauth: "客户敏感操作二次验证",
  link_identity: "绑定第三方登录方式",
  unlink_identity: "解绑第三方登录方式",
  change_primary_email: "变更主登录邮箱",
  revoke_session: "注销指定设备会话",
  revoke_other_sessions: "注销其他全部会话",
  recommend_account_recovery: "初审建议通过账号找回",
  approve_account_recovery: "终审批准账号找回",
  reject_account_recovery: "驳回账号找回申请",
  execute_account_recovery: "执行账号找回切换",
  close_customer_account: "客户注销账号",
  update_customer_preferences: "更新客户偏好设置",
  reference_outbound_conflict: "拦截确认样误出库冲突",
};

export const ROLE_ZH: Record<string, string> = {
  super_admin: "超级管理员",
  finance: "财务专员",
  support: "客服与运营专员",
  template_admin: "模板与目录配置",
  warehouse_admin: "仓库主管",
  receiver: "收货与库管员",
  inspector: "现场质检员",
  reviewer: "独立 QA 复核员",
};

export const CUSTODY_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  in_transit: { label: "在途未到仓", tone: "gray" },
  received: { label: "已实收暂存", tone: "yellow" },
  stored: { label: "在库保管中", tone: "green" },
  at_warehouse: { label: "在库保管中", tone: "green" },
  outbound: { label: "已出库交接", tone: "blue" },
  shipped: { label: "已发运离库", tone: "blue" },
  disposed: { label: "已特殊处置归档", tone: "gray" },
};

export const IDENTITY_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  identified: { label: "已完成 SKU 核身", tone: "green" },
  verified: { label: "已核验归属", tone: "green" },
  pending: { label: "待 SKU 核身", tone: "yellow" },
  quarantined: { label: "违禁/异常隔离", tone: "red" },
  unmatched: { label: "无主未认领", tone: "yellow" },
};

export const PACKAGE_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  checked_in: { label: "已扫码实收·待拆包", tone: "yellow" },
  unpacked: { label: "已拆包建档", tone: "blue" },
  stored: { label: "已上架保管", tone: "green" },
  unmatched: { label: "无主待认领归属", tone: "red" },
  quarantined: { label: "违禁/破损隔离", tone: "red" },
};

export const CONDITION_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "red" | "gray" }> = {
  good: { label: "外观完好", tone: "green" },
  unchecked: { label: "待拆包初检", tone: "gray" },
  damaged: { label: "收货有破损", tone: "red" },
  contaminated: { label: "污损/受潮", tone: "red" },
};

export function describeWarehouseItemLifecycle(item: {
  custody_state?: string | null;
  identity_state?: string | null;
  order_no?: string | null;
  order_number?: string | null;
}) {
  const custody = item.custody_state ?? "received";
  const identity = item.identity_state ?? "pending";
  const hasOrder = Boolean(item.order_no || item.order_number);

  if (custody === "disposed") {
    return {
      custodyLabel: "已特殊处置归档",
      custodyTone: "gray" as const,
      identityLabel: identity === "identified" ? "历史已绑单后处置" : "逾期/无主直接处置（免 SKU 核身）",
      identityTone: "gray" as const,
      note: "该实物已通过双人复核完成特殊处置销毁/变卖，生命周期已终结，无需再执行订单 SKU 核身。",
    };
  }
  if (custody === "outbound" || custody === "shipped") {
    return {
      custodyLabel: "已出库交接",
      custodyTone: "blue" as const,
      identityLabel: identity === "identified" ? "检后正常发运出库" : "未绑单原样退回/出库（免 SKU 核身）",
      identityTone: identity === "identified" ? ("green" as const) : ("blue" as const),
      note: identity === "identified"
        ? "已完成质检并按客户指令发运离库。"
        : "该实物未关联正式质检单，已按原样退回或未委托件出库处理，故未经过订单行 SKU 核身。",
    };
  }
  if (identity === "quarantined") {
    return {
      custodyLabel: CUSTODY_STATE_ZH[custody]?.label ?? custody,
      custodyTone: "red" as const,
      identityLabel: "违禁/异常隔离管控",
      identityTone: "red" as const,
      note: "已移入隔离区锁定，禁止进入常规质检或普通发运，需走异常处置流程。",
    };
  }
  return {
    custodyLabel: CUSTODY_STATE_ZH[custody]?.label ?? custody,
    custodyTone: CUSTODY_STATE_ZH[custody]?.tone ?? ("gray" as const),
    identityLabel: identity === "identified"
      ? "已完成 SKU 核身"
      : hasOrder
        ? "已绑单·待现场核对 SKU"
        : "在库待绑定订单并核身",
    identityTone: identity === "identified" ? ("green" as const) : ("yellow" as const),
    note: identity === "identified" ? "实物已绑定订单预期行并通过 SKU/颜色/尺码核对。" : "需仓库人员在样品建档台核对吊牌/SKU 后完成核身。",
  };
}

export function WarehouseItemLifecycleTags({
  item,
  compact = false,
}: {
  item: { custody_state?: string | null; identity_state?: string | null; order_no?: string | null; order_number?: string | null };
  compact?: boolean;
}) {
  const info = describeWarehouseItemLifecycle(item);
  return (
    <div className={compact ? "actions" : "cell-stack"} title={info.note}>
      <span className={`tag ${info.custodyTone}`}>{info.custodyLabel}</span>
      <span className={`tag ${info.identityTone}`}>{info.identityLabel}</span>
    </div>
  );
}

export function describeOrderNextResponsibility(order: {
  state?: string | null;
  open_block_count?: number;
  arrived_units?: number;
  identified_units?: number;
  expected_units?: number;
}) {
  if (Number(order.open_block_count ?? 0) > 0 || order.state === "on_hold") {
    return { owner: "客服 / 运营专员", action: "跟进异常工单或收货差异，解除订单阻塞", tone: "red" as const };
  }
  switch (order.state) {
    case "draft":
      return { owner: "客户", action: "确认商品明细并提交订单报价", tone: "gray" as const };
    case "awaiting_payment":
      return { owner: "客户 / 财务", action: "等待客户完成付款或人工报价确认", tone: "yellow" as const };
    case "awaiting_samples": {
      const arrived = Number(order.arrived_units ?? 0);
      const identified = Number(order.identified_units ?? 0);
      const expected = Number(order.expected_units ?? 0);
      if (arrived === 0) return { owner: "卖家 / 仓库收货", action: "等待快递包裹到仓并扫码实收", tone: "yellow" as const };
      if (identified < arrived || identified < expected) {
        return { owner: "仓库收货员 (receiver)", action: `已到 ${arrived} 件，待拆包完成剩余 ${Math.max(0, expected - identified)} 件 SKU 核身`, tone: "blue" as const };
      }
      return { owner: "仓库收货员", action: "确认全部样件核身就绪转入待检", tone: "blue" as const };
    }
    case "samples_ready":
    case "queued":
      return { owner: "现场质检员 (inspector)", action: "从检查队列领取任务并开始实测拍照", tone: "blue" as const };
    case "inspecting":
      return { owner: "现场质检员 (inspector)", action: "完成全部必检项、测量复测与机位拍照后提交", tone: "blue" as const };
    case "qa_review":
      return { owner: "独立 QA 复核员 (reviewer)", action: "校对英文表述与证据照片，批准生成正式报告 PDF", tone: "yellow" as const };
    case "report_ready":
    case "action_pending":
      return { owner: "客户 / 仓库出库", action: "客户下达检后发运/退回/留样指令，仓库称重打包交接", tone: "green" as const };
    case "closed":
      return { owner: "已归档完结", action: "全流程履约与账务已闭环", tone: "green" as const };
    case "cancelled":
      return { owner: "已取消", action: "订单已终止", tone: "gray" as const };
    default:
      return { owner: "运营专员", action: "核查订单当前状态", tone: "gray" as const };
  }
}

export function SlaCountdownBadge({
  dueAt,
  active = true,
}: {
  dueAt?: string | null;
  active?: boolean;
}) {
  if (!dueAt) return <span className="muted">—</span>;
  const ms = Date.parse(dueAt) - Date.now();
  if (!Number.isFinite(ms)) return <span className="muted">—</span>;
  if (!active) return <span className="muted">已完结</span>;
  const hours = Math.round(Math.abs(ms) / 3600_000);
  if (ms <= 0) {
    return (
      <span className="tag red nowrap" title={`截止时间：${dueAt}`}>
        已超时 {hours >= 24 ? `${Math.floor(hours / 24)}天${hours % 24}h` : `${Math.max(1, hours)}h`}
      </span>
    );
  }
  if (hours <= 12) {
    return (
      <span className="tag yellow nowrap" title={`截止时间：${dueAt}`}>
        剩 {Math.max(1, hours)}h 到期
      </span>
    );
  }
  return (
    <span className="tag blue nowrap" title={`截止时间：${dueAt}`}>
      剩 {hours >= 24 ? `${Math.floor(hours / 24)}天${hours % 24}h` : `${hours}h`}
    </span>
  );
}

const AUDIT_FIELD_LABELS: Record<string, string> = {
  reason: "原因说明",
  status: "状态",
  state: "阶段",
  decision: "审批结论",
  amount_cents: "金额",
  service_refund_cents: "退服务费",
  compensation_cents: "货值赔偿",
  paid_amount_cents: "实付赔偿",
  payout_reference: "打款水单号",
  payout_method: "打款渠道",
  provider_ref: "渠道凭据",
  receiving_code: "客户收件码",
  revision: "版本",
  enabled: "开关状态",
  roles: "岗位角色",
  method: "执行方式",
  witness_note: "见证记录",
  legal_basis_version: "条款版本",
  list_hash: "清单哈希",
};

export function formatAuditSnapshotSummary(values?: Record<string, unknown> | null): string {
  if (!values || typeof values !== "object") return "已记录状态变更";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined || v === "") continue;
    const label = AUDIT_FIELD_LABELS[k] ?? k;
    if (k.endsWith("_cents") && typeof v === "number") {
      parts.push(`${label}: $${(v / 100).toFixed(2)}`);
    } else if (Array.isArray(v)) {
      parts.push(`${label}: ${v.join(", ")}`);
    } else if (typeof v === "boolean") {
      parts.push(`${label}: ${v ? "是" : "否"}`);
    } else if (typeof v === "object") {
      continue;
    } else {
      parts.push(`${label}: ${String(v)}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : "已完成业务动作并留痕";
}

export function dictLabel(dict: Record<string, { label: string; tone?: string }>, key?: string | null, fallback = "—") {
  if (!key) return fallback;
  return dict[key]?.label ?? key;
}

export function BizTag({
  dict,
  value,
  fallback = "—",
}: {
  dict: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }>;
  value?: string | null;
  fallback?: string;
}) {
  if (!value) return <span className="tag gray">{fallback}</span>;
  const hit = dict[value];
  const cls = hit ? `tag ${hit.tone}` : "tag";
  return <span className={cls} title={value}>{hit ? hit.label : value}</span>;
}

export function Money({
  cents,
  currency = "USD",
  align = "right",
  mutedZero = false,
}: {
  cents: number | null | undefined;
  currency?: string;
  align?: "left" | "right";
  mutedZero?: boolean;
}) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) {
    return <span className={`money-cell ${align === "left" ? "left" : ""} muted`}>—</span>;
  }
  const num = Number(cents) / 100;
  const formatted = /^[A-Z]{3}$/.test(currency)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(num)
    : `${num.toFixed(2)} ${currency}`;
  return (
    <span className={`money-cell ${align === "left" ? "left" : ""}${mutedZero && num === 0 ? " muted" : ""}`}>
      {formatted}
    </span>
  );
}

export function CopyId({
  value,
  short = true,
  label,
}: {
  value?: string | null;
  short?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  const shown = label ?? (short && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value);
  return (
    <span className="copy-id-wrap">
      <code className="code nowrap" title={value}>{shown}</code>
      <button
        type="button"
        className="copy-id-btn"
        title={`复制完整编号：${value}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            // ignore clipboard failure
          }
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </span>
  );
}

export function AdminTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="admin-tabs" role="tablist">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={`admin-tab${active === t.id ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          <span>{t.label}</span>
          {t.count !== undefined && <span className="admin-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  kind = "empty",
  title,
  description,
  actionHref,
  actionLabel,
  onAction,
}: {
  kind?: "empty" | "filtered" | "unconfigured" | "forbidden";
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const badgeMap = {
    empty: "当前无待处理记录",
    filtered: "筛选条件无匹配",
    unconfigured: "外部/平台能力待配置",
    forbidden: "权限受限说明",
  };
  return (
    <div className="admin-empty-box" role="status">
      <div className="admin-empty-badge">{badgeMap[kind]}</div>
      <strong>{title}</strong>
      <p className="muted">{description}</p>
      {(actionHref || onAction) && (
        <div className="actions">
          {actionHref && actionLabel && <Link className="button sm" href={actionHref}>{actionLabel}</Link>}
          {onAction && actionLabel && <button type="button" className="button sm" onClick={onAction}>{actionLabel}</button>}
        </div>
      )}
    </div>
  );
}

export function StatusBanner({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "error" | "success";
  title: string;
  children: ReactNode;
}) {
  const cls = tone === "warning" ? "notice warning" : tone === "error" ? "notice error" : tone === "success" ? "notice success" : "notice";
  return (
    <div className={cls} role={tone === "error" || tone === "warning" ? "alert" : "status"}>
      <strong>{title}：</strong>{children}
    </div>
  );
}

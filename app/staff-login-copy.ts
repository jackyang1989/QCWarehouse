import { staffDestinationArea } from "../packages/core/portal-routes";

const copy = {
  admin: { title: "管理后台登录", description: "使用已获管理后台权限的账号登录。" },
  warehouse: { title: "仓库工作台登录", description: "使用已获仓库工作台权限的账号登录。" },
  general: { title: "内部工作区登录", description: "登录后按账号权限进入管理后台或仓库工作台。" },
};

export function staffLoginCopy(next: string | null | undefined) {
  return copy[staffDestinationArea(next) ?? "general"];
}

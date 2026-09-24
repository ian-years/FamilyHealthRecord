/* ============================================================
   云服务公开配置
   仅包含可安全置于前端的两个值：endpoint + publishableKey。
   publishableKey 只标识「哪个应用」，本身不含权限；服务端强制校验 Origin。
   后端环境 ID 与任何长期密钥都不会出现在前端。
   ============================================================ */
window.PUBLIC_CONFIG = {
  endpoint: "https://health-records-workbench-27897.app.workbuddy.host",
  publishableKey: "wbpk_nmCjG2eQ67WLXMT78P81DC_i7D4AWlZpqbd72JHoW3w56zcGMk9C2Tc"
};

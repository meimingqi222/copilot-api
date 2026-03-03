// Internationalization System
const i18n = {
  // Current language
  lang: "zh",

  // Translations
  translations: {
    zh: {
      // Common
      "app.name": "Copilot API",
      "app.title": "管理控制台",
      loading: "加载中...",
      save: "保存",
      cancel: "取消",
      delete: "删除",
      edit: "编辑",
      create: "创建",
      close: "关闭",
      copy: "复制",
      copySuccess: "已复制到剪贴板",
      search: "搜索",
      refresh: "刷新",
      logout: "退出登录",
      confirm: "确认",
      back: "返回",
      next: "下一步",
      done: "完成",
      yes: "是",
      no: "否",

      // Navigation
      "nav.dashboard": "仪表盘",
      "nav.users": "用户管理",
      "nav.accounts": "账户管理",
      "nav.quota": "配额监控",
      "nav.logs": "系统日志",

      // Dashboard
      "dashboard.title": "仪表盘",
      "dashboard.activeUsers": "活跃用户",
      "dashboard.activeAccounts": "活跃账户",
      "dashboard.requestsToday": "今日请求",
      "dashboard.errorsToday": "今日错误",
      "dashboard.quotaSummary": "配额概览",
      "dashboard.recentActivity": "最近活动",
      "dashboard.noActivity": "暂无活动",
      "dashboard.lastUpdated": "最后更新",
      "dashboard.unlimitedPlan": "无限套餐",

      // Users
      "users.title": "用户管理",
      "users.addUser": "添加用户",
      "users.editUser": "编辑用户",
      "users.username": "用户名",
      "users.role": "角色",
      "users.role.label": "角色",
      "users.quota": "配额",
      "users.used": "已使用",
      "users.status": "状态",
      "users.status.label": "状态",
      "users.lastUsed": "最后使用",
      "users.actions": "操作",
      "users.role.admin": "管理员",
      "users.role.user": "用户",
      "users.status.enabled": "启用",
      "users.status.disabled": "禁用",
      "users.resetKey": "重置密钥",
      "users.confirmReset":
        "确定要重置该用户的 API 密钥吗？旧的密钥将立即失效。",
      "users.newApiKey": "新的 API 密钥",
      "users.keyWarning": "请立即复制此密钥，它不会再显示。",
      "users.quotaHint": "0 = 无限制",
      "users.noUsers": "暂无用户",
      "users.deleteConfirm": '确定要删除用户 "{name}" 吗？',
      "users.createSuccess": "用户创建成功",
      "users.updateSuccess": "用户更新成功",
      "users.deleteSuccess": "用户已删除",
      "users.confirmDelete": "确定要删除该用户吗？此操作不可撤销。",
      "users.resetSuccess": "API 密钥重置成功",

      // Accounts
      "accounts.title": "账户管理",
      "accounts.addAccount": "添加账户",
      "accounts.label": "标签",
      "accounts.status": "状态",
      "accounts.active": "活跃账户",
      "accounts.requestsToday": "今日请求",
      "accounts.errorsToday": "今日错误",
      "accounts.quota": "配额",
      "accounts.status.active": "活跃",
      "accounts.status.inactive": "禁用",
      "accounts.status.exhausted": "耗尽",
      "accounts.premium": "高级交互",
      "accounts.chat": "聊天",
      "accounts.refresh": "刷新令牌",
      "accounts.confirmDelete": "确定要删除该 GitHub 账户吗？此操作不可撤销。",
      "accounts.deleteSuccess": "账户已删除",
      "accounts.refreshSuccess": "令牌刷新成功",
      "accounts.deleteConfirm": '确定要删除账户 "{name}" 吗？',
      "accounts.deviceFlow.title": "添加 GitHub 账户",
      "accounts.deviceFlow.step1": "输入标签",
      "accounts.deviceFlow.step2": "授权",
      "accounts.deviceFlow.step3": "完成",
      "accounts.deviceFlow.instruction": "请访问以下链接并输入验证码：",
      "accounts.deviceFlow.waiting": "等待授权中...",
      "accounts.deviceFlow.success": "账户添加成功！",
      "accounts.noAccounts": "暂无账户",

      // Quota
      "quota.title": "配额监控",
      "quota.accountQuotas": "GitHub 账户配额",
      "quota.accountQuotasDesc":
        "各 GitHub 账号的 Copilot API 配额（由 GitHub 提供）",
      "quota.userUsage": "本系统用户使用量",
      "quota.userUsageDesc": "用户通过本系统消耗的 Token 数量",
      "quota.remaining": "剩余",
      "quota.total": "总计",
      "quota.tokens": "令牌数",
      "quota.unlimited": "无限制",
      "quota.active": "活跃",
      "quota.premium": "高级交互",
      "quota.chat": "对话",
      "quota.completions": "代码补全",
      "quota.used": "已使用",
      "quota.quotaLabel": "配额",
      "quota.refreshSuccess": "配额刷新成功",
      "quota.refreshError": "配额刷新失败",

      // Logs
      "logs.title": "系统日志",
      "logs.level": "级别",
      "logs.all": "全部",
      "logs.allLevels": "所有级别",
      "logs.debug": "调试",
      "logs.info": "信息",
      "logs.warn": "警告",
      "logs.error": "错误",
      "logs.path": "路径",
      "logs.user": "用户",
      "logs.model": "模型",
      "logs.tokens": "令牌",
      "logs.latency": "延迟",
      "logs.time": "时间",
      "logs.search": "搜索日志...",
      "logs.clearFilters": "清除筛选",
      "logs.autoRefresh": "自动刷新 (5秒)",
      "logs.autoRefreshOn": "自动刷新: 开",
      "logs.autoRefreshOff": "自动刷新: 关",
      "logs.noLogs": "暂无日志",
      "logs.showing": "显示 {start} - {end} 条，共 {total} 条",
      "logs.previous": "上一页",
      "logs.next": "下一页",

      // Login
      "login.title": "欢迎回来",
      "login.subtitle": "登录到 Copilot API 管理控制台",
      "login.password": "密码",
      "login.passwordPlaceholder": "请输入管理密码",
      "login.submit": "登录",
      "login.error": "密码错误",

      // Errors
      "error.auth": "认证失败，请重新登录",
      "error.load": "加载失败",
      "error.create": "创建失败",
      "error.update": "更新失败",
      "error.delete": "删除失败",
    },

    en: {
      // Common
      "app.name": "Copilot API",
      "app.title": "Admin Console",
      loading: "Loading...",
      save: "Save",
      cancel: "Cancel",
      delete: "Delete",
      edit: "Edit",
      create: "Create",
      close: "Close",
      copy: "Copy",
      copySuccess: "Copied to clipboard",
      search: "Search",
      refresh: "Refresh",
      logout: "Logout",
      confirm: "Confirm",
      back: "Back",
      next: "Next",
      done: "Done",
      yes: "Yes",
      no: "No",

      // Navigation
      "nav.dashboard": "Dashboard",
      "nav.users": "Users",
      "nav.accounts": "Accounts",
      "nav.quota": "Quota",
      "nav.logs": "Logs",

      // Dashboard
      "dashboard.title": "Dashboard",
      "dashboard.activeUsers": "Active Users",
      "dashboard.activeAccounts": "Active Accounts",
      "dashboard.requestsToday": "Requests Today",
      "dashboard.errorsToday": "Errors Today",
      "dashboard.quotaSummary": "Quota Summary",
      "dashboard.recentActivity": "Recent Activity",
      "dashboard.noActivity": "No recent activity",
      "dashboard.lastUpdated": "Last updated",
      "dashboard.unlimitedPlan": "Unlimited Plan",

      // Users
      "users.title": "User Management",
      "users.addUser": "Add User",
      "users.editUser": "Edit User",
      "users.username": "Username",
      "users.role": "Role",
      "users.role.label": "Role",
      "users.quota": "Quota",
      "users.used": "Used",
      "users.status": "Status",
      "users.status.label": "Status",
      "users.lastUsed": "Last Used",
      "users.actions": "Actions",
      "users.role.admin": "Admin",
      "users.role.user": "User",
      "users.status.enabled": "Enabled",
      "users.status.disabled": "Disabled",
      "users.resetKey": "Reset Key",
      "users.confirmReset":
        "Are you sure you want to reset this user's API key? The old key will be invalidated immediately.",
      "users.newApiKey": "New API Key",
      "users.keyWarning": "Copy this key now. It will not be shown again.",
      "users.quotaHint": "0 = unlimited",
      "users.noUsers": "No users found",
      "users.deleteConfirm": 'Delete user "{name}"?',
      "users.createSuccess": "User created successfully",
      "users.updateSuccess": "User updated successfully",
      "users.deleteSuccess": "User deleted successfully",
      "users.confirmDelete":
        "Are you sure you want to delete this user? This action cannot be undone.",
      "users.resetSuccess": "API key reset successfully",

      // Accounts
      "accounts.title": "Account Management",
      "accounts.addAccount": "Add Account",
      "accounts.label": "Label",
      "accounts.status": "Status",
      "accounts.active": "Active Accounts",
      "accounts.requestsToday": "Requests Today",
      "accounts.errorsToday": "Errors Today",
      "accounts.quota": "Quota",
      "accounts.status.active": "Active",
      "accounts.status.inactive": "Inactive",
      "accounts.status.exhausted": "Exhausted",
      "accounts.premium": "Premium Interactions",
      "accounts.chat": "Chat",
      "accounts.refresh": "Refresh Token",
      "accounts.confirmDelete":
        "Are you sure you want to delete this GitHub account? This action cannot be undone.",
      "accounts.deleteSuccess": "Account deleted successfully",
      "accounts.refreshSuccess": "Token refreshed successfully",
      "accounts.deleteConfirm": 'Delete account "{name}"?',
      "accounts.deviceFlow.title": "Add GitHub Account",
      "accounts.deviceFlow.step1": "Enter Label",
      "accounts.deviceFlow.step2": "Authorize",
      "accounts.deviceFlow.step3": "Complete",
      "accounts.deviceFlow.instruction":
        "Please visit the link below and enter the code:",
      "accounts.deviceFlow.waiting": "Waiting for authorization...",
      "accounts.deviceFlow.success": "Account added successfully!",
      "accounts.noAccounts": "No accounts configured",

      // Quota
      "quota.title": "Quota Monitor",
      "quota.accountQuotas": "GitHub Account Quotas",
      "quota.accountQuotasDesc":
        "Copilot API quotas for each GitHub account (provided by GitHub)",
      "quota.userUsage": "System User Usage",
      "quota.userUsageDesc": "Token consumption by users through this system",
      "quota.remaining": "Remaining",
      "quota.total": "Total",
      "quota.tokens": "Tokens",
      "quota.unlimited": "Unlimited",
      "quota.active": "Active",
      "quota.premium": "Premium",
      "quota.chat": "Chat",
      "quota.completions": "Completions",
      "quota.used": "Used",
      "quota.quotaLabel": "Quota",
      "quota.refreshSuccess": "Quota refreshed successfully",
      "quota.refreshError": "Failed to refresh quota",

      // Logs
      "logs.title": "System Logs",
      "logs.level": "Level",
      "logs.all": "All",
      "logs.allLevels": "All Levels",
      "logs.debug": "Debug",
      "logs.info": "Info",
      "logs.warn": "Warning",
      "logs.error": "Error",
      "logs.path": "Path",
      "logs.user": "User",
      "logs.model": "Model",
      "logs.tokens": "Tokens",
      "logs.latency": "Latency",
      "logs.time": "Time",
      "logs.search": "Search logs...",
      "logs.clearFilters": "Clear Filters",
      "logs.autoRefresh": "Auto refresh (5s)",
      "logs.autoRefreshOn": "Auto Refresh: On",
      "logs.autoRefreshOff": "Auto Refresh: Off",
      "logs.noLogs": "No logs found",
      "logs.showing": "Showing {start} - {end} of {total}",
      "logs.previous": "Previous",
      "logs.next": "Next",

      // Login
      "login.title": "Welcome Back",
      "login.subtitle": "Sign in to Copilot API Admin Console",
      "login.password": "Password",
      "login.passwordPlaceholder": "Enter admin password",
      "login.submit": "Sign In",
      "login.error": "Invalid password",

      // Errors
      "error.auth": "Authentication failed, please login again",
      "error.load": "Failed to load data",
      "error.create": "Failed to create",
      "error.update": "Failed to update",
      "error.delete": "Failed to delete",
    },
  },

  // Initialize language
  init() {
    // Check browser language
    const browserLang = navigator.language || navigator.userLanguage
    const preferredLang = browserLang.startsWith("zh") ? "zh" : "en"

    // Check stored preference
    const storedLang = localStorage.getItem("copilot-api-lang")
    this.lang = storedLang || preferredLang

    return this.lang
  },

  // Set language
  setLang(lang) {
    if (this.translations[lang]) {
      this.lang = lang
      localStorage.setItem("copilot-api-lang", lang)
      return true
    }
    return false
  },

  // Get translation
  t(key, params = {}) {
    const text =
      this.translations[this.lang]?.[key]
      || this.translations["en"]?.[key]
      || key

    // Replace params
    return text.replaceAll(/\{(\w+)\}/g, (match, param) => {
      return params[param] !== undefined ? params[param] : match
    })
  },

  // Get current language
  currentLang() {
    return this.lang
  },

  // Toggle language
  toggle() {
    this.setLang(this.lang === "zh" ? "en" : "zh")
    return this.lang
  },
}

// Auto-init
i18n.init()

// Global variable
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const I18n = i18n

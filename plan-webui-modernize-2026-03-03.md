# WebUI 现代化改造 + 多账号/多用户功能实现计划

**日期：** 2026-03-03  
**项目：** copilot-api

---

## 一、目标概述

| 功能 | 说明 |
|------|------|
| 现代化 WebUI | 单页应用，左侧导航栏，多模块切换 |
| 多用户管理 | 多个 API 用户，每个用户独立 API Key，管理员可增删改查 |
| 配额管理 | 查看每个 Copilot 账号的配额使用情况和剩余额度 |
| 日志查看 | 实时请求日志 + 错误日志，环形缓冲区（最多 1000 条） |
| 多账号负载均衡 | 支持多个 GitHub Copilot 账号，默认策略：耗尽一个账号配额后自动切换下一个 |

---

## 二、架构设计

### 2.1 多账号结构

```
启动时传入多个 GitHub Token：
  --github-token <token1> --github-token <token2>
  或通过环境变量 GITHUB_TOKENS=token1,token2,token3
  或通过文件 --tokens-file /path/to/tokens.txt（每行一个token）

每个账号维护：
  - githubToken: string
  - copilotToken: string（自动刷新）
  - copilotTokenExpiresAt: number
  - usage: CopilotUsageResponse（缓存，5分钟刷新）
  - isExhausted: boolean（当前配额是否耗尽）
  - accountIndex: number
```

### 2.2 多用户结构

```
用户通过 API Key 认证，每个用户有：
  - id: string (uuid)
  - name: string
  - apiKey: string（哈希存储）
  - createdAt: number
  - requestCount: number
  - tokenUsed: number
  - lastUsedAt?: number
  - enabled: boolean

用户数据持久化到：~/.local/share/copilot-api/users.json
```

### 2.3 请求日志结构

```typescript
interface RequestLog {
  id: string
  timestamp: number
  method: string
  path: string
  userId?: string      // 哪个用户发起
  accountIndex?: number // 使用了哪个Copilot账号
  statusCode: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  model?: string
  error?: string
}
// 内存中环形缓冲区，最多1000条
```

---

## 三、需要修改/新增的文件

### 3.1 后端文件

#### 新增文件

| 文件路径 | 说明 |
|----------|------|
| `src/lib/accounts.ts` | 多账号管理：账号列表、当前活跃账号、切换逻辑 |
| `src/lib/users.ts` | 多用户管理：用户 CRUD、API Key 验证、持久化 |
| `src/lib/logger.ts` | 请求日志环形缓冲区、写入/读取 |
| `src/routes/api/users.ts` | 用户管理 REST API（CRUD） |
| `src/routes/api/accounts.ts` | 账号状态 REST API（查看配额、切换） |
| `src/routes/api/logs.ts` | 日志 REST API（查询请求日志和错误日志） |

#### 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `src/lib/state.ts` | 添加 accounts 数组、users 数组，移除单 token 字段改为多账号 |
| `src/lib/token.ts` | 改为支持多账号 token 管理，每账号独立刷新 |
| `src/lib/request-auth.ts` | 改为多用户 API Key 验证，兼容旧单 apiKey 模式 |
| `src/server.ts` | 注册新路由，添加请求日志中间件 |
| `src/start.ts` | 支持多 github-token 参数，支持 tokens-file 参数 |
| `src/routes/chat-completions/route.ts` | 使用多账号选择器获取 copilotToken |
| `src/routes/messages/route.ts` | 同上 |
| `src/routes/embeddings/route.ts` | 同上 |
| `pages/index.html` | 全面重写为现代化 SPA（保留文件，替换内容） |

---

## 四、详细实现步骤

### Step 1：实现多账号管理 (`src/lib/accounts.ts`)

```typescript
export interface CopilotAccount {
  index: number
  githubToken: string
  copilotToken?: string
  copilotTokenExpiresAt?: number
  username?: string         // 从 GitHub API 获取
  usage?: CopilotUsageResponse
  usageLastFetchedAt?: number
  isExhausted: boolean
  refreshTimer?: ReturnType<typeof setTimeout>
}

// 全局账号列表
export const accounts: CopilotAccount[] = []

// 当前活跃账号索引
let activeAccountIndex = 0

// 获取当前活跃账号（负载均衡逻辑）
export function getActiveAccount(): CopilotAccount

// 切换到下一个可用账号（当前账号配额耗尽时调用）
export function switchToNextAccount(): CopilotAccount | null

// 初始化所有账号（启动时调用）
export async function initAccounts(githubTokens: string[]): Promise<void>

// 为单个账号设置 CopilotToken 自动刷新
export async function setupAccountToken(account: CopilotAccount): Promise<void>

// 刷新单个账号的使用情况（5分钟缓存）
export async function refreshAccountUsage(account: CopilotAccount): Promise<void>

// 检查账号配额是否耗尽（基于 usage 数据判断）
export function isAccountExhausted(account: CopilotAccount): boolean
```

**负载均衡策略（quota-exhaustion）：**
- 维护有序账号列表
- 每次请求前调用 `getActiveAccount()`
- 若当前账号 `isExhausted=true`，调用 `switchToNextAccount()`
- 若所有账号都耗尽，返回最后一个账号并记录警告日志
- 当收到上游 429 且提示配额用尽时，标记当前账号 `isExhausted=true` 并切换

### Step 2：多用户管理 (`src/lib/users.ts`)

```typescript
import { randomUUID } from "crypto"
import { timingSafeEqual, createHash } from "crypto"

export interface User {
  id: string
  name: string
  apiKeyHash: string        // SHA-256 hash，不存明文
  apiKeyPrefix: string      // 前8位明文，用于展示
  createdAt: number
  enabled: boolean
  requestCount: number
  tokenUsed: number
  lastUsedAt?: number
}

// 从文件加载/保存用户列表
export async function loadUsers(): Promise<void>
export async function saveUsers(): Promise<void>

// CRUD
export function createUser(name: string): { user: User; plainApiKey: string }
export function deleteUser(id: string): boolean
export function updateUser(id: string, patch: Partial<Pick<User, "name" | "enabled">>): User | null
export function listUsers(): User[]

// 验证 API Key（timing-safe）
export function verifyApiKey(plainKey: string): User | null

// 更新用户统计
export function recordUserRequest(userId: string, tokens: number): void
```

**持久化：** `~/.local/share/copilot-api/users.json`  
**迁移兼容：** 若 `state.apiKey` 存在且 users.json 为空，自动创建一个名为 "default" 的用户

### Step 3：请求日志 (`src/lib/logger.ts`)

```typescript
export interface RequestLog {
  id: string
  timestamp: number
  method: string
  path: string
  userId?: string
  userName?: string
  accountIndex?: number
  statusCode: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  model?: string
  error?: string
  isError: boolean
}

const MAX_LOGS = 1000
const requestLogs: RequestLog[] = []  // 环形缓冲

export function appendLog(log: Omit<RequestLog, "id">): void
export function getLogs(options?: {
  limit?: number
  offset?: number
  onlyErrors?: boolean
  userId?: string
}): { logs: RequestLog[]; total: number }
export function clearLogs(): void
```

### Step 4：修改 `src/lib/state.ts`

```typescript
import type { CopilotAccount } from "./accounts"
import type { User } from "./users"

export interface State {
  // 多账号（替换原来的单 githubToken/copilotToken）
  accounts: CopilotAccount[]
  
  // 多用户（替换原来的单 apiKey）
  users: User[]
  
  // 管理员密码（仍保留，用于 /admin 登录）
  adminPassword?: string
  adminSessionToken?: string
  adminSessionExpiresAt?: number

  // 其他不变
  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string
  manualApprove: boolean
  showToken: boolean
  
  // 向后兼容：单 apiKey 模式
  legacyApiKey?: string
}
```

**向后兼容说明：**
- 若启动时传入 `--api-key` 但无 users.json，自动创建一个内存用户
- 若启动时只传入一个 `--github-token`，accounts 数组长度为 1

### Step 5：修改 `src/lib/request-auth.ts`

```typescript
// 原 requireApiKey 中间件修改为：
// 1. 先检查 state.users 是否有用户配置
// 2. 有用户配置：从 Authorization: Bearer <key> 取出 key，调用 verifyApiKey()
// 3. 无用户配置且有 legacyApiKey：走原逻辑
// 4. 无任何认证配置：放行
// 5. 验证通过后，将 userId 存入 c.set("userId", user.id)
```

### Step 6：修改 `src/start.ts`

新增 CLI 参数：
```
--github-token <token>   可多次传入（Hono/citty 需特殊处理，或用逗号分隔）
--tokens-file <path>     每行一个 GitHub token 的文件路径
```

修改启动流程：
```
1. 收集所有 github token（--github-token 可多次 + --tokens-file）
2. 调用 initAccounts(tokens) 替代原来 setupGitHubToken/setupCopilotToken
3. 加载用户列表 loadUsers()
4. 其余流程不变
```

**注意：** citty 的参数支持多值，需验证或改用逗号分隔字符串  
若 citty 不支持多值 array 参数，改为：`--github-tokens "token1,token2,token3"`

### Step 7：修改路由以使用多账号

在 `src/routes/chat-completions/route.ts`、`messages/route.ts`、`embeddings/route.ts` 中：
```typescript
// 原来：
const copilotToken = state.copilotToken

// 改为：
const account = getActiveAccount()
const copilotToken = account.copilotToken

// 并在收到 429/quota exhausted 时：
// markAccountExhausted(account)
// const newAccount = switchToNextAccount()
```

### Step 8：新增后端 API 路由

#### `src/routes/api/users.ts`（需 admin session 认证）

```
GET    /api/users              列出所有用户（不含 apiKeyHash）
POST   /api/users              创建用户（返回一次性明文 apiKey）
DELETE /api/users/:id          删除用户
PATCH  /api/users/:id          更新用户（name/enabled）
POST   /api/users/:id/reset-key  重置 API Key（返回新的明文 key）
```

#### `src/routes/api/accounts.ts`（需 admin session 认证）

```
GET    /api/accounts           列出所有账号及配额状态
POST   /api/accounts/:index/refresh  手动刷新指定账号配额
POST   /api/accounts/switch    手动切换活跃账号
```

#### `src/routes/api/logs.ts`（需 admin session 认证）

```
GET    /api/logs?limit=100&offset=0&onlyErrors=false&userId=xxx
DELETE /api/logs               清空日志
```

### Step 9：注册路由并添加日志中间件 (`src/server.ts`)

```typescript
import { apiUserRoutes } from "./routes/api/users"
import { apiAccountRoutes } from "./routes/api/accounts"
import { apiLogRoutes } from "./routes/api/logs"

// 日志中间件（记录所有请求）
server.use("*", async (c, next) => {
  const start = Date.now()
  await next()
  appendLog({
    timestamp: Date.now(),
    method: c.req.method,
    path: c.req.path,
    userId: c.get("userId"),
    statusCode: c.res.status,
    durationMs: Date.now() - start,
    isError: c.res.status >= 400,
  })
})

server.route("/api/users", apiUserRoutes)
server.route("/api/accounts", apiAccountRoutes)
server.route("/api/logs", apiLogRoutes)
```

### Step 10：全面重写 `pages/index.html`（现代化 SPA）

---

## 五、WebUI 设计规范

### 5.1 整体布局

```
┌─────────────────────────────────────────────────────┐
│  ⚙️ Copilot API          [admin@localhost]  [logout] │  ← 顶栏
├──────────┬──────────────────────────────────────────┤
│          │                                          │
│  📊 配额  │                                          │
│  👥 用户  │         主内容区域                        │
│  📋 日志  │         （根据左侧菜单切换）               │
│  🤖 账号  │                                          │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

### 5.2 设计风格

- **颜色主题：** 延续当前深色 Gruvbox 主题（用户已熟悉）
- **字体：** Inter（已引入）
- **组件库：** 纯 Vanilla JS + Tailwind CDN（无框架依赖，保持轻量）
- **图标：** Lucide（已引入）
- **响应式：** 移动端折叠侧边栏为底部 Tab Bar

### 5.3 各模块 UI 详情

#### 模块1：配额概览（默认首页）

- 顶部下拉框：选择查看哪个账号的配额（"账号0 (user@github.com)" 格式）
- 配额卡片区：Premium / Chat / Completions 三张卡片，含进度条
- 账号状态徽章：Active / Exhausted
- 刷新按钮（调用 `/api/accounts/:index/refresh`）

#### 模块2：用户管理

- 用户列表表格：Name / API Key Prefix / Status / Requests / Tokens Used / Last Used / Actions
- "新建用户" 按钮 → 弹窗输入 Name → 显示一次性 API Key（带复制按钮）
- 每行操作：启用/禁用 / 重置Key / 删除
- 删除确认弹窗

#### 模块3：日志查看

- 顶部筛选栏：全部 / 仅错误 / 按用户筛选 / 清空日志
- 日志表格：时间 / 方法 / 路径 / 用户 / 账号 / 状态码 / 耗时 / Tokens / 错误信息
- 错误行高亮红色背景
- 分页（每页50条）
- 自动刷新开关（5秒轮询）

#### 模块4：账号管理

- 账号列表卡片（每个 GitHub 账号一张卡）
- 显示：账号序号 / GitHub 用户名 / 当前状态（Active/Exhausted）/ 各配额剩余
- "设为活跃" 按钮（手动切换）
- "刷新配额" 按钮

### 5.4 认证流程

- 访问任意页面，若未登录跳转到登录页（`/admin/login` 复用现有逻辑）
- 登录成功后跳转到 WebUI 主页（`/`，加载 SPA）
- SPA 通过 cookie session 调用所有 `/api/*` 接口
- 登出：调用 `/admin/logout` 清除 session

---

## 六、实现顺序（推荐）

1. **[后端] Step 1** `src/lib/accounts.ts` - 多账号核心逻辑
2. **[后端] Step 2** `src/lib/users.ts` - 多用户核心逻辑
3. **[后端] Step 3** `src/lib/logger.ts` - 请求日志
4. **[后端] Step 4** 修改 `src/lib/state.ts`
5. **[后端] Step 5** 修改 `src/lib/request-auth.ts`
6. **[后端] Step 6** 修改 `src/start.ts`（多 token 参数）
7. **[后端] Step 7** 修改三个推理路由（使用多账号选择器）
8. **[后端] Step 8** 新增三个 `/api/*` 路由文件
9. **[后端] Step 9** 修改 `src/server.ts`（注册路由 + 日志中间件）
10. **[前端] Step 10** 重写 `pages/index.html`（SPA）
11. **[测试]** 更新/补充 `tests/` 下相关测试

---

## 七、接口规范（SPA 调用的 API）

### 用户管理

```
GET    /api/users
Response: { users: Array<{ id, name, apiKeyPrefix, enabled, requestCount, tokenUsed, lastUsedAt, createdAt }> }

POST   /api/users
Body:     { name: string }
Response: { user: {...}, apiKey: "cpapi_xxxxxxxxxxxx" }

DELETE /api/users/:id
Response: { ok: true }

PATCH  /api/users/:id
Body:     { name?: string, enabled?: boolean }
Response: { user: {...} }

POST   /api/users/:id/reset-key
Response: { apiKey: "cpapi_xxxxxxxxxxxx" }
```

### 账号管理

```
GET    /api/accounts
Response: { accounts: Array<{ index, username, isActive, isExhausted, usage: {...} }> }

POST   /api/accounts/:index/refresh
Response: { account: {...} }

POST   /api/accounts/switch
Body:     { index: number }
Response: { ok: true, activeIndex: number }
```

### 日志

```
GET    /api/logs?limit=50&offset=0&onlyErrors=false&userId=xxx
Response: { logs: RequestLog[], total: number }

DELETE /api/logs
Response: { ok: true }
```

---

## 八、向后兼容性

| 旧启动方式 | 新行为 |
|-----------|--------|
| `--github-token <single>` | accounts 数组长度=1，正常工作 |
| `--api-key <key>` | 自动创建内存用户 "default"，该 key 有效 |
| `--admin-password <pwd>` | 管理员密码不变，仍用于 `/admin/login` |
| 无任何认证 | 所有接口公开（与现在一致） |
| `/usage` 路由 | 保留，仍可访问 |
| `/admin` 路由 | 保留登录逻辑，登录后重定向到 SPA |

---

## 九、文件变更汇总

### 新增（6个文件）
- `src/lib/accounts.ts`
- `src/lib/users.ts`  
- `src/lib/logger.ts`
- `src/routes/api/users.ts`
- `src/routes/api/accounts.ts`
- `src/routes/api/logs.ts`

### 修改（8个文件）
- `src/lib/state.ts`
- `src/lib/token.ts`
- `src/lib/request-auth.ts`
- `src/server.ts`
- `src/start.ts`
- `src/routes/chat-completions/route.ts`
- `src/routes/messages/route.ts`
- `src/routes/embeddings/route.ts`

### 重写（1个文件）
- `pages/index.html`（保留文件路径，替换全部内容）

---

## 十、注意事项

1. **citty 多值参数：** citty 是否支持同一参数多次传入需确认；若不支持，改用逗号分隔字符串 `--github-tokens "t1,t2,t3"` 或支持 `GITHUB_TOKENS` 环境变量
2. **API Key 安全：** 存储时使用 SHA-256 哈希，验证时 timing-safe 比较；明文 key 只在创建/重置时返回一次
3. **配额检测：** 判断账号耗尽基于 `usage.quota_snapshots` 的 `remaining <= 0 && !unlimited`；上游 429 也触发切换
4. **日志中间件位置：** 放在认证中间件之后，确保 `userId` 已被填充
5. **SPA 静态文件服务：** `pages/index.html` 通过 `/` 路由返回，保持现有 `server.get("/", ...)` 改为返回 HTML 文件内容
6. **会话安全：** `/api/*` 所有路由统一加 `requireAdminSession` 中间件


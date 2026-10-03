# 内部 Provider 模块

Provider 随应用编译、发布，通过 `services/providers/modules/<id>.ts` 声明接入。
`services/providers/builtins.ts` 是服务层唯一的模块装配清单；没有外部包加载、
插件市场或热更新。

## 边界

- `lib/provider-definitions.ts`：纯元数据，声明 ID、原生协议、OAuth 账号分类。
  `ProviderId`、`OAuthProviderId`、原生 `ProviderProtocol`、账号协议映射和
  持久化协议校验都从这里派生。读取连接文件不需要先启动 Provider runtime。
- `lib/provider-descriptors/<id>.ts`：各家的账号描述、图标与登录表单字段
  （纯数据，UI 与路由能力判断在 runtime 启动前读取）；模块声明自己的
  `descriptor`，注册时校验与 `module.id` 一致。
- `services/providers/module.ts`：模块契约与注册前校验。
- `services/providers/modules/`：各家的 adapter、runtime 工厂、登录策略、
  OAuth 凭证刷新、提前刷新时间、模型发现、fallback 目录与额度拉取。
- `services/providers/account-creation/`、`callbacks/`：直连凭证建号与
  固定 loopback 回调服务器的各家实现。账号创建路由与回调服务器从模块的
  `accountCreation` / `callback` 字段分发；provider 准备凭证或登记 flow，
  宿主负责落库与账户视图。
- `services/providers/index.ts`、`services/protocols/index.ts`：通用装配流程。
  CodeBuddy 两个账号域共享同一个 adapter 实例，注册时去重；模块校验只在此
  进行一次。
- `services/oauth/provider-strategies.ts`、`refresh-strategies.ts`：保留旧调用接口，
  从模块派生查询结果，不再维护各家的实现或分支。

模块使用工厂函数返回声明；不要在模块顶层初始化注册表或调用其他模块。
OAuth 兼容表采用延迟属性读取，避免认证、runtime 与协议入口相互导入时提前
访问尚未初始化的绑定。登录策略实例及登录过程中的内存状态仍在模块内保留。

## 添加 Provider

1. 在 `lib/provider-definitions.ts` 添加一条身份元数据。`oauth` 指账号生命周期
   分类，不是“是否支持浏览器登录”：Windsurf、CodeBuddy、LobsterAI 仍为 `false`，
   但模块可以提供 `oauth` 登录策略。
2. 实现上游请求及 `ProtocolAdapter`，保留其原生 Messages、Responses、Chat 或
   Gemini 能力。跨端点转换继续由公共 IR 层负责，先阅读
   [协议转换约定](translation-conventions.md) 与
   [协议转换易错点](protocol-translation-pitfalls.md)。
3. 创建 `services/providers/modules/<id>.ts`，实现 `ProviderModule`。可引用现有
   runtime，也可提供自己的工厂。OAuth 账号须提供登录和刷新函数；长期凭证可使用
   明确的空刷新函数。直连凭证建号提供 `accountCreation`（可引用
   `services/providers/account-creation/` 的现成实现或自己实现）；回调型登录
   （`pkce-callback` / `callback`）必须提供 `callback` 服务器配置。
4. 在 `services/providers/builtins.ts` 加入模块工厂。无需修改两个初始化函数、
   OAuth 登录分发表、刷新分发表、账号创建分支或另行维护协议枚举。
5. 在 `lib/provider-descriptors/<id>.ts` 提供管理界面的描述、字段与文案，
   并在模块上声明 `descriptor`（纯数据，UI 和路由能力判断在 runtime 启动前
   读取）。

OAuth Provider 可复用 `createOAuthProviderRuntime(id, operations)`，在模块中传入：

```typescript
createRuntime: () =>
  createOAuthProviderRuntime(providerId, {
    discoverModels,
    getFallbackModels,
    fetchQuota,
  })
```

这些函数由 Provider 自己实现；模型与额度落入现有 Connection 状态及持久化流程。
无需给旧的模型发现分支、静态模型表或额度分发表追加条目。省略操作时沿用旧的
OAuth 默认实现；旧静态表没有条目时分别返回空模型列表或无额度快照。
非 OAuth Provider 可直接实现 `ProviderRuntime`。

特殊固定端口回调、账号导入格式、私有模型规范化或新增公共协议能力，仍可能需要
扩展相应子系统。此模块边界统一装配，不将这些行为隐藏在一个无类型的 `fetch` 中。

## 验证

`tests/provider-modules.test.ts` 验证所有内置模块、重复初始化、共享 adapter、
未知 ID、错误声明、OAuth 分类和不同入口的冷启动导入。
`tests/provider-runtime-operations.test.ts` 验证 Provider 自带模型与额度操作。
各 Provider 的现有登录、刷新、请求和流式测试继续覆盖实际行为。

新增 Provider 应补充上游请求测试，然后运行 `bun test ./tests`、
`bun run typecheck`、`bun run lint`、`bun run format:check` 和 `bun run build`。

## 附录：外部加载（第 2 步）设计要点

模块契约稳定后，外部 pack 与内置模块共用同一接口。以下约束先行记录，
实现以 Trae CN 试验为准，未实现前本节只是设计意图：

- 契约：pack 与 `ProviderModule` 同构，但 `id` 为自由字符串、自带
  `descriptor`。v1 的 `adapter` 限用四个通用协议（openai /
  openai-responses / anthropic / gemini-compatible）或引用内置 adapter
  实例，pack 不自带 wire 翻译代码；私有协议仍走内置模块。登录、刷新、
  模型与额度自包含，pack 返回凭证更新结果，宿主统一持久化——多个
  provider 共用一个协议适配器时依旧各拿各的模块。
- 加载：启动时扫描数据目录 `provider-packs/*.{ts,js}` 动态 `import()`
  （Bun 原生）。不接 npm、不接 registry、无热更新；pack 声明
  `apiVersion`，与宿主不匹配时整体禁用并在管理页说明。
- 缺失与损坏：connection 配置独立持久化，pack 缺失只令其连接不可用，
  不影响其他 provider 与网关启动；管理页标记不可用原因。
- 流式取消与代理：沿用现有 dispatch 的 AbortSignal 传递与
  `connection.proxyUrl`，pack 不经手取消语义。
- 管理页：`pages/js/views/accounts.js` 的 `PROVIDER_METAS` 等硬编码是
  主要障碍，账号视图需改为按 API 数据渲染 pack 提供的 descriptor。
- 验收（Trae CN）：不改核心枚举、OAuth 分发与管理页硬编码，完成登录、
  模型发现、调用（通用协议）、刷新与额度展示。

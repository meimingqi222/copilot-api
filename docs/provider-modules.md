# 内部 Provider 模块

Provider 随应用编译、发布，通过 `services/providers/modules/<id>.ts` 声明接入。
`services/providers/builtins.ts` 是服务层唯一的模块装配清单；没有外部包加载、
插件市场或热更新。

## 边界

- `lib/provider-metadata.ts`：纯元数据的唯一装配清单，各家的贡献在
  `lib/provider-descriptors/<id>.ts` 声明身份、协议、OAuth 账号分类与描述。
  `lib/provider-definitions.ts` 从这些贡献派生 `ProviderId`、`OAuthProviderId`、
  原生 `ProviderProtocol`、账号协议映射和持久化协议校验，无需再维护身份表。
  读取连接文件不需要先启动 Provider runtime。
- `lib/provider-descriptors/<id>.ts`：各家的账号描述、图标、登录表单与展示配置
  （纯数据，UI 与路由能力判断在 runtime 启动前读取）；模块声明自己的
  `descriptor`，注册时校验与 `module.id` 一致。页面从 API 读取分类、徽标、
  提示和手动回调配置，不再维护这些 Provider 名单。
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

## 认证状态归属

`oauth.exchange` 返回未注册的 Connection。宿主统一处理身份判重、原地重认证、
注册、模型初始化和持久化；模块不得自行 `upsertProviderConnection`。
`afterAuthentication` 是凭证创建和 OAuth 登录共享的完成钩子，现有私有刷新调度
由各家在模块中声明，账号路由无需再按 Provider ID 分支。

`refreshAuth` 返回 `ProviderAuthUpdate`，不直接写入正在使用的 Connection。
现有 OAuth bundle 解析可用 `prepareOAuthRefresh` 包装：它在独立副本上执行解析，
返回凭证值、context、凭证展示字段、认证状态和认证路由设置的差量。
宿主只合并这些差量，保持并发更新的模型、额度、账号名称与开关。
刷新失败不会把半成品 token 写回宿主，已替换的活动凭证不会接收旧刷新结果。

刷新调度器继续负责同一连接的请求合并、终态错误处理与持久化队列。
Copilot 等已有私有 Connection 刷新实现保持原有生命周期；这个差量契约用于模块的
OAuth `refreshAuth`，不要求重写所有私有后台管理器。

## 添加 Provider

常规接入只维护该 Provider 的纯元数据与服务模块，并在两个装配入口各登记一次。
身份枚举、描述索引、登录分发、刷新分发和页面展示都从贡献派生。
复杂上游可以拆出请求客户端、模型目录和回调配置等文件，由模块统一引用。

1. 在 `lib/provider-descriptors/<id>.ts` 用 `defineProviderMetadata` 声明
   `protocol`、`oauth` 和 `descriptor`，在 `lib/provider-metadata.ts` 装配一次。
   `oauth` 指账号生命周期分类，不是“是否支持浏览器登录”：Windsurf、CodeBuddy、
   LobsterAI 仍为 `false`，但模块可以提供 `oauth` 登录策略。
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
5. 补充 Provider 请求和生命周期测试。描述的 `presentation` 配置分类、徽标、
   提示、导入方式和手动回调入口；描述索引自动派生，无需再登记一遍。

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
内置模块也可直接声明 `fallbackModels`、`discoverModels` 与 `fetchQuota`；默认的
OAuth runtime 与旧查询入口会读取这些操作。静态目录在
`services/providers/model-catalogs/<id>.ts`，集中目录、发现分支和额度分发表已移除。
未声明时返回空模型列表或无额度快照。非 OAuth Provider 可直接实现 `ProviderRuntime`。

固定端口和现有的 query/POST 回调模式通过模块配置接入。新的回调模式、特殊账号
导入格式、私有模型规范化或新增公共协议能力，仍可能需要扩展相应子系统。

## 验证

`tests/provider-modules.test.ts` 验证所有内置模块、重复初始化、共享 adapter、
未知 ID、错误声明、OAuth 分类和不同入口的冷启动导入。
`tests/provider-runtime-operations.test.ts` 验证 Provider 自带模型与额度操作。
`tests/provider-metadata.test.ts` 验证身份、协议和描述派生及重复注册。
`tests/provider-auth-update.test.ts` 验证刷新隔离、认证差量合并与活动凭证校验。
`tests/provider-contributions.test.ts` 验证描述一致性、回调枚举与凭证准备契约；
`tests/provider-presentation.test.ts` 执行页面代码，验证新增描述可以控制展示。
各 Provider 的现有登录、刷新、请求和流式测试继续覆盖实际行为。

新增 Provider 应补充上游请求测试，然后运行 `bun test ./tests`、
`bun run typecheck`、`bun run lint`、`bun run format:check` 和 `bun run build`。

## 维护范围

这里的模块化用于降低内置 Provider 的新增和维护成本。Provider 随宿主一起发布，
没有独立发布、外部动态加载或插件市场的要求。

Runtime 负责 Provider 生命周期，Adapter 负责原生端点请求；多个 Provider 可以
共享同一个 Adapter。模型的原生端点由模型映射和 Adapter 声明，跨端点转换仍由
宿主的公共 IR 层负责。新增 Provider 不应为了复用接口而把所有端点压成 Chat。

纯元数据必须能在读取连接文件、校验协议和返回管理页面描述时独立加载。因此，
纯元数据装配与服务实现装配保留为两层，避免读取配置时初始化网络客户端和认证流程。
这两层是明确的注册入口，不要求把每家上游实现、模型目录和描述塞进一个大文件。

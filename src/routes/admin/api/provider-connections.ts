/**
 * Admin API: Provider Connections
 *
 * 通用 provider connection 的 CRUD 与 credential 子资源管理。
 * 与 legacy `accounts` API 并存,不互相干扰。
 *
 * 路由按功能拆分到子模块,在此组合:
 *   - provider-connections-crud.ts        — CRUD (list / create / read / update / delete)
 *   - provider-connections-models.ts      — 模型相关 (refresh / models CRUD / batch / parse)
 *   - provider-connections-credentials.ts — credential 子资源
 *   - provider-connections-test.ts        — 连通性测试
 *   - provider-connections-fetch-models.ts — 即时模型探测 (不落盘)
 *   - provider-connection-io.ts           — export / import
 */

import { Hono } from "hono"

import { mountConnectionGuard } from "~/routes/admin/api/provider-connection-guard"
import { providerConnectionIoRoutes } from "~/routes/admin/api/provider-connection-io"
import { providerConnectionCredentialRoutes } from "~/routes/admin/api/provider-connections-credentials"
import { providerConnectionCrudRoutes } from "~/routes/admin/api/provider-connections-crud"
import { handleFetchModels } from "~/routes/admin/api/provider-connections-fetch-models"
import { providerConnectionModelRoutes } from "~/routes/admin/api/provider-connections-models"
import { providerConnectionTestRoutes } from "~/routes/admin/api/provider-connections-test"
import { providerPresetRoutes } from "~/routes/admin/api/provider-presets"

export const providerConnectionApiRoutes = new Hono()

// 预设目录路由
providerConnectionApiRoutes.route("/presets", providerPresetRoutes)

// 即时模型探测 (不落盘、不建连接)
providerConnectionApiRoutes.post("/fetch-models", handleFetchModels)

// Export / import (batch) — see provider-connection-io.ts
providerConnectionApiRoutes.route("/", providerConnectionIoRoutes)

// 守卫:所有 /:id 路由拒绝 account-managed connection(*-native protocol)。
// 详见 provider-connection-guard.ts。
// 必须在所有含 /:id 路由的子模块挂载之前注册,才能对它们生效。
mountConnectionGuard(providerConnectionApiRoutes)

// CRUD (list / create / read / update / delete)
providerConnectionApiRoutes.route("/", providerConnectionCrudRoutes)

// 模型相关路由 (refresh-models / models CRUD / batch / parse-models)
providerConnectionApiRoutes.route("/", providerConnectionModelRoutes)

// 连通性测试路由
providerConnectionApiRoutes.route("/", providerConnectionTestRoutes)

// credential 子资源路由
providerConnectionApiRoutes.route("/", providerConnectionCredentialRoutes)

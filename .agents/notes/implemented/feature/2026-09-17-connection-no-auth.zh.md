# Agent Note: 外部访问控制后的 Connection 认证

Status: implemented

[English](2026-09-17-connection-no-auth.md) | 中文

## 问题

homelab 部署在 Harness 外部控制访问，要求浏览器无需第二次登录或持久化浏览器会话密钥即可进入。以打包 JavaScript 补丁维护此策略，会让源码声明、测试和文档无法描述部署后的行为。

## 决策

Connection 提供 `authentication: browser-token | none`，默认为 `browser-token`。既有进程令牌交换与签名 cookie 实现仍是默认行为。显式选择 `none` 会完全省略浏览器认证拥有者：不生成启动令牌，不访问浏览器会话凭据记录，也不签发 cookie。为保持组合兼容性，插件仍要求 credentials 服务；其他凭据拥有者不受影响。

两种模式都会在 index 授权和 API 分发之前执行既有 Host、Origin 和 Fetch-Metadata 校验。信任校验拒绝会在令牌交换或 URL 清理之前返回 403。这些路由校验不认证非浏览器客户端，因此 none 模式要求外部访问控制保护完整 Host，包括 WebSocket upgrade。它既不增加转发 header 解释，也不引入新的绑定策略。

none 模式下，启动 URL 只保留 origin 和根路径。带任意 `token` 查询参数的根路径 GET 会收到指向 `/` 的 303 重定向，以及 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`，但不含 `Set-Cookie`；这会在提供应用之前移除过时启动凭据。其他方法和 index 路径不执行令牌清理。既有 cookie 和签名记录保持不变，因此 browser-token 模式可以恢复既有凭据策略。

这部分取代了[浏览器令牌决策](../architecture/2026-08-24-browser-token-authentication.zh.md)中的无条件认证要求；该决策仍是默认模式的有效记录。[浏览器信任决策](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)仍然有效，因为禁用认证绝不会禁用其请求校验。

## 验证

Connection 源码测试覆盖配置默认值与拒绝、仅在 browser-token 模式初始化凭据、干净启动 URL、none 模式 index 与 API 访问、两种模式下令牌处理之前的信任拒绝，以及过时令牌清理的方法和路径限制。frontend 测试通过真实 Loader 启动 credentials、Connection、webserver 和静态服务，检查 none 模式无 cookie 响应，以及默认模式令牌交换、401 响应、cookie 复用和 403 优先级。伪造 header 的用例使用 Node HTTP 而非 Fetch，确保请求的 Host 原样到达服务器。既有 browser-auth 测试保留签名、有效期、authority 和重启覆盖。这些是 HTTP 入口行为，而非 Session transcript（文本记录）变更；预期响应保留在所属包测试中。

## 曾考虑的替代方案

**继续修补打包 JavaScript。** 这能保留部署行为，却让维护中的 TypeScript 和源码测试与发布包不一致。在既有拥有者中实现同一策略，可以消除这种差异，无需增加第二条授权路径。

**同时禁用信任校验和认证。** 外部身份校验不能替代跨站请求或 DNS rebinding 防御。index 服务和 API 分发都保留同一请求信任策略。

**初始化浏览器认证但跳过 cookie 校验。** 这仍会创建 none 模式不用的浏览器凭据与启动令牌。省略拥有者可避免这些副作用，而不是把它们隐藏起来。

## 后果

默认模式仍要求认证。none 模式下，只要能到达 Host 并发送被接受的路由 header，任何人都能使用其完整工具型 API，除非外部访问控制阻止他们。`trustedHosts` 不能替代访问控制。操作者承担这一部署风险；Harness 不验证外部认证系统。启用认证时，cookie 撤销和浏览器令牌有效期策略保持不变。

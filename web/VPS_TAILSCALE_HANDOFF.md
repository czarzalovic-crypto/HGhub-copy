# HGhub 网页版：交接给本地 Codex 的 VPS + Tailscale 部署说明

## 目标与当前状态

将现有完整网页版部署到用户自己的 VPS，通过 Tailscale 私有网络访问，支持浏览、搜索、详情、封面和视频播放。应用端口仅绑定 VPS 回环地址，由 Tailscale Serve 提供 HTTPS。无需公网域名或开放公网应用端口，不启用 Tailscale Funnel。

本文件仅为交接说明。本次没有登录 VPS、安装服务或改变 Tailscale 配置。

已有源码：

- 仓库：`https://github.com/czarzalovic-crypto/HGhub-copy`
- 分支：`web-online`
- 网页目录：`web/`。仓库根目录仍是原 Tauri 客户端，部署时请进入 `web/`。
- 网页代码基线提交：`3312e2e97fd7b7862a3c446bd953495a5052f8e0`；请从该分支最新提交继续。
- 现有 Sites 地址：`https://hghub-czarzalovic-web.zhangzhewei.chatgpt.site`，已成功部署，访问权限仅所有者。
- 新 VPS 部署独立运行，不需要修改、删除或重新发布现有 Sites。

已验证范围：网页生产构建、13 项后端测试，以及 Sites 上真实的首页资源、列表、搜索、封面、详情、播放地址、HLS 播放列表和视频分片请求。尚未进行浏览器完整播放交互测试或使用真实账号进行登录、注册和评论写入测试。VPS 的出口网络和浏览器仍需重新验收。

## 一、开始前获取的信息

请先读取本地工作区适用的 `AGENTS.md`。再向用户获取或从其已配置环境中确认：

- VPS 的系统和架构，SSH 主机、端口、用户名，以及可用的提权方式。
- 已配置的 SSH 认证方式；不要让用户把密码、私钥或 Tailscale Auth Key 粘贴进聊天或提交到仓库。
- VPS 是否已加入用户的 tailnet；若已加入，确认节点名、在线状态和完整 MagicDNS 名称。
- VPS 是否安装 Docker / Docker Compose，是否已有占用端口或 Tailscale Serve 的服务。
- 用户希望哪些 tailnet 身份或设备能访问该服务。

优先使用已有的认证和服务配置。首次 SSH 连接按正常流程核验主机指纹，保留 SSH 主机密钥验证。Tailscale 如需登录，由用户完成正常登录授权。

云端对话环境当时没有配置 Tailscale VPN 或 VPS SSH 认证；不能将这次云端环境的连通性视作 VPS 已可访问。本地 Codex 应使用用户本机已有的 SSH / Tailscale 连接能力。

## 二、先读懂现有项目

```sh
git clone --branch web-online https://github.com/czarzalovic-crypto/HGhub-copy.git
cd HGhub-copy
git switch -c vps-tailscale
cd web
```

如本地已有同一仓库，保留用户未提交修改，使用现有 checkout 或独立 worktree，不覆盖文件。

关键文件：

| 路径（相对 `web/`） | 用途 |
| --- | --- |
| `WEB.md` | 网页版实现与构建说明 |
| `src/webBridge.ts` | 将原生 IPC 替换为浏览器请求 |
| `src/api.ts` | 前端接口与同源媒体地址 |
| `worker/index.mjs` | 后端业务、登录 Cookie、图片处理、HLS 改写和媒体转发 |
| `scripts/build-worker.mjs` | 把网页资源嵌入 Worker，产出独立服务模块 |
| `scripts/smoke-web.mjs` | 对现有后端模块进行真实上游请求检查 |
| `tests/web-worker.test.mjs` | 13 项后端测试 |
| `.openai/hosting.json` | 原 Sites 的项目标识，现有构建会读取它；不包含认证凭据 |

现有构建命令：

```sh
pnpm install --frozen-lockfile
pnpm test:web
pnpm build
```

源码之前使用 Node 24 和 pnpm 11.25.0 构建通过。建议固定 Node 24 与已验证的 pnpm 版本，保持锁文件不变。

`pnpm build` 产出 `dist/server/index.js`，其中已内嵌 HTML、CSS 和 JS。它默认导出具有 `fetch(request, env, ctx)` 方法的对象，是 Worker 模块，**不是可以直接运行的 Node HTTP 服务器**。直接执行 `node dist/server/index.js` 不会启动监听。

## 三、实现 VPS 的 Node 运行入口

以下部署文件目前尚不存在，需要本地 Codex 实现：

- `server/node-server.mjs`：Node HTTP 与现有 Fetch handler 的适配层。
- `Dockerfile`、`.dockerignore`、`compose.yaml`。
- `.env.example`：只记录变量名及示例，不记录凭据。
- `package.json` 中的 `start` 脚本，以及必要的运行入口测试。
- 实施后的 `VPS_DEPLOY.md`：记录该 VPS 实际采用的端口、启动、更新与回退命令。

### Node 适配层的要求

1. 使用 Node 24 的内置 HTTP、Fetch、Web Streams 和 Web Crypto。加载构建后的 `dist/server/index.js`，复用其 `fetch()` 处理器。
2. 将 Node 请求转换为 Web `Request`，正确处理 GET、HEAD、JSON POST 和请求取消；若使用流式请求体，按 Node Fetch 要求设置 `duplex: 'half'`。
3. 配置请求体上限，拒绝异常大的请求。现有 RPC 的 JSON 文本上限为 16 KiB。
4. 将 Web `Response` 的状态码和响应头传回 Node；使用 `headers.getSetCookie()` 分别转发多个 Set-Cookie，不能用逗号错误合并。
5. 视频响应必须流式传送并处理背压，不能先把整段视频读入内存。保留 Range、206、Content-Range 和 Accept-Ranges。
6. 浏览器断开时停止相应上游请求和媒体流；正确处理 SIGTERM，支持容器重启。
7. 不在日志里记录 Cookie、登录密码、令牌、媒体完整 URL 或带签名的查询参数。
8. `HOST` / `PORT` 可配置；容器内可以监听 `0.0.0.0:3000`，但宿主机端口映射必须仅绑定 `127.0.0.1`。

### 重要：外部 HTTPS Origin

增加 `PUBLIC_ORIGIN` 配置，例如用户 VPS 实际的 `https://<节点名>.<tailnet>.ts.net`。这只是占位示例，必须从 VPS 的真实 Tailscale 配置获取，不要照抄或猜测域名。

Tailscale Serve 终止 HTTPS 后，连接本地应用时是 HTTP。Node 适配层应以经过验证的 `PUBLIC_ORIGIN` 构造 Web Request 的 URL，使它表示浏览器实际访问的 HTTPS 站点。现有 RPC 会比较 `Origin` 与请求 URL 的 origin；若错误使用 `http://127.0.0.1:3000`，浏览器的正常请求也会被当成跨站请求拒绝。

- 不要为了排错删除 Origin 检查。
- 不要盲目信任任意来源的 `X-Forwarded-Host` 或 `X-Forwarded-Proto`。
- 保留账号 Cookie 的 `Secure`、`HttpOnly` 和 `SameSite=Strict`。
- 健康检查可直接请求 `http://127.0.0.1:3000/api/health`；用户界面和登录通过 Tailscale HTTPS 访问。

### 访问权限与网络策略

现有 Sites 的“仅所有者可访问”由 Sites 平台提供；迁移至 VPS 后，这一平台鉴权不会自动存在。

VPS 版本依靠回环端口绑定、Tailscale Serve 和 tailnet ACL / grants 限制访问。请核对现有 tailnet 的规则，确认实际可访问用户范围；不要把“加入 tailnet”直接描述为“只有所有者可访问”。如用户需要仅本人使用，按其身份限制该服务，保留其他已有规则。

保留网页后端的目标 URL 检查、Cookie 会话隔离和跨站检查，不添加任意目标的开放代理。之前 Windows 客户端的严格模式与本机 DNS/FakeIP 冲突，不代表 VPS 应全局关闭网络目标检查。

## 四、推荐的容器结构

建议多阶段构建：构建阶段安装锁定依赖并执行 `pnpm build`；运行阶段只保留 Node 24、`package.json`、Node 适配层、`dist/server/index.js` 和许可证，使用非 root 用户运行。

Compose 的核心配置应类似以下片段，具体字段待实现后验证：

```yaml
services:
  hghub:
    build: .
    restart: unless-stopped
    init: true
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      HOST: "0.0.0.0"
      PORT: "3000"
      PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:?请配置 VPS 的 Tailscale HTTPS Origin}"
```

不要把宿主机映射改成 `3000:3000`，也不要使用会使端口暴露到公网的默认配置。为容器设置适当的日志轮转和健康检查。若 VPS 已占用 3000，选择空闲回环端口并同步更新 Serve 的目标地址。

若使用单独的预构建运行包，必须把构建产物与其对应的源码提交 SHA 一并记录。不要把 `node_modules`、认证文件或本地私密配置打进部署包。

## 五、实施 Tailscale Serve

先进行只读检查：

```sh
tailscale status
tailscale serve status
docker compose version
ss -ltn
```

确认 VPS 已加入正确的 tailnet，并查看现有 Serve 配置。不要覆盖其他服务，不运行 `tailscale serve reset`。

在应用健康检查通过、443 未被现有 Serve 占用的前提下，现代 Tailscale 的典型命令为：

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

执行前核对该 VPS 的 `tailscale serve --help`。如需要启用 MagicDNS / HTTPS，由用户按 Tailscale 的正常流程完成。若已有服务占用入口，先保留它，选择独立的可用 HTTPS 端口或其他不会破坏原有服务的方案，并同步更新 `PUBLIC_ORIGIN`；本项目使用根路径 `/assets/` 和 `/api/`，不能直接挂到 `/hghub/` 子路径而不做适配。

只使用 Serve，不使用 Funnel。用户的电脑或手机也需登录允许访问该 VPS 的 tailnet 身份，然后通过 Serve 返回的实际 HTTPS 地址访问。

## 六、部署与验收顺序

1. 在本地实现并通过 Node 适配层测试与原有后端测试。
2. 按目标架构构建或在 VPS 构建容器，记录 Git SHA、镜像标识和配置文件位置。
3. 启动服务，确认 `http://127.0.0.1:<实际端口>/api/health` 返回 `ok: true`。
4. 核对宿主机监听和 Docker 端口映射，仅有预期的回环应用端口。
5. 配置或新增 Tailscale Serve，确认返回真实 HTTPS 地址及其访问范围。
6. 从用户已加入 tailnet 的本机访问 HTTPS 地址，检查页面及 JS/CSS 加载。
7. 在浏览器测试首页、搜索、分类、详情、封面、实际视频播放、拖动进度条、切换视频、刷新和手机布局。
8. 通过实际部署地址检查 HLS、子播放列表、密钥及视频分片的同源请求；确认 Range / 206 行为。检查浏览器网络面板与服务日志，避免只以返回首页 HTML 判定成功。
9. 测试正常同源 RPC 可用，跨站 RPC 被拒绝；如用户提供正常登录条件，确认登录 Cookie 能保存，刷新、切换线路和退出登录符合预期。不要为验收擅自注册账号或发布评论。
10. 确认容器异常退出可自动恢复；如需要重启 VPS 验收，先与用户协调，避免中断其他服务。

Tailscale 只决定用户如何访问 VPS；VPS 仍需从自身出口访问原有数据源和媒体源。如果出现加载失败，分别检查用户到 VPS、VPS 到上游两段链路，不能把本地或 Sites 的成功当成 VPS 出口可用的证据。

## 七、更新、回退与交付

- 保留已运行镜像标识和上一版构建，更新失败时恢复上一版，再核验健康检查和页面。
- 只回退本次应用或本次新增的 Serve 入口，不重置全机防火墙或整份 tailnet 配置。
- 最终给用户真实 Tailscale HTTPS 地址、部署目录、Compose project 名称、运行版本、查看日志、重启、更新和回退命令。
- 分别说明哪些接口检查通过、哪些浏览器行为实际测试过，以及仍有哪些限制。
- 将实现变更提交到独立分支，保留现有 Windows 客户端和 Sites 版本可用。

## 可直接发给本地 Codex 的任务提示

> 请读取 `https://github.com/czarzalovic-crypto/HGhub-copy` 的 `web-online` 分支中 `web/VPS_TAILSCALE_HANDOFF.md`，在保留现有 Windows 客户端和 Sites 站点的前提下，完成网页版的 Node 运行适配、容器化，以及我自己的 VPS 部署。用 Tailscale Serve 提供私有 HTTPS 访问，宿主机应用端口仅监听回环，不使用 Funnel。先核对已有服务和访问方式，缺少连接信息时向我询问；不要让我在聊天里提供密码、私钥或 Auth Key。实现后完成测试和浏览器播放验收，给我实际访问地址、运行版本以及维护和回退说明。请自主完成已授权的常规实施步骤；遇到登录由我本人完成，遇到会覆盖已有服务或中断其他服务的操作先说明具体影响。

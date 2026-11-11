# HGhub 私人网页版

从 HGhub 1.2.1 移植，保留原项目的 React 界面与非商业许可证。

- 浏览、搜索、分类、排行榜、详情、视频播放与原有账号交互。
- 后端运行于 Cloudflare Worker；数据和媒体统一走同源接口。
- 上游账号令牌只保存在 Secure / HttpOnly Cookie 中，不进入前端脚本、日志或源代码。会话不在 Worker 全局变量中共享。
- 媒体按流转发，支持 Range；播放列表中的子列表、分片和密钥经过同源代理。
- 播放历史、主题和搜索历史保留在当前浏览器；诊断日志仅记录事件与时间。
- 网页固定启用严格安全模式；使用固定线路，禁用任意镜像账号请求。
- 原生窗口关闭、最小化、拖拽和旋转接口已适配浏览器。

## 构建与检查

```sh
pnpm install --frozen-lockfile
pnpm test:web
pnpm build
```

部署入口是 `dist/server/index.js`，它包含网页资源和 Worker 后端。`dist/.openai/hosting.json` 记录 Site ID。Sites 默认仅所有者可访问。

真实接口冒烟检查（需要允许访问上游及媒体源）：

```sh
NODE_USE_ENV_PROXY=1 node scripts/smoke-web.mjs
```

自动测试覆盖会话隔离、Cookie 标记、跨站请求拒绝、目标 URL 检查、HLS 改写、图片处理和媒体 Range 透传。未使用真实账号进行登录、注册或评论写入测试。

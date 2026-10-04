# EdgeSSH-APK

把 [EdgeSSH](https://github.com/xxxooooxxx/EdgeSSH) 网站的前端代码打包进 Android APK 本地运行。

## 架构

- 本仓库完整包含 EdgeSSH 网站源码（与主仓库同步）。
- `android/app/src/main/assets/web/` 是 `npm run build:web` 的构建产物（HTML/CSS/JS），随 APK 发布。
- `android/` 原生工程：WebView 加载 `https://ssh.lyrnox.com/`，页面静态资源拦截后走本地 assets，`/api/*` 代理到真实后端。前端看到的 origin 就是真实域名，WebSocket 直连后端，无需魔改。
- 数据（服务器、代码片段等）来自真实后端 D1，打开即与网站一致。
- Cloudflare Access 登录在 WebView 内完成，Cookie 持久保存。

## 和“网址套壳”的区别

APK 内含网站完整前端代码（3.8MB），断网也能打开界面（数据需联网）。不是空壳 WebView。

## 构建

推送到 main 自动触发 GitHub Actions 构建 debug APK，在 Actions 页下载 Artifacts。

更新前端代码后，需重新跑 `npm run build:web` 并把 `dist/` 同步到 `android/app/src/main/assets/web/`。

# EdgeSSH-APK

把 [EdgeSSH](https://github.com/xxxooooxxx/EdgeSSH) 网站打包成 Android APK。

## 这是什么

- 本仓库完整包含 EdgeSSH 网站源码（与主仓库同步）。
- `android/` 是一个原生 Android 工程，内嵌 WebView，直接加载真实站点 `https://ssh.lyrnox.com`。
- 打开 APK 就是你的网站：所有服务器、代码片段、文件管理都在（数据在服务端 D1，登录一次即可）。
- Cloudflare Access 登录在 WebView 内完成，Cookie 持久保存。

## 和 EdgeSSH-Android（原生重写版）的区别

那个是 Kotlin/Compose 完全重写的独立 App，数据不互通。这个是网站本身的 APK 壳，数据完全一致。

## 构建

推送到 main 会自动触发 GitHub Actions 构建 debug APK，在 Actions 页下载 Artifacts。

本地构建：

```bash
cd android
./gradlew assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

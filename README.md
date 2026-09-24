# Termux 精简版（termux-st）

基于 [termux/termux-app](https://github.com/termux-app) 官方源码深度定制的纯净壳版本，首个发布版本 **v1.0.0**（versionCode 131 / versionName 1.0.0）。

## 下载

APK 在本仓库的 [Releases](https://github.com/likesugar/termux-st/releases) 页面，每次 push 自动构建并发布。

> 注意：CI 构建产物未签名，Releases 中带 `signed` 后缀的 APK 已用调试密钥补签，可直接安装。

## 相对官方版的改动

### 瘦身与纯净
- bootstrap 仅保留 **arm64-v8a** 单架构，并深度瘦身（删 man/doc/include、strip 二进制、剪无关包）
- 关闭 motd、删除示例文档与冗余资源（图标仅保留 xxhdpi）
- 中文界面、无欢迎语

### 内置浏览器（WebActivity）
在抽屉（侧边栏）加入内置浏览器，功能与官方版不同：
- **媒体嗅探与下载**：长按或嗅探列表保存页面媒体资源
- **HTML5 全屏**：支持网页 video 全屏，配合官方同款隐藏系统栏方案
- **返回键**：有历史则 goBack，否则退出
- **媒体自动播放 + 渲染优先级**：视频自动播放，切后台渲染降级
- **选择存储按钮**：抽屉内一键切换浏览器存储位置（shared 模式弹出文件选择器定位到 `/storage/emulated/0/`，配置写入 `~/.termux/browser_storage`）

### 终端增强
- 抽屉快捷按钮：**cc**（清屏）、**ST**（跳转酒馆面板）
- 返回键语义调整：逐级退出

## 构建

```bash
./gradlew assembleRelease
```

环境要求：
- JDK 17
- Android SDK + NDK 27.2（`gradle.properties` 中 `ndkVersion`）
- 构建 bootstrap 由仓库内置的 `app/src/main/cpp/bootstrap-aarch64.zip` 提供（`TERMUX_LOCAL_BOOTSTRAP=1` 已在 CI 设置，防止被官方包覆盖）

推送 `main` 分支后 GitHub Actions 自动出包，见 `.github/workflows/build.yml`。

## 版本

- **v1.0.0**（2026-09-24，内部代号 v77.19）：首个发布版本。包含 v77.12 基线（cc/ST 按钮、WebView 优化）+ 媒体自动播放、渲染优先级、返回键 goBack/finish、HTML5 全屏、抽屉"选择存储"按钮。

# 筹记 · WagerMemo PWA

独立的静态 iPhone 主屏幕 Web App。目标设备为 iPhone 15，Windows 本机即可开发，不依赖 Mac 或 Xcode。

## 安装

部署完成后，在 iPhone 的 Safari 打开 GitHub Pages HTTPS 地址，点“分享”→“添加到主屏幕”。

## 本机数据与隐私

本仓库是公开仓库，应用程序源代码和静态页面可被互联网访问。账本记录不上传 GitHub：它们保存在当前浏览器来源的 IndexedDB，并以 PBKDF2-SHA256 派生密钥和 AES-GCM 加密。应用没有后端、分析 SDK 或云同步。

数据和最近 5 份恢复快照都在同一设备、同一浏览器来源。清除网站数据、设备丢失或忘记口令都可能导致账本永久丢失。此 PWA 不提供原生 iOS Keychain、Face ID、SQLCipher 或 App Store 安装。

## 功能

- 单一 CNY 账本，记录投注、派彩、存入、取出和退款
- 支持编辑、删除、投注净结果汇总及上一份快照恢复
- Windows 本机预览：`node .\\pwa-v1\\serve.mjs`
- 无第三方运行时依赖

## 发布

在仓库 Settings → Pages 将 Source 设为 GitHub Actions。之后向 main 推送会自动发布；工作流只发布应用运行文件，不发布开发文档和图标生成脚本。
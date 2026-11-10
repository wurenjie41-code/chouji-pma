# 筹记（WagerMemo）PWA V1

Windows 可直接开发、无需本机 Mac/Xcode 的 iPhone 主屏幕 Web App。原生 Swift 项目和既有资料仍保留在仓库其他目录；此版本单独位于 `pwa-v1/`。

## 本机预览

需要 Node.js 18 或更高版本，不需要安装 npm 依赖：

```powershell
node .\pwa-v1\scripts\generate-icons.mjs
node .\pwa-v1\serve.mjs
```

在这台电脑访问 `http://127.0.0.1:4173`。本机 `localhost` 可用于开发预览，但局域网 HTTP 地址不提供加密 API；不要用 HTTP 局域网地址在 iPhone 上存入真实账本。

## iPhone 15 安装

Safari 的主屏幕 Web App 需要一个可访问的 HTTPS 地址。仓库包含手动触发的 GitHub Pages 工作流：

1. 把项目推送到你拥有的 GitHub 仓库；不要上传任何真实资金记录或浏览器数据库。
2. 在仓库 **Settings → Pages** 将发布源设为 **GitHub Actions**。
3. Pages 来源设置好后，推送 `main` 分支会自动发布；也可在 Actions 页面手动运行工作流。
4. 部署完成后，从 Actions 部署结果或 Settings → Pages 复制站点 HTTPS 地址。
5. 在 iPhone 15 的 Safari 打开地址，点“分享”→“添加到主屏幕”。

GitHub Pages 是互联网可访问的静态网站。GitHub Free 通常要求 Pages 源仓库为公开仓库；公开的是页面程序和静态资源，不包括设备上的账本记录。若不希望程序公开，不要运行 Pages 工作流；应改用你控制且启用 HTTPS 的私有静态托管。无需购买服务即可在电脑本机预览，但手机实际安装需要一个 HTTPS 托管地址。
工作流只发布运行时文件（页面、脚本、样式和图标），不会将本 README、实施计划或开发脚本放进 Pages 页面目录。

## V1 能力

- 人工录入投注支出、派彩返还、存入、取出、退款；支持编辑和删除。
- 使用整数“分”计算 CNY；投注净结果只合计投注支出、派彩和退款，不把账户存取款当作盈亏。
- IndexedDB 保存 AES-GCM 加密的账本；密钥由用户口令通过 PBKDF2-SHA256（600,000 轮）派生，不把口令写入数据库。
- 每次写入与最新账本同一 IndexedDB 事务中增加加密快照，最多保留 5 个版本，可恢复上一版本。
- 请求浏览器持久存储并显示配额使用情况；超过 80% 时提示。
- Service Worker 只缓存应用静态文件，不缓存或同步账本。
- IndexedDB 中的快照版本号和创建时间等少量索引元数据不加密；流水内容和备注加密。

## 数据与安全边界

这是一款仅在本机浏览器运行的 PWA，不连接后端，不会把记录上传 GitHub Pages。主账本和 5 个恢复快照处于同一设备、同一浏览器来源，快照不是异地备份。清除 Safari 网站数据、卸载/重置设备或浏览器清理存储都可能永久丢失账本；忘记口令也无法恢复。

PWA 口令加密不等于 SQLCipher、iOS Keychain 或原生 Face ID。此版本没有原生生物识别解锁、多设备同步或独立备份。首个可用版本目前只支持单一 CNY 账本和基础人工流水，OCR/外部赔率数据尚未接入。

## 目录

- `DATA_MODEL.md`：本机 IndexedDB 与资金记录结构
- `IMPLEMENTATION_PLAN.md`：开发、设备验证和发布计划
- `index.html`：界面与安装元数据
- `src/app.js`：账本界面、计算和交互
- `src/storage.js`：IndexedDB、WebCrypto、加密快照
- `sw.js`：离线静态文件缓存
- `scripts/generate-icons.mjs`：生成 PNG 安装图标
- `serve.mjs`：无第三方依赖的 Windows 本机预览服务器

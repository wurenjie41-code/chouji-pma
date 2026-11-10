# 筹记（WagerMemo）PWA V1

运行于 iPhone Safari/主屏幕的本机资金记录工具。纯 HTML、CSS、JavaScript，无框架、后端或外部数据源；Windows 可开发和发布，不需要本机 Mac/Xcode。旧 Swift 工程及其他资料仍保留在仓库其他目录。

## 本机预览

需要 Node.js 18 或更高版本，无需安装 npm 依赖：

```powershell
node .\pwa-v1\serve.mjs
```

电脑访问 `http://127.0.0.1:4173`。本机 localhost 可用于加密 API 预览；不要通过局域网 HTTP 在手机上存入真实账本。

## iPhone 15 安装

1. 确认 GitHub 仓库 **Settings → Pages → Source** 为 **GitHub Actions**。
2. 推送 `main` 后等待 **Actions → Publish Chouji PWA to GitHub Pages** 成功。
3. 在 iPhone 15 的 Safari 打开 `https://wurenjie41-code.github.io/chouji-pma/`。
4. 点“分享”→“添加到主屏幕”。首次用临时数据检查页面与解锁后，再录入个人数据。

GitHub Pages 是公开静态托管。公开的是程序和图标，不是存放于设备浏览器的账本；不要把真实流水、备份文件或口令提交到 GitHub。

## 当前功能

- **概览**：投注净结果、累计投注与返还、近 7 日表现、最近流水。
- **明细**：按流水类型筛选；新增、编辑、删除投注支出、派彩、退款、账户存入和账户取出。
- **分析**：近 7 天、近 30 天或全部区间的净结果、投注额、返还额、净结果/投注比例；每日/月度趋势与流水类型构成。
- **加密与恢复**：账本以 AES-256-GCM 加密，PBKDF2-SHA256（600,000 轮）派生口令密钥；每次成功保存后生成最多 5 份本机加密快照，可恢复上一版。
- **加密迁移备份**：导出仅包含密文的 JSON 文件；在另一台设备或清空本机浏览器数据前保存它。导入时需原账本密码，且只会写入当前没有账本的浏览器，不覆盖现有账本。
- **离线与存储提示**：Service Worker 缓存应用资源但不缓存账本；申请浏览器持久存储、显示配额并在接近上限时提醒。

所有金额以整数分保存，单一 CNY 账本。投注净结果 = 派彩 + 退款 − 投注；账户存取仅作资金移动，不纳入盈亏。此工具只记录用户手动输入的信息，不提供赛事、赔率、投注服务或建议。

## 数据与安全边界

应用没有服务器和云同步。IndexedDB 主账本与滚动快照留在当前浏览器来源；加密导出文件可以手动放到独立安全位置。导出文件虽然不含明文流水，任何人拿到它仍可尝试猜测账本密码，因此应当安全保存并使用强口令。忘记口令无法找回；浏览器清理、设备故障或文件丢失仍可能导致数据无法恢复。

这是 PWA，不是原生 iOS App；不使用 SQLCipher、iOS Keychain 或原生 Face ID，也没有 App Store 安装包。移动 Safari 的文件保存/选择体验、离线启动和存储持久性需要在目标 iPhone/iOS 版本上实机确认。暂不支持多币种、多账本、云同步、OCR、赛事/赔率 API 或 CSV 导入导出。

## 目录

- `DATA_MODEL.md`：IndexedDB、加密 envelope、资金流水与备份格式
- `IMPLEMENTATION_PLAN.md`：已完成项、发布与设备检查计划
- `index.html`：页面与安装元数据
- `src/app.js`：页面渲染、分析与交互
- `src/storage.js`：IndexedDB、WebCrypto、快照、加密备份
- `src/styles.css`：响应式界面
- `sw.js`：离线静态文件缓存
- `serve.mjs`：Windows 本机预览服务器


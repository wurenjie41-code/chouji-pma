# 本机辅助识别

截图/照片选择后展开辅助录入，点击识别图片；识别文字可改写，再解析。候选字段默认不勾选，用户逐项核对并勾选总确认后才带入表单，最后仍需加密保存。图片不上传。

本机预览准备：在 ocr-engine 目录运行 `npm ci --ignore-scripts`，再在项目根运行 `node pwa-v1/scripts/package-ocr.mjs`。发布工作流执行同样的固定依赖构建。vendor 是生成资源，不提交到源码仓库。模型加载成功后同源资源加入 Service Worker 缓存；浏览器清理缓存后需联网重新加载。图片内容与账本不经过缓存。

Tesseract.js 与 Tesseract.js-core 来自 naptha 官方 npm 包，许可证随 vendor 提供。模型包 @tesseract.js-data/chi_sim 和 eng 的包元数据为 MIT；引擎与模型有各自的上游版权声明，保留上游包锁和许可证。模型来自 https://github.com/naptha/tessdata 。

参考：https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md 与 https://github.com/naptha/tesseract.js/blob/master/docs/api.md 。

浏览器语音只在支持设备端识别且语言包可用时启动。用户需要自行允许麦克风。没有云端回退，不保证 Safari 可用；系统键盘听写和音频文件转写不属于本机 OCR 引擎。

测试：`node pwa-v1/scripts/acceptance.mjs` 和 `node pwa-v1/scripts/recognition-test.mjs`。`--ocr` 附加测试读取本机合成 sample.png，不包含用户资料。


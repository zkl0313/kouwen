《古贤对话录》资源说明
================================

入口与源码
----------
- index.html — 页面入口（外链 style.css、characters.js、app.js）
- app.js — 含 DEEPSEEK_API_KEY、在线请求与离线兜底逻辑
- characters.js — 人物与原有 systemPrompt（再由 app.js 叠「总编辑」人文层）
- style.css — 样式

在线部署（DeepSeek）
--------------------
见项目根目录 **DEPLOY.md**。推荐使用 **Vercel** + 已提供的 `api/deepseek.js` 同源代理。

图片（可选）
------------
assets/ 下立绘与底纹；无图亦可运行。

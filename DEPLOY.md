# 《古贤对话录》部署说明（DeepSeek + 免本地服务器）

## 为什么需要部署？

DeepSeek 官方 API **不向浏览器任意来源开放 CORS**。  
把静态页部署到 **Vercel** 并启用本仓库里的 **`/api/deepseek` 代理** 后，浏览器只访问**与你网站同源**的地址，由云端函数再请求 DeepSeek，即可正常流式对话。

仅双击本地 `file://` 打开时，仍可能因跨域失败——此时页面会**自动使用离线笔墨**作为兜底。

---

## 推荐：Vercel（已含配置文件）

### 快速验收清单（约 30 分钟）

1. **推送代码**：将本仓库推到 GitHub（确保 `app.js` 中 `DEEPSEEK_API_KEY` 为 `YOUR_KEY_HERE`，真实密钥只放在 Vercel）。
2. **导入项目**：打开 [vercel.com](https://vercel.com) → **Add New… → Project** → Import 该仓库 → **Root Directory** 选项目根目录（须同时包含 `index.html` 与 `api/`）。
3. **环境变量**：**Settings → Environment Variables** → 新增 `DEEPSEEK_API_KEY` = 你的 sk- 密钥 → 勾选 **Production**（Preview 按需）→ Save。
4. **重新部署**：Deployments → 最新一条右侧 **⋯** → **Redeploy**（改环境变量后必须触发一次）。
5. **浏览器验证**：打开分配的 `https://*.vercel.app/...` → DevTools → **Network** → 发一条对话 → 确认存在 **POST 同域** `/api/deepseek` → Status 200 且流式正文正常。
6. **兜底验证**（可选）：临时把环境变量改成错误值 Redeploy → 再发消息 → 应出现离线笔墨回复与相应 Toast（约 25s 内超时也会走离线）。

说明：若你在 `app.js` 里填写了有效 `DEEPSEEK_API_KEY`（以 `sk-` 开头），请求会带 `Authorization` 并由代理转发；**推荐**前端保持 `YOUR_KEY_HERE`，仅由服务端 `process.env.DEEPSEEK_API_KEY` 鉴权。

---

### 给 HR / 面测用的一句话（可直接复制）

模型经 **Vercel Serverless 同源代理**（`/api/deepseek`）调用 DeepSeek，**API Key 仅配置在 Vercel 环境变量**、不进前端仓库；请求 **失败或超时** 时自动 **降级为离线笔墨**，保证演示可完成。

---

## GitHub Pages 可以吗？

**纯 GitHub Pages** 只能托管静态文件，**不能**运行本仓库中的 `api/deepseek.js` 代理，因此**无法**单独靠 Pages 解决 DeepSeek 的 CORS。

可选做法：

- 把同一仓库接到 **Vercel / Netlify / Cloudflare Pages（含 Functions）** 等有 Serverless 的平台；或  
- 另建 **Cloudflare Worker** 转发 API，再把前端里的代理路径改成 Worker 地址（需改 `app.js` 中 `DEEPSEEK_PROXY_PATH` 逻辑）。

---

## 本地预览（可选）

若本机已安装 Node，可在项目根目录执行 `npx vercel dev`，用终端给出的 `http://localhost:3000` 预览与线上一致的代理行为。  
**未安装 Node 不影响**：你仍可只打开 `index.html` 使用离线兜底。

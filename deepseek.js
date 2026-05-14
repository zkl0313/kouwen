/**
 * Vercel Serverless：同源代理 DeepSeek Chat Completions
 * 解决浏览器直连 api.deepseek.com 的 CORS 限制。
 *
 * 环境变量（推荐）：在 Vercel 项目 Settings → Environment Variables 添加 DEEPSEEK_API_KEY
 * 若未设置，则转发请求头里的 Authorization（由前端 app.js 传入）。
 */

const { Readable } = require('stream');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const serverKey = process.env.DEEPSEEK_API_KEY;
    const auth =
      req.headers.authorization || (serverKey && serverKey.trim() ? `Bearer ${serverKey.trim()}` : '');

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
      },
      body: JSON.stringify(req.body),
    });

    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.status(upstream.status);

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end(await upstream.text());
    }
  } catch (err) {
    console.error('[api/deepseek]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'proxy error' });
    }
  }
};

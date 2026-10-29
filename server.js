'use strict';

/**
 * GeForce NOW (play.geforcenow.com) などを学校のPCから開くための
 * リバースプロキシ。Render にデプロイして使う想定。
 *
 * ルーティング方式: /<upstream-host>/<path>
 * 例) https://your-app.onrender.com/play.geforcenow.com/  -> https://play.geforcenow.com/
 */

const express = require('express');
const http = require('http');
const zlib = require('zlib');
const httpProxy = require('http-proxy');
const cheerio = require('cheerio');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// ルート(/)に来たときに飛ばす先
const DEFAULT_TARGET = process.env.DEFAULT_TARGET || 'https://play.geforcenow.com/';

// パス先頭がドメインに見えないときのフォールバック先
const FALLBACK_HOST =
  process.env.FALLBACK_HOST || new URL(DEFAULT_TARGET).host;

const COOKIE_NAME = '__p_host';

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', true);

/* ------------------------------------------------------------------ */
/* プロキシ本体                                                        */
/* ------------------------------------------------------------------ */

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
  selfHandleResponse: true,
  xfwd: true,
});

/* ------------------------------------------------------------------ */
/* ヘルパー                                                            */
/* ------------------------------------------------------------------ */

const FILE_EXT =
  /\.(ico|txt|js|mjs|cjs|css|json|png|jpe?g|gif|svg|webp|avif|xml|html?|woff2?|ttf|otf|eot|map|wasm|bin|mp4|webm|mp3|wav|ogg|pdf|zip|gz)$/i;

function looksLikeUrl(v) {
  return typeof v === 'string' && (/^(https?:)?\/\//i.test(v) || v.startsWith('/'));
}

/** 任意URL -> プロキシ形式の相対パス */
function toProxyUrl(u, baseUrl) {
  if (!u) return u;
  const raw = String(u).trim();
  if (!raw) return u;
  if (/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(raw)) return u;
  try {
    const abs = new URL(raw, baseUrl);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
    return '/' + abs.host + abs.pathname + abs.search + abs.hash;
  } catch (e) {
    return u;
  }
}

/** プロキシ形式URL -> 元のURL */
function fromProxyUrl(u, fallbackHost) {
  try {
    const url = new URL(u);
    const seg = url.pathname.split('/')[1] || '';
    if (seg.includes('.')) {
      url.host = seg;
      url.pathname = url.pathname.slice(1 + seg.length) || '/';
    } else {
      url.host = fallbackHost;
    }
    return url.href;
  } catch (e) {
    return u;
  }
}

function rewriteSrcset(value, baseUrl) {
  return String(value)
    .split(',')
    .map((part) => {
      const p = part.trim();
      if (!p) return p;
      const bits = p.split(/\s+/);
      bits[0] = toProxyUrl(bits[0], baseUrl);
      return bits.join(' ');
    })
    .join(', ');
}

function rewriteCssUrls(css, baseUrl) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const t = u.trim();
      if (!t || /^(data:|blob:|about:|#)/i.test(t)) return m;
      return 'url(' + q + toProxyUrl(t, baseUrl) + q + ')';
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      return '@import ' + q + toProxyUrl(u, baseUrl) + q;
    });
}

function rewriteCookie(cookie) {
  return (
    String(cookie)
      .replace(/;\s*Domain=[^;]*/i, '')
      .replace(/;\s*Path=[^;]*/i, '') + '; Path=/'
  );
}

function getCookie(req, name) {
  const c = req.headers.cookie;
  if (!c) return null;
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/** /<host>/<path> を解析。ドメインに見えなければフォールバック先へ。 */
function resolveTarget(reqUrl, fallbackHost) {
  const m = (reqUrl || '/').match(/^\/([^\/?#]+)([^?#]*)(\?[^#]*)?/);
  if (!m) return null;

  const seg = m[1];
  const rest = (m[2] || '') + (m[3] || '');
  const looksHost = seg.includes('.') && (rest !== '' || !FILE_EXT.test(seg));

  if (looksHost) {
    return { host: seg, path: rest || '/', origin: 'https://' + seg };
  }
  return {
    host: fallbackHost,
    path: '/' + seg + rest,
    origin: 'https://' + fallbackHost,
  };
}

/* ------------------------------------------------------------------ */
/* クライアント側に注入するシム                                        */
/* ------------------------------------------------------------------ */

const INJECT = [
  '<script data-proxy-shim>(function(){try{',
  'var host=(location.pathname.split("/")[1]||"");',
  'if(!host||host.indexOf(".")===-1)return;',
  'function fix(u){',
  'if(typeof u!=="string")return u;',
  'if(/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/.test(u))return u;',
  'var url;try{url=new URL(u,location.href);}catch(e){return u;}',
  'if(url.protocol!=="http:"&&url.protocol!=="https:"&&url.protocol!=="ws:"&&url.protocol!=="wss:")return u;',
  'if(url.host===location.host){',
  'var seg=url.pathname.split("/")[1]||"";',
  'if(seg&&seg.indexOf(".")!==-1)return u;',
  'return "/"+host+url.pathname+url.search+url.hash;',
  '}',
  'return "/"+url.host+url.pathname+url.search+url.hash;',
  '}',
  'window.__proxyFix=fix;',
  'var _fetch=window.fetch;',
  'if(_fetch){window.fetch=function(input,init){try{',
  'if(typeof input==="string"){input=fix(input);}',
  'else if(input&&input.url){var f=fix(input.url);if(f!==input.url){input=new Request(f,input);}}',
  '}catch(e){}return _fetch.call(this,input,init);};}',
  'var _open=XMLHttpRequest.prototype.open;',
  'XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=fix(u);}catch(e){}return _open.apply(this,arguments);};',
  'var _WS=window.WebSocket;',
  'if(_WS){var PWS=function(u,p){u=fix(u);return p?new _WS(u,p):new _WS(u);};',
  'PWS.prototype=_WS.prototype;try{Object.setPrototypeOf(PWS,_WS);}catch(e){}window.WebSocket=PWS;}',
  'if(navigator.sendBeacon){var _sb=navigator.sendBeacon.bind(navigator);',
  'navigator.sendBeacon=function(u,d){return _sb(fix(u),d);};}',
  '}catch(e){console.warn("[proxy shim]",e);}})();<\/script>',
].join('');

/* ------------------------------------------------------------------ */
/* HTML 書き換え                                                       */
/* ------------------------------------------------------------------ */

const URL_ATTRS = [
  'href', 'src', 'action', 'poster', 'data-src', 'data-href',
  'formaction', 'manifest', 'ping', 'background', 'cite', 'longdesc',
];

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  $('base[href]').each((_, el) => {
    const v = $(el).attr('href');
    if (v) $(el).attr('href', toProxyUrl(v, baseUrl));
  });

  $('*').each((_, el) => {
    if (!el || el.type !== 'tag') return;
    const $el = $(el);

    for (const a of URL_ATTRS) {
      const v = $el.attr(a);
      if (v && looksLikeUrl(v)) $el.attr(a, toProxyUrl(v, baseUrl));
    }

    const ss = $el.attr('srcset');
    if (ss) $el.attr('srcset', rewriteSrcset(ss, baseUrl));

    const style = $el.attr('style');
    if (style && style.includes('url(')) {
      $el.attr('style', rewriteCssUrls(style, baseUrl));
    }

    if ($el.attr('integrity')) $el.removeAttr('integrity');
  });

  $('style').each((_, el) => {
    const css = $(el).html();
    if (css && css.includes('url(')) $(el).html(rewriteCssUrls(css, baseUrl));
  });

  const $head = $('head');
  if ($head.length) $head.prepend(INJECT);
  else $.root().prepend(INJECT);

  return $.html();
}

/* ------------------------------------------------------------------ */
/* レスポンス処理                                                      */
/* ------------------------------------------------------------------ */

function fixOutgoingHeaders(proxyReq, req) {
  const t = req._target;
  if (!t) return;

  if (req.headers.origin) {
    try {
      const o = new URL(req.headers.origin);
      const seg = o.pathname.split('/')[1] || '';
      o.host = seg.includes('.') ? seg : t.host;
      o.pathname = '/';
      proxyReq.setHeader('origin', o.origin);
    } catch (e) {
      proxyReq.setHeader('origin', 'https://' + t.host);
    }
  }

  if (req.headers.referer) {
    proxyReq.setHeader('referer', fromProxyUrl(req.headers.referer, t.host));
  }
}

proxy.on('proxyReq', fixOutgoingHeaders);
proxy.on('proxyReqWs', fixOutgoingHeaders);

proxy.on('proxyRes', (proxyRes, req, res) => {
  const t = req._target || { host: FALLBACK_HOST, path: '/' };
  const upstreamUrl = 'https://' + t.host + t.path;
  const h = proxyRes.headers;

  if (h.location) h.location = toProxyUrl(h.location, upstreamUrl);

  const cookies = h['set-cookie'] ? h['set-cookie'].slice() : [];
  cookies.push(COOKIE_NAME + '=' + t.host + '; Path=/; SameSite=Lax');
  h['set-cookie'] = cookies.map(rewriteCookie);

  delete h['content-security-policy'];
  delete h['content-security-policy-report-only'];
  delete h['x-frame-options'];
  delete h['strict-transport-security'];
  delete h['cross-origin-opener-policy'];
  delete h['cross-origin-embedder-policy'];
  delete h['cross-origin-resource-policy'];
  h['access-control-allow-origin'] = '*';

  const ct = String(h['content-type'] || '').toLowerCase();
  const isHtml = ct.includes('text/html');
  const isCss = ct.includes('text/css');

  if ((isHtml || isCss) && req.method !== 'HEAD') {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('error', () => { try { res.end(); } catch (e) {} });

    proxyRes.on('end', () => {
      let buf = Buffer.concat(chunks);

      const enc = String(h['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip') buf = zlib.gunzipSync(buf);
        else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
      } catch (e) { /* 解凍できなければそのまま */ }

      let text = buf.toString('utf8');
      try {
        text = isHtml
          ? rewriteHtml(text, upstreamUrl)
          : rewriteCssUrls(text, upstreamUrl);
      } catch (e) {
        console.error('[rewrite]', e.message);
      }

      delete h['content-length'];
      delete h['content-encoding'];
      delete h['transfer-encoding'];

      res.writeHead(proxyRes.statusCode || 200, h);
      res.end(text);
    });
  } else {
    res.writeHead(proxyRes.statusCode || 200, h);
    proxyRes.pipe(res);
  }
});

proxy.on('error', (err, req, res) => {
  console.error('[proxy error]', err && err.message);

  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    try {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    } catch (e) {}
    try { res.end('Proxy error: ' + (err && err.message)); } catch (e) {}
  } else if (res && typeof res.destroy === 'function') {
    try { res.destroy(); } catch (e) {}
  }
});

/* ------------------------------------------------------------------ */
/* ルーティング                                                        */
/* ------------------------------------------------------------------ */

app.get('/__health', (req, res) => res.type('text/plain').send('ok'));

app.use((req, res) => {
  if (req.url === '/' || req.url === '') {
    const u = new URL(DEFAULT_TARGET);
    return res.redirect(302, '/' + u.host + (u.pathname || '/') + (u.search || ''));
  }

  const fallback = getCookie(req, COOKIE_NAME) || FALLBACK_HOST;
  const t = resolveTarget(req.url, fallback);

  if (!t) {
    res.status(400).type('text/plain').send('bad request');
    return;
  }

  req._target = t;
  req.url = t.path;

  proxy.web(req, res, { target: t.origin });
});

/* ------------------------------------------------------------------ */
/* サーバ起動（WebSocket 対応）                                        */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const fallback = getCookie(req, COOKIE_NAME) || FALLBACK_HOST;
  const t = resolveTarget(req.url, fallback);

  if (!t) { try { socket.destroy(); } catch (e) {} return; }

  req._target = t;
  req.url = t.path;

  proxy.ws(req, socket, head, { target: t.origin });
});

server.listen(PORT, () => {
  console.log('gfn-proxy listening on port ' + PORT);
  console.log('default target: ' + DEFAULT_TARGET);
});
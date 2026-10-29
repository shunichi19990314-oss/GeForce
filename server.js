'use strict';

const http = require('http');
const express = require('express');
const cheerio = require('cheerio');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ORIGIN = 'https://play.geforcenow.com';
const ORIGIN_HOST = new URL(ORIGIN).host;
const PREFIX = '/__p/';

// プロキシを許可するホスト（サフィックス一致）
const ALLOW = (
  process.env.ALLOW_HOSTS ||
  'geforcenow.com,nvidia.com,nvidiagrid.net,nvidiagrid.com,akamaihd.net,akamaized.net'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ALLOW_RE = new RegExp(
  '^https://([a-z0-9-]+\\.)*(' +
    ALLOW.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    ')(/|$)',
  'i'
);

function isAllowed(abs) {
  try {
    const u = new URL(abs);
    return u.protocol === 'https:' && ALLOW_RE.test(u.href);
  } catch {
    return false;
  }
}

/**
 * 元ページの base を基準にURLを解決し、プロキシ用の形に変換する。
 *  - 元オリジンと同じホスト  -> ルート絶対パス（/ プロキシが拾う）
 *  - 許可ホスト（別オリジン） -> /__p/https://host/path
 *  - それ以外               -> 絶対URLのまま（直接アクセス）
 */
function mapUrl(value, base) {
  if (value == null) return value;
  const v = String(value).trim();
  if (!v || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(v)) return value;

  let abs;
  try {
    abs = new URL(v, base).href;
  } catch {
    return value;
  }

  if (!/^https:/i.test(abs)) return abs;
  if (!isAllowed(abs)) return abs;

  const u = new URL(abs);
  if (u.host === ORIGIN_HOST) return u.pathname + u.search + u.hash;
  return PREFIX + abs;
}

function rewriteHtml(html, base) {
  const $ = cheerio.load(html);

  const pairs = [
    ['script', 'src'],
    ['link', 'href'],
    ['img', 'src'],
    ['source', 'src'],
    ['video', 'src'],
    ['video', 'poster'],
    ['audio', 'src'],
    ['iframe', 'src'],
    ['object', 'data'],
    ['a', 'href'],
    ['form', 'action'],
  ];

  for (const [sel, attr] of pairs) {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      $(el).attr(attr, mapUrl(v, base));
    });
  }

  $('img[srcset], source[srcset]').each((_, el) => {
    const v = $(el).attr('srcset');
    if (!v) return;
    $(el).attr(
      'srcset',
      v
        .split(',')
        .map((part) => {
          const [u, d] = part.trim().split(/\s+/);
          return mapUrl(u, base) + (d ? ' ' + d : '');
        })
        .join(', ')
    );
  });

  $('meta[http-equiv="refresh"]').each((_, el) => {
    const c = $(el).attr('content');
    if (!c) return;
    const m = c.match(/url\s*=\s*(.+)$/i);
    if (m) $(el).attr('content', c.replace(m[1], mapUrl(m[1].trim(), base)));
  });

  // サブリソース整合性はプロキシ後に崩れるので外す
  $('script[integrity], link[integrity]').removeAttr('integrity');
  $('*[crossorigin]').removeAttr('crossorigin');

  // シムを最優先で読み込ませる
  $('head').prepend('<script src="/__shim.js"></script>');

  return $.html();
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${mapUrl(u, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${mapUrl(u, base)}${q}`);
}

const SHIM = `(function () {
  if (window.__GFN_SHIM__) return;
  window.__GFN_SHIM__ = true;
  var P = ${JSON.stringify(PREFIX)};
  var ORIGIN = ${JSON.stringify(ORIGIN)};
  var RE = new RegExp(${JSON.stringify(ALLOW_RE.source)}, 'i');

  function base() {
    var p = location.pathname + location.search + location.hash;
    if (p.indexOf(P) === 0) return p.slice(P.length);
    return location.origin + p;
  }

  function map(u) {
    if (u == null) return u;
    var s = String(u);
    if (/^(data:|blob:|javascript:|about:|#)/i.test(s)) return u;
    var a;
    try { a = new URL(s, base()).href; } catch (e) { return u; }
    if (a.indexOf(location.origin + P) === 0) return a.slice(location.origin.length);
    if (!/^https:/i.test(a)) return u;
    if (!RE.test(a)) return u;
    var url = new URL(a);
    if (url.host === new URL(ORIGIN).host) return url.pathname + url.search + url.hash;
    return P + a;
  }

  var of = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' || input instanceof URL) input = map(String(input));
    else if (input && input.url) input = new Request(map(input.url), input);
    return of.call(this, input, init);
  };

  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    var args = [].slice.call(arguments);
    args[1] = map(u);
    return xo.apply(this, args);
  };

  var OWS = window.WebSocket;
  function WSP(url, protocols) {
    return protocols === undefined ? new OWS(map(url)) : new OWS(map(url), protocols);
  }
  WSP.prototype = OWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { WSP[k] = OWS[k]; });
  window.WebSocket = WSP;

  var OES = window.EventSource;
  if (OES) {
    function ES(url, cfg) { return new OES(map(url), cfg); }
    ES.prototype = OES.prototype;
    window.EventSource = ES;
  }

  var OW = window.Worker;
  if (OW) {
    function WK(url, opts) { return new OW(map(url), opts); }
    WK.prototype = OW.prototype;
    window.Worker = WK;
  }

  var oo = window.open;
  window.open = function (u) { return oo.call(window, u ? map(u) : u); };

  if (navigator.sendBeacon) {
    var ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return ob(map(u), d); };
  }
})();`;

const proxyCache = new Map();

function proxyFor(origin) {
  if (proxyCache.has(origin)) return proxyCache.get(origin);

  const mw = createProxyMiddleware({
    target: origin,
    changeOrigin: true,
    ws: true,
    secure: true,
    xfwd: true,
    selfHandleResponse: true,
    cookieDomainRewrite: '',
    cookiePathRewrite: '/',
    proxyTimeout: 180000,
    timeout: 180000,

    onProxyReq(proxyReq, req) {
      // 圧縮を切って本文を書き換えられるようにする
      proxyReq.setHeader('accept-encoding', 'identity');
      try {
        const t = new URL(req.__target || ORIGIN);
        proxyReq.setHeader('origin', t.origin);
        proxyReq.setHeader('referer', t.origin + '/');
      } catch {}
      proxyReq.removeHeader('if-none-match');
      proxyReq.removeHeader('if-modified-since');
    },

    onProxyRes(proxyRes, req, res) {
      const h = proxyRes.headers;
      for (const k of [
        'x-frame-options',
        'content-security-policy',
        'content-security-policy-report-only',
        'cross-origin-opener-policy',
        'cross-origin-embedder-policy',
        'cross-origin-resource-policy',
        'strict-transport-security',
      ]) {
        delete h[k];
      }

      if (h.location) {
        h.location = mapUrl(h.location, req.__target || ORIGIN);
      }

      const status = proxyRes.statusCode || 200;
      const ct = String(h['content-type'] || '').toLowerCase();
      const isHtml = ct.includes('text/html');
      const isCss = ct.includes('text/css');

      if (status === 304 || status === 204 || (!isHtml && !isCss)) {
        res.writeHead(status, h);
        proxyRes.pipe(res);
        return;
      }

      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        try {
          body = isHtml
            ? rewriteHtml(body, req.__target || ORIGIN)
            : rewriteCss(body, req.__target || ORIGIN);
        } catch {}

        const buf = Buffer.from(body, 'utf8');
        delete h['content-encoding'];
        delete h['transfer-encoding'];
        h['content-length'] = String(buf.length);
        res.writeHead(status, h);
        res.end(buf);
      });
    },

    onError(err, req, res) {
      if (res && !res.headersSent && res.writeHead) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Proxy error: ' + err.message);
      } else if (res && res.destroy) {
        res.destroy();
      }
    },
  });

  proxyCache.set(origin, mw);
  return mw;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// 任意の Basic 認証（URL を知られても大丈夫なように）
if (process.env.BASIC_USER && process.env.BASIC_PASS) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const [u, p] = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
    if (u === process.env.BASIC_USER && p === process.env.BASIC_PASS) return next();
    res.writeHead(401, { 'www-authenticate': 'Basic realm="gfn"' });
    res.end('Auth required');
  });
}

app.get('/__health', (req, res) => res.type('text/plain').send('ok'));
app.get('/__shim.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.send(SHIM);
});

// 任意ホスト用プロキシ
app.use(PREFIX, (req, res, next) => {
  const raw = req.originalUrl.slice(PREFIX.length);
  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).type('text/plain').send('Bad URL');
  }
  const abs = target.href;
  if (!isAllowed(abs)) {
    return res.status(403).type('text/plain').send('Host not allowed: ' + target.host);
  }
  req.__target = abs;
  req.url = target.pathname + target.search;
  return proxyFor(target.origin)(req, res, next);
});

// 本体（すべて play.geforcenow.com へ）
app.use((req, res, next) => {
  req.__target = ORIGIN + req.originalUrl;
  return proxyFor(ORIGIN)(req, res, next);
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  let target;
  if (req.url.startsWith(PREFIX)) {
    try {
      target = new URL(req.url.slice(PREFIX.length));
    } catch {
      return socket.destroy();
    }
    req.url = target.pathname + target.search;
  } else {
    target = new URL(req.url, ORIGIN);
  }
  const abs = target.href;
  if (!isAllowed(abs)) return socket.destroy();
  req.__target = abs;
  proxyFor(target.origin).upgrade(req, socket, head);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('listening on ' + PORT);
});
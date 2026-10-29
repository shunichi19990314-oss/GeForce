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

const BLOCK_RE = /(^|\.)(doubleclick\.net|googletagmanager\.com|google-analytics\.com)$/i;

function shouldProxy(abs) {
  try {
    const u = new URL(abs);
    return u.protocol === 'https:' && !BLOCK_RE.test(u.hostname);
  } catch {
    return false;
  }
}

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
  if (!shouldProxy(abs)) return abs;

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

  $('script[integrity], link[integrity]').removeAttr('integrity');
  $('*[crossorigin]').removeAttr('crossorigin');

  // 本来のドキュメントURLをシムへ渡す（相対URL解決の基準）
  $('head').prepend(
    `<script>window.__GFN_DOC__=${JSON.stringify(base)};</script>` +
      '<script src="/__shim.js"></script>'
  );

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
  var OH = ${JSON.stringify(ORIGIN_HOST)};
  var BLOCK = new RegExp(${JSON.stringify(BLOCK_RE.source)}, 'i');

  // 相対URLの解決基準は「本来のドキュメントURL」。
  // 無ければ現在地から復元する（プロキシ自身のオリジンには解決させない）。
  function base() {
    if (window.__GFN_DOC__) return window.__GFN_DOC__;
    var p = location.pathname + location.search + location.hash;
    if (p.indexOf(P) === 0) return p.slice(P.length);
    return ${JSON.stringify(ORIGIN)} + p;
  }

  function map(u) {
    if (u == null) return u;
    var s = String(u);
    if (/^(data:|blob:|javascript:|about:|#)/i.test(s)) return u;
    var a;
    try { a = new URL(s, base()).href; } catch (e) { return u; }
    if (a.indexOf(location.origin + P) === 0) return a.slice(location.origin.length);
    if (!/^https:/i.test(a)) return u;
    var url = new URL(a);
    if (BLOCK.test(url.hostname)) return u;
    if (url.host === location.host) return url.pathname + url.search + url.hash;
    if (url.host === OH) return url.pathname + url.search + url.hash;
    return P + a;
  }

  var box = null, count = 0;
  function overlay() {
    if (box) return box;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;right:8px;bottom:8px;width:min(560px,90vw);max-height:45vh;overflow:auto;background:#000d;color:#0f0;font:11px/1.4 monospace;padding:8px;border:1px solid #0f0;border-radius:6px;white-space:pre-wrap';
    box.addEventListener('click', function () { box.remove(); box = null; });
    document.documentElement.appendChild(box);
    return box;
  }
  function log(kind, url, extra) {
    if (count++ > 200) return;
    var line = '[' + kind + '] ' + (extra || '') + ' ' + String(url);
    (overlay().appendChild(document.createElement('div'))).textContent = line;
    console.warn('GFN-PROXY', line);
  }

  var of = window.fetch;
  window.fetch = function (input, init) {
    var target = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url);
    var mapped = map(target);
    if (typeof input === 'string' || input instanceof URL) input = mapped;
    else if (input && input.url) input = new Request(mapped, input);
    return of.call(this, input, init).then(
      function (r) { if (r.status >= 400) log('fetch', mapped, r.status); return r; },
      function (e) { log('fetch', mapped, 'ERR ' + e.message); throw e; }
    );
  };

  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    var args = [].slice.call(arguments);
    var mapped = map(u);
    args[1] = mapped;
    this.addEventListener('loadend', function () {
      if (this.status === 0 || this.status >= 400) log('xhr', mapped, this.status || 'ERR');
    });
    return xo.apply(this, args);
  };

  var OWS = window.WebSocket;
  function WSP(url, protocols) {
    var mapped = map(url);
    var ws = protocols === undefined ? new OWS(mapped) : new OWS(mapped, protocols);
    ws.addEventListener('error', function () { log('ws', mapped, 'ERR'); });
    return ws;
  }
  WSP.prototype = OWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { WSP[k] = OWS[k]; });
  window.WebSocket = WSP;

  var OES = window.EventSource;
  if (OES) {
    function ES(url, cfg) {
      var mapped = map(url);
      var es = new OES(mapped, cfg);
      es.addEventListener('error', function () { log('sse', mapped, 'ERR'); });
      return es;
    }
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

  if (/[?&]debug=1/.test(location.href) || localStorage.getItem('gfnDebug') === '1') {
    localStorage.setItem('gfnDebug', '1');
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', overlay);
    else overlay();
    log('init', window.__GFN_DOC__ || location.href, 'debug on');
  }
})();`;

const LOG = [];
function pushLog(o) {
  LOG.push(o);
  if (LOG.length > 300) LOG.shift();
}

/**
 * 受け取った生パスを正規化する。
 * - プロキシ自身のホストを指していたらパスに畳む
 * - 先頭の /__p/ が二重三重に付いていたら剥がす
 * - スキーム無しは ORIGIN 配下のパスとして扱う
 */
function normalizeTarget(raw, selfHost) {
  let cur = String(raw || '').trim();
  for (let i = 0; i < 4; i++) {
    let u;
    if (/^https?:\/\//i.test(cur)) {
      try {
        u = new URL(cur);
      } catch {
        return null;
      }
    } else {
      try {
        u = new URL(ORIGIN + (cur.startsWith('/') ? cur : '/' + cur));
      } catch {
        return null;
      }
    }

    if (u.host.toLowerCase() === selfHost) {
      cur = u.pathname + u.search;
      continue;
    }
    if (u.pathname.startsWith(PREFIX)) {
      cur = u.pathname.slice(PREFIX.length) + u.search;
      continue;
    }
    if (u.protocol !== 'https:') return null;
    return u;
  }
  return null;
}

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
      proxyReq.setHeader('accept-encoding', 'identity');
      proxyReq.setHeader('origin', ORIGIN);
      proxyReq.setHeader('referer', ORIGIN + '/');
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

      if (h.location) h.location = mapUrl(h.location, req.__target || ORIGIN);

      const status = proxyRes.statusCode || 200;
      if (status >= 400) pushLog({ t: Date.now(), status, url: req.__target });

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
      pushLog({ t: Date.now(), error: err.message, url: req.__target });
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
app.disable('etag');
app.set('trust proxy', true);

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

app.get('/__log', (req, res) => {
  res.type('application/json');
  res.send(JSON.stringify(LOG.slice(-100), null, 2));
});

app.get('/__shim.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.send(SHIM);
});

app.use(PREFIX, (req, res, next) => {
  const selfHost = String(req.headers.host || '').toLowerCase();
  const target = normalizeTarget(req.originalUrl.slice(PREFIX.length), selfHost);
  if (!target) {
    return res.status(400).type('text/plain').send('Bad URL');
  }
  if (!shouldProxy(target.href)) {
    return res.status(403).type('text/plain').send('Not proxied: ' + target.host);
  }
  req.__target = target.href;
  req.url = target.pathname + target.search;
  return proxyFor(target.origin)(req, res, next);
});

app.use((req, res, next) => {
  req.__target = ORIGIN + req.originalUrl;
  return proxyFor(ORIGIN)(req, res, next);
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const selfHost = String(req.headers.host || '').toLowerCase();
  let target;
  if (req.url.startsWith(PREFIX)) {
    target = normalizeTarget(req.url.slice(PREFIX.length), selfHost);
    if (!target) return socket.destroy();
    req.url = target.pathname + target.search;
  } else {
    target = new URL(req.url, ORIGIN);
  }
  if (!shouldProxy(target.href)) return socket.destroy();
  req.__target = target.href;
  proxyFor(target.origin).upgrade(req, socket, head);
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
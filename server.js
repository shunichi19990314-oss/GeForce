'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const zlib = require('zlib');
const express = require('express');
const cheerio = require('cheerio');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ORIGIN = 'https://play.geforcenow.com';
const ORIGIN_HOST = new URL(ORIGIN).host;
const PREFIX = '/__p/';
const MAX_BODY = 2 * 1024 * 1024;

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

function fixRedirectUri(v, selfHost) {
  if (!v) return v;
  let s = String(v);
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (/^https?:\/\//i.test(s)) {
    let ru;
    try {
      ru = new URL(s);
    } catch {
      return v;
    }
    if (ru.host === ORIGIN_HOST) return s;
    if (selfHost && ru.host.toLowerCase() === selfHost) {
      return ORIGIN + ru.pathname + ru.search + ru.hash;
    }
    return s;
  }
  if (s.startsWith('/')) return ORIGIN + s;
  return v;
}

function rewriteRedirectInUrl(u, selfHost) {
  const v = u.searchParams.get('redirect_uri');
  if (!v) return null;
  const f = fixRedirectUri(v, selfHost);
  if (f === v) return null;
  u.searchParams.set('redirect_uri', f);
  return f;
}

function rewriteRedirectInForm(s, selfHost) {
  let changed = false;
  const out = s.replace(/(^|&)redirect_uri=([^&]*)/g, (m, pre, val) => {
    let dec;
    try {
      dec = decodeURIComponent(val.replace(/\+/g, ' '));
    } catch {
      return m;
    }
    const f = fixRedirectUri(dec, selfHost);
    if (f === dec) return m;
    changed = true;
    return pre + 'redirect_uri=' + encodeURIComponent(f);
  });
  return changed ? out : null;
}

function rewriteHtml(html, base) {
  const $ = cheerio.load(html);

  let effBase = base;
  const baseAttr = $('base[href]').attr('href');
  if (baseAttr) {
    try {
      effBase = new URL(baseAttr, base).href;
    } catch {}
    $('base[href]').attr('href', mapUrl(baseAttr, base));
  }

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
      $(el).attr(attr, mapUrl(v, effBase));
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
          return mapUrl(u, effBase) + (d ? ' ' + d : '');
        })
        .join(', ')
    );
  });

  $('meta[http-equiv="refresh"]').each((_, el) => {
    const c = $(el).attr('content');
    if (!c) return;
    const m = c.match(/url\s*=\s*(.+)$/i);
    if (m) $(el).attr('content', c.replace(m[1], mapUrl(m[1].trim(), effBase)));
  });

  $('script[integrity], link[integrity]').removeAttr('integrity');
  $('*[crossorigin]').removeAttr('crossorigin');

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

// OAuth 戻り先ページの置き換え（opener / sessionStorage に依存しない実装）
const REDIRECT_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>GeForce NOW</title>
<style>body{background:#1a1a1a;color:#ccc;font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body><div>認証中...</div>
<script>
(function () {
  function norm(x) {
    try {
      var a = new URL(x, location.href);
      if (a.origin === location.origin) return a.pathname + a.search + a.hash;
      return '/__p/' + a.href;
    } catch (e) { return x; }
  }
  var u = new URL(location.href);
  var oauthUrl = u.searchParams.get('oauth_url');
  var state = u.searchParams.get('state');

  if (oauthUrl && state) {
    try { sessionStorage.setItem('oauth_nonce_session', state); } catch (e) {}
    location.replace(norm(oauthUrl));
    return;
  }

  var data = {};
  u.searchParams.forEach(function (v, k) { data[k] = v; });

  var ret = '/mall/#/loginwall';
  try {
    var raw = sessionStorage.getItem('GfnOauthUrlData');
    if (raw) {
      var o = JSON.parse(raw);
      if (o && o.returnUrl) ret = norm(o.returnUrl);
    }
  } catch (e) {}
  if (data.state) {
    try {
      var st = decodeURIComponent(data.state);
      if (st && st.charAt(0) === '/') ret = st;
    } catch (e) {}
  }

  try { localStorage.setItem('oauth', JSON.stringify({ data: data })); } catch (e) {}

  location.replace(ret);
})();
</script></body></html>`;

const SHIM = `(function () {
  if (window.__GFN_SHIM__) return;
  window.__GFN_SHIM__ = true;
  var P = ${JSON.stringify(PREFIX)};
  var OH = ${JSON.stringify(ORIGIN_HOST)};
  var BLOCK = new RegExp(${JSON.stringify(BLOCK_RE.source)}, 'i');
  var LKEY = '__gfnLog';

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
    if (s.indexOf('/__') === 0) return s;
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

  var box = null, list = null, lines = [], count = 0;

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function saveLog() { try { localStorage.setItem(LKEY, JSON.stringify(lines.slice(-200))); } catch (e) {} }
  function restoreLog() {
    try {
      var v = JSON.parse(localStorage.getItem(LKEY) || '[]');
      if (v && v.length) lines = v;
    } catch (e) {}
  }

  function mkBtn(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:inherit;color:#0f0;background:#022;border:1px solid #0f0;border-radius:4px;padding:1px 7px;cursor:pointer';
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b); });
    return b;
  }

  function copyText(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function copyAll(b) {
    var text = lines.join('\\n');
    var flash = function (ok) {
      b.textContent = ok ? 'COPIED' : 'FAILED';
      setTimeout(function () { b.textContent = 'COPY'; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { flash(true); },
        function () { flash(copyText(text)); }
      );
    } else {
      flash(copyText(text));
    }
  }

  function runClear(b) {
    b.textContent = 'RUNNING';
    fetch('/__clearcookies')
      .then(function (r) { return r.text(); })
      .then(function (t) { log('clearcookies', '', t.trim()); })
      .catch(function (e) { log('clearcookies', '', 'ERR ' + e.message); })
      .then(function () { b.textContent = 'CLR'; });
  }

  function runLogin(b) {
    b.textContent = 'RUNNING';
    fetch('/__loginflow')
      .then(function (r) { return r.text(); })
      .then(function (t) { log('loginflow', '', '\\n  ' + t.replace(/\\n/g, '\\n  ')); })
      .catch(function (e) { log('loginflow', '', 'ERR ' + e.message); })
      .then(function () { b.textContent = 'LOGIN'; });
  }

  function overlay() {
    if (box) return box;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;right:8px;bottom:8px;width:min(620px,92vw);max-height:48vh;display:flex;flex-direction:column;background:#000e;color:#0f0;font:11px/1.45 monospace;border:1px solid #0f0;border-radius:6px;overflow:hidden';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:6px;align-items:center;padding:5px 7px;border-bottom:1px solid #0f066;background:#011';

    var title = document.createElement('span');
    title.textContent = 'GFN PROXY LOG';
    title.style.cssText = 'flex:1;font-weight:bold;letter-spacing:.5px';

    head.appendChild(title);
    head.appendChild(mkBtn('LOGIN', runLogin));
    head.appendChild(mkBtn('CLR', runClear));
    head.appendChild(mkBtn('COPY', copyAll));
    head.appendChild(mkBtn('CLEAR', function () { lines = []; saveLog(); if (list) list.textContent = ''; }));
    head.appendChild(mkBtn('CLOSE', function () {
      store('gfnDebug', '0');
      box.remove();
      box = null;
      list = null;
    }));

    list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow:auto;padding:6px 7px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text';

    box.appendChild(head);
    box.appendChild(list);
    document.documentElement.appendChild(box);

    if (lines.length === 0) list.textContent = '(まだ通信ログはありません)';
    for (var i = 0; i < lines.length; i++) {
      var d = document.createElement('div');
      d.textContent = lines[i];
      list.appendChild(d);
    }
    list.scrollTop = list.scrollHeight;
    return box;
  }

  function log(kind, url, extra) {
    var line = '[' + kind + '] ' + (extra || '') + ' ' + String(url);
    console.warn('GFN-PROXY', line);
    if (count++ > 400) return;
    if (lines.length === 0 && list) list.textContent = '';
    lines.push(line);
    saveLog();
    if (!box) return;
    var d = document.createElement('div');
    d.textContent = line;
    list.appendChild(d);
    list.scrollTop = list.scrollHeight;
  }

  function ref() { try { return base(); } catch (e) { return ''; } }

  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) log('res', t.src || t.href, 'FAIL');
    else if (e && e.message) log('err', '', e.message);
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    log('rej', '', (r && (r.message || r)) || 'unknown');
  });

  try {
    var lp = window.Location && window.Location.prototype;
    if (lp) {
      var oAssign = lp.assign;
      var oReplace = lp.replace;
      if (oAssign) lp.assign = function (u) { log('nav', u, 'assign'); return oAssign.call(this, map(u)); };
      if (oReplace) lp.replace = function (u) { log('nav', u, 'replace'); return oReplace.call(this, map(u)); };

      var hd = Object.getOwnPropertyDescriptor(lp, 'href');
      if (hd && hd.set && hd.get) {
        Object.defineProperty(lp, 'href', {
          configurable: true,
          enumerable: hd.enumerable,
          get: function () { return hd.get.call(this); },
          set: function (v) { log('nav', v, 'href'); hd.set.call(this, map(v)); }
        });
      }
    }
  } catch (e) {}

  var oo = window.open;
  window.open = function () {
    var a = [].slice.call(arguments);
    if (a.length && a[0]) a[0] = map(a[0]);
    log('open', a[0], a[1] || '');
    return oo.apply(window, a);
  };

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

  var xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try { if (!this.__refset) { this.__refset = 1; this.setRequestHeader('x-gfn-ref', ref()); } } catch (e) {}
    return xs.apply(this, arguments);
  };

  var os = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'x-gfn-ref') this.__refset = 1;
    return os.call(this, k, v);
  };

  var OWS = window.WebSocket;
  function WSP(url, protocols) {
    var mapped = map(url);
    var ws = protocols === undefined ? new OWS(mapped) : new OWS(mapped, protocols);
    ws.addEventListener('error', function () { log('ws', mapped, 'ERR'); });
    ws.addEventListener('open', function () { log('ws', mapped, 'OPEN'); });
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

  if (navigator.sendBeacon) {
    var ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return ob(map(u), d); };
  }

  var want = load('gfnDebug');
  if (/[?&]debug=0/.test(location.href)) { want = '0'; store('gfnDebug', '0'); }
  else if (/[?&]debug=1/.test(location.href)) { want = '1'; store('gfnDebug', '1'); }
  if (want === null) want = '1';

  function keys(o) {
    try {
      var a = [];
      for (var i = 0; i < o.length; i++) a.push(o.key(i));
      return a.join(',');
    } catch (e) { return '?'; }
  }

  function boot() {
    restoreLog();
    if (want !== '0') overlay();
    log('init', window.__GFN_DOC__ || location.href, 'shim active');
    log('diag', location.pathname, 'ss=[' + keys(sessionStorage) + '] ls=[' + keys(localStorage) + ']');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();`;

const LOG = [];
function pushLog(o) {
  LOG.push(o);
  if (LOG.length > 400) LOG.shift();
}

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

function toRealReferer(v) {
  if (!v) return ORIGIN + '/';
  try {
    const u = new URL(v);
    if (u.pathname.startsWith(PREFIX)) {
      const t = normalizeTarget(u.pathname.slice(PREFIX.length) + u.search, u.host);
      if (t) return t.href;
    }
    return ORIGIN + u.pathname + u.search;
  } catch {
    return ORIGIN + '/';
  }
}

function decodeBody(buf, enc) {
  const e = String(enc || '').toLowerCase();
  if (e === 'gzip') return zlib.gunzipSync(buf);
  if (e === 'br') return zlib.brotliDecompressSync(buf);
  if (e === 'deflate') return zlib.inflateSync(buf);
  return buf;
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

const proxyCache = new Map();

function proxyFor(origin) {
  if (proxyCache.has(origin)) return proxyCache.get(origin);

  const targetHost = new URL(origin).host;
  const isMainHost = targetHost === ORIGIN_HOST;

  const mw = createProxyMiddleware({
    target: origin,
    pathFilter: () => true,
    changeOrigin: true,
    ws: true,
    secure: true,
    selfHandleResponse: true,
    proxyTimeout: 180000,
    timeout: 180000,

    pathRewrite: (p, req) => req.__path || p,

    onProxyReq(proxyReq, req) {
      for (const k of [
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-forwarded-port',
        'forwarded',
        'true-client-ip',
        'cf-connecting-ip',
        'x-real-ip',
      ]) {
        proxyReq.removeHeader(k);
      }
      proxyReq.setHeader('host', targetHost);
      proxyReq.setHeader('accept-encoding', 'gzip, deflate, br');
      proxyReq.setHeader('origin', ORIGIN);
      proxyReq.setHeader('referer', toRealReferer(req.headers['x-gfn-ref'] || req.headers.referer));
      proxyReq.removeHeader('x-gfn-ref');
      proxyReq.removeHeader('if-none-match');
      proxyReq.removeHeader('if-modified-since');

      if (req.__bodySet) {
        proxyReq.removeHeader('transfer-encoding');
        proxyReq.setHeader('content-length', String(req.__body.length));
        proxyReq.write(req.__body);
        proxyReq.end();
      }

      pushLog({ t: Date.now(), sent: `${req.method} https://${targetHost}${req.__path}` });
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

      const cookiePath = isMainHost ? '/' : PREFIX + origin + '/';
      if (h['set-cookie']) {
        const arr = Array.isArray(h['set-cookie']) ? h['set-cookie'] : [h['set-cookie']];
        h['set-cookie'] = arr.map((c) => {
          let out = String(c).replace(/;\s*domain=[^;]*/gi, '');
          if (/;\s*path=/i.test(out)) out = out.replace(/;\s*path=[^;]*/gi, '; Path=' + cookiePath);
          else out += '; Path=' + cookiePath;
          return out;
        });
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
        const raw = Buffer.concat(chunks);
        let text;
        try {
          text = decodeBody(raw, h['content-encoding']).toString('utf8');
        } catch {
          delete h['transfer-encoding'];
          res.writeHead(status, h);
          return res.end(raw);
        }

        let body = text;
        try {
          body = isHtml
            ? rewriteHtml(text, req.__target || ORIGIN)
            : rewriteCss(text, req.__target || ORIGIN);
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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function probeOnce(url, method, body, headers) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ error: 'bad url' });
    }
    const r = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        timeout: 20000,
        headers,
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          let b = Buffer.concat(chunks);
          try {
            b = decodeBody(b, resp.headers['content-encoding']);
          } catch {}
          const keep = {};
          for (const k of Object.keys(resp.headers)) {
            if (/^(server|via|x-cache|x-amz|akamai|cf-|x-akamai|x-served|x-nv|content-type|location)/i.test(k))
              keep[k] = resp.headers[k];
          }
          resolve({ status: resp.statusCode, headers: keep, body: b.toString('utf8').slice(0, 300) });
        });
      }
    );
    r.on('error', (e) => resolve({ error: e.message }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ error: 'timeout' });
    });
    if (body) r.write(body);
    r.end();
  });
}

function fetchText(url, limit) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ error: 'bad url' });
    }
    const r = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 20000,
        headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'ja,en;q=0.8' },
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          let b = Buffer.concat(chunks);
          try {
            b = decodeBody(b, resp.headers['content-encoding']);
          } catch {}
          resolve({
            status: resp.statusCode,
            ct: resp.headers['content-type'],
            body: b.toString('utf8').slice(0, limit || 8000),
          });
        });
      }
    );
    r.on('error', (e) => resolve({ error: e.message }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ error: 'timeout' });
    });
    r.end();
  });
}

function probeH2(url, method, body, headers) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ error: 'bad url' });
    }
    const c = http2.connect(u.origin);
    const done = (v) => {
      try {
        c.close();
      } catch {}
      resolve(v);
    };
    c.on('error', (e) => done({ error: e.message }));
    c.on('connect', () => {
      const r = c.request({
        ':method': method,
        ':path': u.pathname + u.search,
        ':authority': u.host,
        ':scheme': 'https',
        ...headers,
      });
      let status = null;
      let hdrs = {};
      const chunks = [];
      r.on('response', (h) => {
        status = h[':status'];
        hdrs = h;
      });
      r.on('data', (d) => chunks.push(d));
      r.on('end', () =>
        done({ status, headers: hdrs, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) })
      );
      r.on('error', (e) => done({ error: e.message }));
      if (body) r.write(body);
      r.end();
    });
  });
}

function probeLocal(path, headers) {
  return new Promise((resolve) => {
    const r = http.request(
      { hostname: '127.0.0.1', port: PORT, path, method: 'GET', timeout: 20000, headers },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () =>
          resolve({
            status: resp.statusCode,
            contentType: resp.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8').slice(0, 250),
          })
        );
      }
    );
    r.on('error', (e) => resolve({ error: e.message }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ error: 'timeout' });
    });
    r.end();
  });
}

const REDIRECT_PATHS = [
  '/redirect/starfleet-oauth-redirect.html',
  '/redirect/starfleet-oauth-redirect-login.html',
  '/redirect/gfn-jarvis-oauth-redirect.html',
];

const REDIR_CANDIDATES = [
  'https://play.geforcenow.com/redirect/starfleet-oauth-redirect.html',
  'https://play.geforcenow.com/redirect/starfleet-oauth-redirect-login.html',
  'https://play.geforcenow.com/callback/redirect',
];

const STARFLEET_CLIENT = 'W1Z7DwzG1dcpXFxv0pmeatjnf0uK3ICySganqdMx2nU';
const IDP_ID = 'PDiAhv2kJTFeQ7WOPqiQ2tRZ7lGhR2X11dXvM4TZSxg';
const COOKIE_HOSTS = [
  'play.geforcenow.com',
  'login.nvidia.com',
  'login.nvgs.nvidia.com',
  'accounts.nvgs.nvidia.com',
  'accounts.nvidia.com',
];

function loginUrl(redirectUri, deviceId) {
  const p = new URLSearchParams({
    response_type: 'code',
    device_id: deviceId || '00000000-0000-4000-8000-000000000000',
    scope: 'openid consent email tk_client age',
    client_id: STARFLEET_CLIENT,
    redirect_uri: redirectUri,
    ui_locales: 'ja_JP',
    nonce: 'probe-nonce-0001',
    prompt: 'select_account',
    code_challenge: 'VJhJYHcNs4_IW7BHKji-UrEMfDv_Ar2-4fbDpcBJBls',
    code_challenge_method: 'S256',
    idp_id: IDP_ID,
  });
  return 'https://login.nvidia.com/authorize?' + p.toString();
}

function followChain(url, headers, maxHops) {
  return new Promise((resolve) => {
    const hops = [];
    let cur = url;
    (async () => {
      for (let i = 0; i < (maxHops || 6); i++) {
        const p = await probeOnce(cur, 'GET', null, headers);
        hops.push({ status: p.status || 0, url: cur.slice(0, 200) });
        const loc = p.headers && p.headers.location;
        if (!loc || [301, 302, 303, 307, 308].indexOf(p.status) === -1) break;
        try {
          cur = new URL(loc, cur).href;
        } catch {
          break;
        }
      }
      const last = hops.length ? hops[hops.length - 1].url : '';
      resolve({ hops, ok: !/\/v1\/error/.test(last) });
    })();
  });
}

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.set('trust proxy', true);

if (process.env.BASIC_USER && process.env.BASIC_PASS) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/__')) return next();
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
  res.send(JSON.stringify(LOG.slice(-80), null, 2));
});

app.get('/__shim.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.send(SHIM);
});

app.get('/__get', async (req, res) => {
  const selfHost = String(req.headers.host || '').toLowerCase();
  const t = normalizeTarget(String(req.query.u || ''), selfHost);
  if (!t) return res.status(400).type('text/plain').send('bad u');
  const p = await fetchText(t.href, Number(req.query.n || 8000));
  res.type('text/plain; charset=utf-8');
  res.send('STATUS ' + p.status + '  CT ' + p.ct + '\n\n' + (p.body || p.error || ''));
});

app.get('/__clearcookies', (req, res) => {
  const raw = String(req.headers.cookie || '');
  const names = raw
    .split(';')
    .map((c) => c.split('=')[0].trim())
    .filter(Boolean);
  const out = [];
  for (const n of names) {
    out.push(`${n}=; Path=/; Max-Age=0`);
    for (const h of COOKIE_HOSTS) out.push(`${n}=; Path=${PREFIX}https://${h}/; Max-Age=0`);
  }
  if (out.length) res.setHeader('set-cookie', out);
  res.type('text/plain');
  res.send('cleared ' + names.length + ' cookie(s)');
});

app.get('/__selftest', async (req, res) => {
  const r = await probeOnce(ORIGIN + '/mall/', 'GET', null, {
    'user-agent': UA,
    accept: 'text/html',
  });
  const body = r.body || '';
  res.type('application/json');
  res.send(
    JSON.stringify(
      {
        originStatus: r.status,
        shimTagPresent: body.includes('/__shim.js'),
        docVarPresent: body.includes('__GFN_DOC__'),
      },
      null,
      2
    )
  );
});

app.get('/__proxytest', async (req, res) => {
  const u = String(req.query.u || 'https://pcs.geforcenow.com/v1/serviceUrls');
  const r = await probeLocal('/__p/' + u, { accept: '*/*', 'user-agent': UA });
  res.type('application/json');
  res.send(JSON.stringify({ url: u, result: r, recent: LOG.slice(-6) }, null, 2));
});

app.get('/__loginflow', async (req, res) => {
  const dev = req.query.d ? String(req.query.d) : null;
  const headerSets = {
    as_proxy: { 'user-agent': UA, origin: ORIGIN, referer: ORIGIN + '/mall/' },
    bare: { 'user-agent': UA },
  };
  const out = [];
  for (const [name, h] of Object.entries(headerSets)) {
    for (const r of REDIR_CANDIDATES) {
      const c = await followChain(loginUrl(r, dev), h, 6);
      out.push({ headers: name, redirect_uri: r, ok: c.ok, hops: c.hops });
    }
  }
  res.type('application/json');
  res.send(JSON.stringify({ out }, null, 2));
});

app.get('/__probe', async (req, res) => {
  const selfHost = String(req.headers.host || '').toLowerCase();
  const t = normalizeTarget(String(req.query.u || ''), selfHost);
  if (!t) return res.status(400).type('text/plain').send('bad u');
  const method = String(req.query.m || 'GET').toUpperCase();
  const body = req.query.b ? String(req.query.b) : null;

  const base = { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9' };
  const browserish = {
    ...base,
    host: t.host,
    origin: ORIGIN,
    referer: ORIGIN + '/',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };

  const out = {};
  out.A_bare = await probeOnce(t.href, method, body, { ...base, host: t.host });
  out.B_browserish = await probeOnce(t.href, method, body, { ...browserish });
  out.D_http2 = await probeH2(t.href, method, body, { ...browserish });

  res.type('application/json');
  res.send(JSON.stringify({ target: t.href, method, out }, null, 2));
});

// 自前の戻り先ページ
app.get(REDIRECT_PATHS, (req, res) => {
  res.type('text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.send(REDIRECT_HTML);
});

async function prepare(req, target) {
  const selfHost = String(req.headers.host || '').toLowerCase();
  const fixed = rewriteRedirectInUrl(target, selfHost);
  if (fixed) pushLog({ t: Date.now(), redirectFixed: fixed, url: target.href });

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const len = Number(req.headers['content-length'] || 0);
  if (
    (req.method === 'POST' || req.method === 'PUT') &&
    ct.includes('x-www-form-urlencoded') &&
    len > 0 &&
    len <= MAX_BODY
  ) {
    const buf = await readAll(req);
    const s = buf.toString('utf8');
    const ns = rewriteRedirectInForm(s, selfHost);
    req.__body = Buffer.from(ns === null ? s : ns, 'utf8');
    req.__bodySet = true;
    if (ns !== null) pushLog({ t: Date.now(), redirectFixedBody: target.href });
  }
}

app.use(PREFIX, async (req, res, next) => {
  const selfHost = String(req.headers.host || '').toLowerCase();
  const target = normalizeTarget(req.originalUrl.slice(PREFIX.length), selfHost);
  if (!target) return res.status(400).type('text/plain').send('Bad URL');
  if (!shouldProxy(target.href)) return res.status(403).type('text/plain').send('Not proxied: ' + target.host);

  try {
    await prepare(req, target);
  } catch {}

  req.__target = target.href;
  req.__path = target.pathname + target.search;
  req.url = req.__path;

  return proxyFor(target.origin)(req, res, () => {
    pushLog({ t: Date.now(), fellThrough: req.__target });
    return proxyFor(ORIGIN)(req, res, () => res.status(502).type('text/plain').send('no handler'));
  });
});

app.use(async (req, res, next) => {
  const target = new URL(ORIGIN + req.originalUrl);
  try {
    await prepare(req, target);
  } catch {}

  req.__target = target.href;
  req.__path = target.pathname + target.search;
  return proxyFor(ORIGIN)(req, res, () => res.status(502).type('text/plain').send('no handler'));
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const selfHost = String(req.headers.host || '').toLowerCase();
  let target;
  if (req.url.startsWith(PREFIX)) {
    target = normalizeTarget(req.url.slice(PREFIX.length), selfHost);
    if (!target) return socket.destroy();
    req.__path = target.pathname + target.search;
    req.url = req.__path;
  } else {
    target = new URL(req.url, ORIGIN);
    req.__path = target.pathname + target.search;
  }
  if (!shouldProxy(target.href)) return socket.destroy();
  req.__target = target.href;
  proxyFor(target.origin).upgrade(req, socket, head);
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
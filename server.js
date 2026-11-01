'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 8080;
const ORIGIN = 'https://play.geforcenow.com';
const PREFIX = '/__p/';
const REDIRECT_PATH = '/redirect/starfleet-oauth-redirect.html';
const REDIRECT_PATHS = [
  '/redirect/starfleet-oauth-redirect.html',
  '/redirect/starfleet-oauth-redirect-login.html',
  '/redirect/gfn-jarvis-oauth-redirect.html',
];

const BLOCK = /(^|\.)(doubleclick\.net|googletagmanager\.com|google-analytics\.com)$/i;
const AUTH_RE = /(^|\.)(accounts\.nvgs\.nvidia\.com|login\.nvidia\.com|login\.nvgs\.nvidia\.com)$/i;

const SKIP_PREFIX = ['data:', 'blob:', 'javascript:', 'mailto:', 'about:', 'tel:', 'chrome-extension:'];

function isAllowed(abs) {
  try {
    const u = new URL(abs);
    if (u.protocol !== 'https:') return false;
    return !BLOCK.test(u.hostname);
  } catch {
    return false;
  }
}

function selfHostOf(req) {
  return String(req.headers.host || '').toLowerCase();
}

/* ---------------- URL 変換 ---------------- */

function mapUrl(u, base) {
  if (u == null) return u;
  const s = String(u).trim();
  if (!s) return u;
  const low = s.toLowerCase();
  for (const p of SKIP_PREFIX) if (low.startsWith(p)) return u;
  if (s.startsWith('#')) return u;

  let abs;
  try {
    abs = new URL(s, base);
  } catch {
    return u;
  }
  if (abs.protocol !== 'https:') return u;
  if (BLOCK.test(abs.hostname)) return u;

  // すでにプロキシ経由のパスならそのまま
  if (abs.origin === base && abs.pathname.startsWith(PREFIX)) {
    return abs.pathname + abs.search + abs.hash;
  }
  return PREFIX + abs.href;
}

function mapLocation(loc, target) {
  try {
    const abs = new URL(loc, target);
    if (abs.protocol !== 'https:') return loc;
    return PREFIX + abs.href;
  } catch {
    return loc;
  }
}

function fixCookie(host) {
  return (c) =>
    String(c)
      .replace(/;\s*domain=[^;]*/gi, '')
      .replace(/;\s*path=[^;]*/gi, '')
      .replace(/;\s*partitioned/gi, '') + '; Path=' + PREFIX + 'https://' + host + '/';
}

function fixRedirectUri(str, selfHost) {
  if (!selfHost) return str;
  return str.replace(/(redirect_uri=)([^&"'\s<>]+)/gi, (m, p, v) => {
    let d = v;
    try {
      d = decodeURIComponent(v);
    } catch {
      /* keep */
    }
    try {
      const u = new URL(d);
      if (u.host.toLowerCase() === selfHost) {
        return p + encodeURIComponent(ORIGIN + REDIRECT_PATH);
      }
    } catch {
      /* keep */
    }
    return m;
  });
}

/* ---------------- HTML / CSS 書き換え ---------------- */

const ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'data-src', 'data-href'];

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => 'url(' + q + mapUrl(u, base) + q + ')')
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => '@import ' + q + mapUrl(u, base) + q);
}

function rewriteHtml(html, docUrl, req) {
  const selfHost = selfHostOf(req);
  const $ = cheerio.load(html, { decodeEntities: false });

  let effBase = docUrl;
  const bHref = $('base[href]').attr('href');
  if (bHref) {
    try {
      effBase = new URL(bHref, docUrl).href;
    } catch {
      /* keep */
    }
    $('base[href]').attr('href', mapUrl(bHref, docUrl));
  }

  for (const a of ATTRS) {
    $(`[${a}]`).each((_, el) => {
      const v = $(el).attr(a);
      if (v != null) $(el).attr(a, mapUrl(v, effBase));
    });
  }

  $('[srcset]').each((_, el) => {
    const v = $(el).attr('srcset');
    if (!v) return;
    $(el).attr(
      'srcset',
      v
        .split(',')
        .map((part) => {
          const t = part.trim();
          if (!t) return t;
          const i = t.search(/\s/);
          const u = i < 0 ? t : t.slice(0, i);
          const d = i < 0 ? '' : t.slice(i);
          return mapUrl(u, effBase) + d;
        })
        .join(', ')
    );
  });

  $('style').each((_, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css, effBase));
  });

  $('[style]').each((_, el) => {
    const v = $(el).attr('style');
    if (v) $(el).attr('style', rewriteCss(v, effBase));
  });

  $('meta[http-equiv="refresh"]').each((_, el) => {
    const c = $(el).attr('content');
    if (!c) return;
    const m = c.match(/url\s*=\s*(.+)$/i);
    if (m) $(el).attr('content', c.replace(m[1], mapUrl(m[1].trim(), effBase)));
  });

  $('script[integrity], link[integrity]').removeAttr('integrity');
  $('*[crossorigin]').removeAttr('crossorigin');
  $('meta[property^="og:url"]').each((_, el) => {
    const v = $(el).attr('content');
    if (v) $(el).attr('content', mapUrl(v, effBase));
  });

  // redirect_uri の補正（プロキシ自身のホストを指している場合のみ）
  $('script').each((_, el) => {
    const s = $(el).html();
    if (s && s.indexOf('redirect_uri') >= 0) $(el).html(fixRedirectUri(s, selfHost));
  });

  $('head').prepend(
    `<script>window.__GFN_DOC__=${JSON.stringify(docUrl)};window.__GFN_SELF__=${JSON.stringify(selfHost)};</script>` +
      '<script src="/__shim.js"></script>'
  );

  return $.html();
}

/* ---------------- クライアントシム ---------------- */

const SHIM = String.raw`(function () {
  if (window.__GFN_PROXY_SHIM__) return;
  window.__GFN_PROXY_SHIM__ = true;

  var P = '/__p/';
  var DOC = window.__GFN_DOC__ || location.href;
  var SELF = window.__GFN_SELF__ || location.host;
  var AUTH = /(^|\.)(accounts\.nvgs\.nvidia\.com|login\.nvidia\.com|login\.nvgs\.nvidia\.com)$/i;
  var WATCH = /(^|\.)(accounts\.nvgs\.nvidia\.com|login\.nvidia\.com|login\.nvgs\.nvidia\.com|play\.geforcenow\.com|pcs\.geforcenow\.com)$/i;

  /* ---- ログ ---- */
  var ON = localStorage.getItem('gfnDebug') !== '0';
  var lines = [];
  try { lines = JSON.parse(localStorage.getItem('gfnLog') || '[]'); } catch (e) { lines = []; }
  var box, bodyEl;

  function paint() {
    if (!ON) return;
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;right:8px;bottom:8px;width:min(560px,94vw);max-height:46vh;background:rgba(8,10,14,.94);color:#b9f6ca;font:11px/1.4 ui-monospace,monospace;border:1px solid #2e7d32;border-radius:8px;z-index:2147483647;display:flex;flex-direction:column;box-shadow:0 8px 24px rgba(0,0,0,.5)';
      var head = document.createElement('div');
      head.style.cssText = 'display:flex;gap:6px;align-items:center;padding:5px 6px;border-bottom:1px solid #2e7d32;color:#e8f5e9;font-weight:700';
      var t = document.createElement('span');
      t.textContent = 'GFN LOG';
      t.style.flex = '1';
      head.appendChild(t);
      var mk = function (label, fn) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'background:#1b5e20;color:#e8f5e9;border:0;border-radius:4px;padding:2px 7px;font:11px ui-monospace,monospace;cursor:pointer';
        b.onclick = fn;
        head.appendChild(b);
        return b;
      };
      var cp = mk('COPY', copyAll);
      mk('CLEAR', function () { lines = []; localStorage.setItem('gfnLog', '[]'); if (bodyEl) bodyEl.textContent = ''; });
      mk('CLOSE', function () { box.remove(); box = null; });
      bodyEl = document.createElement('div');
      bodyEl.style.cssText = 'overflow:auto;padding:5px 6px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text';
      box.appendChild(head);
      box.appendChild(bodyEl);
      document.body.appendChild(box);

      function copyAll() {
        var text = lines.join('\n');
        var done = function (ok) { cp.textContent = ok ? 'COPIED' : 'FAIL'; setTimeout(function () { cp.textContent = 'COPY'; }, 1200); };
        var fb = function () {
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            ta.remove();
            return ok;
          } catch (e) { return false; }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fb()); });
        } else done(fb());
      }
    }
    bodyEl.textContent = lines.join('\n');
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function log(s) {
    var d = new Date();
    var stamp = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    lines.push(stamp + ' ' + s);
    if (lines.length > 400) lines = lines.slice(-400);
    try { localStorage.setItem('gfnLog', JSON.stringify(lines)); } catch (e) {}
    if (ON) { try { paint(); } catch (e) {} }
  }
  window.__gfnLog = log;
  if (document.body) paint();
  else document.addEventListener('DOMContentLoaded', paint);

  /* ---- URL 正規化 ---- */
  function norm(x) {
    try {
      var a = new URL(String(x), document.baseURI || location.href);
      if (a.origin === location.origin) return a.pathname + a.search + a.hash;
      if (a.protocol === 'https:') return P + a.href;
      return a.href;
    } catch (e) { return x; }
  }
  function hostOf(x) {
    try { return new URL(String(x), location.href).hostname; } catch (e) { return ''; }
  }
  function watch(x) { return AUTH.test(hostOf(x)); }

  /* ---- レスポンス観察 ---- */
  function observe(label, url, status, headers, body) {
    if (!watch(url)) return;
    var loc = '';
    try { loc = (headers && headers.get && headers.get('location')) || ''; } catch (e) {}
    var head = '[' + label + '] ' + status + ' ' + String(url).slice(0, 160);
    if (loc) head += ' LOC=' + String(loc).slice(0, 200);
    if (body) head += ' BODY=' + String(body).slice(0, 300).replace(/\s+/g, ' ');
    log(head);
  }

  /* ---- fetch ---- */
  var of = window.fetch;
  if (of) {
    window.fetch = function (input, init) {
      try {
        var isReq = input && typeof input === 'object' && input.url;
        var url = isReq ? input.url : String(input);
        var t = norm(url);
        if (AUTH.test(hostOf(url))) log('sent ' + String(url).slice(0, 200));
        var p;
        if (isReq) p = of.call(this, new Request(t, input), init);
        else p = of.call(this, t, init);
        return p.then(function (res) {
          if (watch(url)) {
            try {
              res.clone().text().then(function (b) { observe('fetch', url, res.status, res.headers, b); }, function () {
                observe('fetch', url, res.status, res.headers, '');
              });
            } catch (e) { observe('fetch', url, res.status, res.headers, ''); }
          }
          return res;
        });
      } catch (e) {
        return of.apply(this, arguments);
      }
    };
  }

  /* ---- XHR ---- */
  var xo = XMLHttpRequest.prototype.open;
  var xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__u = String(u);
    this.__t = norm(u);
    if (AUTH.test(hostOf(u))) log('sent ' + String(u).slice(0, 200));
    var a = Array.prototype.slice.call(arguments);
    a[1] = this.__t;
    return xo.apply(this, a);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener('loadend', function () {
      var st = 0;
      try { st = self.status; } catch (e) {}
      if (st >= 400 && watch(self.__u)) log('[xhr] ' + st + ' ' + String(self.__u).slice(0, 160));
      if (watch(self.__u)) {
        var b = '';
        try { if (self.responseType === '' || self.responseType === 'text') b = (self.responseText || '').slice(0, 300); } catch (e) {}
        observe('xhr', self.__u, st, null, b);
      }
    });
    return xs.apply(this, arguments);
  };

  /* ---- WebSocket ---- */
  var OW = window.WebSocket;
  if (OW) {
    window.WebSocket = function (u, p) {
      var t = norm(u).replace(/^\/__p\//, '');
      log('ws ' + String(u).slice(0, 160));
      return p === undefined ? new OW(t) : new OW(t, p);
    };
    window.WebSocket.prototype = OW.prototype;
  }

  /* ---- window.open ---- */
  var oo = window.open;
  window.open = function (u) {
    var a = Array.prototype.slice.call(arguments);
    if (u) { a[0] = norm(u); log('open ' + String(u).slice(0, 160)); }
    return oo.apply(window, a);
  };

  /* ---- Location ---- */
  var d = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
  if (d && d.set) {
    Object.defineProperty(Location.prototype, 'href', {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function (v) {
        var t = norm(v);
        if (String(t) !== String(v)) log('nav ' + String(v).slice(0, 160));
        return d.set.call(this, t);
      },
    });
  }
  ['assign', 'replace'].forEach(function (k) {
    var f = Location.prototype[k];
    if (!f) return;
    Location.prototype[k] = function (v) {
      var t = norm(v);
      if (String(t) !== String(v)) log('nav(' + k + ') ' + String(v).slice(0, 160));
      return f.call(this, t);
    };
  });

  /* window.location = url 形式（href セッターを通らない） */
  try {
    var loc = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      get: function () { return loc; },
      set: function (v) {
        var t = norm(v);
        log('nav(loc) ' + String(v).slice(0, 160));
        d && d.set ? d.set.call(loc, t) : (loc.href = t);
      },
    });
  } catch (e) {}

  /* ---- form / a ---- */
  var fsub = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    try { if (this.action) this.action = norm(this.action); } catch (e) {}
    return fsub.apply(this, arguments);
  };
  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (f && f.action) { try { f.action = norm(f.action); } catch (e) {} }
  }, true);
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var h = a.getAttribute('href');
    if (!h || h.charAt(0) === '#' || a.target === '_blank') return;
    var host = hostOf(h);
    if (!host || host === location.hostname) return;
    ev.preventDefault();
    location.href = h;
  }, true);

  /* ---- 認証情報の後始末 ---- */
  try {
    var q = new URL(location.href);
    if (/\/loginwall/.test(q.hash) && q.searchParams.get('code')) log('code=' + q.searchParams.get('code').slice(0, 12) + '...');
  } catch (e) {}
})();`;

/* ---------------- 戻り先ページ ---------------- */

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

  try {
    localStorage.setItem('oauth', JSON.stringify({ data: data, t: Date.now() }));
  } catch (e) {}
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'gfn-oauth', data: data }, '*');
    }
  } catch (e) {}

  location.replace(ret);
})();
</script></body></html>`;

/* ---------------- プロキシ ---------------- */

const proxyCache = new Map();

function decodeBody(buf, enc) {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf).toString('utf8');
    if (enc === 'deflate') return zlib.inflateSync(buf).toString('utf8');
    if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
  } catch {
    /* fall through */
  }
  return buf.toString('utf8');
}

function refetchStringtable(target, req) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(target);
    } catch {
      return resolve(null);
    }
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': req.headers['accept-language'] || 'ja-JP,ja;q=0.9',
      referer: 'https://accounts.nvgs.nvidia.com/',
      origin: 'https://accounts.nvgs.nvidia.com',
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
      cookie: req.headers.cookie || '',
    };
    const r = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })
        );
      }
    );
    r.on('error', () => resolve(null));
    r.setTimeout(8000, () => {
      r.destroy();
      resolve(null);
    });
    r.end();
  });
}

function proxyFor(origin) {
  if (proxyCache.has(origin)) return proxyCache.get(origin);

  const mw = createProxyMiddleware({
    target: origin,
    changeOrigin: true,
    secure: true,
    ws: true,
    xfwd: true,
    selfHandleResponse: true,
    proxyTimeout: 120000,
    pathFilter: () => true,
    pathRewrite: (p, req) => req.__path || p,

    onProxyReq(proxyReq, req) {
      let t;
      try {
        t = new URL(req.__target || origin);
      } catch {
        t = new URL(origin);
      }
      proxyReq.setHeader('accept-encoding', 'identity');
      if (!proxyReq.getHeader('accept-language')) proxyReq.setHeader('accept-language', 'ja-JP,ja;q=0.9');
      proxyReq.setHeader('origin', t.origin);
      proxyReq.setHeader('referer', t.href);
      try {
        proxyReq.removeHeader('if-none-match');
        proxyReq.removeHeader('if-modified-since');
      } catch {}
    },

    async onProxyRes(proxyRes, req, res) {
      const target = req.__target || origin;
      let host = '';
      try {
        host = new URL(target).host;
      } catch {}

      const h = proxyRes.headers;
      for (const k of [
        'x-frame-options',
        'content-security-policy',
        'content-security-policy-report-only',
        'cross-origin-opener-policy',
        'cross-origin-embedder-policy',
        'cross-origin-resource-policy',
        'strict-transport-security',
        'permissions-policy',
        'report-to',
        'nel',
        'alt-svc',
      ]) delete h[k];

      if (h.location) h.location = mapLocation(h.location, target);
      if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map(fixCookie(host));
      if (h['access-control-allow-origin']) h['access-control-allow-origin'] = req.headers.origin || '*';

      const ct = String(h['content-type'] || '').toLowerCase();
      const enc = String(h['content-encoding'] || '').toLowerCase();
      const isHtml = ct.includes('text/html');
      const isCss = ct.includes('text/css');
      const isText =
        isHtml || isCss || ct.includes('javascript') || ct.includes('json') || ct.includes('text/');

      if (!isText) {
        res.writeHead(proxyRes.statusCode, h);
        proxyRes.pipe(res);
        return;
      }

      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', async () => {
        let status = proxyRes.statusCode;
        let buf = Buffer.concat(chunks);
        let headers = h;

        // stringtable 404 の救済
        if (status === 404 && /\/api\/1\/stringtable\//.test(target)) {
          const alt = await refetchStringtable(target, req);
          if (alt && alt.status === 200) {
            status = alt.status;
            buf = alt.body;
            headers = Object.assign({}, h, alt.headers);
            for (const k of ['content-security-policy', 'strict-transport-security', 'alt-svc', 'set-cookie']) delete headers[k];
          }
        }

        let body = decodeBody(buf, enc);
        if (isHtml) body = rewriteHtml(body, target, req);
        else if (isCss) body = rewriteCss(body, target);
        else if (/redirect_uri=/.test(body)) body = fixRedirectUri(body, selfHostOf(req));

        const out = Buffer.from(body, 'utf8');
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        headers['content-length'] = String(out.length);
        if (isHtml || isCss || ct.includes('json')) headers['cache-control'] = 'no-store';

        if (!res.headersSent) res.writeHead(status, headers);
        res.end(out);
      });
    },

    onError(err, req, res) {
      try {
        if (res && !res.headersSent && res.writeHead) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Proxy error: ' + err.message);
        } else if (res && res.destroy) res.destroy();
      } catch {}
    },
  });

  proxyCache.set(origin, mw);
  return mw;
}

/* ---------------- アプリ ---------------- */

const app = express();
app.disable('x-powered-by');
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

app.get('/__shim.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.send(SHIM);
});

app.get('/__diag', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const cookies = String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
  res.send('host=' + selfHostOf(req) + '\ncookies=' + JSON.stringify(cookies));
});

app.get('/__clearcookies', (req, res) => {
  const list = String(req.headers.cookie || '').split(';');
  const out = [];
  for (const c of list) {
    const name = c.split('=')[0].trim();
    if (!name) continue;
    out.push(`${name}=; Path=/; Max-Age=0`);
    out.push(`${name}=; Path=${PREFIX}; Max-Age=0`);
  }
  res.setHeader('set-cookie', out);
  res.type('text/plain').send('cleared ' + out.length);
});

// サーバ側プローブ（ブラウザから叩ける）
app.get('/__probe', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).type('text/plain').send('url required');
  const variants = [
    { name: 'plain', headers: {} },
    { name: 'browser', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', accept: 'application/json, text/plain, */*', 'accept-language': 'ja-JP,ja;q=0.9' },
    { name: 'referer', headers: { referer: 'https://accounts.nvgs.nvidia.com/', origin: 'https://accounts.nvgs.nvidia.com', accept: 'application/json' } },
  ];
  const out = {};
  await Promise.all(
    variants.map(
      (v) =>
        new Promise((resolve) => {
          let u;
          try {
            u = new URL(url);
          } catch {
            out[v.name] = 'bad url';
            return resolve();
          }
          const r = https.request(
            { host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: v.headers },
            (pr) => {
              const c = [];
              pr.on('data', (d) => c.push(d));
              pr.on('end', () => {
                out[v.name] = pr.statusCode + ' ' + String(pr.headers['content-type'] || '') + ' :: ' + Buffer.concat(c).toString('utf8').slice(0, 200);
                resolve();
              });
            }
          );
          r.on('error', (e) => {
            out[v.name] = 'ERR ' + e.message;
            resolve();
          });
          r.setTimeout(10000, () => {
            r.destroy();
            out[v.name] = 'TIMEOUT';
            resolve();
          });
          r.end();
        })
    )
  );
  res.type('application/json').send(JSON.stringify({ url, out }, null, 2));
});

app.get('/__get', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).type('text/plain').send('url required');
  try {
    const u = new URL(url);
    const r = https.request(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
          accept: '*/*',
          'accept-language': 'ja-JP,ja;q=0.9',
        },
      },
      (pr) => {
        const c = [];
        pr.on('data', (d) => c.push(d));
        pr.on('end', () => {
          res.type('text/plain; charset=utf-8').send('STATUS ' + pr.statusCode + '\n\n' + Buffer.concat(c).toString('utf8'));
        });
      }
    );
    r.on('error', (e) => res.type('text/plain').send('ERR ' + e.message));
    r.setTimeout(15000, () => {
      r.destroy();
      res.type('text/plain').send('TIMEOUT');
    });
    r.end();
  } catch (e) {
    res.status(400).type('text/plain').send('bad url');
  }
});

// OAuth 戻り先
app.get(REDIRECT_PATHS, (req, res) => {
  res.type('text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.send(REDIRECT_HTML);
});

// 任意ホスト
app.use(PREFIX, (req, res, next) => {
  const raw = req.originalUrl.slice(PREFIX.length);
  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).type('text/plain').send('Bad URL');
  }
  if (!isAllowed(target.href)) return res.status(403).type('text/plain').send('Host not allowed');
  req.__target = target.href;
  req.__path = target.pathname + target.search;
  req.url = target.pathname + target.search;
  return proxyFor(target.origin)(req, res, next);
});

// 本体
app.use((req, res, next) => {
  req.__target = ORIGIN + req.originalUrl;
  req.__path = req.originalUrl;
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
  if (!isAllowed(target.href)) return socket.destroy();
  proxyFor(target.origin).upgrade(req, socket, head);
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
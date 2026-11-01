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
const MARK = '/~';
const PAGE_HDR = 'x-gfn-page';
const REDIRECT_PATH = '/redirect/starfleet-oauth-redirect.html';
const REDIRECT_PATHS = [
  '/redirect/starfleet-oauth-redirect.html',
  '/redirect/starfleet-oauth-redirect-login.html',
  '/redirect/gfn-jarvis-oauth-redirect.html',
];

const BLOCK = /(^|\.)(doubleclick\.net|googletagmanager\.com|google-analytics\.com)$/i;
const SKIP_PREFIX = ['data:', 'blob:', 'javascript:', 'mailto:', 'about:', 'tel:', 'chrome-extension:'];
const AUTH_RE = /(^|\.)(accounts\.nvgs\.nvidia\.com|login\.nvidia\.com|login\.nvgs\.nvidia\.com)$/i;
const CLEAR_HOSTS = ['accounts.nvgs.nvidia.com', 'login.nvgs.nvidia.com', 'login.nvidia.com', 'play.geforcenow.com'];

let SELF_HOST = '';
const srvLog = [];

function srv(s) {
  srvLog.push(new Date().toISOString().slice(11, 19) + ' ' + s);
  if (srvLog.length > 400) srvLog.shift();
}

function b64u(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function unb64u(s) {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function isAllowed(abs) {
  try {
    const u = new URL(abs);
    if (u.protocol !== 'https:') return false;
    return !BLOCK.test(u.hostname);
  } catch {
    return false;
  }
}

function chainOf(host) {
  const labels = String(host).toLowerCase().split('.').filter(Boolean);
  const out = [];
  for (let k = 1; k <= labels.length; k++) out.push(b64u(labels.slice(labels.length - k).join('.')));
  return out;
}

function siteOf(host) {
  const l = String(host).toLowerCase().split('.').filter(Boolean);
  return l.slice(-2).join('.');
}

function proxyUrl(absUrl) {
  const u = new URL(absUrl);
  const p = u.pathname && u.pathname.charAt(0) === '/' ? u.pathname : '/' + u.pathname;
  let out = PREFIX + chainOf(u.hostname).join('/') + MARK + p;
  if (u.search) out += '?q=' + b64u(u.search);
  return out + u.hash;
}

function parseProxyPath(originalUrl) {
  const rest = originalUrl.slice(PREFIX.length);
  if (/^https?:\/\//i.test(rest)) return new URL(rest);

  const mi = rest.indexOf(MARK);
  if (mi < 0) throw new Error('bad url');
  const segs = rest.slice(0, mi).split('/');
  const host = unb64u(segs[segs.length - 1]);
  if (!host) throw new Error('bad host');

  let tail = rest.slice(mi + MARK.length) || '/';
  let search = '';
  const qi = tail.indexOf('?');
  if (qi >= 0) {
    const qs = tail.slice(qi + 1);
    tail = tail.slice(0, qi);
    search = qs.startsWith('q=') ? unb64u(qs.slice(2)) : '?' + qs;
  }
  if (tail.charAt(0) !== '/') tail = '/' + tail;
  return new URL('https://' + host + tail + search);
}

function realUrlFromProxy(u) {
  if (!u) return null;
  try {
    const p = new URL(u);
    if (!p.pathname.startsWith(PREFIX)) return u;
    return parseProxyPath(p.pathname + p.search).href;
  } catch {
    return null;
  }
}

/* ---------------- URL 変換 ---------------- */

function mapUrl(u, base) {
  if (u == null) return u;
  const s = String(u).trim();
  if (!s) return u;
  const low = s.toLowerCase();
  for (const p of SKIP_PREFIX) if (low.startsWith(p)) return u;
  if (s.charAt(0) === '#') return u;
  if (s.startsWith(PREFIX)) return u;

  let abs;
  try {
    abs = new URL(s, base);
  } catch {
    return u;
  }
  if (abs.protocol !== 'https:') return u;
  if (BLOCK.test(abs.hostname)) return u;
  if (abs.pathname.startsWith(PREFIX)) return abs.pathname + abs.search + abs.hash;
  if (SELF_HOST && abs.hostname === SELF_HOST) return abs.pathname + abs.search + abs.hash;

  return proxyUrl(abs.href);
}

function mapLocation(loc, target) {
  try {
    const abs = new URL(loc, target);
    if (abs.protocol !== 'https:') return loc;
    return proxyUrl(abs.href);
  } catch {
    return loc;
  }
}

function fixCookie(host) {
  return (c) => {
    let path = PREFIX + chainOf(host).join('/') + MARK + '/';
    const m = String(c).match(/;\s*domain=\.?([^;\s]+)/i);
    if (m && m[1]) {
      const d = m[1].trim().toLowerCase();
      if (d && host.toLowerCase().endsWith(d)) path = PREFIX + chainOf(d).join('/') + '/';
    }
    return (
      String(c)
        .replace(/;\s*domain=[^;]*/gi, '')
        .replace(/;\s*path=[^;]*/gi, '')
        .replace(/;\s*partitioned/gi, '') + '; Path=' + path
    );
  };
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
      if (u.hostname.toLowerCase() === selfHost) {
        return p + encodeURIComponent(ORIGIN + REDIRECT_PATH);
      }
    } catch {
      /* keep */
    }
    return m;
  });
}

/* MainAuth_N を新しい順に並べ替える */
function reorderCookie(header) {
  const parts = String(header || '')
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean);
  const rank = (c) => {
    const n = c.split('=')[0];
    const m = n.match(/_(\d+)$/);
    return m ? Number(m[1]) : 0;
  };
  return parts
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((o) => o.c)
    .join('; ');
}

/* ---------------- HTML / CSS 書き換え ---------------- */

const ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'data-src', 'data-href'];

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => 'url(' + q + mapUrl(u, base) + q + ')')
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => '@import ' + q + mapUrl(u, base) + q);
}

function rewriteHtml(html, docUrl, req) {
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

  $('script').each((_, el) => {
    const s = $(el).html();
    if (s && s.indexOf('redirect_uri') >= 0) $(el).html(fixRedirectUri(s, SELF_HOST));
  });

  $('head').prepend(
    `<script>window.__GFN_DOC__=${JSON.stringify(docUrl)};window.__GFN_SELF__=${JSON.stringify(SELF_HOST)};</script>` +
      '<script src="/__shim.js"></script>'
  );

  return $.html();
}

/* ---------------- クライアントシム ---------------- */

const SHIM = String.raw`(function () {
  if (window.__GFN_PROXY_SHIM__) return;
  window.__GFN_PROXY_SHIM__ = true;

  var P = '/__p/';
  var M = '/~';
  var RU = 'https://play.geforcenow.com/redirect/starfleet-oauth-redirect.html';
  var AUTH = /(^|\.)(accounts\.nvgs\.nvidia\.com|login\.nvidia\.com|login\.nvgs\.nvidia\.com)$/i;
  var WATCH = /(^|\.)(accounts\.nvgs\.nvidia\.com|login\.nvidia\.com|login\.nvgs\.nvidia\.com|play\.geforcenow\.com|pcs\.geforcenow\.com)$/i;

  function b64u(s) {
    try { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    catch (e) { return ''; }
  }
  function chain(h) {
    var l = String(h).toLowerCase().split('.').filter(Boolean), out = [];
    for (var k = 1; k <= l.length; k++) out.push(b64u(l.slice(l.length - k).join('.')));
    return out.join('/');
  }

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
      var cp;
      var mk = function (label, fn) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'background:#1b5e20;color:#e8f5e9;border:0;border-radius:4px;padding:2px 7px;font:11px ui-monospace,monospace;cursor:pointer';
        b.onclick = fn;
        head.appendChild(b);
        return b;
      };
      var copyAll = function () {
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
      };
      cp = mk('COPY', copyAll);
      mk('CLEAR', function () { lines = []; try { localStorage.setItem('gfnLog', '[]'); } catch (e) {} if (bodyEl) bodyEl.textContent = ''; });
      mk('CLOSE', function () { box.remove(); box = null; });
      bodyEl = document.createElement('div');
      bodyEl.style.cssText = 'overflow:auto;padding:5px 6px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text';
      box.appendChild(head);
      box.appendChild(bodyEl);
      document.body.appendChild(box);
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

  function fixRU(x) {
    var s = String(x);
    if (s.indexOf('redirect_uri=') < 0) return s;
    return s.replace(/(redirect_uri=)([^&#]*)/gi, function (m, p, v) {
      var d = v;
      try { d = decodeURIComponent(v); } catch (e) {}
      try {
        var a = new URL(d, location.href);
        if (a.hostname === location.hostname) {
          log('redirectFixed ' + RU);
          return p + encodeURIComponent(RU);
        }
      } catch (e) {}
      return m;
    });
  }

  function norm(x) {
    try {
      var s = fixRU(x);
      var a = new URL(s, document.baseURI || location.href);
      if (a.pathname.indexOf(P) === 0) return a.pathname + a.search + a.hash;
      if (a.origin === location.origin) return a.pathname + a.search + a.hash;
      if (a.protocol !== 'https:') return a.href;
      return P + chain(a.hostname) + M + a.pathname + (a.search ? '?q=' + b64u(a.search) : '') + a.hash;
    } catch (e) { return x; }
  }
  function hostOf(x) {
    try { return new URL(String(x), location.href).hostname; } catch (e) { return ''; }
  }
  function watch(x) { return WATCH.test(hostOf(x)); }

  function observe(label, url, status, headers, body) {
    if (!watch(url)) return;
    var loc = '';
    try { loc = (headers && headers.get && headers.get('location')) || ''; } catch (e) {}
    var head = '[' + label + '] ' + status + ' ' + String(url).slice(0, 160);
    if (loc) head += ' LOC=' + String(loc).slice(0, 220);
    if (body) head += ' BODY=' + String(body).slice(0, 300).replace(/\s+/g, ' ');
    log(head);
  }

  var of = window.fetch;
  if (of) {
    window.fetch = function (input, init) {
      try {
        var isReq = input && typeof input === 'object' && input.url;
        var url = isReq ? input.url : String(input);
        var t = norm(url);
        if (AUTH.test(hostOf(url))) log('sent ' + String(url).slice(0, 200));
        var i2 = {};
        var k;
        for (k in (init || {})) i2[k] = init[k];
        var hh = new Headers(i2.headers || (isReq ? input.headers : undefined));
        hh.set('x-gfn-page', location.href);
        i2.headers = hh;
        var p;
        if (isReq) p = of.call(this, new Request(t, input), i2);
        else p = of.call(this, t, i2);
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

  var xo = XMLHttpRequest.prototype.open;
  var xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__u = String(u);
    this.__t = norm(u);
    if (AUTH.test(hostOf(u))) log('sent ' + String(u).slice(0, 200));
    var a = Array.prototype.slice.call(arguments);
    a[1] = this.__t;
    var r = xo.apply(this, a);
    try { this.setRequestHeader('x-gfn-page', location.href); } catch (e) {}
    return r;
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener('loadend', function () {
      var st = 0;
      try { st = self.status; } catch (e) {}
      if (watch(self.__u)) {
        var b = '';
        try { if (self.responseType === '' || self.responseType === 'text') b = (self.responseText || '').slice(0, 300); } catch (e) {}
        observe('xhr', self.__u, st, null, b);
      }
    });
    return xs.apply(this, arguments);
  };

  var OW = window.WebSocket;
  if (OW) {
    window.WebSocket = function (u, p) {
      var t = norm(u).replace(/^\/__p\//, '');
      log('ws ' + String(u).slice(0, 160));
      return p === undefined ? new OW(t) : new OW(t, p);
    };
    window.WebSocket.prototype = OW.prototype;
  }

  var oo = window.open;
  window.open = function (u) {
    var a = Array.prototype.slice.call(arguments);
    if (u) { a[0] = norm(u); log('open ' + String(u).slice(0, 200)); }
    return oo.apply(window, a);
  };

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

  try {
    var loc = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      get: function () { return loc; },
      set: function (v) {
        var t = norm(v);
        log('nav(loc) ' + String(v).slice(0, 160));
        if (d && d.set) d.set.call(loc, t); else loc.href = t;
      },
    });
  } catch (e) {}

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
})();`;

/* ---------------- 戻り先ページ ---------------- */

const REDIRECT_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>GeForce NOW</title>
<style>body{background:#1a1a1a;color:#ccc;font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body><div>認証中...</div>
<script>
(function () {
  function b64u(s) {
    try { return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }
    catch (e) { return ''; }
  }
  function chain(h) {
    var l = String(h).toLowerCase().split('.').filter(Boolean), out = [];
    for (var k = 1; k <= l.length; k++) out.push(b64u(l.slice(l.length - k).join('.')));
    return out.join('/');
  }
  function norm(x) {
    try {
      var a = new URL(x, location.href);
      if (a.pathname.indexOf('/__p/') === 0) return a.pathname + a.search + a.hash;
      if (a.origin === location.origin) return a.pathname + a.search + a.hash;
      return '/__p/' + chain(a.hostname) + '/~' + a.pathname + (a.search ? '?q=' + b64u(a.search) : '') + a.hash;
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

  try { localStorage.setItem('oauth', JSON.stringify({ data: data, t: Date.now() })); } catch (e) {}
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

      let ref = realUrlFromProxy(req.headers[PAGE_HDR]) || realUrlFromProxy(req.headers.referer);
      try {
        proxyReq.removeHeader(PAGE_HDR);
      } catch {}

      let refOrigin = '';
      if (ref) {
        try {
          refOrigin = new URL(ref).origin;
          proxyReq.setHeader('referer', ref);
          proxyReq.setHeader('origin', refOrigin);
          proxyReq.setHeader(
            'sec-fetch-site',
            siteOf(new URL(ref).hostname) === siteOf(t.hostname) ? 'same-site' : 'cross-site'
          );
        } catch {
          ref = null;
        }
      }
      if (!ref) {
        refOrigin = t.origin;
        proxyReq.setHeader('referer', t.href);
        proxyReq.setHeader('origin', t.origin);
      }
      req.__refOrigin = refOrigin;

      if (AUTH_RE.test(t.hostname) && req.headers.cookie) {
        const re = reorderCookie(req.headers.cookie);
        try {
          proxyReq.setHeader('cookie', re);
        } catch {}
      }

      try {
        proxyReq.removeHeader('if-none-match');
        proxyReq.removeHeader('if-modified-since');
      } catch {}

      if (AUTH_RE.test(t.hostname)) {
        const names = String(req.headers.cookie || '')
          .split(';')
          .map((c) => c.trim().split('=')[0])
          .filter(Boolean);
        srv(
          '[req] ' + req.method + ' ' + t.hostname + t.pathname + (t.search || '') +
            ' o=' + refOrigin +
            ' r=' + String(ref || '-').slice(0, 90) +
            ' ck=' + JSON.stringify(names) +
            ' hdr=' + JSON.stringify(Object.keys(req.headers).filter((k) => /^x-|^sec-fetch-mode|^accept$/.test(k)))
        );
      }
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
      if (h['set-cookie']) {
        const arr = Array.isArray(h['set-cookie']) ? h['set-cookie'] : [h['set-cookie']];
        if (AUTH_RE.test(host)) {
          srv(
            '[set] ' + host + ' :: ' +
              arr
                .map((c) => {
                  const parts = String(c).split(';');
                  const attrs = parts.slice(1).map((s) => s.trim().split('=')[0]).join(',');
                  return parts[0].split('=')[0] + '{' + attrs + '}';
                })
                .join(' | ')
          );
        }
        h['set-cookie'] = arr.map(fixCookie(host));
      }
      if (h['access-control-allow-origin']) h['access-control-allow-origin'] = req.__refOrigin || req.headers.origin || '*';
      if (h['access-control-allow-credentials']) h['access-control-allow-credentials'] = 'true';

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

        if (status === 404 && /\/api\/1\/stringtable\//.test(target)) {
          const alt = await refetchStringtable(target, req);
          if (alt && alt.status === 200) {
            status = alt.status;
            buf = alt.body;
            headers = Object.assign({}, h, alt.headers);
            for (const k of [
              'content-security-policy',
              'strict-transport-security',
              'alt-svc',
              'set-cookie',
              'content-encoding',
              'transfer-encoding',
            ]) delete headers[k];
          }
        }

        let body = decodeBody(buf, enc);
        if (isHtml) body = rewriteHtml(body, target, req);
        else if (isCss) body = rewriteCss(body, target);
        else if (body.indexOf('redirect_uri=') >= 0) body = fixRedirectUri(body, SELF_HOST);

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

app.use((req, res, next) => {
  SELF_HOST = String(req.headers.host || '').toLowerCase();
  next();
});

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

app.get('/__srvlog', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.send(srvLog.join('\n') || '(empty)');
});

app.get('/__diag', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const cookies = String(req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim().split('=')[0])
    .filter(Boolean);
  res.send('host=' + SELF_HOST + '\ncookies=' + JSON.stringify(cookies));
});

/* 全 Cookie 削除ページ（各ホストのパス宛に fetch して削除させる） */
app.get('/__clear', (req, res) => {
  const urls = CLEAR_HOSTS.map((h) => PREFIX + chainOf(h).join('/') + MARK + '/__clear');
  res.type('text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.send(`<!doctype html><meta charset="utf-8"><title>clear</title>
<style>body{font:13px system-ui;background:#111;color:#ccc;padding:16px}</style>
<pre id="o">clearing...</pre>
<script>
var urls = ${JSON.stringify(urls)};
var out = [];
(async function () {
  for (var i = 0; i < urls.length; i++) {
    try {
      var r = await fetch(urls[i], { cache: 'no-store' });
      out.push(urls[i].split('/~')[0].split('/').pop() + ': ' + (await r.text()));
    } catch (e) { out.push(urls[i] + ': ERR ' + e.message); }
  }
  document.getElementById('o').textContent = out.join('\\n');
})();
</script>`);
});

app.get('/__clearcookies', (req, res) => {
  const names = String(req.headers.cookie || '')
    .split(';')
    .map((c) => c.split('=')[0].trim())
    .filter(Boolean);
  const out = [];
  for (const n of names) {
    out.push(n + '=; Path=/; Max-Age=0');
    out.push(n + '=; Path=' + PREFIX + '; Max-Age=0');
  }
  res.setHeader('set-cookie', out);
  res.type('text/plain').send('cleared ' + out.length);
});

app.get('/__probe', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).type('text/plain').send('url required');
  const variants = [
    { name: 'plain', headers: {} },
    {
      name: 'browser',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'ja-JP,ja;q=0.9',
      },
    },
    {
      name: 'referer',
      headers: {
        referer: 'https://accounts.nvgs.nvidia.com/',
        origin: 'https://accounts.nvgs.nvidia.com',
        accept: 'application/json',
      },
    },
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
                out[v.name] =
                  pr.statusCode +
                  ' ' +
                  String(pr.headers['content-type'] || '') +
                  ' :: ' +
                  Buffer.concat(c).toString('utf8').slice(0, 200);
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
          res
            .type('text/plain; charset=utf-8')
            .send('STATUS ' + pr.statusCode + '\n\n' + Buffer.concat(c).toString('utf8'));
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

app.get(REDIRECT_PATHS, (req, res) => {
  res.type('text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.send(REDIRECT_HTML);
});

app.use(PREFIX, (req, res, next) => {
  let target;
  try {
    target = parseProxyPath(req.originalUrl);
  } catch {
    return res.status(400).type('text/plain').send('Bad URL');
  }

  // パス内の削除エンドポイント（そのホストの Cookie が載ってくる）
  if (target.pathname === '/__clear') {
    const mi = req.originalUrl.indexOf(MARK);
    const base = mi >= 0 ? req.originalUrl.slice(0, mi + MARK.length) + '/' : PREFIX;
    const names = String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.split('=')[0].trim())
      .filter(Boolean);
    const out = [];
    for (const n of names) out.push(n + '=; Path=' + base + '; Max-Age=0');
    res.setHeader('set-cookie', out);
    return res.type('text/plain').send('[' + names.join(',') + ']');
  }

  if (!isAllowed(target.href)) return res.status(403).type('text/plain').send('Host not allowed');
  req.__target = target.href;
  req.__path = target.pathname + target.search;
  req.url = target.pathname + target.search;
  return proxyFor(target.origin)(req, res, next);
});

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
      target = parseProxyPath(req.url);
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
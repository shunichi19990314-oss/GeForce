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

  // ---------------- log overlay ----------------
  var box = null, list = null, lines = [], count = 0;

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

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

  var PROBE_URLS = [
    'https://pcs.geforcenow.com/v1/serviceUrls',
    'https://apps.gxn.nvidia.com/graphql',
    'https://gx-target-experiments-frontend-api.gx.nvidia.com/cloudvariables/v3'
  ];

  function runProbe(b) {
    b.textContent = 'RUNNING';
    var i = 0;
    (function step() {
      if (i >= PROBE_URLS.length) { b.textContent = 'PROBE'; return; }
      var u = PROBE_URLS[i++];
      fetch('/__probe?u=' + encodeURIComponent(u))
        .then(function (r) { return r.text(); })
        .then(function (t) { log('probe', u, '\\n  ' + t.replace(/\\n/g, '\\n  ')); })
        .catch(function (e) { log('probe', u, 'ERR ' + e.message); })
        .then(step);
    })();
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
    head.appendChild(mkBtn('PROBE', runProbe));
    head.appendChild(mkBtn('COPY', copyAll));
    head.appendChild(mkBtn('CLEAR', function () { lines = []; if (list) list.textContent = ''; }));
    head.appendChild(mkBtn('CLOSE', function () {
      store('gfnDebug', '0');
      box.remove();
      box = null;
      list = null;
    }));

    list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow:auto;padding:6px 7px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text';
    list.textContent = '(まだ通信ログはありません)';

    box.appendChild(head);
    box.appendChild(list);
    document.documentElement.appendChild(box);

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
    if (!box) return;
    var d = document.createElement('div');
    d.textContent = line;
    list.appendChild(d);
    list.scrollTop = list.scrollHeight;
  }

  function ref() { try { return base(); } catch (e) { return ''; } }

  // ---------------- network hooks ----------------
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

  var oo = window.open;
  window.open = function (u) { return oo.call(window, u ? map(u) : u); };

  if (navigator.sendBeacon) {
    var ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return ob(map(u), d); };
  }

  var want = load('gfnDebug');
  if (/[?&]debug=0/.test(location.href)) { want = '0'; store('gfnDebug', '0'); }
  else if (/[?&]debug=1/.test(location.href)) { want = '1'; store('gfnDebug', '1'); }
  if (want === null) want = '1';

  function boot() {
    if (want !== '0') overlay();
    log('init', window.__GFN_DOC__ || location.href, 'shim active');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();`;

const LOG = [];
function pushLog(o) {
  LOG.push(o);
  if (LOG.length > 300) LOG.shift();
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

const proxyCache = new Map();

function proxyFor(origin) {
  if (proxyCache.has(origin)) return proxyCache.get(origin);

  const targetHost = new URL(origin).host;

  const mw = createProxyMiddleware({
    target: origin,
    changeOrigin: true,
    ws: true,
    secure: true,
    selfHandleResponse: true,
    cookieDomainRewrite: '',
    cookiePathRewrite: '/',
    proxyTimeout: 180000,
    timeout: 180000,

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
      // 宛先ホストを明示的に固定する（ここが崩れると Akamai=404 / CloudFront=403 になる）
      proxyReq.setHeader('host', targetHost);
      proxyReq.setHeader('accept-encoding', 'gzip, deflate, br');
      proxyReq.setHeader('origin', ORIGIN);
      proxyReq.setHeader('referer', toRealReferer(req.headers['x-gfn-ref'] || req.headers.referer));
      proxyReq.removeHeader('x-gfn-ref');
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
            if (/^(server|via|x-cache|x-amz|akamai|cf-|x-akamai|x-served|x-nv|content-type)/i.test(k))
              keep[k] = resp.headers[k];
          }
          resolve({ status: resp.statusCode, headers: keep, body: b.toString('utf8').slice(0, 900) });
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
        done({ status, headers: hdrs, body: Buffer.concat(chunks).toString('utf8').slice(0, 700) })
      );
      r.on('error', (e) => done({ error: e.message }));
      if (body) r.write(body);
      r.end();
    });
  });
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
  out.C_with_forwarded = await probeOnce(t.href, method, body, {
    ...browserish,
    'x-forwarded-for': req.headers['x-forwarded-for'] || '203.0.113.9',
    'x-forwarded-host': selfHost,
    'x-forwarded-proto': 'https',
  });
  out.D_http2 = await probeH2(t.href, method, body, { ...browserish });

  res.type('application/json');
  res.send(JSON.stringify({ target: t.href, method, out }, null, 2));
});

app.use(PREFIX, (req, res, next) => {
  const selfHost = String(req.headers.host || '').toLowerCase();
  const target = normalizeTarget(req.originalUrl.slice(PREFIX.length), selfHost);
  if (!target) return res.status(400).type('text/plain').send('Bad URL');
  if (!shouldProxy(target.href)) return res.status(403).type('text/plain').send('Not proxied: ' + target.host);
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
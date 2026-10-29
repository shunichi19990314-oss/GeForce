'use strict';

const express = require('express');
const http = require('http');
const zlib = require('zlib');
const { PassThrough } = require('stream');
const httpProxy = require('http-proxy');
const cheerio = require('cheerio');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DEFAULT_TARGET = process.env.DEFAULT_TARGET || 'https://play.geforcenow.com/';
const FALLBACK_HOST = process.env.FALLBACK_HOST || new URL(DEFAULT_TARGET).host;
const COOKIE_NAME = '__p_host';
const DEBUG = !!process.env.DEBUG_PROXY;

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', true);

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
  selfHandleResponse: true,
  xfwd: true,
});

/* ================================================================== */
/* 診断用バッファ                                                     */
/* ================================================================== */

const RECENT = [];
function record(line) {
  RECENT.push(line);
  if (RECENT.length > 300) RECENT.shift();
}

/* ================================================================== */
/* ヘルパー                                                           */
/* ================================================================== */

const FILE_EXT =
  /\.(ico|txt|js|mjs|cjs|css|json|png|jpe?g|gif|svg|webp|avif|xml|html?|woff2?|ttf|otf|eot|map|wasm|bin|mp4|webm|mp3|wav|ogg|pdf|zip|gz)$/i;

const REDIRECT_KEYS = [
  'redirect_uri', 'redirectUri', 'redirect_url', 'redirectUrl',
  'callback_url', 'callbackUrl', 'return_url', 'returnUrl',
];

function looksLikeUrl(v) {
  return typeof v === 'string' && (/^(https?:)?\/\//i.test(v) || v.startsWith('/'));
}

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

/** プロキシURL → upstream URL（文字列の見た目を保つ） */
function toUpstreamIfProxy(value, proxyHost, hostHint) {
  if (!value) return null;
  const v = String(value).trim();
  const m = v.match(/^([a-z][a-z0-9+.\-]*:\/\/)([^\/?#]*)([\s\S]*)$/i);
  if (!m) return null;

  const scheme = m[1];
  const hostPort = m[2];
  const rest = m[3] || '';

  if (hostPort.toLowerCase() !== String(proxyHost || '').toLowerCase()) return null;

  const rm = rest.match(/^([^?#]*)([\s\S]*)$/);
  let p = rm[1];
  const tail = rm[2];

  let upHost = hostHint;
  const seg = p.split('/')[1] || '';
  if (seg.includes('.')) {
    upHost = seg;
    p = p.slice(1 + seg.length);
  }
  return scheme + upHost + p + tail;
}

/** Referer から「今表示しているページの upstream ホスト」を取り出す */
function hintFromReferer(req, proxyHost) {
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.host !== proxyHost) return null;
    const seg = u.pathname.split('/')[1] || '';
    if (seg.includes('.')) return seg;
  } catch (e) {}
  return null;
}

function rewriteSrcset(value, baseUrl) {
  return String(value).split(',').map((part) => {
    const p = part.trim();
    if (!p) return p;
    const bits = p.split(/\s+/);
    bits[0] = toProxyUrl(bits[0], baseUrl);
    return bits.join(' ');
  }).join(', ');
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
  return String(cookie)
    .replace(/;\s*Domain=[^;]*/i, '')
    .replace(/;\s*Path=[^;]*/i, '') + '; Path=/';
}

function getCookie(req, name) {
  const c = req.headers.cookie;
  if (!c) return null;
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function resolveTarget(reqUrl, fallbackHost) {
  const m = (reqUrl || '/').match(/^\/([^\/?#]+)([^?#]*)(\?[^#]*)?/);
  if (!m) return null;
  const seg = m[1];
  const rest = (m[2] || '') + (m[3] || '');
  const looksHost = seg.includes('.') && (rest !== '' || !FILE_EXT.test(seg));
  if (looksHost) return { host: seg, path: rest || '/', origin: 'https://' + seg };
  return { host: fallbackHost, path: '/' + seg + rest, origin: 'https://' + fallbackHost };
}

/* ================================================================== */
/* redirect_uri の書き換え                                            */
/* ================================================================== */

function rewriteQueryString(query, proxyHost, hostHint) {
  let out = query;
  let changed = false;

  for (const k of REDIRECT_KEYS) {
    const re = new RegExp('(^|&)' + k + '=([^&]*)', 'g');
    out = out.replace(re, (all, pre, rawVal) => {
      let decoded;
      try { decoded = decodeURIComponent(rawVal); } catch (e) { return all; }
      const nv = toUpstreamIfProxy(decoded, proxyHost, hostHint);
      if (!nv) return all;
      changed = true;
      return pre + k + '=' + encodeURIComponent(nv);
    });
  }
  return changed ? out : null;
}

function rewriteRedirectQuery(path, proxyHost, hostHint) {
  const qi = path.indexOf('?');
  if (qi === -1) return path;
  const base = path.slice(0, qi);
  const out = rewriteQueryString(path.slice(qi + 1), proxyHost, hostHint);
  return out === null ? path : base + '?' + out;
}

function rewriteRedirectBody(buf, contentType, proxyHost, hostHint) {
  const ct = String(contentType || '').toLowerCase();
  const text = buf.toString('utf8');

  if (ct.includes('application/x-www-form-urlencoded')) {
    const out = rewriteQueryString(text, proxyHost, hostHint);
    return out === null ? null : Buffer.from(out, 'utf8');
  }

  if (ct.includes('application/json')) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let changed = false;
    for (const k of REDIRECT_KEYS) {
      if (typeof obj[k] === 'string') {
        const nv = toUpstreamIfProxy(obj[k], proxyHost, hostHint);
        if (nv) { obj[k] = nv; changed = true; }
      }
    }
    return changed ? Buffer.from(JSON.stringify(obj), 'utf8') : null;
  }

  return null;
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function makeFakeReq(orig, body) {
  const pt = new PassThrough();
  pt.method = orig.method;
  pt.url = orig.url;
  pt.originalUrl = orig.originalUrl;
  pt.headers = orig.headers;
  pt.httpVersion = orig.httpVersion;
  pt.socket = orig.socket;
  pt.connection = orig.connection || orig.socket;
  pt._target = orig._target;
  if (body && body.length) pt.write(body);
  pt.end();
  return pt;
}

/* ================================================================== */
/* クライアント側シム                                                 */
/* ================================================================== */

const INJECT = [
  '<script data-proxy-shim>(function(){try{',
  'var L=location;',
  'var host=(L.pathname.split("/")[1]||"");',
  'if(!host||host.indexOf(".")===-1)return;',
  'var RKEYS=["redirect_uri","redirectUri","redirect_url","redirectUrl","callback_url","callbackUrl","return_url","returnUrl"];',
  'function fixR(s){',
  '  if(!s)return s;',
  '  var q=s.charAt(0)==="?"?s.slice(1):s;',
  '  for(var i=0;i<RKEYS.length;i++){',
  '    var k=RKEYS[i];',
  '    var re=new RegExp("(^|&)"+k+"=([^&]*)","g");',
  '    q=q.replace(re,function(all,pre,val){',
  '      var d;try{d=decodeURIComponent(val);}catch(e){return all;}',
  '      var u;try{u=new URL(d,L.href);}catch(e){return all;}',
  '      if(u.host!==L.host)return all;',
  '      var seg=u.pathname.split("/")[1]||"";',
  '      if(seg&&seg.indexOf(".")!==-1)return all;',
  '      return pre+k+"="+encodeURIComponent(L.origin+"/"+host+u.pathname+u.search+u.hash);',
  '    });',
  '  }',
  '  return "?"+q;',
  '}',
  'function fix(u){',
  '  if(typeof u!=="string"||!u)return u;',
  '  if(/^(data:|blob:|javascript:|about:|mailto:|tel:)/i.test(u))return u;',
  '  if(u.charAt(0)==="#")return u;',
  '  var url;try{url=new URL(u,L.href);}catch(e){return u;}',
  '  if(url.protocol!=="http:"&&url.protocol!=="https:"&&url.protocol!=="ws:"&&url.protocol!=="wss:")return u;',
  '  if(url.host===L.host){',
  '    var seg=url.pathname.split("/")[1]||"";',
  '    if(seg&&seg.indexOf(".")!==-1)return url.pathname+fixR(url.search)+url.hash;',
  '    return "/"+host+url.pathname+fixR(url.search)+url.hash;',
  '  }',
  '  return "/"+url.host+url.pathname+fixR(url.search)+url.hash;',
  '}',
  'window.__proxyFix=fix;',
  'try{var d=Object.getOwnPropertyDescriptor(Location.prototype,"href");',
  'if(d&&d.get&&d.set){Object.defineProperty(L,"href",{configurable:true,',
  'get:function(){return d.get.call(L);},',
  'set:function(v){d.set.call(L,fix(String(v)));}});}}catch(e){}',
  'try{var rAssign=Location.prototype.assign;L.assign=function(u){rAssign.call(L,fix(String(u)));};}catch(e){}',
  'try{var rReplace=Location.prototype.replace;L.replace=function(u){rReplace.call(L,fix(String(u)));};}catch(e){}',
  'try{var wOpen=window.open;window.open=function(u,n,f){return wOpen.call(window,u==null?u:fix(String(u)),n,f);};}catch(e){}',
  'try{var pH=history.pushState;history.pushState=function(s,t,u){return pH.call(history,s,t,u==null?u:fix(String(u)));};}catch(e){}',
  'try{var rH=history.replaceState;history.replaceState=function(s,t,u){return rH.call(history,s,t,u==null?u:fix(String(u)));};}catch(e){}',
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

/* ================================================================== */
/* HTML 書き換え                                                      */
/* ================================================================== */

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
    if (style && style.includes('url(')) $el.attr('style', rewriteCssUrls(style, baseUrl));
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

/* ================================================================== */
/* レスポンス処理                                                     */
/* ================================================================== */

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

  // ★ Cookie は HTML 応答のときだけ更新（APIドメインで汚染されないように）
  const cookies = h['set-cookie'] ? h['set-cookie'].slice() : [];
  if (isHtml) cookies.push(COOKIE_NAME + '=' + t.host + '; Path=/; SameSite=Lax');
  h['set-cookie'] = cookies.map(rewriteCookie);

  if ((isHtml || isCss) && req.method !== 'HEAD') {
    if (isHtml) h['cache-control'] = 'no-cache';

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
      } catch (e) {}

      let text = buf.toString('utf8');
      try {
        text = isHtml ? rewriteHtml(text, upstreamUrl) : rewriteCssUrls(text, upstreamUrl);
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
    try { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); } catch (e) {}
    try { res.end('Proxy error: ' + (err && err.message)); } catch (e) {}
  } else if (res && typeof res.destroy === 'function') {
    try { res.destroy(); } catch (e) {}
  }
});

/* ================================================================== */
/* ルーティング                                                       */
/* ================================================================== */

app.get('/__health', (req, res) => res.type('text/plain').send('ok'));

app.get('/__last', (req, res) => {
  res.type('text/plain; charset=utf-8').send(RECENT.slice(-60).join('\n') || '(empty)');
});

app.use(async (req, res) => {
  if (req.url === '/' || req.url === '') {
    const u = new URL(DEFAULT_TARGET);
    return res.redirect(302, '/' + u.host + (u.pathname || '/') + (u.search || ''));
  }

  // ★ Referer を最優先、次に HTMLページの Cookie、最後に既定値
  const hostHint =
    hintFromReferer(req, req.headers.host) ||
    getCookie(req, COOKIE_NAME) ||
    FALLBACK_HOST;

  const t = resolveTarget(req.url, hostHint);
  if (!t) {
    res.status(400).type('text/plain').send('bad request');
    return;
  }

  const rawUrl = t.path;
  const fixedUrl = rewriteRedirectQuery(t.path, req.headers.host, hostHint);
  const isNav = String(req.headers['sec-fetch-mode'] || '') === 'navigate';

  req._target = t;
  req.url = fixedUrl;

  if (isNav || fixedUrl.includes('redirect_uri')) {
    record(
      new Date().toISOString() + '  ' + req.method + '  ' + t.host + rawUrl +
      '\n    referer: ' + (req.headers.referer || '-') +
      '\n    hint:    ' + hostHint +
      (fixedUrl !== rawUrl ? '\n    -> ' + fixedUrl : '\n    (no change)')
    );
  }
  if (DEBUG) console.log(req.method, '->', t.origin + fixedUrl);

  const ct = String(req.headers['content-type'] || '');
  const mayHaveBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);

  if (mayHaveBody && /(x-www-form-urlencoded|application\/json)/i.test(ct)) {
    const body = await readRequestBody(req);
    const newBody = rewriteRedirectBody(body, ct, req.headers.host, hostHint);
    const finalBody = newBody || body;

    if (newBody) {
      record('  BODY: ' + body.toString('utf8') + '\n    -> ' + finalBody.toString('utf8'));
      req.headers['content-length'] = String(finalBody.length);
      delete req.headers['transfer-encoding'];
    }

    proxy.web(makeFakeReq(req, finalBody), res, { target: t.origin });
    return;
  }

  proxy.web(req, res, { target: t.origin });
});

/* ================================================================== */
/* サーバ起動                                                         */
/* ================================================================== */

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const hostHint =
    hintFromReferer(req, req.headers.host) ||
    getCookie(req, COOKIE_NAME) ||
    FALLBACK_HOST;

  const t = resolveTarget(req.url, hostHint);
  if (!t) { try { socket.destroy(); } catch (e) {} return; }

  req._target = t;
  req.url = rewriteRedirectQuery(t.path, req.headers.host, hostHint);

  proxy.ws(req, socket, head, { target: t.origin });
});

server.listen(PORT, () => {
  console.log('gfn-proxy listening on port ' + PORT);
  console.log('default target: ' + DEFAULT_TARGET);
});
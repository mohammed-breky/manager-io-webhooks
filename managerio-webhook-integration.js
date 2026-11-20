/*
  CREATED BY MOHAMMED BREKY

 * Manager.io page script: create / update / delete of ANY record type  ->   webhook
 * (sales invoices, sales quotes, customers, receipts, ... anything that saves through /<name>-form)
 * Runs in the browser inside Manager's main page, like any other page script / extension.
 *
 * Sends one POST per event (JSON):
 *   { entity_type:"sales_quote", action:"create|update|delete", guid:"<uuid>",
 *     http_method:"POST", source:"UI", timestamp:"<UTC ISO>", event_id:"<uuid, for de-duplication>" }
 * Never sends amounts, names, lines, cookies or any page content.
 *
 * How it detects (proven on real Manager traffic for invoices, quotes, customers, receipts):
 *   entity : taken from the page path  /<name>-form  or  /<name>-view   (sales-quote -> sales_quote)
 *   save   : htmx POST /<name>-form; success = HTTP 200 + HX-Redirect (not to /login).
 *            a save made from a LIST redirects back to the list, from a view page to the view page - both are success.
 *            the posted JSON's top-level "id": real UUID = update (= record guid), nil UUID = create.
 *   create : the new record's guid is the single `key` property on the /<name>-view page Manager opens next
 *            (never counted by UUIDs: other scripts add their own UUID literals to the page).
 *   delete : htmx POST /form-delete made from a /<name>-form page; success = 200 + HX-Redirect.
 *            guid = the single `key` property embedded in that page.
 * Events are stored in localStorage first and removed only after the webhook answers 2xx, so a closed tab or a
 * network blip does not lose them; they are re-sent on the next page load.
 *
 * Limits: sees only actions made in a browser where this script runs (not API calls, imports, other tools).
 * Anyone who can open Manager can read the webhook URL below. Set DEBUG=false when you are happy.
 */
(function () {
  'use strict';
  if (window.top !== window || window.__mbWebhookInstalled) return;
  window.__mbWebhookInstalled = true;

  // ------------------------------------------------------------------ settings
  var WEBHOOK_URL = 'https://your-webhook-url-here';
  var DEBUG = false;                          // small on-screen note + console lines; set false afterwards
  var IGNORE = ['script-extension'];         // record types that must NOT produce events (Manager's own extension scripts)
  var NIL = '00000000-0000-0000-0000-000000000000';
  var FORM_RE = /^\/([a-z0-9-]+)-form$/, VIEW_RE = /^\/([a-z0-9-]+)-view$/, DELETE = '/form-delete';
  var QUEUE_KEY = 'mbwh_queue_v2', PENDING_KEY = 'mbwh_pending_v2', LOCK_KEY = 'mbwh_lock_v2';
  var PENDING_TTL_MS = 15000, DEDUPE_MS = 3000, RETRY_MS = 30000, LOCK_MS = 10000;
  var UUID_1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var KEY_G = /(?:^|[^\w$.-])key["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

  // ------------------------------------------------------------------ helpers
  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[mb-webhook]'].concat([].slice.call(arguments))); } catch (e) {}
  }
  function toast(msg) {
    if (!DEBUG) return;
    try {
      var s = document.getElementById('mbwh-style');
      if (!s) {
        s = document.createElement('style'); s.id = 'mbwh-style';
        s.textContent = '@media print{#mbwh-toast{display:none!important}}';
        document.head.appendChild(s);
      }
      var t = document.getElementById('mbwh-toast');
      if (!t) {
        t = document.createElement('div'); t.id = 'mbwh-toast';
        t.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#222;color:#fff;font:12px/1.4 sans-serif;padding:6px 10px;border-radius:4px;direction:ltr;max-width:60vw';
        document.body.appendChild(t);
      }
      t.textContent = 'webhook: ' + msg;
      clearTimeout(t._h); t._h = setTimeout(function () { t.textContent = ''; }, 5000);
    } catch (e) {}
  }
  function jget(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function jdel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function uuid4() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function pathOf(u) { try { return new URL(u, location.href).pathname; } catch (e) { return ''; } }
  function distinct(arr) { var o = {}; arr.forEach(function (x) { o[x] = 1; }); return Object.keys(o); }
  function entityOf(re, path) { var m = re.exec(path || ''); return m && IGNORE.indexOf(m[1]) < 0 ? m[1] : null; }
  function etype(name) { return name.replace(/-/g, '_'); }

  // ------------------------------------------------------------------ queue + delivery
  var recent = {};
  function emit(entity, action, guid) {
    var k = entity + ':' + action + ':' + guid, now = Date.now();
    if (recent[k] && now - recent[k] < DEDUPE_MS) { log('duplicate suppressed', k); return; }
    recent[k] = now;
    var ev = { entity_type: etype(entity), action: action, guid: guid, http_method: 'POST', source: 'UI',
               timestamp: new Date().toISOString(), event_id: uuid4() };
    var q = jget(QUEUE_KEY, []); q.push(ev); jset(QUEUE_KEY, q);
    log('queued', ev.entity_type, action, guid); toast(ev.entity_type + ' ' + action + ' queued');
    flush();
  }
  var flushing = false, again = false;
  function flush() {
    if (flushing) { again = true; return Promise.resolve(); }   // something new arrived mid-delivery: go round again
    var lock = jget(LOCK_KEY, 0);
    if (lock && Date.now() - lock < LOCK_MS) return Promise.resolve();   // another tab is delivering
    flushing = true; jset(LOCK_KEY, Date.now());
    function next() {
      var q = jget(QUEUE_KEY, []);
      if (!q.length) { return Promise.resolve(true); }
      var ev = q[0];
      return fetch(WEBHOOK_URL, { method: 'POST', mode: 'cors', credentials: 'omit', keepalive: true,
                                  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) })
        .then(function (r) {
          if (!r.ok) { log('webhook answered', r.status); toast('webhook error ' + r.status + ' (will retry)'); return false; }
          jset(QUEUE_KEY, jget(QUEUE_KEY, []).filter(function (x) { return x.event_id !== ev.event_id; }));
          log('delivered', ev.entity_type, ev.action, ev.guid); toast('delivered ' + ev.entity_type + ' ' + ev.action);
          jset(LOCK_KEY, Date.now());
          return next();
        })
        .catch(function (e) { log('send failed', e && e.name); toast('send failed (will retry)'); return false; });
    }
    return next().then(function (done) {
      flushing = false; jdel(LOCK_KEY);
      if (!done) setTimeout(flush, RETRY_MS);
      else if (again) { again = false; flush(); }
    });
  }

  // ------------------------------------------------------------------ reading ids
  function postedId(cfg, elt) {
    var cands = [];
    try { var fd = cfg && cfg.formData; if (fd && fd.forEach) fd.forEach(function (v) { cands.push(v); }); } catch (e) {}
    try { var p = cfg && cfg.parameters; if (p) for (var k in p) cands.push(p[k]); } catch (e) {}
    try {
      var f = (elt && elt.closest && elt.closest('form')) || document.querySelector('form');
      if (f) [].forEach.call(f.querySelectorAll('input,textarea'), function (i) { cands.push(i.value); });
    } catch (e) {}
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      if (typeof v === 'string' && v.charAt(0) === '{') {
        try { var o = JSON.parse(v); if (o && typeof o.id === 'string') return o.id.toLowerCase(); } catch (e) {}
      }
    }
    return null;
  }
  function soleKey(html) {                 // the single `key` property of a record page
    var m, found = [];
    KEY_G.lastIndex = 0;
    while ((m = KEY_G.exec(html))) found.push(m[1].toLowerCase());
    var d = distinct(found);
    return d.length === 1 ? d[0] : null;
  }

  // ------------------------------------------------------------------ create: resolved on the view page after the redirect
  function resolvePending(attempt) {
    var p = jget(PENDING_KEY, null);
    if (!p) return;
    if (Date.now() - p.t > PENDING_TTL_MS) { jdel(PENDING_KEY); log('pending create expired'); return; }
    if (entityOf(VIEW_RE, pathOf(location.href)) !== p.entity) return;
    var g = soleKey(document.documentElement.innerHTML);
    if (g) { jdel(PENDING_KEY); emit(p.entity, 'create', g); return; }
    if (attempt < 4) { setTimeout(function () { resolvePending(attempt + 1); }, 400); return; }
    // fallback: the page's original HTML (not changed by scripts) - the same rule the server-side version uses
    fetch(location.href, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var g2 = soleKey(t);
        jdel(PENDING_KEY);
        if (g2) emit(p.entity, 'create', g2); else { log('create guid not found on the view page'); toast('create: guid not found'); }
      })
      .catch(function () { log('create fallback failed'); });
  }

  // ------------------------------------------------------------------ htmx hooks
  var ctx = (typeof WeakMap === 'function') ? new WeakMap() : null;
  document.addEventListener('htmx:beforeRequest', function (e) {
    try {
      var d = e.detail || {}, cfg = d.requestConfig || {};
      if (String(cfg.verb || '').toLowerCase() !== 'post' || !ctx) return;
      var p = pathOf(cfg.path || (d.pathInfo && d.pathInfo.requestPath) || '');
      var ent = entityOf(FORM_RE, p);
      if (ent) ctx.set(cfg, { kind: 'save', entity: ent, id: postedId(cfg, d.elt) });
      else if (p === DELETE) {
        var pe = entityOf(FORM_RE, location.pathname);       // deleting from a record's confirm form
        if (pe) ctx.set(cfg, { kind: 'delete', entity: pe, guid: soleKey(document.documentElement.innerHTML) });
      }
    } catch (err) { log('beforeRequest error', err && err.name); }
  });
  document.addEventListener('htmx:afterRequest', function (e) {
    try {
      var d = e.detail || {}, cfg = d.requestConfig;
      var c = cfg && ctx && ctx.get(cfg);
      if (!c) return;
      ctx.delete(cfg);
      var xhr = d.xhr, status = xhr && xhr.status, hr = xhr && xhr.getResponseHeader ? xhr.getResponseHeader('HX-Redirect') : null;
      var ok = status === 200 && !!hr;
      if (c.kind === 'save') {
        // success = 200 + HX-Redirect. A form opened from a LIST redirects back to the list, from a view page to the view page.
        if (!ok || pathOf(hr) === '/login') { log('save not successful, status', status); toast('save failed - no event'); return; }
        if (c.id === NIL) {
          if (entityOf(VIEW_RE, pathOf(hr)) === c.entity) { jset(PENDING_KEY, { t: Date.now(), entity: c.entity }); log('create pending (guid comes on the view page)'); }
          else { log('create saved but redirected to', pathOf(hr), '- guid unknown, not sent'); toast('create: guid unknown'); }
        }
        else if (c.id && UUID_1.test(c.id)) emit(c.entity, 'update', c.id);
        else log('save: posted id not readable - no event');
      } else {
        if (!ok) { log('delete not successful, status', status); toast('delete failed - no event'); return; }
        if (c.guid) emit(c.entity, 'delete', c.guid); else { log('delete: guid not found on the page - no event'); toast('delete: guid not found'); }
      }
    } catch (err) { log('afterRequest error', err && err.name); }
  });

  // ------------------------------------------------------------------ on every page load
  function start() { resolvePending(0); flush(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.__mbwh = { flush: flush, queue: function () { return jget(QUEUE_KEY, []); }, clear: function () { jdel(QUEUE_KEY); jdel(PENDING_KEY); jdel(LOCK_KEY); } };
  log('installed');
})();

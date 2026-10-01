// Element picker injected into the previewed page (main world) with
// webview.executeJavaScript. Plain JS on purpose: it is shipped verbatim.
// Talks to Drover through console messages prefixed with MARK.
(function () {
  'use strict';
  var MARK = '__HERDR_PICK__';
  if (window.__herdrPicker) {
    window.__herdrPicker.enable();
    return 'enabled';
  }
  var ACCENT = window.__herdrPickerAccent || '#d97757';
  var root = null;
  var box = null;
  var label = null;
  var current = null;
  var enabled = false;
  var savedCursor = '';

  function send(msg) {
    try {
      console.debug(MARK + JSON.stringify(msg));
    } catch (e) {
      /* ignore */
    }
  }

  function rgba(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function ensureUi() {
    if (root && root.isConnected) return;
    root = document.createElement('div');
    root.setAttribute('data-herdr-picker', '');
    root.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;');
    box = document.createElement('div');
    box.setAttribute(
      'style',
      'position:fixed;pointer-events:none;box-sizing:border-box;display:none;border-radius:3px;border:2px solid ' +
        ACCENT +
        ';background:' +
        rgba(ACCENT, 0.12) +
        ';transition:left 50ms,top 50ms,width 50ms,height 50ms;'
    );
    label = document.createElement('div');
    label.setAttribute(
      'style',
      'position:fixed;pointer-events:none;display:none;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'background:#1f1f1d;color:#fff;font:500 11px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;' +
        'padding:2px 7px;border-radius:5px;box-shadow:0 2px 10px rgba(0,0,0,.3);'
    );
    root.appendChild(box);
    root.appendChild(label);
    (document.body || document.documentElement).appendChild(root);
  }

  function deepAt(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (el && root && root.contains(el)) return null;
    return el;
  }

  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function goodClass(c) {
    if (!c || c.length > 40 || c.indexOf(':') >= 0) return false;
    if (/^(css|sc|jsx|svelte|astro|emotion|chakra|mui|tw)-[a-z0-9]{4,}$/i.test(c)) return false;
    if (/^_?[a-zA-Z0-9]{5,}_[a-zA-Z0-9]{4,}$/.test(c)) return false; // css modules hash
    return true;
  }

  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  function selectorOf(el) {
    if (el.id && !/\d{4,}/.test(el.id) && unique('#' + esc(el.id))) return '#' + esc(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 7) {
      var part = node.tagName.toLowerCase();
      if (node.id && !/\d{4,}/.test(node.id)) {
        parts.unshift(part + '#' + esc(node.id));
        if (unique(parts.join(' > '))) return parts.join(' > ');
        node = node.parentElement;
        continue;
      }
      var cls = Array.prototype.filter.call(node.classList || [], goodClass).slice(0, 2);
      if (cls.length) part += '.' + cls.map(esc).join('.');
      var parent = node.parentElement;
      if (parent) {
        var tag = node.tagName;
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === tag;
        });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      var sel = parts.join(' > ');
      if (unique(sel)) return sel;
      node = parent;
    }
    return parts.join(' > ');
  }

  function shortSource(file, line) {
    if (!file) return '';
    var f = String(file).replace(/^webpack:\/\/[^/]*\//, '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
    var i = f.search(/(^|\/)(src|app|pages|components|lib)\//);
    if (i > 0) f = f.slice(f.charAt(i) === '/' ? i + 1 : i);
    return f + (line ? ':' + line : '');
  }

  function sourceFromStack(stack) {
    if (!stack) return '';
    var lines = String(stack).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/(https?:\/\/[^\s)]+|\/[^\s):]+\.(?:jsx?|tsx?|vue|svelte|mjs)[^\s):]*):(\d+):\d+/);
      if (!m) continue;
      if (/node_modules|\.vite\/deps|react-dom|react\.development|jsx-dev-runtime|chunk-/.test(m[1])) continue;
      return shortSource(m[1], m[2]);
    }
    return '';
  }

  function reactInfo(el) {
    var key = null;
    var node = el;
    var fiber = null;
    while (node && !fiber) {
      for (var k in node) {
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
          key = k;
          break;
        }
      }
      if (key) fiber = node[key];
      node = node.parentElement;
    }
    if (!fiber) return null;
    var source = '';
    if (fiber._debugSource) source = shortSource(fiber._debugSource.fileName, fiber._debugSource.lineNumber);
    else if (fiber._debugStack) source = sourceFromStack(fiber._debugStack.stack || fiber._debugStack);
    var names = [];
    var f = fiber.return;
    var guard = 0;
    while (f && names.length < 4 && guard++ < 60) {
      var t = f.type;
      var name = null;
      if (typeof t === 'function') name = t.displayName || t.name;
      else if (t && typeof t === 'object') {
        var inner = t.render || t.type;
        name = t.displayName || (inner && (inner.displayName || inner.name));
      }
      if (name && /^[A-Z]/.test(name) && names.indexOf(name) < 0 && !/^(Fragment|Suspense|StrictMode|Provider|Consumer|Router|Routes|Route|Outlet|ErrorBoundary)$/.test(name)) {
        names.push(name);
        if (!source && f._debugSource) source = shortSource(f._debugSource.fileName, f._debugSource.lineNumber);
      }
      f = f.return;
    }
    return { component: names.join(' ‹ '), source: source };
  }

  function vueInfo(el) {
    var node = el;
    while (node && !node.__vueParentComponent) node = node.parentElement;
    var inst = node && node.__vueParentComponent;
    if (!inst) return null;
    var names = [];
    var source = '';
    var guard = 0;
    while (inst && names.length < 4 && guard++ < 40) {
      var t = inst.type || {};
      var name = t.name || t.__name || (t.__file ? t.__file.split('/').pop().replace(/\.vue$/, '') : '');
      if (name && names.indexOf(name) < 0) names.push(name);
      if (!source && t.__file) source = shortSource(t.__file);
      inst = inst.parent;
    }
    return { component: names.join(' ‹ '), source: source };
  }

  function svelteInfo(el) {
    var node = el;
    while (node && !node.__svelte_meta) node = node.parentElement;
    var loc = node && node.__svelte_meta && node.__svelte_meta.loc;
    if (!loc) return null;
    return { component: '', source: shortSource(loc.file, loc.line) };
  }

  var STYLE_KEYS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'gap', 'flex-direction', 'justify-content',
    'align-items', 'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight',
    'line-height', 'border', 'border-radius', 'box-shadow', 'opacity', 'z-index'
  ];
  var DEFAULTS = /^(none|normal|auto|0px|static|visible|rgba\(0, 0, 0, 0\)|0px none rgb\(.*\)|start|stretch|row|1)$/;

  function stylesOf(el) {
    var cs = window.getComputedStyle(el);
    var out = [];
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var k = STYLE_KEYS[i];
      var v = cs.getPropertyValue(k);
      if (!v || DEFAULTS.test(v)) continue;
      if (k === 'font-family') v = v.split(',')[0];
      if (v.length > 80) v = v.slice(0, 77) + '…';
      out.push(k + ': ' + v);
    }
    return out.join('; ');
  }

  function htmlOf(el) {
    var html = el.outerHTML || '';
    html = html.replace(/\s+/g, ' ');
    if (html.length <= 900) return html;
    var open = html.match(/^<[^>]+>/);
    var head = open ? open[0] : html.slice(0, 200);
    return head + ' … ' + html.slice(-60);
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    var fw = reactInfo(el) || vueInfo(el) || svelteInfo(el) || { component: '', source: '' };
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 160) text = text.slice(0, 157) + '…';
    return {
      url: location.href,
      title: document.title,
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      html: htmlOf(el),
      text: text,
      component: fw.component || undefined,
      source: fw.source || undefined,
      styles: stylesOf(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }

  function show(el) {
    if (!el || !box) return;
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    var name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    var cls = Array.prototype.filter.call(el.classList || [], goodClass).slice(0, 2);
    if (cls.length) name += '.' + cls.join('.');
    var fw = reactInfo(el) || vueInfo(el);
    var comp = fw && fw.component ? fw.component.split(' ‹ ')[0] : '';
    label.textContent = (comp ? comp + '  ' : '') + name + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.style.display = 'block';
    var top = r.top - 22;
    if (top < 2) top = Math.min(window.innerHeight - 22, r.bottom + 4);
    label.style.top = top + 'px';
    label.style.left = Math.max(2, Math.min(r.left, window.innerWidth - label.offsetWidth - 4)) + 'px';
  }

  function hide() {
    if (box) box.style.display = 'none';
    if (label) label.style.display = 'none';
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function onMove(e) {
    var el = deepAt(e.clientX, e.clientY);
    if (el && el !== current) {
      current = el;
      show(el);
    }
  }

  function onClick(e) {
    block(e);
    var el = deepAt(e.clientX, e.clientY) || current;
    if (!el) return;
    var info = describe(el);
    var keep = !!e.shiftKey;
    hide();
    send({ type: 'pick', element: info, keep: keep });
    if (!keep) disable(false);
    else
      setTimeout(function () {
        if (enabled && current) show(current);
      }, 350);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      block(e);
      disable(true);
    }
  }

  function onScroll() {
    if (current) show(current);
  }

  var BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'touchstart'];

  function enable() {
    if (enabled) return;
    ensureUi();
    enabled = true;
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);
    for (var i = 0; i < BLOCKED.length; i++) window.addEventListener(BLOCKED[i], block, true);
    savedCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';
  }

  function disable(notify) {
    if (!enabled) return;
    enabled = false;
    current = null;
    hide();
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    for (var i = 0; i < BLOCKED.length; i++) window.removeEventListener(BLOCKED[i], block, true);
    document.documentElement.style.cursor = savedCursor;
    if (notify) send({ type: 'exit' });
  }

  window.__herdrPicker = {
    enable: enable,
    disable: function () {
      disable(false);
    }
  };
  enable();
  return 'enabled';
})();

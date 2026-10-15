(function () {
  'use strict';
  var root = document.documentElement;
  var body = document.body;
  var VIEWS = ['side', 'swipe', 'onion', 'diff', 'head'];
  var view = 'side';
  var selected = null;
  var current = null;
  var states = new Map();

  function all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function shown(el) { return !el.closest('[hidden]'); }
  function frames() { return all('.frame'); }
  function frameOf(el) { return el.closest('.frame'); }

  function stateFor(frame) {
    var s = states.get(frame);
    if (!s) { s = { zoom: 1, x: 0, y: 0, fit: 1 }; states.set(frame, s); }
    return s;
  }
  function applyTransform(frame) {
    var s = stateFor(frame);
    var t = 'translate(' + s.x + 'px, ' + s.y + 'px) scale(' + s.fit * s.zoom + ')';
    all('.stage', frame).forEach(function (st) { st.style.transform = t; });
  }
  function fitFrame(frame) {
    var s = stateFor(frame);
    var vp = all('.viewport', frame).filter(shown)[0];
    var st = vp && vp.querySelector('.stage');
    var w = st ? Number(st.getAttribute('data-w')) : 0;
    s.fit = 1;
    if (vp && w > 0 && vp.clientWidth > 0) s.fit = Math.min(1, vp.clientWidth / w);
    all('.viewport', frame).forEach(function (v) {
      var sg = v.querySelector('.stage');
      var sh = sg ? Number(sg.getAttribute('data-h')) : 0;
      if (sh > 0) v.style.height = Math.ceil(sh * s.fit * s.zoom) + 'px';
    });
    applyTransform(frame);
  }
  function setStageSize(img) {
    var st = img.closest('.stage');
    if (!st || Number(st.getAttribute('data-w')) > 0 || !img.naturalWidth) return;
    st.setAttribute('data-w', String(img.naturalWidth));
    st.setAttribute('data-h', String(img.naturalHeight));
    fitFrame(frameOf(st));
  }
  function zoomBy(frame, factor, cx, cy) {
    var s = stateFor(frame);
    var z = Math.min(16, Math.max(0.1, s.zoom * factor));
    var r = z / s.zoom;
    s.x = cx - (cx - s.x) * r;
    s.y = cy - (cy - s.y) * r;
    s.zoom = z;
    applyTransform(frame);
  }

  function setView(name) {
    if (VIEWS.indexOf(name) < 0) return;
    view = name;
    body.setAttribute('data-view', name);
    all('#views button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === name)); });
    frames().forEach(function (f) { showFrameView(f); });
    if (selected && !shown(selected)) select(null);
  }
  function showFrameView(frame) {
    var key = frame.getAttribute('data-tkey');
    all('.tpane', frame).forEach(function (p) { p.hidden = p.getAttribute('data-tkey') !== key; });
    var pane = all('.tpane', frame).filter(function (p) { return !p.hidden; })[0];
    if (!pane) return;
    var wanted = all('.view', pane).some(function (v) { return v.getAttribute('data-view') === view; }) ? view : 'side';
    all('.view', pane).forEach(function (v) { v.hidden = v.getAttribute('data-view') !== wanted; });
    fitFrame(frame);
  }

  function setCurrent(frame) {
    if (current) current.classList.remove('current');
    current = frame;
    all('#sidebar li.current').forEach(function (l) { l.classList.remove('current'); });
    if (!frame) return;
    frame.classList.add('current');
    var link = document.querySelector('#sidebar a[href="#' + frame.id + '"]');
    if (link && link.parentNode) link.parentNode.classList.add('current');
  }
  function reveal(el) {
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  function select(box) {
    if (selected) selected.classList.remove('selected');
    selected = box;
    if (!box) return;
    box.classList.add('selected');
    setCurrent(frameOf(box));
    reveal(box);
  }
  function boxes() { return all('.box').filter(shown); }
  function frameIndex(el) { return frames().indexOf(frameOf(el)); }
  function moveBox(dir) {
    var list = boxes();
    if (!list.length) return;
    var i = list.indexOf(selected);
    if (i >= 0) {
      i = Math.min(list.length - 1, Math.max(0, i + dir));
    } else {
      var ci = current ? frames().indexOf(current) : (dir > 0 ? 0 : frames().length - 1);
      var hits = list.filter(function (b) { return dir > 0 ? frameIndex(b) >= ci : frameIndex(b) <= ci; });
      if (!hits.length) return;
      i = list.indexOf(dir > 0 ? hits[0] : hits[hits.length - 1]);
    }
    select(list[i]);
  }
  function moveFrame(dir) {
    var list = frames();
    if (!list.length) return;
    var i = current ? list.indexOf(current) + dir : (dir > 0 ? 0 : list.length - 1);
    i = Math.min(list.length - 1, Math.max(0, i));
    select(null);
    setCurrent(list[i]);
    reveal(list[i]);
  }

  function setTheme(t) { root.setAttribute('data-theme', t); }
  function toggleTheme() {
    var cur = root.getAttribute('data-theme');
    if (!cur) cur = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    setTheme(cur === 'dark' ? 'light' : 'dark');
  }
  function togglePulse() {
    var on = body.classList.toggle('pulse');
    var b = document.getElementById('pulse-toggle');
    if (b) b.setAttribute('aria-pressed', String(on));
  }
  function toggleHelp(force) {
    var h = document.getElementById('help');
    if (h) h.hidden = force === undefined ? !h.hidden : !force;
  }

  function init() {
    all('#views button').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
    });
    var tb = document.getElementById('theme-toggle');
    if (tb) tb.addEventListener('click', toggleTheme);
    var pb = document.getElementById('pulse-toggle');
    if (pb) pb.addEventListener('click', togglePulse);
    var hb = document.getElementById('help-toggle');
    if (hb) hb.addEventListener('click', function () { toggleHelp(); });
    var help = document.getElementById('help');
    if (help) help.addEventListener('click', function () { toggleHelp(false); });

    all('.frame').forEach(function (frame) {
      all('img', frame).forEach(function (img) {
        if (img.complete) setStageSize(img);
        img.addEventListener('load', function () { setStageSize(img); });
      });
      all('[data-action]', frame).forEach(function (b) {
        b.addEventListener('click', function () {
          var a = b.getAttribute('data-action');
          var s = stateFor(frame);
          if (a === 'zoom-in') zoomBy(frame, 1.25, 0, 0);
          else if (a === 'zoom-out') zoomBy(frame, 0.8, 0, 0);
          else if (a === 'reset') { s.zoom = 1; s.x = 0; s.y = 0; fitFrame(frame); }
        });
      });
      all('.theme-select', frame).forEach(function (sel) {
        sel.addEventListener('change', function () {
          frame.setAttribute('data-tkey', sel.value);
          showFrameView(frame);
          if (selected && !shown(selected)) select(null);
        });
      });
      all('.swipe input', frame).forEach(function (inp) {
        var apply = function () {
          var layer = inp.closest('.view').querySelector('.head-layer');
          var v = Number(inp.value);
          layer.setAttribute('data-clip', String(v));
          layer.style.setProperty('clip-path', 'inset(0 ' + (100 - v) + '% 0 0)');
        };
        inp.addEventListener('input', apply);
        apply();
      });
      all('.onion input', frame).forEach(function (inp) {
        var apply = function () {
          inp.closest('.view').querySelector('.head-layer').style.opacity = String(Number(inp.value) / 100);
        };
        inp.addEventListener('input', apply);
        apply();
      });
      all('.viewport', frame).forEach(function (vp) {
        vp.addEventListener('wheel', function (e) {
          e.preventDefault();
          var r = vp.getBoundingClientRect();
          zoomBy(frame, e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        vp.addEventListener('mousedown', function (e) {
          if (e.button !== 0) return;
          var s = stateFor(frame);
          var sx = e.clientX, sy = e.clientY, ox = s.x, oy = s.y;
          var move = function (m) { s.x = ox + m.clientX - sx; s.y = oy + m.clientY - sy; applyTransform(frame); };
          var up = function () {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
          };
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
          e.preventDefault();
        });
      });
      showFrameView(frame);
    });
    all('.box').forEach(function (box) {
      var open = function () { box.classList.add('tip-open'); };
      var close = function () { box.classList.remove('tip-open'); };
      box.addEventListener('mouseenter', open);
      box.addEventListener('mouseleave', close);
      box.addEventListener('focus', open);
      box.addEventListener('blur', close);
      box.addEventListener('click', function () { select(box); });
    });
    all('#sidebar a[href^="#frame-"]').forEach(function (a) {
      a.addEventListener('click', function () {
        var f = document.getElementById(a.getAttribute('href').slice(1));
        if (f) { select(null); setCurrent(f); }
      });
    });
    window.addEventListener('resize', function () { frames().forEach(fitFrame); });

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target;
      var tag = t && t.tagName;
      if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && t.type !== 'range')) return;
      var k = e.key;
      if (k === 'j' || k === 'ArrowDown' || k === 'ArrowRight') {
        if (tag === 'INPUT' && k !== 'j') return;
        moveBox(1);
      } else if (k === 'k' || k === 'ArrowUp' || k === 'ArrowLeft') {
        if (tag === 'INPUT' && k !== 'k') return;
        moveBox(-1);
      } else if (k === 'n') moveFrame(1);
      else if (k === 'p') moveFrame(-1);
      else if (k >= '1' && k <= '5') setView(VIEWS[Number(k) - 1]);
      else if (k === '?') toggleHelp();
      else if (k === 'Escape') toggleHelp(false);
      else return;
      e.preventDefault();
    });
    setView('side');
  }
  init();
})();

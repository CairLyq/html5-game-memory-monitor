/**
 * popup.js — 扩展弹窗面板。
 *
 * 打开弹窗（即点击扩展图标，activeTab 生效）时：
 *  - 若当前页已有监测脚本（白名单网站或此前注入过）→ 直接拉取统计；
 *  - 否则向当前标签页临时注入 hook.js（MAIN world）+ content.js，
 *    仅统计注入之后的资源，不申请常驻权限。
 * 每 500ms 拉取一次快照，渲染指标并绘制 FPS / JS 堆 / 纹理显存三条趋势折线。
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var MAX = 90; // 历史样本数（45 秒 @500ms）
  var hist = { fps: [], frameMs: [], heap: [], tex: [] };
  var emaRate = 0;

  var injecting = false;    // 正在执行注入
  var uninjectable = false; // 当前页无法注入（浏览器内部页面等），不再重试
  var lateMode = false;     // 本次为本弹窗临时注入（非白名单 document_start 注入）

  function fmtMB(b) { return b ? (b / 1048576).toFixed(2) : '0.00'; }
  function fmtInt(v) { return (typeof v === 'number' && isFinite(v)) ? Math.round(v).toLocaleString() : '--'; }
  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }

  function setStatus(msg, warn) {
    var el = $('status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'status' + (warn ? ' warn' : '');
  }

  function colorForFps(f) {
    if (f >= 50) return '#34d399';
    if (f >= 30) return '#fbbf24';
    return '#f87171';
  }

  /* ---------- 按需注入（activeTab） ---------- */

  function injectScripts(tab, cb) {
    injecting = true;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['hook.js'],
      world: 'MAIN',
      injectImmediately: true
    }, function () {
      if (chrome.runtime.lastError) {
        injecting = false;
        uninjectable = true;
        cb(false);
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
        injectImmediately: true
      }, function () {
        injecting = false;
        if (chrome.runtime.lastError) { uninjectable = true; cb(false); return; }
        lateMode = true;
        cb(true);
      });
    });
  }

  // 若当前页尚未注入则先注入，成功后再继续 cb
  function ensureInjected(tab, cb) {
    chrome.tabs.sendMessage(tab.id, { type: 'get-stats' }, function (resp) {
      if (!chrome.runtime.lastError && resp) { cb(); return; }
      if (uninjectable) return;
      injectScripts(tab, function (ok) { if (ok) cb(); });
    });
  }

  function render(resp) {
    if (!resp || !resp.ok) { setStatus('未注入：请在有游戏页面的标签页使用', true); return; }
    if (!resp.instrumented) { setStatus('等待监测注入（≤1 秒）…'); return; }

    var s = resp.stats || {};
    setStatus(s.active
      ? (lateMode ? '监测中（临时注入 · 仅统计之后的资源）' : '监测中')
      : '本页未检测到 WebGL 上下文', !s.active);

    // 引擎
    setText('engine', s.engine ? (s.engine + (s.engineVersion ? ' v' + s.engineVersion : '')) : '未识别');

    // FPS / 帧耗时 / 绘制
    var fps = s.fps || 0;
    var fpsEl = $('fps');
    if (fpsEl) { fpsEl.textContent = fmtInt(fps); fpsEl.style.color = colorForFps(fps); }
    setText('frameMs', s.frameMs != null ? s.frameMs.toFixed(1) : '--');
    setText('drawTotal', fmtInt(s.drawCallsTotal != null ? s.drawCallsTotal : s.drawCalls));
    setText('contexts', fmtInt(s.contexts));

    // 每帧 draw call（hook 在 rAF 中计算上一帧的 draw call 数）
    setText('dps', fmtInt(s.drawCalls));

    // JS 堆
    var heap = resp.jsHeap || {};
    if (heap.used) {
      setText('heapUsed', (heap.used / 1048576).toFixed(1));
      setText('heapLimit', (heap.limit / 1048576).toFixed(0));
      var pct = Math.min(100, (heap.used / heap.limit) * 100);
      var bar = $('heapBar');
      if (bar) {
        bar.style.width = pct.toFixed(1) + '%';
        bar.style.background = pct > 85
          ? 'linear-gradient(90deg,#f59e0b,#ef4444)'
          : 'linear-gradient(90deg,#22c55e,#34d399)';
      }
      setText('heapRatio', pct.toFixed(0) + '%');
    }

    // GPU 资源
    setText('texCount', fmtInt(s.texturesAlive));
    setText('bufCount', fmtInt(s.buffersAlive));
    setText('shaderCount', fmtInt(s.shadersAlive));
    setText('progCount', fmtInt(s.programsAlive));
    setText('texMB', fmtMB(s.texBytes));
    setText('bufMB', fmtMB(s.bufBytes));
    setText('rbMB', fmtMB(s.rbBytes));
    setText('rbCount', fmtInt(s.renderbuffersAlive));

    // 纹理明细（含来源）
    renderTextures(s.textures, s.textureTotal);

    // 趋势
    push(hist.fps, fps);
    push(hist.frameMs, s.frameMs != null ? s.frameMs : 0);
    push(hist.heap, heap.used ? heap.used / 1048576 : 0);
    push(hist.tex, s.texBytes ? s.texBytes / 1048576 : 0);
    drawSpark($('sparkFps'), hist.fps, '#22d3ee');
    drawSpark($('sparkHeap'), hist.heap, '#a78bfa');
    drawSpark($('sparkTex'), hist.tex, '#34d399');
  }

  function push(arr, v) {
    arr.push(v);
    if (arr.length > MAX) arr.shift();
  }

  function drawSpark(canvas, data, color) {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 100;
    var h = canvas.clientHeight || 30;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (data.length < 2) return;
    var max = Math.max.apply(null, data);
    var min = Math.min.apply(null, data);
    var range = (max - min) || 1;
    var step = w / (MAX - 1);
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = w - (MAX - 1 - i) * step;
      var y = h - 3 - ((data[i] - min) / range) * (h - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /* ---------- 纹理明细渲染 ---------- */

  var FORMAT_NAMES = {
    0x1908: 'RGBA', 0x1907: 'RGB', 0x1906: 'ALPHA',
    0x1909: 'LUM', 0x190A: 'LUM_A', 0x1902: 'DEPTH', 0x84F9: 'D_STENCIL',
    0x8227: 'RG', 0x8228: 'RG_I',
    0x8058: 'RGBA8', 0x8059: 'RGB8', 0x8C40: 'SRGB8', 0x8C41: 'SRGBA8',
    0x8057: 'RGB565', 0x8035: 'RGBA4', 0x806F: 'RGB5_A1',
    0x881A: 'RGBA16F', 0x881B: 'RGB16F', 0x8814: 'RGBA32F', 0x8815: 'RGB32F',
    0x822D: 'R16F', 0x822E: 'R32F', 0x822F: 'RG16F', 0x8230: 'RG32F',
    0x8229: 'R8', 0x822B: 'RG8', 0x8232: 'R8UI', 0x8238: 'RG8UI',
    0x8D97: 'RGBA8UI', 0x8D96: 'RGB8UI', 0x906F: 'RGB10_A2',
    0x81A5: 'D16', 0x81A6: 'D24', 0x8CAC: 'D32F', 0x88F0: 'D24_S8', 0x8DAD: 'D32F_S8',
    0x83F0: 'DXT1', 0x83F1: 'DXT1A', 0x83F2: 'DXT3', 0x83F3: 'DXT5',
    0x8D64: 'ETC1',
    0x9270: 'ETC2_RGB', 0x9271: 'ETC2_RGB_A1', 0x9272: 'ETC2_RGBA',
    0x9276: 'EAC_R11', 0x9278: 'EAC_RG11',
    0x93B0: 'ASTC_4x4', 0x93B1: 'ASTC_5x4', 0x93B2: 'ASTC_5x5', 0x93B3: 'ASTC_6x5',
    0x8E8C: 'BC7', 0x8E8D: 'BC6H_UF16', 0x8E8E: 'BC6H_SF16', 0x8E8F: 'BC5'
  };

  function formatName(fmt) {
    if (fmt == null) return '-';
    return FORMAT_NAMES[fmt] || ('0x' + fmt.toString(16).toUpperCase());
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 来源对象 -> 显示文本（函数名 @ 文件名:行号）
  function sourceText(src) {
    if (!src || !src.file) return '未知';
    var file = src.file;
    var slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    if (slash >= 0) file = file.substring(slash + 1);
    if (file.length > 42) file = file.substring(0, 39) + '...';
    var func = src.func ? src.func + ' @ ' : '';
    return func + file + (src.line ? ':' + src.line : '');
  }

  // 优先显示资源 URL/名称，回退到调用栈来源
  function resourceText(item) {
    if (item.sourceName) {
      var name = String(item.sourceName);
      if (name.length > 32) name = name.substring(0, 29) + '...';
      return name;
    }
    if (item.sourceUrl) {
      var url = String(item.sourceUrl);
      var fname = url.substring(url.lastIndexOf('/') + 1).split('?')[0];
      if (!fname) fname = url;
      if (fname.length > 32) fname = fname.substring(0, 29) + '...';
      return fname;
    }
    return sourceText(item.uploadedSource || item.createdSource);
  }

  function renderTextures(list, total) {
    var container = $('texList');
    var empty = $('texListEmpty');
    var countEl = $('texDetailCount');
    if (!container) return;

    if (countEl) {
      if (total) {
        var shown = list ? list.length : 0;
        countEl.textContent = total + ' 份' + (shown < total ? '（显示前 ' + shown + '）' : '');
      } else {
        countEl.textContent = '';
      }
    }

    if (!list || list.length === 0) {
      container.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var src = item.uploadedSource || item.createdSource;
      var srcLabel = resourceText(item);
      var kb = item.bytes / 1024;
      var sizeLabel = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB';
      var dim = item.width ? (item.width + '×' + item.height + (item.depth > 1 ? '×' + item.depth : '') + (item.mip ? ' M' : '')) : '-';
      var title = 'ID #' + item.id + ' · ' + sizeLabel
        + '\n格式: ' + formatName(item.format)
        + '\n尺寸: ' + dim
        + '\n存活: ' + (item.age != null ? item.age + 's' : '-')
        + (item.sourceName ? '\n资源名: ' + item.sourceName : '')
        + (item.sourceUrl ? '\n资源地址: ' + item.sourceUrl : '')
        + (src && src.raw ? '\n调用栈: ' + src.raw : '');
      html += '<div class="tex-row" title="' + escapeHtml(title) + '">'
        + '<span class="col-size">' + sizeLabel + '</span>'
        + '<span class="col-dim">' + dim + '</span>'
        + '<span class="col-fmt">' + formatName(item.format) + '</span>'
        + '<span class="col-src">' + escapeHtml(srcLabel) + '</span>'
        + '</div>';
    }
    container.innerHTML = html;
  }

  function currentTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) { setStatus('未找到活动标签页', true); return; }
      cb(tab);
    });
  }

  function init() {
    $('btnReset').addEventListener('click', function () {
      currentTab(function (tab) {
        ensureInjected(tab, function () {
          chrome.tabs.sendMessage(tab.id, { type: 'reset' }, function () {
            if (!chrome.runtime.lastError) setStatus('计数已重置');
          });
        });
      });
    });
    $('btnReload').addEventListener('click', function () {
      currentTab(function (tab) { chrome.tabs.reload(tab.id); });
    });
    $('btnHud').addEventListener('click', function () {
      currentTab(function (tab) {
        ensureInjected(tab, function () {
          chrome.tabs.sendMessage(tab.id, { type: 'show-hud' }, function () {
            if (!chrome.runtime.lastError) setStatus('已在页面显示 HUD 面板');
          });
        });
      });
    });
    $('btnPanel').addEventListener('click', function () {
      currentTab(function (tab) {
        var url = chrome.runtime.getURL('texture-panel.html') + '?tab=' + tab.id + '&url=' + encodeURIComponent(tab.url || '');
        chrome.tabs.create({ url: url });
      });
    });
    $('btnOptions').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });

    function poll() {
      currentTab(function (tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'get-stats' }, function (resp) {
          if (chrome.runtime.lastError) {
            if (uninjectable) { setStatus('此页面无法注入监测脚本（浏览器内部页面或受限站点）', true); return; }
            if (!injecting) {
              setStatus('正在向当前页面注入监测…');
              injectScripts(tab, function (ok) {
                if (!ok) setStatus('此页面无法注入监测脚本（浏览器内部页面或受限站点）', true);
              });
            }
            return;
          }
          render(resp);
        });
      });
    }
    poll();
    setInterval(poll, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

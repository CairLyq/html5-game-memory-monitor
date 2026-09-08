(function () {
  'use strict';

  var FORMAT_NAMES = {
    6407: 'RGB', 6408: 'RGBA', 6406: 'ALPHA', 6409: 'LUMINANCE', 6410: 'LUMINANCE_ALPHA',
    32856: 'RGB8', 32857: 'RGBA8', 32849: 'RGB8', 32855: 'RGB565', 32854: 'RGBA4',
    33189: 'R8', 33321: 'R8UI', 33325: 'RG8', 33330: 'RG8UI',
    34836: 'SRGB8', 34837: 'SRGB8_ALPHA8',
    35905: 'R16F', 35906: 'RG16F', 35907: 'RGBA16F',
    36012: 'R32F', 36013: 'RG32F', 36014: 'RGBA32F',
    36194: 'RGB10_A2', 36221: 'R11F_G11F_B10F',
    37492: 'RGBA8UI', 36220: 'RGB10_A2UI',
    33776: 'DEPTH_COMPONENT16', 33777: 'DEPTH_COMPONENT24', 33778: 'DEPTH_COMPONENT32F',
    34041: 'DEPTH_STENCIL', 35056: 'DEPTH24_STENCIL8', 36013: 'DEPTH32F_STENCIL8'
  };

  function formatName(fmt) {
    if (fmt == null) return '-';
    return FORMAT_NAMES[fmt] || ('0x' + fmt.toString(16));
  }

  function fmtBytes(b) {
    if (!b) return '0 B';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }

  function fmtUrl(url) {
    if (!url) return '';
    return url.substring(url.lastIndexOf('/') + 1).split('?')[0] || url;
  }

  function sourceText(src) {
    if (!src || !src.file) return '';
    var f = src.file;
    var slash = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\'));
    if (slash >= 0) f = f.substring(slash + 1);
    return (src.func ? src.func + ' @ ' : '') + f + (src.line ? ':' + src.line : '');
  }

  // 从 URL 参数获取 tab ID
  var params = new URLSearchParams(window.location.search);
  var tabId = parseInt(params.get('tab'), 10);
  var tabUrl = params.get('url') || '';

  var allTextures = [];
  var refreshTimer = null;

  function $(id) { return document.getElementById(id); }

  function requestTab(type, extra) {
    return new Promise(function (resolve) {
      if (!tabId) { resolve({ ok: false, error: 'no tab id' }); return; }
      var msg = { type: type };
      if (extra) for (var k in extra) msg[k] = extra[k];
      chrome.tabs.sendMessage(tabId, msg, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: 'no response' });
        }
      });
    });
  }

  async function loadTextures() {
    var resp = await requestTab('get-all-textures');
    if (resp && resp.ok && resp.textures) {
      allTextures = resp.textures;
      render();
    } else {
      $('texBody').innerHTML = '<tr><td colspan="8" class="empty">无法获取纹理数据，请确认游戏页面已注入扩展并刷新。</td></tr>';
    }
  }

  function getFiltered() {
    var q = $('searchInput').value.trim().toLowerCase();
    var onlyVisible = $('hideHidden').checked;
    var sort = $('sortSelect').value;

    var list = allTextures.filter(function (t) {
      if (onlyVisible && t.hidden) return false;
      if (!q) return true;
      var hay = (t.sourceName + ' ' + t.sourceUrl + ' ' + sourceText(t.uploadedSource) + ' ' + sourceText(t.createdSource)).toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    list.sort(function (a, b) {
      switch (sort) {
        case 'bytes-asc': return a.bytes - b.bytes;
        case 'bind-desc': return b.bindCount - a.bindCount;
        case 'bind-asc': return a.bindCount - b.bindCount;
        case 'id-asc': return a.id - b.id;
        case 'bytes-desc':
        default: return b.bytes - a.bytes;
      }
    });

    return list;
  }

  function render() {
    var list = getFiltered();
    var totalBytes = allTextures.reduce(function (s, t) { return s + (t.bytes || 0); }, 0);
    var hiddenCount = allTextures.filter(function (t) { return t.hidden; }).length;

    $('totalCount').textContent = allTextures.length;
    $('totalBytes').textContent = fmtBytes(totalBytes);
    $('hiddenCount').textContent = hiddenCount;
    $('shownCount').textContent = list.length;

    if (list.length === 0) {
      $('texBody').innerHTML = '<tr><td colspan="8" class="empty">没有匹配的纹理</td></tr>';
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var dim = t.width ? (t.width + '×' + t.height + (t.depth > 1 ? '×' + t.depth : '') + (t.mip ? ' M' : '')) : '-';
      var resName = t.sourceName || fmtUrl(t.sourceUrl) || sourceText(t.uploadedSource || t.createdSource) || '未知';
      var resUrl = t.sourceUrl || '';
      var stack = !t.sourceUrl && !t.sourceName ? sourceText(t.uploadedSource || t.createdSource) : '';
      var rowClass = (t.hidden ? 'hidden-row ' : '') + (t.replaced ? 'replaced-row' : '');
      var btnClass = t.hidden ? 'btn-show' : 'btn-hide';
      var btnText = t.hidden ? '显示' : '隐藏';
      var titleAttr = (t.sourceUrl ? 'URL: ' + t.sourceUrl + '\n' : '') +
        (t.sourceName ? '名称: ' + t.sourceName + '\n' : '') +
        'ID: ' + t.id + ' · ' + fmtBytes(t.bytes) + ' · ' + dim + ' · ' + formatName(t.format) +
        '\n绑定: ' + t.bindCount + ' (每秒 ' + t.bindCountFrame + ')';

      html += '<tr class="' + rowClass + '" title="' + titleAttr.replace(/"/g, '&quot;') + '">'
        + '<td class="col-id">' + t.id + '</td>'
        + '<td class="col-size">' + fmtBytes(t.bytes) + '</td>'
        + '<td class="col-dim">' + dim + '</td>'
        + '<td class="col-fmt">' + formatName(t.format) + '</td>'
        + '<td class="col-bind">' + t.bindCount + '<br><span class="frame-bind">' + t.bindCountFrame + '/s</span></td>'
        + '<td class="col-resource">'
        + '<span class="res-name">' + escapeHtml(resName) + '</span>'
        + (resUrl ? '<span class="res-url">' + escapeHtml(resUrl) + '</span>' : '')
        + (stack ? '<span class="res-stack">' + escapeHtml(stack) + '</span>' : '')
        + '</td>'
        + '<td class="col-age">' + (t.age != null ? t.age + 's' : '-') + '</td>'
        + '<td class="col-action">'
        + '<button class="' + btnClass + '" data-action="toggle" data-id="' + t.id + '">' + btnText + '</button>'
        + (t.replaced
            ? '<button class="btn-restore" data-action="restore" data-id="' + t.id + '" title="恢复原始纹理: ' + escapeHtml(t.replacementName || '') + '">恢复</button>'
            : '<button class="btn-replace" data-action="replace" data-id="' + t.id + '">替换</button>')
        + '</td>'
        + '</tr>';
    }
    $('texBody').innerHTML = html;

    // 绑定所有操作按钮
    var btns = $('texBody').querySelectorAll('button[data-action]');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function (e) {
        var id = parseInt(e.target.getAttribute('data-id'), 10);
        var action = e.target.getAttribute('data-action');
        if (action === 'toggle') toggleHidden(id);
        else if (action === 'replace') startReplace(id);
        else if (action === 'restore') restoreTex(id);
      });
    }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function toggleHidden(id) {
    var resp = await requestTab('toggle-hidden', { id: id });
    if (resp && resp.ok) {
      // 更新本地数据
      for (var i = 0; i < allTextures.length; i++) {
        if (allTextures[i].id === id) {
          allTextures[i].hidden = resp.hidden;
          break;
        }
      }
      render();
    }
  }

  var pendingReplaceId = null;
  function startReplace(id) {
    pendingReplaceId = id;
    var input = $('fileInput');
    input.value = '';
    input.click();
  }

  function handleFileSelect(e) {
    var file = e.target.files[0];
    if (!file || pendingReplaceId == null) return;
    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (ev) {
      var dataUrl = ev.target.result;
      doReplace(pendingReplaceId, dataUrl, file.name);
      pendingReplaceId = null;
    };
    reader.onerror = function () {
      alert('读取文件失败');
      pendingReplaceId = null;
    };
    reader.readAsDataURL(file);
  }

  async function doReplace(id, dataUrl, name) {
    var resp = await requestTab('replace-texture', { id: id, dataUrl: dataUrl, name: name });
    if (resp && resp.ok) {
      // 更新本地数据
      for (var i = 0; i < allTextures.length; i++) {
        if (allTextures[i].id === id) {
          allTextures[i].replaced = true;
          allTextures[i].replacementName = name;
          allTextures[i].replacementWidth = resp.width;
          allTextures[i].replacementHeight = resp.height;
          break;
        }
      }
      render();
    } else {
      alert('替换失败: ' + (resp && resp.error ? resp.error : '未知错误'));
    }
  }

  async function restoreTex(id) {
    var resp = await requestTab('restore-texture', { id: id });
    if (resp && resp.ok) {
      for (var i = 0; i < allTextures.length; i++) {
        if (allTextures[i].id === id) {
          allTextures[i].replaced = false;
          allTextures[i].replacementName = '';
          break;
        }
      }
      render();
    }
  }

  function downloadFile(name, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function exportData(format) {
    var resp = await requestTab('export-textures', { format: format });
    if (resp && resp.ok && resp.data) {
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      if (format === 'json') {
        downloadFile('textures-' + ts + '.json', resp.data.data, 'application/json');
      } else {
        downloadFile('textures-' + ts + '.csv', resp.data.data, 'text/csv;charset=utf-8');
      }
    }
  }

  function init() {
    if (tabUrl) {
      $('tabInfo').textContent = tabUrl;
      document.title = '纹理明细 - ' + tabUrl.substring(0, 50);
    }

    $('searchInput').addEventListener('input', render);
    $('sortSelect').addEventListener('change', render);
    $('hideHidden').addEventListener('change', render);
    $('btnRefresh').addEventListener('click', loadTextures);
    $('btnExportCsv').addEventListener('click', function () { exportData('csv'); });
    $('btnExportJson').addEventListener('click', function () { exportData('json'); });
    $('fileInput').addEventListener('change', handleFileSelect);

    loadTextures();
    // 每 2 秒自动刷新
    refreshTimer = setInterval(loadTextures, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

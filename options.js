/**
 * options.js — 常驻监测网站白名单管理。
 *
 * 添加站点时必须先同步调用 chrome.permissions.request（用户手势内），
 * 授权成功后才写入 chrome.storage.sync；background.js 监听 storage 变化
 * 统一重新注册内容脚本。
 */
(function () {
  'use strict';

  var SITES_KEY = 'sites';

  function $(id) { return document.getElementById(id); }

  /* ---------- 输入 → match pattern ---------- */

  function toPattern(input) {
    var s = String(input || '').trim().toLowerCase();
    if (!s) return null;
    // 完整 pattern：scheme://host/path
    var m = s.match(/^(\*|https?|file):\/\/([^/]+)(.*)$/);
    if (m) {
      var host = m[2];
      if (!/^[a-z0-9*.-]+$/.test(host)) return null;
      var path = m[3] || '/*';
      return m[1] + '://' + host + path;
    }
    // 仅主机名：example.com / *.example.com / localhost
    if (!/^[a-z0-9*.-]+$/.test(s)) return null;
    if (s.indexOf('*') >= 0 && s.indexOf('*.') !== 0) return null;
    return '*://' + s + '/*';
  }

  function patternToHost(p) {
    var m = String(p).match(/^[^:]+:\/\/([^/]+)\/?/);
    return m ? m[1] : p;
  }

  /* ---------- 渲染 ---------- */

  function showMsg(text, cls) {
    var el = $('msg');
    el.textContent = text;
    el.className = 'msg ' + (cls || '');
  }

  function loadSites(cb) {
    chrome.storage.sync.get(SITES_KEY, function (items) {
      cb(items[SITES_KEY] || []);
    });
  }

  function saveSites(sites, cb) {
    chrome.storage.sync.set({ sites: sites }, cb || function () {});
  }

  function checkGranted(pattern, cb) {
    chrome.permissions.contains({ origins: [pattern] }, function (ok) {
      cb(!!ok && !chrome.runtime.lastError);
    });
  }

  function render() {
    loadSites(function (sites) {
      $('siteCount').textContent = sites.length ? '（' + sites.length + '）' : '';
      var list = $('siteList');
      var empty = $('siteEmpty');
      list.innerHTML = '';
      if (!sites.length) { empty.style.display = 'block'; return; }
      empty.style.display = 'none';

      var pending = sites.length;
      sites.forEach(function (p) {
        checkGranted(p, function (granted) {
          var li = document.createElement('li');

          var host = document.createElement('span');
          host.className = 'site-host';
          host.textContent = p;
          host.title = p;

          var tag = document.createElement('span');
          if (granted) {
            tag.className = 'tag ok';
            tag.textContent = '已授权';
          } else {
            tag.className = 'tag lost';
            tag.textContent = '授权已撤销';
          }

          var action = document.createElement('button');
          action.type = 'button';
          if (granted) {
            action.textContent = '删除';
            action.addEventListener('click', function () { removeSite(p); });
          } else {
            action.textContent = '重新授权';
            action.className = 'primary';
            action.addEventListener('click', function () { regrantSite(p); });
          }

          li.appendChild(host);
          li.appendChild(tag);
          li.appendChild(action);
          list.appendChild(li);

          if (--pending === 0) {
            // 授权被撤销的项排在最后，便于处理
            Array.prototype.slice.call(list.children)
              .sort(function (a, b) {
                var av = a.querySelector('.tag').className.indexOf('lost') >= 0 ? 1 : 0;
                var bv = b.querySelector('.tag').className.indexOf('lost') >= 0 ? 1 : 0;
                return av - bv;
              })
              .forEach(function (el) { list.appendChild(el); });
          }
        });
      });
    });
  }

  /* ---------- 操作 ---------- */

  function addSite() {
    var pattern = toPattern($('siteInput').value);
    if (!pattern) {
      showMsg('格式无效。请输入域名（如 example.com）或完整匹配串（如 https://*.example.com/game/*）。', 'err');
      return;
    }
    // 必须在用户手势内同步调用，之前不能有 await/异步
    chrome.permissions.request({ origins: [pattern] }, function (granted) {
      if (!granted) { showMsg('未授予该网站访问权限，已取消添加。', 'err'); return; }
      loadSites(function (sites) {
        if (sites.indexOf(pattern) >= 0) { showMsg('该网站已在白名单中。', 'err'); return; }
        sites.push(pattern);
        saveSites(sites, function () {
          $('siteInput').value = '';
          showMsg('已添加 ' + pattern + '，白名单网站的下一个页面开始自动监测。', 'ok');
          render();
        });
      });
    });
  }

  function removeSite(pattern) {
    loadSites(function (sites) {
      saveSites(sites.filter(function (p) { return p !== pattern; }), function () {
        chrome.permissions.remove({ origins: [pattern] }, function () {
          showMsg('已删除 ' + pattern + ' 并收回授权。', 'ok');
          render();
        });
      });
    });
  }

  function regrantSite(pattern) {
    chrome.permissions.request({ origins: [pattern] }, function (granted) {
      showMsg(granted ? '已恢复授权 ' + pattern + '。' : '未授予授权。', granted ? 'ok' : 'err');
      render();
    });
  }

  function init() {
    $('btnAdd').addEventListener('click', addSite);
    $('siteInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addSite();
    });
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

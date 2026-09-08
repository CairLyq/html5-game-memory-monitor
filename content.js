/**
 * content.js — 隔离世界（Isolated World）。
 *
 * 职责：
 *  1. 接收 hook.js（MAIN world，同步注入）通过 postMessage 推送的统计快照；
 *  2. 采样 performance.memory（JS 堆内存，仅 Chrome 系浏览器支持）；
 *  3. 响应 popup 的 get-stats / reset 消息。
 *
 * 注：hook.js 由 background.js 按白名单动态注册（document_start，MAIN world），
 *     或由 popup.js 通过 activeTab 临时注入，无需本脚本再动态注入。
 */
(function () {
  'use strict';
  if (window.__GAME_MEM_CONTENT__) return;
  window.__GAME_MEM_CONTENT__ = true;

  var MARK = 'game-mem-hook:v1';
  var CTL = 'game-mem-hook:ctl:v1';
  var latest = null;
  var pendingReplies = {};

  // 监听 hook.js 的回复
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (d && d.mark === MARK && d.replyTo && pendingReplies[d.replyTo]) {
      var cb = pendingReplies[d.replyTo];
      delete pendingReplies[d.replyTo];
      cb(d.data);
    }
  });

  function requestHook(cmd, extra, timeout) {
    return new Promise(function (resolve) {
      var id = cmd + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      var timer = setTimeout(function () {
        delete pendingReplies[id];
        resolve({ ok: false, error: 'timeout' });
      }, timeout || 3000);
      pendingReplies[id] = function (data) {
        clearTimeout(timer);
        resolve(data);
      };
      var msg = { mark: CTL, cmd: cmd, _reqId: id };
      if (extra) for (var k in extra) msg[k] = extra[k];
      window.postMessage(msg, '*');
    });
  }

  function readJsHeap() {
    try {
      var m = performance.memory;
      if (m && typeof m.usedJSHeapSize === 'number') {
        return { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit };
      }
    } catch (e) { /* 非 Chrome 环境无此 API */ }
    return null;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (d && d.mark === MARK && typeof d.t === 'number') {
      latest = d;
      latest.jsHeap = readJsHeap();
      latest.url = location.href;
      latest.title = document.title;
    }
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'get-stats') {
      sendResponse({
        ok: true,
        stats: latest,
        jsHeap: latest ? latest.jsHeap : readJsHeap(),
        url: location.href,
        title: document.title,
        instrumented: !!latest
      });
      return;
    }
    if (msg.type === 'reset') {
      window.postMessage({ mark: CTL, cmd: 'reset' }, '*');
      latest = null;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'show-hud') {
      window.postMessage({ mark: CTL, cmd: 'show-hud' }, '*');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'get-all-textures') {
      requestHook('get-all-textures').then(function (data) {
        sendResponse({ ok: true, textures: data });
      });
      return true; // 异步
    }
    if (msg.type === 'toggle-hidden') {
      requestHook('toggle-hidden', { id: msg.id }).then(function (data) {
        sendResponse(data);
      });
      return true;
    }
    if (msg.type === 'export-textures') {
      requestHook('export-textures', { format: msg.format || 'csv' }).then(function (data) {
        sendResponse(data);
      });
      return true;
    }
    if (msg.type === 'replace-texture') {
      requestHook('replace-texture', { id: msg.id, dataUrl: msg.dataUrl, name: msg.name }).then(function (data) {
        sendResponse(data);
      });
      return true;
    }
    if (msg.type === 'restore-texture') {
      requestHook('restore-texture', { id: msg.id }).then(function (data) {
        sendResponse(data);
      });
      return true;
    }
  });
})();

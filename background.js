/**
 * background.js — Service Worker。
 *
 * 职责：按用户在选项页配置的网站白名单，动态注册内容脚本。
 *
 * 设计：
 *  - 白名单存于 chrome.storage.sync 的 'sites'（match pattern 数组）；
 *  - storage.onChanged 触发后重新注册（options 页只写 storage，注册统一在这里做）；
 *  - 白名单网站在 document_start 注入 hook.js（MAIN world，页面脚本执行前挂钩 WebGL）
 *    和 content.js（隔离世界），persistAcrossSessions 保证注册跨浏览器重启生效；
 *  - 仅注册已通过 optional host permissions 授权的 pattern（用户在 chrome://extensions
 *    手动撤销授权后，自动跳过该站点）。
 */

var SITES_KEY = 'sites';
var HOOK_REG_ID = 'gmm-hook-main';
var CONTENT_REG_ID = 'gmm-content-iso';

// 串行化，避免 onChanged 与 onInstalled 并发注册/注销互相踩踏
var syncing = Promise.resolve();

function getSites() {
  return chrome.storage.sync.get(SITES_KEY).then(function (items) {
    return items[SITES_KEY] || [];
  });
}

function filterGranted(patterns) {
  return Promise.all(patterns.map(function (p) {
    return chrome.permissions.contains({ origins: [p] }).then(function (ok) {
      return ok ? p : null;
    });
  })).then(function (list) {
    return list.filter(Boolean);
  });
}

function syncRegistrations() {
  syncing = syncing.then(function () {
    return chrome.scripting.getRegisteredContentScripts().then(function (registered) {
      var ids = registered
        .map(function (s) { return s.id; })
        .filter(function (id) { return id === HOOK_REG_ID || id === CONTENT_REG_ID; });
      if (ids.length) return chrome.scripting.unregisterContentScripts({ ids: ids });
    }).then(function () {
      return getSites().then(filterGranted).then(function (sites) {
        if (!sites.length) return;
        return chrome.scripting.registerContentScripts([
          {
            id: HOOK_REG_ID,
            matches: sites,
            js: ['hook.js'],
            runAt: 'document_start',
            world: 'MAIN',
            persistAcrossSessions: true
          },
          {
            id: CONTENT_REG_ID,
            matches: sites,
            js: ['content.js'],
            runAt: 'document_start',
            persistAcrossSessions: true
          }
        ]);
      });
    });
  }).catch(function (err) {
    console.error('[GameMem] 同步内容脚本注册失败:', err);
  });
  return syncing;
}

chrome.runtime.onInstalled.addListener(function () { syncRegistrations(); });
chrome.runtime.onStartup.addListener(function () { syncRegistrations(); });
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'sync' && changes[SITES_KEY]) syncRegistrations();
});

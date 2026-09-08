# Chrome Web Store Listing — HTML5 游戏内存监测

> Last Updated: 2026-09-08

## Store Listing

**Extension Name**

HTML5 游戏内存监测

**Short Description**

监测 HTML5 游戏的内存、纹理显存、FPS 与绘制调用，仅在您指定的网站启用。

**Detailed Description**

为 HTML5 游戏开发者和性能调优者打造的内存监测工具：实时查看 JS 堆内存、WebGL 纹理显存、FPS、帧耗时与绘制调用，并自动识别 Phaser / PixiJS / Three.js / Babylon.js / Cocos / LayaAir 等常见游戏引擎。

主要功能：
• JS 堆内存：已用 / 总量 / 上限，含占比进度条与趋势图
• WebGL 资源：纹理、缓冲区、着色器、渲染缓冲的数量与估算显存
• 纹理明细列表：逐份纹理的大小、格式、尺寸与加载来源，支持排序、搜索、导出 CSV/JSON
• 性能指标：FPS、帧耗时、每帧绘制调用，附 45 秒趋势折线
• 页面内悬浮 HUD：可拖动、可折叠，随时查看关键指标

启用方式（完全由您掌控）：
• 白名单网站：把常用游戏站加入白名单，这些网站会在页面加载前自动开始监测
• 点击图标：点击工具栏图标即可对当前页面临时监测，不留任何权限
• 悬浮 HUD 默认关闭，需要时在弹窗中一键开启

隐私说明：不收集、不上传任何数据，所有统计仅保存在您的浏览器本地；只在您明确授权的网站或您点击图标时工作。

**Category**

Developer Tools

**Single Purpose**

监测 HTML5 游戏页面的内存与 WebGL 资源占用。

**Primary Language**

Chinese (Simplified)

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | icons/icon128.png |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | 🟡 Needs update | docs/screenshots/popup-overview.png |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | 🟡 Needs update | docs/screenshots/texture-panel.png |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes

- Screenshot 1：弹窗面板监测 demo 页（纹理数量与显存随时间增长），底部可见「白名单」按钮；建议标注"仅在你指定的网站启用"。
- Screenshot 2：页面内 HUD 面板 + 纹理明细弹窗；HUD 需手动开启（默认关闭），截图前先开启。
- 权限模型改动后（新增白名单按钮、HUD 默认关闭），两张截图均需重截。

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| scripting | permissions | 在用户授权的网站或用户点击扩展图标时，向页面注入监测脚本以统计该页面的内存与 WebGL 资源。没有它扩展无法工作。 |
| storage | permissions | 在本地保存用户的网站白名单和 HUD 显示偏好；数据不出设备。 |
| `*://*/*` | optional_host_permissions | 用户在选项页把某个网站加入白名单时，按该站点单独申请访问授权；仅用于在白名单网站注入监测脚本。用户可随时删除条目收回授权。 |
| `file:///*` | optional_host_permissions | 支持监测本地 file:// 打开的 HTML5 游戏页面，同样由用户主动添加并授权。 |

安装时不申请任何 host 权限（无"读取和更改您在所有网站上的数据"安装警告）；所有网站访问均为用户逐站点授予的 optional 权限。点击扩展图标使用 activeTab，无需常驻授权。

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

所有统计数据（内存、纹理、FPS 等）仅存在于当前浏览器会话本地；网站白名单与 HUD 偏好仅保存在本地 chrome.storage。无任何网络请求，无遥测，无第三方共享。

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**

（未发布；若上架，建议用 GitHub Pages 托管仓库内隐私政策页面。扩展本身无数据收集，政策可声明"不收集任何数据"。）

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name**

cair

**Contact Email**

（待填写）

**Support URL / Email**

https://github.com/CairLyq/html5-game-memory-monitor/issues

**Homepage URL**

https://github.com/CairLyq/html5-game-memory-monitor

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.7.0 | 2026-09-08 | 改为按需启用：网站白名单（逐站授权）+ 点击图标临时监测；HUD 默认关闭；安装时零网站权限警告 | Draft |
| 1.6.1 | — | 修复绘制调用指标为每帧口径 | 未提交 |

## Review Notes

### Known Issues / Limitations

- 点击图标临时监测只统计注入之后的资源，页面初始资源不计入（白名单方式完整统计）——弹窗内有明确提示。
- 需要 Chrome / Edge 111+。
- `performance.memory` 为 Chromium 独有，其他浏览器 JS 堆一栏显示 `--`。

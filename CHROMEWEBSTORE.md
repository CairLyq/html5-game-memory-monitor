# Chrome Web Store Listing — HTML5 游戏内存监测

> Last Updated: 2026-09-08

## Store Listing

**Extension Name**

HTML5 游戏内存监测

**Short Description**
<!-- 33 字，≤132 ✓ 直接粘贴下行 -->

监测 HTML5 游戏的内存、纹理显存、FPS 与绘制调用，自动识别游戏引擎，打开游戏页自动开始统计。

**Detailed Description**

为 HTML5 游戏开发者和性能调优者打造的内存监测工具：实时查看 JS 堆内存、WebGL 纹理显存、FPS、帧耗时与绘制调用，并自动识别 Phaser / PixiJS / Three.js / Babylon.js / Cocos / LayaAir 等常见游戏引擎。

主要功能：
• JS 堆内存：已用 / 总量 / 上限，含占比进度条与趋势图
• WebGL 资源：纹理、缓冲区、着色器、渲染缓冲的数量与估算显存
• 纹理明细列表：逐份纹理的大小、格式、尺寸与加载来源，支持排序、搜索、导出 CSV/JSON
• 性能指标：FPS、帧耗时、每帧绘制调用，附 45 秒趋势折线
• 页面内悬浮 HUD：可拖动、可折叠，随时查看关键指标

零配置使用：打开游戏页面即自动开始统计（识别到 WebGL 活动 / 游戏引擎的页面），点击工具栏图标即可查看；不需要在任何页面上手动开启。悬浮 HUD 默认关闭，需要时在弹窗中一键开启。不想监测某些网站时，可以在浏览器扩展详情页自行调整网站访问权限。

隐私说明：不收集、不上传任何数据，所有统计仅保存在您的浏览器本地。

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
| Screenshot 1 [REQUIRED] | 1280×800 | ✅ Ready | docs/screenshots/store-shot-1280x800-1.png |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ✅ Ready | docs/screenshots/store-shot-1280x800-2.png |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes

- Screenshot 1：弹窗面板（JS 堆 / GPU 资源 / 纹理明细 / 趋势折线）。
- Screenshot 2：纹理明细面板（显隐 / 排序 / 导出）。
- UI 大改后重截：在游戏页打开弹窗/面板截图，再用 PIL 合成到 1280×800 画布（深色主题同扩展样式）。

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `<all_urls>`（content_scripts） | host access | 监测脚本必须在游戏页面的任何脚本运行之前（document_start）注入并挂钩 WebGL API，才能统计到页面加载的全部资源；游戏可能运行在任何网站上，且引擎在早期初始化阶段就会创建 GPU 资源。挂钩有异常保护、非 WebGL 页面保持静默；用户可在扩展详情页自行收窄网站访问权限。 |

扩展不申请 tabs、storage 等其他权限，无 background，无遥测。

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
| 1.8.0 | 2026-09-08 | 移除白名单配置：恢复全站 document_start 注入，游戏页面（识别到 WebGL 活动/引擎）自动开始统计；弹窗按钮变化，截图需重截 | Draft |
| 1.7.1 | 2026-09-08 | 纹理来源深入解析：跳过引擎封装帧，显示业务侧调用帧；修复 CSV 中文标题乱码（UTF-8 BOM）；修复导出 undefined | 未提交 |
| 1.7.0 | 2026-09-08 | 网站白名单（逐站授权）+ 点击图标临时监测；HUD 默认关闭；LayaAir 3.x 逐层压缩纹理尺寸/显存修复 | 未提交 |
| 1.6.1 | — | 修复绘制调用指标为每帧口径 | 未提交 |

## Review Notes

### Known Issues / Limitations

- 点击图标临时监测只统计注入之后的资源，页面初始资源不计入（白名单方式完整统计）——弹窗内有明确提示。
- 需要 Chrome / Edge 111+。
- `performance.memory` 为 Chromium 独有，其他浏览器 JS 堆一栏显示 `--`。

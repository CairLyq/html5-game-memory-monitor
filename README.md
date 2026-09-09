# HTML5 游戏内存监测（Chrome / Edge 扩展）

一个 Manifest V3 浏览器扩展：实时监测 HTML5 游戏页面的 **JS 堆内存**、**WebGL 资源（纹理 / 缓冲区 / 着色器 / 程序）**、**FPS / 帧耗时** 与 **绘制调用**，并自动识别常见游戏引擎。

> 需要 Chrome / Edge **111+**（MAIN world content script）。Firefox 暂不适配（`performance.memory` 与 MAIN world 注册均不可用，JS 堆内存一栏会显示 `--`）。
>
> **零配置启用**：监测脚本在页面脚本运行前自动注入；识别到 WebGL 活动 / 游戏引擎的页面自动开始统计，点击扩展图标即可查看。非 WebGL 页面挂钩保持静默。页面内 HUD 默认关闭。

## 启用方式

- **自动**：打开游戏页面即自动开始统计（脚本在 `document_start` 注入页面主世界，游戏脚本运行前完成 WebGL 挂钩，页面加载的全部资源都可统计）；
- **页面内 HUD**：默认关闭。在弹窗中点击「显示 HUD」开启后会跨页面记住；点击 HUD 上的 `×` 关闭后不再自动弹出，可随时从弹窗重新打开；
- 如果不想让某些网站被监测，可在 `chrome://extensions` 扩展详情页把「网站访问权限」改为「在特定网站上」或「点击时」。

## 功能

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| JS 堆内存 | `performance.memory`（仅 Chrome 系） | 已用 / 总 / 上限，含占比进度条 |
| FPS / 帧耗时 | 挂钩 `requestAnimationFrame` | 每秒结算，帧耗时 EMA 平滑 |
| 绘制调用 | 挂钩 `drawArrays / drawElements`（含 Instanced / Range） | 累计 + 每秒速率 |
| 纹理数量与估算显存 | 挂钩 `texImage2D / texImage3D / texStorage2D / texStorage3D / compressedTexImage2D / compressedTexImage3D / generateMipmap / deleteTexture` | 按格式与尺寸估算，含 WebGL2 3D 纹理 / 2D 数组纹理 |
| 纹理来源（创建/上传位置） | 捕获 `createTexture` 和首次 `texImage2D / texImage3D / texStorage*` 的调用栈，解析函数名 / 文件 / 行号 | 弹窗纹理明细列表，按显存降序，悬停查看完整栈 |
| 渲染缓冲（Renderbuffer） | 挂钩 `createRenderbuffer / deleteRenderbuffer / renderbufferStorage / renderbufferStorageMultisample` | 数量与估算显存，含多重采样倍数 |
| 缓冲区数量与估算显存 | 挂钩 `bufferData / bufferSubData / deleteBuffer` | 按字节数统计 |
| 着色器 / 程序 | 挂钩 create/delete | 存活数量 |
| 引擎识别 | 检测全局对象 | Phaser / PixiJS / Three.js / Babylon.js / Cocos / LayaAir / CreateJS / PlayCanvas / melonJS / Unity WebGL |

## 截图预览

### 弹窗面板

![弹窗面板](docs/screenshots/popup-overview.png)

实时显示 JS 堆内存、纹理数量与显存、FPS、帧耗时、绘制调用，以及纹理明细列表（含资源名称与加载地址）。

### 纹理明细面板

![纹理明细面板](docs/screenshots/texture-panel.png)

全量纹理列表，支持搜索、排序、显隐调试、素材替换、绑定次数统计，以及 CSV/JSON 导出。

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）；
2. 打开右上角 **开发者模式**；
3. 点击 **加载已解压的扩展程序**，选择本目录 `html5-game-memory-monitor`；
4. 打开 HTML5 游戏页面（或 `demo/game.html`），点击扩展图标查看面板。

> 安装扩展后，**已打开的页面需要刷新一次**（脚本在 `document_start` 注入）。
> 若要监测 `file://` 打开的本地页面，需在扩展详情页开启 **“允许访问文件网址”**。

## 演示页

```bash
# 方式一：直接双击 demo/game.html（需开启 file 访问权限）
# 方式二：本地起一个静态服务
python -m http.server 8000 --directory demo
# 访问 http://localhost:8000/game.html
```

演示页每 1.5 秒创建一张 256×256 RGBA 纹理（约 0.25MB，含 mipmap 约 0.33MB），累积到 60 张后停止，便于观察纹理数量与估算显存随时间的增长。

## 架构

```
页面（主世界 Main World）                扩展（隔离世界）                弹窗
┌───────────────────────┐   postMessage   ┌────────────────────┐  chrome.runtime  ┌──────────┐
│ hook.js               │ ───────────────▶ │ content.js         │ ───────────────▶ │ popup    │
│ 挂钩 getContext/WebGL │  快照 500ms/次   │ 缓存快照           │  get-stats/reset │ 渲染+折线 │
│ 统计资源/绘制/FPS     │ ◀─────────────── │ 采样 JS 堆         │ ◀─────────────── │ 按钮     │
│ 识别引擎               │  控制消息(重置)  │ 响应控制消息        │                  │          │
└───────────────────────┘                  └────────────────────┘                  └──────────┘
```

- **manifest.json**：静态注册 `content_scripts`（hook.js → MAIN world，content.js → 隔离世界，均 `document_start`）；无 background、无额外权限。
- **hook.js**：页面主世界挂钩脚本，在页面任何脚本之前完成 WebGL API 挂钩（解决 Laya 等引擎早期初始化错过的问题）。挂钩 `WebGLRenderingContext` 与 `WebGL2RenderingContext`（含 3D 纹理 / 2D 数组纹理 / 渲染缓冲）。所有挂钩 try/catch 保护，不影响游戏运行。第一次 WebGL 方法调用自动激活统计；识别到引擎全局对象后自动打上引擎标签；带 `__GAME_MEM_HOOK__` 防重复注入；在 XHR / fetch 加载层标记二进制资源 URL，上传纹理时反查来源。
- **content.js**：隔离世界。接收 hook 快照、采样 JS 堆、响应弹窗消息。
- **popup**：纯前端弹窗，无外部依赖；用 Canvas 绘制 FPS / JS 堆 / 纹理显存三条趋势折线（最近约 45 秒）。

## 项目结构

```
html5-game-memory-monitor/
├── manifest.json          # MV3 清单（静态 content_scripts，document_start 注入）
├── hook.js                # 主世界 WebGL 挂钩（核心）
├── content.js             # 隔离世界消息层
├── popup.html / popup.css / popup.js
├── icons/                 # 16/48/128 图标（tools/gen_icons.py 生成，需要 Pillow）
├── demo/game.html         # 纹理增长演示页
├── tests/hook.test.js     # 单元测试（纯函数 + 伪造 WebGL 环境挂钩逻辑）
├── tests/layaair-replay.js # LayaAir 3.x 真实调用序列回归测试
└── tools/gen_icons.py     # 图标生成脚本（需要 Pillow）
```

## 测试

```bash
node tests/hook.test.js
```

覆盖：格式→字节换算表、纹理/压缩纹理估算、纹理上传/删除/mipmap/texStorage2D 的显存增减、缓冲区字节统计、绘制调用计数、着色器/程序计数、重置消息、返回值不被破坏。

## 口径与已知限制

- **显存为估算值**：按 `internalFormat × 尺寸` 计算；`texSubImage2D` 部分更新按整幅重估；压缩格式按 4×4 块近似（ASTC/PVRTC 块尺寸不同）；纹理显存不含采样器状态与帧缓冲附件引用。
- **纹理来源为调用栈解析**：记录 `createTexture` 和首次 `texImage2D` 的调用位置，并沿调用栈深入解析：入口帧通常是引擎 GL 封装层（如 `laya.webgl_2D.js`），会继续跳过引擎 bundle 帧，提取第一个业务侧帧（加载器回调 / 场景反序列化 / 业务代码）作为来源展示；引擎内部生成的纹理（渲染目标、阴影图）无业务帧时回退显示入口帧。若代码被压缩或混淆，函数名可能不直观；视频纹理等每帧重复上传只记录首次上传来源；快照最多携带显存最大的 50 份纹理明细。
- **JS 堆内存**：Chrome 独有 API；数字包含 GC 未回收部分，作为趋势参考而非精确占用。
- 安装扩展前已打开的页面不会自动注入，刷新即可。
- 不想监测某些网站时，可在扩展详情页调整「网站访问权限」（如仅限特定网站或点击时）。
- **WebGPU 游戏**：暂未挂钩（可在 hook.js 中扩展 `navigator.gpu`）。
- **OffscreenCanvas** 中的 WebGL 上下文未追踪（可在 `getContext` 挂钩中扩展）。

## 扩展点

- 想加 WebGPU 统计：在 `hook.js` 挂钩 `navigator.gpu.requestAdapter`，统计 buffer/texture 分配。
- 想加音频内存：挂钩 `AudioContext` / `createBuffer`。
- 想加录制导出：popup 里把 `hist` 历史数据序列化导出 CSV/JSON。

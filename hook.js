/**
 * hook.js — 注入页面“主世界”(Main World) 的 WebGL 资源挂钩脚本。
 *
 * 注入方式：在 manifest.json 中注册为 MAIN world content script，document_start 同步执行，
 *           确保在页面任何脚本之前完成 WebGL API 挂钩（解决 Laya 等引擎早期初始化错过的问题）。
 *
 * 职责：
 *  - 挂钩 HTMLCanvasElement.getContext，检测 WebGL / WebGL2 上下文；
 *  - 统计纹理（含 WebGL2 3D 纹理 / 2D 数组纹理）/ 缓冲区 / 着色器 / 着色程序 / 渲染缓冲的数量与估算显存；
 *  - 为每一份纹理和渲染缓冲记录来源（创建 / 上传位置的函数名、文件、行号）；
 *  - 统计绘制调用次数、FPS、帧耗时；
 *  - 识别常见 HTML5 游戏引擎（Phaser / PixiJS / Three.js / Babylon.js / Cocos / LayaAir 等）；
 *  - 每 500ms 通过 window.postMessage 把统计快照（含纹理/渲染缓冲明细）推送给 content script。
 *
 * 设计约束：
 *  - 所有挂钩均以 try/catch 保护，失败时静默跳过，绝不影响游戏运行；
 *  - 第一次 WebGL 方法调用自动激活统计（兜底：即使 getContext 被错过也能开始统计）；
 *  - 纹理 / 缓冲区 / 渲染缓冲显存为“估算值”，口径见 README；
 *  - 调用栈仅在 createTexture / createRenderbuffer 和首次上传时捕获，避免每帧开销；
 *  - 用 postMessage 与隔离世界通信（content script 无法读取页面 JS 对象）。
 */
(function () {
  'use strict';

  var MARK = 'game-mem-hook:v1';
  var CTL = 'game-mem-hook:ctl:v1';

  /* ================= 一、纯函数：显存估算与栈解析（可在 Node 中单测） ================= */

  // WebGL2 尺寸化 internalFormat -> 每像素字节
  function sizedBytes(fmt) {
    switch (fmt) {
      case 0x8229: case 0x8232: case 0x8231: return 1;           // R8 / R8UI / R8I
      case 0x822B: case 0x8237: case 0x8238: case 0x822D: return 2; // RG8 / RG8I / RG8UI / R16F
      case 0x8057: case 0x8035: case 0x806F: return 2;           // RGB565 / RGBA4 / RGB5_A1
      case 0x81A5: return 2;                                     // DEPTH_COMPONENT16
      case 0x8059: case 0x8C40: return 3;                        // RGB8 / SRGB8
      case 0x81A6: return 3;                                     // DEPTH_COMPONENT24
      case 0x8058: case 0x8C41: case 0x8D97: case 0x8D96: return 4; // RGBA8 / SRGB8_ALPHA8 / RGBA8UI / RGB8UI
      case 0x822E: case 0x8CAC: return 4;                        // R32F / DEPTH_COMPONENT32F
      case 0x822F: return 4;                                     // RG16F
      case 0x88F0: return 4;                                     // DEPTH24_STENCIL8
      case 0x881B: return 6;                                     // RGB16F
      case 0x8230: return 8;                                     // RG32F
      case 0x881A: return 8;                                     // RGBA16F
      case 0x8DAD: return 8;                                     // DEPTH32F_STENCIL8
      case 0x8815: return 12;                                    // RGB32F
      case 0x8814: return 16;                                    // RGBA32F
      case 0x906F: return 4;                                     // RGB10_A2
      default: return 0;
    }
  }

  // 组件类型 -> 每组件字节
  function componentBytes(type) {
    switch (type) {
      case 0x1400: case 0x1401: return 1;                        // BYTE / UNSIGNED_BYTE
      case 0x1402: case 0x1403: case 0x8033: case 0x8034:
      case 0x8363: case 0x140B: return 2;                        // SHORT / UNSIGNED_SHORT / 4444 / 5551 / 565 / HALF_FLOAT
      case 0x1404: case 0x1405: case 0x1406: case 0x8368:
      case 0x84FA: case 0x8C3B: return 4;                        // INT / UNSIGNED_INT / FLOAT / 2_10_10_10_REV / 24_8 / 10F_11F_11F_REV
      case 0x8DAD: return 8;                                     // FLOAT_32_UNSIGNED_INT_24_8_REV
      default: return 0;
    }
  }

  // 非尺寸化格式 -> 通道数
  function channelsForFormat(fmt) {
    switch (fmt) {
      case 0x1908: return 4;                                     // RGBA
      case 0x1907: return 3;                                     // RGB
      case 0x190A: return 2;                                     // LUMINANCE_ALPHA
      case 0x84F9: return 2;                                     // DEPTH_STENCIL
      case 0x8227: case 0x8228: return 2;                        // RG / RG_INTEGER
      case 0x1906: case 0x1909: case 0x1902: case 0x1903: return 1; // ALPHA / LUMINANCE / DEPTH_COMPONENT / RED
      default: return 0;
    }
  }

  function bytesPerPixel(internalFormat, type) {
    var bpp = sizedBytes(internalFormat);
    if (bpp) return bpp;
    var ch = channelsForFormat(internalFormat);
    if (!ch) return 0;
    var cb = componentBytes(type || 0x1401);
    return cb ? ch * cb : 0;
  }

  function estimateTexBytes(internalFormat, width, height, type) {
    if (!width || !height) return 0;
    var bpp = bytesPerPixel(internalFormat, type);
    return bpp ? width * height * bpp : 0;
  }

  // 压缩格式 -> 每 4x4 块字节（近似；ASTC/PVRTC 块尺寸不同，按 4x4 估算）
  var COMPRESSED_BLOCK = {
    0x83F0: 8, 0x83F1: 8, 0x83F2: 16, 0x83F3: 16,                 // S3TC DXT1 / DXT3 / DXT5
    0x8DBB: 8, 0x8DBC: 8, 0x8DBD: 16, 0x8DBE: 16,                 // RGTC
    0x8D64: 8,                                                     // ETC1
    0x9270: 8, 0x9271: 8, 0x9272: 16, 0x9273: 8, 0x9274: 8,
    0x9275: 16, 0x9276: 8, 0x9277: 8, 0x9278: 16, 0x9279: 16,     // ETC2 / EAC
    0x8C00: 8, 0x8C01: 8, 0x8C02: 8, 0x8C03: 8,
    0x8C04: 16, 0x8C05: 16, 0x8C06: 16, 0x8C07: 16,               // PVRTC
    0x93B0: 16, 0x93B1: 16, 0x93B2: 16, 0x93B3: 16,               // ASTC 4x4
    0x8E8C: 16, 0x8E8D: 16, 0x8E8E: 16, 0x8E8F: 16                // BPTC
  };

  function estimateCompressedBytes(internalFormat, width, height) {
    if (!width || !height) return 0;
    var block = COMPRESSED_BLOCK[internalFormat] || 16;
    return block * Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));
  }

  // 解析 V8 调用栈，提取第一个非 hook.js 自身的帧
  function parseSource(stack) {
    var empty = { func: '', file: '', line: 0, raw: '' };
    if (!stack) return empty;
    var lines = stack.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.indexOf('hook.js') >= 0) continue;
      if (line.indexOf('captureStack') >= 0) continue;
      var m = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
      if (m) return { func: m[1], file: m[2], line: parseInt(m[3], 10), raw: line.trim() };
      m = line.match(/at\s+(.+?):(\d+):(\d+)/);
      if (m) return { func: '', file: m[1], line: parseInt(m[2], 10), raw: line.trim() };
      m = line.match(/(.+?)@(.+?):(\d+):(\d+)/);
      if (m) return { func: m[1], file: m[2], line: parseInt(m[3], 10), raw: line.trim() };
    }
    return empty;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      sizedBytes: sizedBytes,
      componentBytes: componentBytes,
      channelsForFormat: channelsForFormat,
      bytesPerPixel: bytesPerPixel,
      estimateTexBytes: estimateTexBytes,
      estimateCompressedBytes: estimateCompressedBytes,
      parseSource: parseSource
    };
  }

  if (typeof window === 'undefined') return;

  /* ================= 二、浏览器挂钩逻辑 ================= */

  var GL_TEXTURE_2D = 0x0DE1;
  var GL_TEXTURE_3D = 0x806F;
  var GL_TEXTURE_2D_ARRAY = 0x8C1A;
  var GL_TEXTURE_BINDING_2D = 0x8069;
  var GL_TEXTURE_BINDING_3D = 0x806A;
  var GL_TEXTURE_BINDING_2D_ARRAY = 0x8C1D;
  var GL_RENDERBUFFER_BINDING = 0x8CA7;

  var state = {
    enabled: true,
    active: false,          // 是否已检测到 WebGL 活动（第一次 WebGL 调用自动置 true）
    contexts: 0,
    fps: 0,
    frameMs: 0,
    lastFrameT: 0,
    rafFrames: 0,
    rafLast: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
    drawCalls: 0,
    texturesAlive: 0,
    texBytes: 0,
    buffersAlive: 0,
    bufBytes: 0,
    shadersAlive: 0,
    programsAlive: 0,
    activeProgram: 0,
    renderbuffersAlive: 0,
    rbBytes: 0,
    engine: null,
    engineVersion: ''
  };

  // 纹理注册表：key = WebGLTexture，value = 元数据
  var textureRegistry = new Map();
  var nextTexId = 1;

  // 渲染缓冲注册表：key = WebGLRenderbuffer，value = 元数据
  var renderbufferRegistry = new Map();
  var nextRbId = 1;

  var bufBytesMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var ctxSeen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function safeGetParam(gl, p) {
    try { return gl.getParameter(p); } catch (e) { return null; }
  }

  function captureStack() {
    try {
      var err = new Error();
      return err.stack || '';
    } catch (e) { return ''; }
  }

  // 根据 target 返回对应的纹理绑定查询常量
  function bindingForTarget(target) {
    if (target === GL_TEXTURE_3D) return GL_TEXTURE_BINDING_3D;
    if (target === GL_TEXTURE_2D_ARRAY) return GL_TEXTURE_BINDING_2D_ARRAY;
    return GL_TEXTURE_BINDING_2D;
  }

  function getBoundTexMeta(gl, target) {
    var tex = safeGetParam(gl, bindingForTarget(target));
    if (!tex) return null;
    return textureRegistry.get(tex) || null;
  }

  function updateTexBytes(meta, baseBytes) {
    if (!meta) return;
    var factor = meta.mip ? 4 / 3 : 1;
    var next = baseBytes * factor;
    state.texBytes += next - meta.bytes;
    meta.bytes = next;
  }

  // 通用挂钩：先调用原方法，再执行 wrapper(orig, args, ret)
  // 第一次 WebGL 方法调用自动激活 state.active（兜底，即使 getContext 被错过）
  // 按原型分别去重（WebGL1 和 WebGL2 原型可能各自定义同名方法，需分别 patch）
  var patched = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function patch(proto, name, wrapper) {
    if (!proto) return;
    if (patched) {
      if (!patched.has(proto)) patched.set(proto, {});
      var seen = patched.get(proto);
      if (seen[name]) return;
      seen[name] = true;
    }
    if (typeof proto[name] !== 'function') return;
    var orig = proto[name];
    try {
      proto[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        var ret = orig.apply(this, args);
        if (state.enabled) {
          if (!state.active) state.active = true;
          try { wrapper.call(this, orig, args, ret); } catch (e) { /* 静默，不干扰游戏 */ }
        }
        return ret;
      };
    } catch (e) { /* 忽略 */ }
  }

  // 同时 patch WebGL1 和 WebGL2 原型（Chrome 147+ 中 WebGL2 原型不继承 WebGL1 原型）
  function patchBoth(name, wrapper) {
    patch(R, name, wrapper);
    patch(R2, name, wrapper);
  }

  var R = typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null;
  var R2 = typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null;

  // ---- 纹理显隐替换 ----
  // 隐藏纹理时，在 bindTexture 中把它替换成 1x1 透明纹理，游戏中对应区域变透明
  var hiddenTextures = typeof Set !== 'undefined' ? new Set() : null;
  var dummyTex = null;
  // 纹理替换：key = 原始 WebGLTexture，value = { tex: 替代纹理, name: 替换来源, width, height }
  var replacementTextures = typeof Map !== 'undefined' ? new Map() : null;

  function getDummyTex(gl) {
    if (!dummyTex) {
      try {
        dummyTex = gl.createTexture();
        gl.bindTexture(0x0DE1, dummyTex);
        var pixels = new Uint8Array([0, 0, 0, 0]);
        gl.texImage2D(0x0DE1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, pixels);
        gl.texParameteri(0x0DE1, 0x2801, 0x2600);
        gl.texParameteri(0x0DE1, 0x2800, 0x2600);
      } catch (e) { dummyTex = null; }
    }
    return dummyTex;
  }

  // bindTexture 需要在 orig 之前替换 texture，所以不用通用 patch（通用 patch 先 orig 后 wrapper）
  function patchBindTexture(proto) {
    if (!proto) return;
    if (patched) {
      if (!patched.has(proto)) patched.set(proto, {});
      var seen = patched.get(proto);
      if (seen['bindTexture']) return;
      seen['bindTexture'] = true;
    }
    if (typeof proto.bindTexture !== 'function') return;
    var orig = proto.bindTexture;
    try {
      proto.bindTexture = function (target, texture) {
        if (state.enabled) {
          if (!state.active) state.active = true;
          // 绑定计数（基于原始纹理）
          if (texture && textureRegistry.has(texture)) {
            var meta = textureRegistry.get(texture);
            meta.bindCount++;
            meta.bindCountFrame++;
          }
          // 替换纹理（优先级高于隐藏）
          if (replacementTextures && texture && replacementTextures.has(texture)) {
            var rep = replacementTextures.get(texture);
            if (rep && rep.tex) texture = rep.tex;
          } else if (hiddenTextures && texture && hiddenTextures.has(texture)) {
            // 隐藏替换
            var dt = getDummyTex(this);
            if (dt) texture = dt;
          }
        }
        return orig.call(this, target, texture);
      };
    } catch (e) { /* 忽略 */ }
  }
  patchBindTexture(R);
  patchBindTexture(R2);

  // ---- 纹理 ----
  patchBoth('createTexture', function (orig, args, tex) {
    if (!tex) return;
    textureRegistry.set(tex, {
      id: nextTexId++,
      bytes: 0,
      format: null,
      width: 0,
      height: 0,
      depth: 0,
      target: 0,
      mip: false,
      createdAt: now(),
      createdSource: parseSource(captureStack()),
      uploadedAt: 0,
      uploadedSource: null,
      sourceUrl: '',
      sourceName: '',
      bindCount: 0,
      bindCountFrame: 0
    });
    state.texturesAlive++;
  });

  patchBoth('deleteTexture', function (orig, args) {
    var tex = args[0];
    if (tex) {
      var meta = textureRegistry.get(tex);
      if (meta) {
        state.texBytes -= meta.bytes;
        textureRegistry.delete(tex);
      }
      if (hiddenTextures) hiddenTextures.delete(tex);
      if (replacementTextures && replacementTextures.has(tex)) {
        var rep = replacementTextures.get(tex);
        if (rep && rep.tex) {
          try { orig.call(this, 0x0DE1, rep.tex); } catch (e) {}
        }
        replacementTextures.delete(tex);
      }
    }
    if (state.texturesAlive > 0) state.texturesAlive--;
  });

  function parseTexImageArgs(args) {
    var internalFormat = args[2];
    var width = 0, height = 0, type = 0x1401;
    if (args.length > 6) {
      width = args[3]; height = args[4]; type = args[7] || 0x1401;
    } else {
      type = args[4] || 0x1401;
      var src = args[5];
      if (src) { width = src.width || 0; height = src.height || 0; }
    }
    return { internalFormat: internalFormat, width: width, height: height, type: type };
  }

  // 从 texImage2D 参数中提取 pixels 对象（支持 9 参数和 6 参数两种签名）
  function extractPixels(args) {
    if (args.length > 6) return args[8]; // 9 参数：pixels 是第 9 个
    return args[5]; // 6 参数：pixels 是第 6 个
  }

  // 从 pixels 对象中提取资源来源（URL/名称）
  function extractSourceFromPixels(pixels) {
    if (!pixels) return null;
    var cname = pixels.constructor ? pixels.constructor.name : '';
    if (cname === 'HTMLImageElement' || (typeof HTMLImageElement !== 'undefined' && pixels instanceof HTMLImageElement)) {
      return { url: pixels.currentSrc || pixels.src || '', name: pixels.alt || pixels.name || '', type: 'image' };
    }
    if (cname === 'HTMLCanvasElement' || (typeof HTMLCanvasElement !== 'undefined' && pixels instanceof HTMLCanvasElement)) {
      return { url: '', name: pixels.id || 'canvas', type: 'canvas' };
    }
    if (cname === 'ImageBitmap' || (typeof ImageBitmap !== 'undefined' && pixels instanceof ImageBitmap)) {
      return { url: '', name: 'ImageBitmap', type: 'imagebitmap' };
    }
    if (cname === 'HTMLVideoElement' || (typeof HTMLVideoElement !== 'undefined' && pixels instanceof HTMLVideoElement)) {
      return { url: pixels.currentSrc || pixels.src || '', name: 'video', type: 'video' };
    }
    if (pixels.buffer || (typeof pixels.byteLength === 'number' && typeof pixels.BYTES_PER_ELEMENT === 'number')) {
      return { url: '', name: 'raw pixel data', type: 'raw' };
    }
    return null;
  }

  function uploadTex2D(gl, args, compressed) {
    var target = args[0];
    var bytes = compressed
      ? estimateCompressedBytes(args[2], args[3], args[4])
      : (function () { var p = parseTexImageArgs(args); return estimateTexBytes(p.internalFormat, p.width, p.height, p.type); })();
    if (bytes <= 0) return;
    var meta = getBoundTexMeta(gl, target);
    if (!meta) return;
    if (!meta.uploadedAt) {
      meta.uploadedSource = parseSource(captureStack());
      meta.uploadedAt = now();
    }
    // 提取 pixels 来源（图片 URL / canvas / ImageBitmap 等）
    if (!meta.sourceUrl && !meta.sourceName) {
      var srcInfo = extractSourceFromPixels(extractPixels(args));
      if (srcInfo) {
        meta.sourceUrl = srcInfo.url;
        meta.sourceName = srcInfo.name;
      }
    }
    var p = parseTexImageArgs(args);
    meta.format = compressed ? args[2] : p.internalFormat;
    meta.width = compressed ? args[3] : p.width;
    meta.height = compressed ? args[4] : p.height;
    meta.target = target;
    updateTexBytes(meta, bytes);
  }

  // texSubImage2D 专用：只提取 pixels 来源，不更新字节数（字节数由 texImage2D / texStorage2D 负责）
  // texSubImage2D 签名：(target, level, xoffset, yoffset, width, height, format, type, pixels) 9 参数
  //              或 (target, level, xoffset, yoffset, format, type, pixels) 7 参数
  function uploadTexSubImage2D(gl, args) {
    var meta = getBoundTexMeta(gl, args[0]);
    if (!meta) return;
    if (!meta.uploadedAt) {
      meta.uploadedSource = parseSource(captureStack());
      meta.uploadedAt = now();
    }
    if (!meta.sourceUrl && !meta.sourceName) {
      var pixels = args.length > 7 ? args[8] : args[6];
      var srcInfo = extractSourceFromPixels(pixels);
      if (srcInfo) {
        meta.sourceUrl = srcInfo.url;
        meta.sourceName = srcInfo.name;
      }
    }
  }

  patchBoth('texImage2D', function (orig, args) { uploadTex2D(this, args, false); });
  patchBoth('texSubImage2D', function (orig, args) { uploadTexSubImage2D(this, args); });
  patchBoth('compressedTexImage2D', function (orig, args) { uploadTex2D(this, args, true); });

  patchBoth('generateMipmap', function () {
    var meta = getBoundTexMeta(this, GL_TEXTURE_2D);
    if (!meta || meta.mip || meta.bytes <= 0) return;
    meta.mip = true;
    var add = meta.bytes / 3;
    meta.bytes += add;
    state.texBytes += add;
  });

  // WebGL2：texStorage2D
  patch(R2, 'texStorage2D', function (orig, args) {
    if (args[0] !== GL_TEXTURE_2D && args[0] !== GL_TEXTURE_2D_ARRAY) return;
    var levels = args[1], internalFormat = args[2], w = args[3], h = args[4];
    var bpp = sizedBytes(internalFormat);
    if (!bpp || !w || !h) return;
    var total = 0, cw = w, ch = h;
    for (var i = 0; i < levels; i++) {
      total += bpp * cw * ch;
      cw = Math.max(1, cw >> 1);
      ch = Math.max(1, ch >> 1);
    }
    var meta = getBoundTexMeta(this, args[0]);
    if (!meta) return;
    if (!meta.uploadedAt) {
      meta.uploadedSource = parseSource(captureStack());
      meta.uploadedAt = now();
    }
    meta.format = internalFormat;
    meta.width = w;
    meta.height = h;
    meta.target = args[0];
    meta.mip = true;
    updateTexBytes(meta, total / (4 / 3));
  });

  // WebGL2：3D 纹理 / 2D 数组纹理
  function uploadTex3D(gl, args, compressed) {
    var target = args[0];
    var internalFormat = args[2];
    var width = args[3], height = args[4], depth = args[5];
    var type = args[8] || 0x1401;
    var bytes = compressed
      ? (COMPRESSED_BLOCK[internalFormat] || 16) * Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * Math.max(1, Math.ceil(depth / 4))
      : width * height * depth * bytesPerPixel(internalFormat, type);
    if (bytes <= 0) return;
    var meta = getBoundTexMeta(gl, target);
    if (!meta) return;
    if (!meta.uploadedAt) {
      meta.uploadedSource = parseSource(captureStack());
      meta.uploadedAt = now();
    }
    meta.format = internalFormat;
    meta.width = width;
    meta.height = height;
    meta.depth = depth;
    meta.target = target;
    updateTexBytes(meta, bytes);
  }

  patch(R2, 'texImage3D', function (orig, args) { uploadTex3D(this, args, false); });
  patch(R2, 'texSubImage3D', function (orig, args) { uploadTex3D(this, args, false); });
  patch(R2, 'compressedTexImage3D', function (orig, args) { uploadTex3D(this, args, true); });

  patch(R2, 'texStorage3D', function (orig, args) {
    var target = args[0], levels = args[1], internalFormat = args[2];
    var w = args[3], h = args[4], d = args[5];
    var bpp = sizedBytes(internalFormat);
    if (!bpp || !w || !h || !d) return;
    var total = 0, cw = w, ch = h, cd = d;
    for (var i = 0; i < levels; i++) {
      total += bpp * cw * ch * cd;
      cw = Math.max(1, cw >> 1);
      ch = Math.max(1, ch >> 1);
      cd = Math.max(1, cd >> 1);
    }
    var meta = getBoundTexMeta(this, target);
    if (!meta) return;
    if (!meta.uploadedAt) {
      meta.uploadedSource = parseSource(captureStack());
      meta.uploadedAt = now();
    }
    meta.format = internalFormat;
    meta.width = w;
    meta.height = h;
    meta.depth = d;
    meta.target = target;
    meta.mip = true;
    updateTexBytes(meta, total / (4 / 3));
  });

  // ---- 渲染缓冲（Renderbuffer）----
  patchBoth('createRenderbuffer', function (orig, args, rb) {
    if (!rb) return;
    renderbufferRegistry.set(rb, {
      id: nextRbId++,
      bytes: 0,
      format: null,
      width: 0,
      height: 0,
      samples: 0,
      createdAt: now(),
      createdSource: parseSource(captureStack())
    });
    state.renderbuffersAlive++;
  });

  patchBoth('deleteRenderbuffer', function (orig, args) {
    var rb = args[0];
    if (rb) {
      var meta = renderbufferRegistry.get(rb);
      if (meta) {
        state.rbBytes -= meta.bytes;
        renderbufferRegistry.delete(rb);
      }
    }
    if (state.renderbuffersAlive > 0) state.renderbuffersAlive--;
  });

  function updateRenderbuffer(gl, args, multisample) {
    var rb = safeGetParam(gl, GL_RENDERBUFFER_BINDING);
    if (!rb) return;
    var meta = renderbufferRegistry.get(rb);
    if (!meta) return;
    var internalFormat, width, height, samples = 0;
    if (multisample) {
      samples = args[1] || 0;
      internalFormat = args[2];
      width = args[3];
      height = args[4];
    } else {
      internalFormat = args[1];
      width = args[2];
      height = args[3];
    }
    var bpp = sizedBytes(internalFormat);
    if (!bpp) bpp = bytesPerPixel(internalFormat, 0x1401); // 兜底
    if (!bpp || !width || !height) return;
    var bytes = width * height * bpp * Math.max(1, samples);
    var prev = meta.bytes;
    meta.bytes = bytes;
    meta.format = internalFormat;
    meta.width = width;
    meta.height = height;
    meta.samples = samples;
    state.rbBytes += bytes - prev;
  }

  patchBoth('renderbufferStorage', function (orig, args) { updateRenderbuffer(this, args, false); });
  patch(R2, 'renderbufferStorageMultisample', function (orig, args) { updateRenderbuffer(this, args, true); });

  // ---- 缓冲区 ----
  patchBoth('createBuffer', function () { state.buffersAlive++; });
  patchBoth('deleteBuffer', function (orig, args) {
    if (state.buffersAlive > 0) state.buffersAlive--;
    var buf = args[0];
    if (buf && bufBytesMap) {
      var b = bufBytesMap.get(buf) || 0;
      if (b) { state.bufBytes -= b; bufBytesMap.delete(buf); }
    }
  });
  patchBoth('bufferData', function (orig, args) {
    var target = args[0];
    var size = typeof args[1] === 'number' ? args[1] : (args[1] && args[1].byteLength) || 0;
    var bind = target === 0x8892 ? 0x8894 : target === 0x8893 ? 0x8895 : null;
    if (!bind || !size || !bufBytesMap) return;
    var buf = safeGetParam(this, bind);
    if (!buf) return;
    var prev = bufBytesMap.get(buf) || 0;
    bufBytesMap.set(buf, size);
    state.bufBytes += size - prev;
  });
  patchBoth('bufferSubData', function (orig, args) {
    var target = args[0], offset = args[1] || 0;
    var size = (args[2] && args[2].byteLength) || 0;
    var bind = target === 0x8892 ? 0x8894 : target === 0x8893 ? 0x8895 : null;
    if (!bind || !size || !bufBytesMap) return;
    var buf = safeGetParam(this, bind);
    if (!buf) return;
    var prev = bufBytesMap.get(buf) || 0;
    if (offset + size > prev) {
      bufBytesMap.set(buf, offset + size);
      state.bufBytes += (offset + size) - prev;
    }
  });

  // ---- 着色器 / 程序 ----
  patchBoth('createShader', function () { state.shadersAlive++; });
  patchBoth('deleteShader', function () { if (state.shadersAlive > 0) state.shadersAlive--; });
  patchBoth('createProgram', function () { state.programsAlive++; });
  patchBoth('deleteProgram', function () { if (state.programsAlive > 0) state.programsAlive--; });
  patchBoth('useProgram', function (orig, args) { state.activeProgram = args[0] ? 1 : 0; });

  // ---- 绘制调用 ----
  ['drawArrays', 'drawElements'].forEach(function (n) {
    patchBoth(n, function () { state.drawCalls++; });
  });
  ['drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'].forEach(function (n) {
    patch(R2, n, function () { state.drawCalls++; });
  });

  // ---- getContext 检测（用于上下文计数和引擎识别；active 由首次 WebGL 调用自动激活） ----
  // 关键修复：某些浏览器/引擎会把 createTexture/deleteTexture/texImage2D 等常用方法
  // 直接定义在 gl 实例自身上，遮蔽原型方法。仅 patch 原型无效，必须在 getContext 时
  // 删除实例自身的 WebGL 方法属性，让它回退到已被 patch 的原型方法。
  function patchInstance(gl) {
    try {
      var names = Object.getOwnPropertyNames(gl);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (typeof gl[name] !== 'function') continue;
        var proto = Object.getPrototypeOf(gl);
        var found = false;
        while (proto && proto !== Object.prototype) {
          if (typeof proto[name] === 'function') { found = true; break; }
          proto = Object.getPrototypeOf(proto);
        }
        if (found) {
          try { delete gl[name]; } catch (e) { /* 忽略 non-configurable */ }
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype) {
    var origGetContext = HTMLCanvasElement.prototype.getContext;
    if (typeof origGetContext === 'function') {
      HTMLCanvasElement.prototype.getContext = function () {
        var ctx = origGetContext.apply(this, arguments);
        var type = arguments[0];
        if ((type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') && ctx) {
          state.active = true;
          if (!ctxSeen || !ctxSeen.has(ctx)) {
            if (ctxSeen) ctxSeen.add(ctx);
            state.contexts++;
            patchInstance(ctx);
          }
          detectEngine();
        }
        return ctx;
      };
    }
  }

  // ---- FPS / 帧耗时 ----
  var origRAF = window.requestAnimationFrame;
  if (typeof origRAF === 'function') {
    window.requestAnimationFrame = function (cb) {
      return origRAF.call(window, function (t) {
        state.rafFrames++;
        if (state.lastFrameT > 0) {
          var dt = t - state.lastFrameT;
          if (dt > 0 && dt < 1000) {
            state.frameMs = state.frameMs ? state.frameMs * 0.9 + dt * 0.1 : dt;
          }
        }
        state.lastFrameT = t;
        if (typeof cb === 'function') return cb(t);
      });
    };
  }

  // ---- LayaAir 专用：资源 URL 关联 ----
  // Laya 的纹理上传链路：Texture2D(Sr)._texture -> H(GPU纹理包装).resource -> WebGLTexture
  // 通过挂钩 setImageData 建立 H -> {url,name} 映射，再挂钩 setTextureImageData 把 URL 写入纹理元数据
  function setupLayaHooks() {
    if (window.__gameMemLayaHooks) return;
    try {
      if (typeof Laya === 'undefined' || !Laya.Texture2D || !Laya.Texture2D.prototype) return;
      window.__gameMemLayaHooks = true;

      var layaTexUrlMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
      if (!layaTexUrlMap) return;

      // 挂钩 Texture2D 的数据设置方法，建立 H -> {url, name} 映射
      var texMethods = ['setImageData', 'setPixelsData', 'setSubPixelsData', 'setDDSData', 'setKTXData', 'setHDRData'];
      for (var i = 0; i < texMethods.length; i++) {
        (function (name) {
          var orig = Laya.Texture2D.prototype[name];
          if (typeof orig !== 'function') return;
          Laya.Texture2D.prototype[name] = function () {
            try {
              var h = this._texture;
              if (h && !layaTexUrlMap.has(h)) {
                layaTexUrlMap.set(h, { url: this.url || '', name: this.name || '' });
              }
            } catch (e) { /* 忽略 */ }
            return orig.apply(this, arguments);
          };
        })(texMethods[i]);
      }

      // 挂钩 textureContext 的上传方法，把 URL 写入 WebGLTexture 元数据
      function applyTextureContextHooks() {
        try {
          if (!Laya.LayaGL || !Laya.LayaGL.textureContext) return false;
          var tc = Laya.LayaGL.textureContext;
          if (tc.__gameMemHooked) return true;
          tc.__gameMemHooked = true;

          var tcMethods = ['setTextureImageData', 'setTexturePixelsData', 'setTextureSubImageData',
            'setTexture3DImageData', 'setTexture3DPixelsData', 'setTexture3DSubPixelsData',
            'setCubeImageData', 'setCubePixelsData'];
          for (var i = 0; i < tcMethods.length; i++) {
            (function (name) {
              var orig = tc[name];
              if (typeof orig !== 'function') return;
              tc[name] = function () {
                try {
                  var h = arguments[0]; // 第一个参数是 H 对象
                  if (h && h.resource) {
                    var meta = textureRegistry.get(h.resource);
                    if (meta && !meta.sourceUrl && !meta.sourceName) {
                      // 优先从 layaTexUrlMap 查（经 setImageData 建立的映射）
                      var info = layaTexUrlMap.get(h);
                      if (info && (info.url || info.name)) {
                        if (info.url) meta.sourceUrl = info.url;
                        if (info.name) meta.sourceName = info.name;
                      } else {
                        // 兜底：遍历 arguments，找到图片类型的参数提取 URL
                        // （Laya 可能直接调用 setTextureImageData 而不经过 Texture2D.setImageData）
                        for (var j = 1; j < arguments.length; j++) {
                          var srcInfo = extractSourceFromPixels(arguments[j]);
                          if (srcInfo && (srcInfo.url || srcInfo.name)) {
                            if (srcInfo.url) meta.sourceUrl = srcInfo.url;
                            if (srcInfo.name) meta.sourceName = srcInfo.name;
                            break;
                          }
                        }
                      }
                    }
                  }
                } catch (e) { /* 忽略 */ }
                return orig.apply(this, arguments);
              };
            })(tcMethods[i]);
          }
          return true;
        } catch (e) { return false; }
      }

      // textureContext 可能尚未初始化，定时重试
      if (!applyTextureContextHooks()) {
        var attempts = 0;
        var timer = setInterval(function () {
          attempts++;
          if (applyTextureContextHooks() || attempts > 30) {
            clearInterval(timer);
          }
        }, 500);
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---- 引擎识别 ----
  function detectEngine() {
    if (state.engine) return;
    try {
      var checks = [
        ['Phaser', 'Phaser', 'VERSION'],
        ['PixiJS', 'PIXI', 'VERSION'],
        ['Three.js', 'THREE', 'REVISION'],
        ['Babylon.js', 'BABYLON', 'Version'],
        ['Cocos Creator', 'cc', 'ENGINE_VERSION'],
        ['LayaAir', 'Laya', 'version'],
        ['CreateJS/EaselJS', 'createjs', 'version'],
        ['PlayCanvas', 'pc', 'version'],
        ['melonJS', 'me', 'version'],
        ['Unity WebGL', 'unityInstance', null]
      ];
      for (var i = 0; i < checks.length; i++) {
        var c = checks[i];
        if (window[c[1]]) {
          state.engine = c[0];
          var ver = c[2] && window[c[1]][c[2]];
          state.engineVersion = ver != null ? String(ver) : '';
          if (c[0] === 'LayaAir') setupLayaHooks();
          return;
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---- 快照与通信 ----
  var TOP_TEXTURES = 50;
  var TOP_RENDERBUFFERS = 20;

  function getJsHeap() {
    try {
      if (performance && performance.memory && performance.memory.usedJSHeapSize) {
        return performance.memory.usedJSHeapSize;
      }
    } catch (e) { /* 忽略 */ }
    return 0;
  }

  function snapshot() {
    var t = now();

    var texList = [];
    textureRegistry.forEach(function (meta, texObj) {
      texList.push({
        id: meta.id,
        bytes: meta.bytes,
        format: meta.format,
        width: meta.width,
        height: meta.height,
        depth: meta.depth || 0,
        target: meta.target,
        mip: meta.mip,
        age: Math.round((t - meta.createdAt) / 1000),
        createdSource: meta.createdSource,
        uploadedSource: meta.uploadedSource,
        sourceUrl: meta.sourceUrl || '',
        sourceName: meta.sourceName || '',
        bindCount: meta.bindCount || 0,
        bindCountFrame: meta.bindCountFrame || 0,
        hidden: hiddenTextures ? hiddenTextures.has(texObj) : false,
        replaced: replacementTextures ? replacementTextures.has(texObj) : false,
        replacementName: replacementTextures && replacementTextures.has(texObj) ? replacementTextures.get(texObj).name : ''
      });
    });
    texList.sort(function (a, b) { return b.bytes - a.bytes; });

    var rbList = [];
    renderbufferRegistry.forEach(function (meta) {
      rbList.push({
        id: meta.id,
        bytes: meta.bytes,
        format: meta.format,
        width: meta.width,
        height: meta.height,
        samples: meta.samples,
        age: Math.round((t - meta.createdAt) / 1000),
        createdSource: meta.createdSource
      });
    });
    rbList.sort(function (a, b) { return b.bytes - a.bytes; });

    return {
      mark: MARK,
      t: t,
      active: state.active,
      contexts: state.contexts,
      fps: state.fps,
      frameMs: Math.round(state.frameMs * 10) / 10,
      drawCalls: state.drawCalls,
      texturesAlive: state.texturesAlive,
      texBytes: Math.round(state.texBytes),
      buffersAlive: state.buffersAlive,
      bufBytes: Math.round(state.bufBytes),
      shadersAlive: state.shadersAlive,
      programsAlive: state.programsAlive,
      hasActiveProgram: !!state.activeProgram,
      renderbuffersAlive: state.renderbuffersAlive,
      rbBytes: Math.round(state.rbBytes),
      engine: state.engine,
      engineVersion: state.engineVersion,
      jsHeap: getJsHeap(),
      textures: texList.slice(0, TOP_TEXTURES),
      textureTotal: texList.length,
      renderbuffers: rbList.slice(0, TOP_RENDERBUFFERS),
      renderbufferTotal: rbList.length
    };
  }

  setInterval(function () {
    var el = now() - state.rafLast;
    state.fps = el > 50 ? Math.round((state.rafFrames * 1000) / el) : 0;
    state.rafFrames = 0;
    state.rafLast = now();
    // 重置每帧绑定计数
    textureRegistry.forEach(function (meta) { meta.bindCountFrame = 0; });
  }, 1000);

  setInterval(function () {
    try { window.postMessage(snapshot(), '*'); } catch (e) { /* 忽略 */ }
  }, 500);

  // ---- 纹理面板辅助函数 ----
  function findTexById(id) {
    var found = null;
    var numId = Number(id);
    textureRegistry.forEach(function (meta, texObj) {
      if (meta.id === numId) found = { tex: texObj, meta: meta };
    });
    return found;
  }

  function getAllTextures() {
    var t = now();
    var list = [];
    textureRegistry.forEach(function (meta, texObj) {
      list.push({
        id: meta.id,
        bytes: meta.bytes,
        format: meta.format,
        width: meta.width,
        height: meta.height,
        depth: meta.depth || 0,
        target: meta.target,
        mip: meta.mip,
        age: Math.round((t - meta.createdAt) / 1000),
        sourceUrl: meta.sourceUrl || '',
        sourceName: meta.sourceName || '',
        createdSource: meta.createdSource,
        uploadedSource: meta.uploadedSource,
        bindCount: meta.bindCount || 0,
        bindCountFrame: meta.bindCountFrame || 0,
        hidden: hiddenTextures ? hiddenTextures.has(texObj) : false,
        replaced: replacementTextures ? replacementTextures.has(texObj) : false,
        replacementName: replacementTextures && replacementTextures.has(texObj) ? replacementTextures.get(texObj).name : '',
        replacementWidth: replacementTextures && replacementTextures.has(texObj) ? replacementTextures.get(texObj).width : 0,
        replacementHeight: replacementTextures && replacementTextures.has(texObj) ? replacementTextures.get(texObj).height : 0
      });
    });
    list.sort(function (a, b) { return b.bytes - a.bytes; });
    return list;
  }

  function toggleTextureHidden(id) {
    var found = findTexById(id);
    if (!found) return { ok: false, error: 'texture not found' };
    if (hiddenTextures) {
      if (hiddenTextures.has(found.tex)) {
        hiddenTextures.delete(found.tex);
      } else {
        hiddenTextures.add(found.tex);
      }
    }
    return { ok: true, id: id, hidden: hiddenTextures ? hiddenTextures.has(found.tex) : false };
  }

  // 替换纹理：用 data URL 图片创建替代纹理，bindTexture 时自动替换
  function replaceTexture(id, dataUrl, name) {
    var found = findTexById(id);
    if (!found) return Promise.resolve({ ok: false, error: 'texture not found' });
    if (!replacementTextures) return Promise.resolve({ ok: false, error: 'replacement not supported' });

    // 如果已有替代纹理，先删除
    if (replacementTextures.has(found.tex)) {
      var old = replacementTextures.get(found.tex);
      if (old && old.tex) {
        try {
          var gl = found.meta.target ? null : null;
          // 用原始上下文删除替代纹理
          if (old._gl) old._gl.deleteTexture(old.tex);
        } catch (e) {}
      }
      replacementTextures.delete(found.tex);
    }

    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          // 找到一个可用的 WebGL 上下文
          var gl = null;
          var canvases = document.querySelectorAll('canvas');
          for (var i = 0; i < canvases.length; i++) {
            var c = canvases[i];
            gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
            if (gl) break;
          }
          if (!gl) { resolve({ ok: false, error: 'no webgl context' }); return; }

          var repTex = gl.createTexture();
          gl.bindTexture(found.meta.target || 0x0DE1, repTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(found.meta.target || 0x0DE1, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.texParameteri(found.meta.target || 0x0DE1, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(found.meta.target || 0x0DE1, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(found.meta.target || 0x0DE1, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(found.meta.target || 0x0DE1, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

          replacementTextures.set(found.tex, {
            tex: repTex,
            name: name || 'replaced',
            width: img.width,
            height: img.height,
            _gl: gl
          });

          resolve({ ok: true, id: id, replaced: true, width: img.width, height: img.height, name: name || 'replaced' });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      };
      img.onerror = function () {
        resolve({ ok: false, error: 'image load failed' });
      };
      img.src = dataUrl;
    });
  }

  // 恢复纹理：删除替代纹理，恢复原始绑定
  function restoreTexture(id) {
    var found = findTexById(id);
    if (!found) return { ok: false, error: 'texture not found' };
    if (!replacementTextures || !replacementTextures.has(found.tex)) {
      return { ok: true, id: id, replaced: false };
    }
    var rep = replacementTextures.get(found.tex);
    if (rep && rep.tex && rep._gl) {
      try { rep._gl.deleteTexture(rep.tex); } catch (e) {}
    }
    replacementTextures.delete(found.tex);
    return { ok: true, id: id, replaced: false };
  }

  function exportTextures(format) {
    var list = getAllTextures();
    if (format === 'json') {
      return { ok: true, format: 'json', data: JSON.stringify(list, null, 2), count: list.length };
    }
    // CSV
    var headers = ['ID', '大小(字节)', '大小(MB)', '宽度', '高度', '深度', '格式', 'Mipmap', '存活(秒)', '绑定次数', '每秒绑定', '隐藏', '资源名', '资源URL', '创建来源', '上传来源'];
    var rows = [headers.join(',')];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      function csvCell(v) {
        if (v == null) return '';
        var s = String(v);
        if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) {
          s = '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }
      var createdSrc = t.createdSource ? (t.createdSource.func || '') + '@' + (t.createdSource.file || '') + ':' + (t.createdSource.line || '') : '';
      var uploadedSrc = t.uploadedSource ? (t.uploadedSource.func || '') + '@' + (t.uploadedSource.file || '') + ':' + (t.uploadedSource.line || '') : '';
      rows.push([
        t.id,
        t.bytes,
        (t.bytes / 1048576).toFixed(3),
        t.width,
        t.height,
        t.depth,
        t.format,
        t.mip ? 'Y' : 'N',
        t.age,
        t.bindCount,
        t.bindCountFrame,
        t.hidden ? 'Y' : 'N',
        csvCell(t.sourceName),
        csvCell(t.sourceUrl),
        csvCell(createdSrc),
        csvCell(uploadedSrc)
      ].join(','));
    }
    return { ok: true, format: 'csv', data: rows.join('\n'), count: list.length };
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (d && d.mark === CTL) {
      if (d.cmd === 'reset') {
        state.drawCalls = 0;
        state.rafFrames = 0;
        state.fps = 0;
        state.frameMs = 0;
      } else if (d.cmd === 'set-enabled') {
        state.enabled = !!d.value;
      } else if (d.cmd === 'get-all-textures') {
        try { ev.source.postMessage({ mark: MARK, replyTo: d._reqId, data: getAllTextures() }, '*'); } catch (e) {}
      } else if (d.cmd === 'toggle-hidden') {
        var r = toggleTextureHidden(d.id);
        try { ev.source.postMessage({ mark: MARK, replyTo: d._reqId, data: r }, '*'); } catch (e) {}
      } else if (d.cmd === 'replace-texture') {
        replaceTexture(d.id, d.dataUrl, d.name).then(function (rr) {
          try { ev.source.postMessage({ mark: MARK, replyTo: d._reqId, data: rr }, '*'); } catch (e) {}
        });
      } else if (d.cmd === 'restore-texture') {
        var rs = restoreTexture(d.id);
        try { ev.source.postMessage({ mark: MARK, replyTo: d._reqId, data: rs }, '*'); } catch (e) {}
      } else if (d.cmd === 'export-textures') {
        var er = exportTextures(d.format || 'csv');
        try { ev.source.postMessage({ mark: MARK, replyTo: d._reqId, data: er }, '*'); } catch (e) {}
      }
    }
  });

  detectEngine();

  // ---- 页面内悬浮 HUD 面板 ----
  function createHUD() {
    if (document.getElementById('game-mem-hud')) return;
    try {
      if (localStorage.getItem('game-mem-hud-hidden') === '1') return;
    } catch (e) { /* 忽略 */ }

    var hud = document.createElement('div');
    hud.id = 'game-mem-hud';
    hud.style.cssText = 'position:fixed;z-index:2147483647;top:12px;right:12px;width:320px;'
      + 'background:rgba(15,18,25,0.94);border:1px solid rgba(0,212,255,0.3);border-radius:8px;'
      + 'font-family:"Segoe UI",system-ui,sans-serif;font-size:11px;color:#c8d0e0;'
      + 'box-shadow:0 4px 20px rgba(0,0,0,0.5);user-select:none;overflow:hidden;';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;'
      + 'background:rgba(0,212,255,0.1);cursor:move;border-bottom:1px solid rgba(0,212,255,0.2)';
    var titleLeft = document.createElement('div');
    titleLeft.style.cssText = 'display:flex;align-items:center;gap:6px';
    var title = document.createElement('span');
    title.style.cssText = 'font-weight:600;color:#00d4ff;font-size:12px;letter-spacing:0.5px';
    title.textContent = 'GameMem';
    var engineLabel = document.createElement('span');
    engineLabel.style.cssText = 'color:#6b7a90;font-size:10px';
    engineLabel.id = 'game-mem-hud-engine';
    titleLeft.appendChild(title);
    titleLeft.appendChild(engineLabel);
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:2px';
    function makeHudBtn(text, title) {
      var b = document.createElement('button');
      b.textContent = text;
      b.title = title;
      b.style.cssText = 'background:none;border:none;color:#6b7a90;cursor:pointer;font-size:14px;'
        + 'padding:0 5px;line-height:1;border-radius:3px';
      b.onmouseenter = function () { b.style.color = '#00d4ff'; b.style.background = 'rgba(0,212,255,0.1)'; };
      b.onmouseleave = function () { b.style.color = '#6b7a90'; b.style.background = 'none'; };
      return b;
    }
    var toggleBtn = makeHudBtn('—', '折叠/展开');
    var closeBtn = makeHudBtn('×', '关闭（可在弹窗中重新打开）');
    actions.appendChild(toggleBtn);
    actions.appendChild(closeBtn);
    header.appendChild(titleLeft);
    header.appendChild(actions);

    var body = document.createElement('div');
    body.id = 'game-mem-hud-body';
    body.style.cssText = 'padding:8px 10px';

    var metrics = document.createElement('div');
    metrics.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px 10px;margin-bottom:8px';
    var metricDefs = [
      ['jsHeap', 'JS 堆', '--'],
      ['textures', '纹理', '--'],
      ['texBytes', '纹理显存', '--'],
      ['fps', 'FPS', '--'],
      ['frameMs', '帧耗时', '--'],
      ['drawCalls', 'Draw Call', '--']
    ];
    var metricEls = {};
    for (var mi = 0; mi < metricDefs.length; mi++) {
      var m = document.createElement('div');
      m.style.cssText = 'display:flex;flex-direction:column;gap:1px';
      var label = document.createElement('span');
      label.style.cssText = 'color:#6b7a90;font-size:10px';
      label.textContent = metricDefs[mi][1];
      var value = document.createElement('span');
      value.style.cssText = 'color:#e0e8f0;font-weight:600;font-size:13px;font-variant-numeric:tabular-nums';
      value.id = 'game-mem-hud-' + metricDefs[mi][0];
      value.textContent = metricDefs[mi][2];
      m.appendChild(label);
      m.appendChild(value);
      metrics.appendChild(m);
      metricEls[metricDefs[mi][0]] = value;
    }

    var texSection = document.createElement('div');
    var texHeader = document.createElement('div');
    texHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
    var texTitle = document.createElement('span');
    texTitle.style.cssText = 'color:#6b7a90;font-size:10px;font-weight:600';
    texTitle.textContent = '纹理明细 Top 10';
    var texCount = document.createElement('span');
    texCount.id = 'game-mem-hud-tex-count';
    texCount.style.cssText = 'color:#00d4ff;font-size:10px';
    texHeader.appendChild(texTitle);
    texHeader.appendChild(texCount);
    var texList = document.createElement('div');
    texList.id = 'game-mem-hud-tex-list';
    texList.style.cssText = 'max-height:220px;overflow-y:auto;scrollbar-width:thin';
    texSection.appendChild(texHeader);
    texSection.appendChild(texList);

    body.appendChild(metrics);
    body.appendChild(texSection);
    hud.appendChild(header);
    hud.appendChild(body);
    (document.body || document.documentElement).appendChild(hud);

    // 拖动
    var isDragging = false, dragOX = 0, dragOY = 0;
    function dragStart(e) {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      var rect = hud.getBoundingClientRect();
      var cx = e.touches ? e.touches[0].clientX : e.clientX;
      var cy = e.touches ? e.touches[0].clientY : e.clientY;
      dragOX = cx - rect.left;
      dragOY = cy - rect.top;
      e.preventDefault();
    }
    function dragMove(e) {
      if (!isDragging) return;
      var cx = e.touches ? e.touches[0].clientX : e.clientX;
      var cy = e.touches ? e.touches[0].clientY : e.clientY;
      var x = Math.max(0, Math.min(window.innerWidth - hud.offsetWidth, cx - dragOX));
      var y = Math.max(0, Math.min(window.innerHeight - 40, cy - dragOY));
      hud.style.left = x + 'px';
      hud.style.top = y + 'px';
      hud.style.right = 'auto';
    }
    function dragEnd() { isDragging = false; }
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', dragMove);
    document.addEventListener('mouseup', dragEnd);
    header.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchmove', dragMove, { passive: false });
    document.addEventListener('touchend', dragEnd);

    var collapsed = false;
    toggleBtn.addEventListener('click', function () {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '+' : '—';
    });
    closeBtn.addEventListener('click', function () {
      hud.remove();
      try { localStorage.setItem('game-mem-hud-hidden', '1'); } catch (e) {}
    });

    function fmtBytes(b) {
      if (!b) return '0B';
      if (b >= 1073741824) return (b / 1073741824).toFixed(2) + 'G';
      if (b >= 1048576) return (b / 1048576).toFixed(1) + 'M';
      if (b >= 1024) return (b / 1024).toFixed(0) + 'K';
      return b + 'B';
    }
    function fmtUrl(url) {
      if (!url) return '';
      var f = url.substring(url.lastIndexOf('/') + 1).split('?')[0];
      return f || url;
    }
    function fmtSource(item) {
      if (item.sourceName) return item.sourceName;
      if (item.sourceUrl) return fmtUrl(item.sourceUrl);
      var src = item.uploadedSource || item.createdSource;
      if (src && src.file) {
        var f = src.file;
        var slash = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\'));
        if (slash >= 0) f = f.substring(slash + 1);
        return (src.func ? src.func + '@' : '') + f;
      }
      return '未知';
    }

    function updateHUD() {
      var snap = snapshot();
      engineLabel.textContent = snap.engine ? snap.engine + (snap.engineVersion ? ' ' + snap.engineVersion : '') : '';
      metricEls.jsHeap.textContent = snap.jsHeap ? fmtBytes(snap.jsHeap) : '--';
      metricEls.textures.textContent = snap.texturesAlive;
      metricEls.texBytes.textContent = fmtBytes(snap.texBytes);
      metricEls.fps.textContent = snap.fps || '--';
      metricEls.frameMs.textContent = snap.frameMs ? snap.frameMs + 'ms' : '--';
      metricEls.drawCalls.textContent = snap.drawCalls;
      texCount.textContent = snap.textureTotal + ' 份';

      var list = snap.textures || [];
      var html = '';
      for (var ti = 0; ti < Math.min(list.length, 10); ti++) {
        var t = list[ti];
        var dim = t.width ? t.width + '×' + t.height : '-';
        var src = fmtSource(t);
        if (src.length > 30) src = src.substring(0, 27) + '...';
        var fullTitle = (t.sourceUrl || '') + (t.sourceName ? ' | ' + t.sourceName : '');
        html += '<div style="display:flex;justify-content:space-between;gap:6px;padding:3px 0;'
          + 'border-bottom:1px solid rgba(255,255,255,0.05);align-items:baseline">'
          + '<span style="color:#e0e8f0;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:42px">' + fmtBytes(t.bytes) + '</span>'
          + '<span style="color:#8a96ac;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:60px">' + dim + '</span>'
          + '<span style="color:#9ab0d0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right" title="' + fullTitle.replace(/"/g, '&quot;') + '">' + src + '</span>'
          + '</div>';
      }
      if (list.length === 0) {
        html = '<div style="color:#6b7a90;padding:10px 0;text-align:center">暂无纹理</div>';
      }
      texList.innerHTML = html;
    }

    updateHUD();
    setInterval(updateHUD, 1000);
  }

  // ---- 控制台定时输出 ----
  function startConsoleOutput() {
    setInterval(function () {
      var snap = snapshot();
      if (!snap.active) return;
      var line = '%c[GameMem] ' + (snap.engine || '')
        + ' | JS堆:' + (snap.jsHeap ? (snap.jsHeap / 1048576).toFixed(1) + 'MB' : '--')
        + ' | 纹理:' + snap.texturesAlive + '(' + (snap.texBytes / 1048576).toFixed(1) + 'MB)'
        + ' | FPS:' + snap.fps + ' 帧时:' + snap.frameMs + 'ms'
        + ' | Draw:' + snap.drawCalls
        + ' | 缓冲:' + snap.buffersAlive + ' 着色器:' + snap.shadersAlive + ' 程序:' + snap.programsAlive
        + ' | RenderBuf:' + snap.renderbuffersAlive;
      console.log(line, 'color:#00d4ff;font-weight:bold');
      if (snap.textures && snap.textures.length > 0) {
        var tableData = snap.textures.slice(0, 15).map(function (t) {
          var src = t.uploadedSource || t.createdSource || {};
          return {
            '大小(MB)': parseFloat((t.bytes / 1048576).toFixed(2)),
            '尺寸': t.width ? t.width + '×' + t.height : '-',
            '格式': t.format,
            '资源名': t.sourceName || '',
            '资源文件': t.sourceUrl ? t.sourceUrl.substring(t.sourceUrl.lastIndexOf('/') + 1).split('?')[0] : '',
            '创建函数': src.func || ''
          };
        });
        console.table(tableData);
      }
    }, 5000);
  }

  function initHUD() {
    createHUD();
    startConsoleOutput();
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initHUD);
    } else {
      initHUD();
    }

    // 监听 popup 的"显示 HUD"请求
    window.addEventListener('message', function (ev) {
      if (ev.source !== window) return;
      var d = ev.data;
      if (d && d.mark === CTL && d.cmd === 'show-hud') {
        try { localStorage.removeItem('game-mem-hud-hidden'); } catch (e) {}
        createHUD();
      }
    });
  }
})();

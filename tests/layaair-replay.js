/**
 * layaair-replay.js — 用 LayaAir 3.2 引擎的真实 WebGL 调用序列回归验证 hook.js。
 *
 * 背景：LayaAir 3.x WebGL2 上传纹理走 texStorage2D + texSubImage2D（GL2TextureContext.ts），
 * 地图（Plane+MeshRenderer）贴图读不到大小，是因为部分 Chrome 版本把 WebGL 方法作为
 * 实例自身属性（不可删除时原型 patch 被遮蔽），texStorage2D 捕获缺失。
 *
 * 场景：
 *  A. 正常 LayaAir PNG 贴图：texStorage2D + texSubImage2D(9参) + generateMipmap
 *  B. sRGB 变体（SRGB8_ALPHA8，无 mipmap）
 *  C. KTX 压缩 DXT1：逐层 compressedTexImage2D
 *  D. texStorage2D 被不可删除的实例属性遮蔽（根因场景）→ texSubImage2D 兜底
 *  E. 实例属性可删除 → patchInstance 修复后 texStorage2D 直接捕获
 *
 * 运行：node tests/layaair-replay.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const hookPath = path.join(__dirname, '..', 'hook.js');

/* ---- 伪造浏览器环境 ---- */
const messages = [];
const listeners = [];
const intervals = [];

class FakeTex {}
class FakeBuf {}
class FakeRb {}

// WebGL1/WebGL2 共有方法（两套原型各挂一份，与真实浏览器一致）
function makeGlProto() {
  return {
    getParameter(p) {
      if (p === 0x8069) return this._s.tex;
      if (p === 0x806A) return this._s.tex3d;
      if (p === 0x8C1D) return this._s.tex2darr;
      if (p === 0x8894) return this._s.arr;
      if (p === 0x8895) return this._s.elem;
      if (p === 0x8CA7) return this._s.rb;
      return null;
    },
    bindTexture(t, tex) { this._s.tex = tex; },
    createTexture() { return new FakeTex(); },
    deleteTexture(t) { if (this._s.tex === t) this._s.tex = null; },
    texImage2D() {},
    texSubImage2D() {},
    compressedTexImage2D() {},
    generateMipmap() {},
    texParameteri() {},
    pixelStorei() {},
    createBuffer() { return new FakeBuf(); },
    deleteBuffer() {},
    bufferData() {},
    bufferSubData() {},
    createRenderbuffer() { return new FakeRb(); },
    deleteRenderbuffer() {},
    renderbufferStorage() {},
    drawArrays() {},
    drawElements() {},
    useProgram() {}
  };
}
const GL1Proto = makeGlProto();
const GL2Proto = Object.create(GL1Proto);
GL2Proto.texStorage2D = function () {};
GL2Proto.texImage3D = function () {};
GL2Proto.texSubImage3D = function () {};
GL2Proto.texStorage3D = function () {};
GL2Proto.compressedTexImage3D = function () {};

// 伪造 XMLHttpRequest（验证 KTX 资源 URL 标记链路）
function FakeXHR() { this._handlers = {}; }
FakeXHR.prototype = {
  open(m, u) { this._url = u; },
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
  send() {},
  __fire(type) { (this._handlers[type] || []).forEach(function (fn) { fn(); }); }
};
global.XMLHttpRequest = FakeXHR;

function FakeGL1() { this._s = { tex: null, tex3d: null, tex2darr: null, arr: null, elem: null, rb: null }; }
FakeGL1.prototype = GL1Proto;
function FakeGL2() { this._s = { tex: null, tex3d: null, tex2darr: null, arr: null, elem: null, rb: null }; }
FakeGL2.prototype = GL2Proto;

global.window = {
  addEventListener(ev, fn) { listeners.push(fn); },
  postMessage(d) { messages.push(d); },
  requestAnimationFrame(cb) { return 1; }
};
Object.defineProperty(global, 'navigator', { value: { userAgent: 'node-test' }, configurable: true });
Object.defineProperty(global, 'performance', { value: { now: () => Date.now() }, configurable: true });
global.setInterval = (fn) => { intervals.push(fn); return 0; };
global.setTimeout = () => 0;
global.document = undefined; // 跳过 HUD 初始化

global.HTMLCanvasElement = function () {};
global.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type === 'webgl2') return new FakeGL2();
  if (type === 'webgl' || type === 'experimental-webgl') return new FakeGL1();
  return null;
};
global.WebGLRenderingContext = function () {};
global.WebGLRenderingContext.prototype = GL1Proto;
global.WebGL2RenderingContext = function () {};
global.WebGL2RenderingContext.prototype = GL2Proto;

delete require.cache[require.resolve(hookPath)];
require(hookPath);

const snapshot = () => messages[messages.length - 1];
const push = () => intervals[1]();
// 纹理明细按显存降序，最新创建的取 id 最大的
function latest(s) {
  var list = s.textures || [];
  var best = null;
  for (var i = 0; i < list.length; i++) if (!best || list[i].id > best.id) best = list[i];
  return best;
}

const canvas = new global.HTMLCanvasElement();
const gl = canvas.getContext('webgl2');
assert.ok(gl, '能拿到 WebGL2 上下文');

// LayaAir 常量
const TEXTURE_2D = 0x0DE1;
const RGBA8 = 0x8058, SRGB8_ALPHA8 = 0x8C41;
const RGBA = 0x1908, UNSIGNED_BYTE = 0x1401;
const DXT1 = 0x83F1; // COMPRESSED_RGBA_S3TC_DXT1_EXT

function scenario(name, fn) {
  const before = snapshot();
  const beforeBytes = before.texBytes;
  fn();
  push();
  const s = snapshot();
  const t = latest(s);
  console.log(`\n=== ${name} ===`);
  if (!t || t.bytes === 0) {
    console.log('  ❌ 未记录到纹理大小！');
    return { ok: false, t: t, delta: s.texBytes - beforeBytes };
  }
  console.log(`  ${t.width}×${t.height} | ${(t.bytes / 1024).toFixed(1)}KB | format=0x${(t.format || 0).toString(16)} | mip=${t.mip} | 显存增量 ${(deltaMB(s.texBytes - beforeBytes))}`);
  return { ok: true, t: t, delta: s.texBytes - beforeBytes };
}
function deltaMB(b) { return (b / 1048576).toFixed(2) + 'MB'; }

/* A. 正常 LayaAir PNG 贴图（GL2TextureContext.setTextureImageData 的真实调用序列） */
push(); // 先产生一次初始快照
let A = scenario('A. PNG 地图 RGBA8 1024x1024：texStorage2D + texSubImage2D + generateMipmap', () => {
  const tex = gl.createTexture();
  gl.bindTexture(TEXTURE_2D, tex);
  gl.texStorage2D(TEXTURE_2D, 2, RGBA8, 1024, 1024);
  const img = { width: 1024, height: 1024, src: 'https://game.example/assets/map.png' };
  gl.texSubImage2D(TEXTURE_2D, 0, 0, 0, 1024, 1024, RGBA, UNSIGNED_BYTE, img);
  gl.generateMipmap(TEXTURE_2D);
});
assert.ok(A.ok, 'A: 记录到纹理大小');
assert.strictEqual(A.t.width, 1024, 'A: 宽 1024');
// texStorage2D 2 层 = 1024²*4 * (1 + 1/4) ≈ 5.24MB；generateMipmap 检查 mip 标记
assert.strictEqual(A.t.mip, true, 'A: mip 已标记');

/* B. sRGB 变体 */
let B = scenario('B. sRGB 地图 SRGB8_ALPHA8 2048x2048（无 mipmap）', () => {
  const tex = gl.createTexture();
  gl.bindTexture(TEXTURE_2D, tex);
  gl.texStorage2D(TEXTURE_2D, 1, SRGB8_ALPHA8, 2048, 2048);
  const img = { width: 2048, height: 2048, src: 'https://game.example/assets/ground.png' };
  gl.texSubImage2D(TEXTURE_2D, 0, 0, 0, 2048, 2048, RGBA, UNSIGNED_BYTE, img);
});
assert.ok(B.ok, 'B: 记录到纹理大小');
assert.strictEqual(B.t.width, 2048, 'B: 宽 2048');

/* C. KTX 压缩 DXT1（GL2TextureContext KTX 路径：逐层 compressedTexImage2D） */
let C = scenario('C. KTX 压缩 DXT1 1024x1024：compressedTexImage2D ×2 层', () => {
  const tex = gl.createTexture();
  gl.bindTexture(TEXTURE_2D, tex);
  let w = 1024, h = 1024;
  for (let i = 0; i < 2; i++) {
    gl.compressedTexImage2D(TEXTURE_2D, i, DXT1, w, h, 0, new Uint8Array(8));
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
  }
});
assert.ok(C.ok, 'C: 记录到压缩纹理大小');
assert.strictEqual(C.t.width, 1024, 'C: 基准尺寸取最大层 1024（不被最小层覆盖）');
// DXT1 两层字节求和：8*(256²) + 8*(128²) = 655360
assert.strictEqual(C.t.bytes, 8 * 256 * 256 + 8 * 128 * 128, 'C: 字节为各层求和');

/* D. 根因场景：texStorage2D 被不可删除的实例属性遮蔽 → 靠 texSubImage2D 兜底 */
{
  const tex = gl.createTexture();
  gl.bindTexture(TEXTURE_2D, tex);
  Object.defineProperty(gl, 'texStorage2D', {
    value: function () {}, writable: false, configurable: false
  });
  let D = scenario('D. texStorage2D 遮蔽缺失（v1.6.3 根因）：texSubImage2D(9参) 兜底记录尺寸', () => {
    const img = { width: 512, height: 512, src: 'https://game.example/assets/map2.png' };
    gl.texSubImage2D(TEXTURE_2D, 0, 0, 0, 512, 512, RGBA, UNSIGNED_BYTE, img);
  });
  assert.ok(D.ok, 'D: texSubImage2D 兜底记录到大小');
  assert.strictEqual(D.t.width, 512, 'D: 宽 512');
  // RGBA8 512x512 无 mip = 1MB；generateMipmap 之前
  assert.ok(Math.abs(D.delta - 512 * 512 * 4) < 1, 'D: 显存增量 = 512²×4');
  // 后续 generateMipmap 仍能加上 1/3
  gl.generateMipmap(TEXTURE_2D);
  push();
  const s2 = snapshot();
  const t2 = latest(s2);
  assert.ok(Math.abs(t2.bytes - 512 * 512 * 4 * 4 / 3) < 1, 'D: mipmap 后 4/3 系数生效');
}

/* E. 新上下文（无实例遮蔽）：texStorage2D 直接捕获 */
{
  const gl2 = canvas.getContext('webgl2'); // 干净上下文
  const tex = gl2.createTexture();
  gl2.bindTexture(TEXTURE_2D, tex);
  let E = scenario('E. 无遮蔽上下文：texStorage2D 直接捕获 256x256', () => {
    gl2.texStorage2D(TEXTURE_2D, 1, RGBA8, 256, 256);
    const img = { width: 256, height: 256 };
    gl2.texSubImage2D(TEXTURE_2D, 0, 0, 0, 256, 256, RGBA, UNSIGNED_BYTE, img);
  });
  assert.ok(E.ok, 'E: texStorage2D 捕获到大小');
  assert.strictEqual(E.t.width, 256, 'E: 宽 256');
}

/* F. LayaAir KTX 地图经 XHR 加载：资源 URL 标记 → 上传时反查 */
{
  const xhr = new global.XMLHttpRequest();
  xhr.open('GET', 'https://game.example/assets/map_terrain.ktx');
  xhr.responseType = 'arraybuffer';
  xhr.response = new ArrayBuffer(64);
  xhr.send();
  xhr.__fire('load'); // 引擎 load 回调里同步解析并上传
  let F = scenario('F. XHR 加载的 KTX 地图 1024x1024：来源显示资源 URL', () => {
    const tex = gl.createTexture();
    gl.bindTexture(TEXTURE_2D, tex);
    gl.compressedTexImage2D(TEXTURE_2D, 0, DXT1, 1024, 1024, 0, new Uint8Array(xhr.response));
  });
  assert.ok(F.ok, 'F: 记录到纹理大小');
  assert.strictEqual(F.t.sourceUrl, 'https://game.example/assets/map_terrain.ktx', 'F: 来源 = 资源 URL');
}

push();
const s = snapshot();
console.log(`\n=== 总计 ===\n纹理: ${s.textureTotal} 份, 显存: ${(s.texBytes / 1048576).toFixed(2)}MB`);
console.log('\n✔ LayaAir 3.x 全部上传路径验证通过');

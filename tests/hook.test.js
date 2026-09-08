/**
 * hook.js 单元测试：纯函数估算 + 挂钩逻辑（用伪造 WebGL 环境驱动）。
 * 运行：node tests/hook.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const hookPath = path.join(__dirname, '..', 'hook.js');

/* ---------------- 1. 纯函数：显存估算 ---------------- */
const pure = require(hookPath);
const { sizedBytes, bytesPerPixel, estimateTexBytes, estimateCompressedBytes } = pure;

assert.strictEqual(sizedBytes(0x8058), 4, 'RGBA8 = 4B/px');
assert.strictEqual(sizedBytes(0x8814), 16, 'RGBA32F = 16B/px');
assert.strictEqual(sizedBytes(0x881A), 8, 'RGBA16F = 8B/px');
assert.strictEqual(sizedBytes(0x81A5), 2, 'DEPTH_COMPONENT16 = 2B/px');
assert.strictEqual(bytesPerPixel(0x1908, 0x1401), 4, 'RGBA + UNSIGNED_BYTE = 4B/px');
assert.strictEqual(bytesPerPixel(0x1908, 0x1406), 16, 'RGBA + FLOAT = 16B/px');
assert.strictEqual(bytesPerPixel(0x1907, 0x1401), 3, 'RGB + BYTE = 3B/px');
assert.strictEqual(bytesPerPixel(0x190A, 0x1401), 2, 'LUMINANCE_ALPHA = 2B/px');
assert.strictEqual(bytesPerPixel(0x1909, 0x1401), 1, 'LUMINANCE = 1B/px');
assert.strictEqual(estimateTexBytes(0x8058, 256, 256, 0x1401), 256 * 256 * 4, 'RGBA8 256x256');
assert.strictEqual(estimateTexBytes(0x1908, 0, 100, 0x1401), 0, '宽为 0 返回 0');
assert.ok(estimateCompressedBytes(0x83F0, 256, 256) > 0, 'DXT1 估算 > 0');
assert.strictEqual(estimateCompressedBytes(0x83F0, 4, 4), 8, 'DXT1 4x4 = 8B');

// parseSource 纯函数
var ps = pure.parseSource('Error\n    at foo (bar.js:42:7)\n    at hook.js:10:5');
assert.strictEqual(ps.func, 'foo', 'parseSource 提取函数名');
assert.strictEqual(ps.file, 'bar.js', 'parseSource 提取文件名');
assert.strictEqual(ps.line, 42, 'parseSource 提取行号');
var ps2 = pure.parseSource('Error\n    at hook.js:10:5\n    at baz.js:1:2');
assert.strictEqual(ps2.file, 'baz.js', 'parseSource 跳过 hook.js 自身帧');
var ps3 = pure.parseSource('');
assert.strictEqual(ps3.file, '', 'parseSource 空栈返回空');

/* ---------------- 2. 挂钩逻辑（伪造浏览器环境） ---------------- */
const messages = [];
const listeners = [];
const intervals = [];
let rafCb = null;

class FakeTex {}
class FakeBuf {}
class FakeRb {}

const GLProto = {
  getParameter(p) {
    if (p === 0x8069) return this._s.tex;   // TEXTURE_BINDING_2D
    if (p === 0x806A) return this._s.tex3d; // TEXTURE_BINDING_3D
    if (p === 0x8894) return this._s.arr;   // ARRAY_BUFFER_BINDING
    if (p === 0x8895) return this._s.elem;  // ELEMENT_ARRAY_BUFFER_BINDING
    if (p === 0x8CA7) return this._s.rb;    // RENDERBUFFER_BINDING
    return null;
  },
  createTexture() { return new FakeTex(); },
  deleteTexture(t) { if (this._s.tex === t) this._s.tex = null; if (this._s.tex3d === t) this._s.tex3d = null; },
  texImage2D() {},
  texSubImage2D() {},
  texStorage2D() {},
  compressedTexImage2D() {},
  generateMipmap() {},
  createBuffer() { return new FakeBuf(); },
  deleteBuffer(b) { if (this._s.arr === b) this._s.arr = null; if (this._s.elem === b) this._s.elem = null; },
  bufferData() {},
  bufferSubData() {},
  createRenderbuffer() { return new FakeRb(); },
  deleteRenderbuffer(r) { if (this._s.rb === r) this._s.rb = null; },
  renderbufferStorage() {},
  drawArrays() {},
  drawElements() {},
  drawArraysInstanced() {},
  drawElementsInstanced() {},
  createShader() { return {}; },
  deleteShader() {},
  createProgram() { return {}; },
  deleteProgram() {},
  useProgram() {}
};

function FakeGLContext() { this._s = { tex: null, tex3d: null, arr: null, elem: null, rb: null }; }
FakeGLContext.prototype = Object.create(GLProto);
FakeGLContext.prototype.constructor = FakeGLContext;

global.window = {
  addEventListener(ev, fn) { listeners.push(fn); },
  postMessage(d) { messages.push(d); },
  requestAnimationFrame(cb) { rafCb = cb; return 1; }
};
Object.defineProperty(global, 'navigator', { value: { userAgent: 'node-test' }, configurable: true });
Object.defineProperty(global, 'performance', { value: { now: () => Date.now() }, configurable: true });
global.setInterval = (fn) => { intervals.push(fn); return 0; };
global.setTimeout = () => 0;
global.HTMLCanvasElement = function () {};
global.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return new FakeGLContext();
  return null;
};
global.WebGLRenderingContext = function () {};
global.WebGLRenderingContext.prototype = GLProto;
global.WebGL2RenderingContext = function () {};
global.WebGL2RenderingContext.prototype = Object.create(GLProto);
global.WebGL2RenderingContext.prototype.texStorage2D = function () {};
global.WebGL2RenderingContext.prototype.texImage3D = function () {};
global.WebGL2RenderingContext.prototype.texStorage3D = function () {};
global.WebGL2RenderingContext.prototype.renderbufferStorageMultisample = function () {};
global.WebGL2RenderingContext.prototype.drawArraysInstanced = function () {};
global.WebGL2RenderingContext.prototype.drawElementsInstanced = function () {};

// 清缓存后重新执行 hook.js，使其在伪造浏览器环境下运行挂钩逻辑
delete require.cache[require.resolve(hookPath)];
require(hookPath);

const snapshot = () => messages[messages.length - 1];
const push = () => intervals[1](); // intervals[0]=FPS 结算, intervals[1]=快照推送

const canvas = new HTMLCanvasElement();
const gl = canvas.getContext('webgl');
assert.ok(gl, '能拿到 WebGL 上下文');

push();
let s = snapshot();
assert.strictEqual(s.active, true, '检测到 WebGL 上下文');
assert.strictEqual(s.contexts, 1, '上下文计数为 1');
assert.strictEqual(s.engine, null, '无引擎全局变量时不误报');

// 纹理上传：RGBA8 256x256
const tex = gl.createTexture();
gl._s.tex = tex;
gl.texImage2D(0x0DE1, 0, 0x1908, 256, 256, 0, 0x1908, 0x1401, null);
push();
s = snapshot();
assert.strictEqual(s.texturesAlive, 1, '存活纹理 1');
assert.strictEqual(s.texBytes, 256 * 256 * 4, 'RGBA8 256x256 = 262144B');

// 纹理明细与来源追踪
assert.strictEqual(s.textureTotal, 1, 'textureTotal = 1');
assert.ok(Array.isArray(s.textures) && s.textures.length === 1, 'textures 列表含 1 项');
var t0 = s.textures[0];
assert.strictEqual(t0.bytes, 256 * 256 * 4, '明细 bytes 正确');
assert.strictEqual(t0.width, 256, '明细 width 正确');
assert.strictEqual(t0.height, 256, '明细 height 正确');
assert.strictEqual(t0.format, 0x1908, '明细 format 正确');
assert.ok(typeof t0.id === 'number' && t0.id > 0, '纹理有自增 ID');
assert.ok(typeof t0.age === 'number', '纹理有存活时长');
assert.ok(t0.createdSource && t0.createdSource.file, 'createdSource 非空');
assert.ok(t0.createdSource.file.indexOf('hook.test.js') >= 0, 'createdSource 指向测试文件');
assert.ok(t0.createdSource.line > 0, 'createdSource 有行号');
assert.ok(t0.uploadedSource && t0.uploadedSource.file, 'uploadedSource 非空');
assert.ok(t0.uploadedSource.file.indexOf('hook.test.js') >= 0, 'uploadedSource 指向测试文件');
assert.ok(t0.uploadedSource.line > 0, 'uploadedSource 有行号');

// 第二张纹理 128x128
const tex2 = gl.createTexture();
gl._s.tex = tex2;
gl.texImage2D(0x0DE1, 0, 0x1908, 128, 128, 0, 0x1908, 0x1401, null);
push();
s = snapshot();
assert.strictEqual(s.texBytes, 262144 + 65536, '两张纹理合计');

// generateMipmap：基础层增加 1/3
gl._s.tex = tex;
gl.generateMipmap();
push();
s = snapshot();
assert.ok(Math.abs(s.texBytes - (262144 + 65536 + 262144 / 3)) < 1, 'mipmap 计入 4/3 系数');

// 删除 tex2：显存回退
gl.deleteTexture(tex2);
push();
s = snapshot();
assert.strictEqual(s.texturesAlive, 1, '删除后存活纹理 1');
assert.ok(Math.abs(s.texBytes - (262144 + 262144 / 3)) < 1, '删除后显存回退');

// 删除后纹理明细同步移除
assert.strictEqual(s.textureTotal, 1, '删除后 textureTotal = 1');
assert.strictEqual(s.textures.length, 1, '删除后明细列表 1 项');
assert.ok(Math.abs(s.textures[0].bytes - (256 * 256 * 4 * 4 / 3)) < 1, '剩余明细为 tex（含 mip）');
assert.ok(s.textures[0].mip === true, '剩余纹理 mip 标记为 true');

// 缓冲区
const buf = gl.createBuffer();
gl._s.arr = buf;
gl.bufferData(0x8892, 4096, 0x88E4);
push();
s = snapshot();
assert.strictEqual(s.buffersAlive, 1, '存活缓冲区 1');
assert.strictEqual(s.bufBytes, 4096, '缓冲区 4096B');

// 绘制调用
gl.drawArrays(4, 0, 3);
gl.drawElements(4, 3, 0x1403, 0);
push();
s = snapshot();
assert.strictEqual(s.drawCalls, 2, '绘制调用计数 2');

// 着色器 / 程序
gl.createShader();
gl.createShader();
gl.createProgram();
push();
s = snapshot();
assert.strictEqual(s.shadersAlive, 2, '着色器计数 2');
assert.strictEqual(s.programsAlive, 1, '程序计数 1');

// FPS 结算不抛错
window.requestAnimationFrame(function () {});
if (rafCb) rafCb(Date.now() - 500);
if (rafCb) rafCb(Date.now());
intervals[0]();
push();
s = snapshot();
assert.strictEqual(typeof s.fps, 'number', 'FPS 为数值');

// 重置：只清累计计数，不破坏存活资源统计
listeners.forEach(function (fn) {
  fn({ source: global.window, data: { mark: 'game-mem-hook:ctl:v1', cmd: 'reset' } });
});
push();
s = snapshot();
assert.strictEqual(s.drawCalls, 0, '重置后绘制调用归零');
assert.ok(s.texturesAlive >= 1, '重置不清空存活纹理统计');

// 返回值不被破坏
const tex3 = gl.createTexture();
assert.ok(tex3 instanceof FakeTex, 'createTexture 返回原对象');

// 渲染缓冲（Renderbuffer）追踪
const rb = gl.createRenderbuffer();
gl._s.rb = rb;
gl.renderbufferStorage(0x8D41, 0x8058, 512, 512); // RENDERBUFFER, RGBA8, 512x512
push();
s = snapshot();
assert.strictEqual(s.renderbuffersAlive, 1, '渲染缓冲存活 1');
assert.strictEqual(s.rbBytes, 512 * 512 * 4, '渲染缓冲 RGBA8 512x512 = 1MB');
assert.ok(Array.isArray(s.renderbuffers) && s.renderbuffers.length === 1, '渲染缓冲明细 1 项');
assert.strictEqual(s.renderbuffers[0].width, 512, '渲染缓冲明细 width');
assert.strictEqual(s.renderbuffers[0].format, 0x8058, '渲染缓冲明细 format');
assert.ok(s.renderbuffers[0].createdSource && s.renderbuffers[0].createdSource.file, '渲染缓冲有来源');
gl.deleteRenderbuffer(rb);
push();
s = snapshot();
assert.strictEqual(s.renderbuffersAlive, 0, '删除后渲染缓冲 0');
assert.strictEqual(s.rbBytes, 0, '删除后渲染缓冲显存 0');

// WebGL2 3D 纹理追踪（用 WebGL2 模拟上下文）
function FakeGL2Context() { this._s = { tex: null, tex3d: null, arr: null, elem: null, rb: null }; }
FakeGL2Context.prototype = Object.create(global.WebGL2RenderingContext.prototype);
const gl2 = new FakeGL2Context();
const tex3d = gl2.createTexture();
gl2._s.tex3d = tex3d;
gl2.texImage3D(0x806F, 0, 0x8058, 64, 64, 16, 0, 0x1908, 0x1401, null); // TEXTURE_3D, RGBA8, 64x64x16
push();
s = snapshot();
assert.ok(s.textures.some(function (t) { return t.depth === 16 && t.width === 64; }), '3D 纹理明细含 depth');
assert.ok(s.texBytes >= 64 * 64 * 16 * 4, '3D 纹理显存计入');

// 自动激活：即使不通过 getContext，第一次 WebGL 方法调用也应激活
// （本测试中已通过 getContext 激活，这里验证 active 状态持续为 true）
assert.strictEqual(s.active, true, 'active 持续为 true');

console.log('✔ hook.js 全部断言通过（纯函数 + 挂钩逻辑 + 渲染缓冲 + 3D 纹理）');

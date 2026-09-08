/* MV.mpr — 多平面重建(MPR): 轴位/冠状/矢状三平面 + 十字线联动
 * 由序列堆栈构建体数据(有效值 Float32), 三视图各自滚轮/滑条定位,
 * 任一视图点击或拖动即移动十字线, 其余两视图同步刷新。
 * 支持 WW/WL(左键拖拽)、缩放(右键/Ctrl+滚轮/双指)、平移(Shift+左键/双指)、复位。
 */
(function () {
  'use strict';
  window.MV = window.MV || {};
  const U = MV.U;

  const PLANE_LABEL = { axial: '轴位 AX', coronal: '冠状 COR', sagittal: '矢状 SAG' };
  const LINE_COLOR = { x: '#ff6b81', y: '#61d9ff', z: '#ffd83d' };   // 十字线: x红/y蓝/z黄
  MV.mprCrosshair = true;   // 十字线显示开关(工具栏按钮切换)

  /** 从 Stack 异步构建体数据
   * 层位沿图像法线(IOP 行向量×列向量)投影并排序 — 兼容轴位/冠状/矢状位采集;
   * 层间距回退链: 法线方向投影差中位数 → SpacingBetweenSlices → SliceThickness → 1 */
  async function buildVolume(stack, onProgress) {
    const imgs = stack.images;
    if (!imgs.length) throw new Error('空序列');
    const first = await stack.instance(imgs[0].file);
    const fr = await first.dec.getFrame(imgs[0].frame);
    if (fr.kind === 'rgb') throw new Error('MPR 暂不支持彩色序列');
    const nx = fr.cols, ny = fr.rows;
    const p0 = first.ds.p || {};
    const sx = p0.spacingX > 0 ? p0.spacingX : 1;
    const sy = p0.spacingY > 0 ? p0.spacingY : 1;

    // 图像法线 = 行方向 × 列方向(缺省假设轴位 1,0,0 / 0,1,0 → 法线 0,0,1)
    const iop0 = p0.orientation && p0.orientation.length >= 6 ? p0.orientation : [1, 0, 0, 0, 1, 0];
    const nrm = [
      iop0[1] * iop0[5] - iop0[2] * iop0[4],
      iop0[2] * iop0[3] - iop0[0] * iop0[5],
      iop0[0] * iop0[4] - iop0[1] * iop0[3]
    ];

    // 逐层: 读位置投影, 收集顺序
    const order = [];
    const zsInfo = [];
    let wc = NaN, ww = NaN;
    if (isFinite(p0.wc) && isFinite(p0.ww) && p0.ww > 0) { wc = p0.wc; ww = p0.ww; }

    for (let k = 0; k < imgs.length; k++) {
      const inst = await stack.instance(imgs[k].file);
      const dsP = inst.ds.p || {};
      if (!isFinite(wc) && isFinite(dsP.wc) && isFinite(dsP.ww) && dsP.ww > 0) { wc = dsP.wc; ww = dsP.ww; }
      const pos = dsP.position;
      const zProj = pos && pos.length >= 3 ? (pos[0] * nrm[0] + pos[1] * nrm[1] + pos[2] * nrm[2]) : NaN;
      zsInfo.push({ k, zProj, inst });
    }

    const hasProj = zsInfo.every((e) => isFinite(e.zProj));
    let zs = new Float32Array(imgs.length);
    if (hasProj) {
      zsInfo.sort((a, b) => a.zProj - b.zProj);
      for (let i = 0; i < zsInfo.length; i++) { zs[i] = zsInfo[i].zProj; order.push(zsInfo[i].k); }
    } else {
      for (let k = 0; k < imgs.length; k++) { zs[k] = k; order.push(k); }
    }

    // 层间距回退链
    let sz = 0;
    if (hasProj && imgs.length >= 2) {
      const diffs = [];
      for (let k = 1; k < imgs.length; k++) diffs.push(Math.abs(zs[k] - zs[k - 1]));
      diffs.sort((a, b) => a - b);
      const med = diffs[Math.floor(diffs.length / 2)];
      if (med > 0.01) sz = med;   // 全同投影(单排定位像等)则跳过
    }
    if (!(sz > 0.01)) sz = Math.abs(p0.spacingBetween || 0);
    if (!(sz > 0.01)) sz = Math.abs(p0.thickness || 0);
    if (!(sz > 0.01)) sz = 1;

    // 按层序构建体数据
    const vol = new Float32Array(nx * ny * imgs.length);
    for (let i = 0; i < order.length; i++) {
      const k = order[i];
      const inst = zsInfo.length ? zsInfo[hasProj ? i : k].inst : await stack.instance(imgs[k].file);
      const f = await inst.dec.getFrame(imgs[k].frame);
      if (f.cols !== nx || f.rows !== ny) throw new Error('序列内图像尺寸不一致, 无法重建');
      const dsP = inst.ds.p || {};
      const sl = dsP.slope || 1, it = dsP.intercept || 0, sg = !!dsP.signed;
      const src = f.pixels;
      const base = i * nx * ny;
      for (let j = 0; j < nx * ny; j++) {
        let v = src[j];
        if (sg && v > 32767) v -= 65536;
        vol[base + j] = v * sl + it;
      }
      if (onProgress && (i % 8 === 0 || i === order.length - 1)) onProgress((i + 1) / order.length);
    }

    // 全局自动窗兜底
    if (!isFinite(wc) || !isFinite(ww) || ww <= 0) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < vol.length; i += 29) { const v = vol[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      wc = (mn + mx) / 2; ww = Math.max(1, mx - mn);
    }
    return { vol, nx, ny, nz: imgs.length, sx, sy, sz, wc, ww };
  }

  /* ============ 单个 MPR 视图 ============ */
  class MprPlane {
    constructor(view, plane) {
      this.view = view;
      this.plane = plane;          // axial | coronal | sagittal
      this.el = U.el('div', { class: 'pane mpr-pane' });
      this.canvas = U.el('canvas', { class: 'vp-canvas' });
      this.label = U.el('div', { class: 'mpr-label' });
      this.loadMask = U.el('div', { class: 'vp-load', text: '重建中…', style: { display: 'none' } });
      this.el.appendChild(this.canvas);
      this.el.appendChild(this.label);
      this.el.appendChild(this.loadMask);
      this.ctx = this.canvas.getContext('2d');
      this.zoom = 1; this.pan = { x: 0, y: 0 };
      this.active = false;
      this._bind();
      this._lastW = 0; this._lastH = 0;
      this._sizeTimer = setInterval(() => {
        if (this.el.clientWidth !== this._lastW || this.el.clientHeight !== this._lastH) this._resize();
      }, 350);
      this._resize();
    }

    destroy() { clearInterval(this._sizeTimer); this.el.innerHTML = ''; }

    /** 该平面的图像尺寸与像素物理尺寸(水平, 垂直) */
    dims() {
      const v = this.view.vol;
      if (this.plane === 'axial') return { w: v.nx, h: v.ny, px: v.sx, py: v.sy, ax: 'x', ay: 'y' };
      if (this.plane === 'coronal') return { w: v.nx, h: v.nz, px: v.sx, py: v.sz, ax: 'x', ay: 'z' };
      return { w: v.ny, h: v.nz, px: v.sy, py: v.sz, ax: 'y', ay: 'z' };   // sagittal
    }
    /** 取平面像素值 */
    sample(x, y) {
      const v = this.view.vol, c = this.view.cross;
      if (this.plane === 'axial') return v.vol[c.z * v.nx * v.ny + y * v.nx + x];
      if (this.plane === 'coronal') return v.vol[y * v.nx * v.ny + c.y * v.nx + x];
      return v.vol[y * v.nx * v.ny + x * v.nx + c.x];
    }
    /** 当前平面定位索引(z/y/x) */
    idx() { return this.view.cross[this.plane === 'axial' ? 'z' : this.plane === 'coronal' ? 'y' : 'x']; }
    /** 该平面滚动轴的最大值 */
    axisMax() {
      const v = this.view.vol;
      return this.plane === 'axial' ? v.nz : this.plane === 'coronal' ? v.ny : v.nx;
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
      this._lastW = this.el.clientWidth; this._lastH = this.el.clientHeight;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.render();
    }

    render() {
      const v = this.view.vol;
      if (!v) return;
      const dpr = window.devicePixelRatio || 1;
      const W = this.canvas.width, H = this.canvas.height;
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      const d = this.dims();
      // 各向异性: 水平/垂直像素间距不同, 按物理比例缩放
      const fit = Math.min(W / (d.w * d.px), H / (d.h * d.py)) * 0.96;
      const scale = fit * this.zoom;
      const cx = W / 2 + this.pan.x * dpr, cy = H / 2 + this.pan.y * dpr;
      const ox = cx - d.w * d.px * scale / 2;
      const oy = cy - d.h * d.py * scale / 2;

      // 生成平面图像(带 LUT)
      const { wc, ww, invert } = this.view;
      const lo = wc - ww / 2, range = Math.max(1e-6, ww);
      const img = ctx.createImageData(d.w, d.h);
      const data = img.data;
      for (let y = 0; y < d.h; y++) {
        for (let x = 0; x < d.w; x++) {
          let t = (this.sample(x, y) - lo) / range;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          let g = Math.round(t * 255);
          if (invert) g = 255 - g;
          const i = (y * d.w + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = g;
          data[i + 3] = 255;
        }
      }
      const tmp = this._tmpCanvas || (this._tmpCanvas = document.createElement('canvas'));
      tmp.width = d.w; tmp.height = d.h;
      tmp.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = MV.imageSmooth !== false;
      ctx.imageSmoothingQuality = 'high';
      // drawImage 到物理比例目标区
      ctx.drawImage(tmp, ox, oy, d.w * d.px * scale, d.h * d.py * scale);

      // 十字线(可隐藏): 方向由该轴在平面内的朝向决定(d.ax=平面水平轴→竖线, d.ay=垂直轴→横线)
      if (MV.mprCrosshair !== false) {
        const cross = this.view.cross;
        const lineV = (value, color) => {
          const x = ox + value * d.px * scale;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * dpr;
          ctx.setLineDash([6 * dpr, 5 * dpr]);
          ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy + d.h * d.py * scale); ctx.stroke();
          ctx.setLineDash([]);
        };
        const lineH = (value, color) => {
          const y = oy + value * d.py * scale;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * dpr;
          ctx.setLineDash([6 * dpr, 5 * dpr]);
          ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + d.w * d.px * scale, y); ctx.stroke();
          ctx.setLineDash([]);
        };
        lineV(cross[d.ax], LINE_COLOR[d.ax]);
        lineH(cross[d.ay], LINE_COLOR[d.ay]);
      }

      // 标签
      this.label.innerHTML = PLANE_LABEL[this.plane] +
        '<span class="mpr-sub"> · ' + (this.idx() + 1) + '/' + this.axisMax() + ' · WC ' + Math.round(wc) + '/WW ' + Math.round(ww) +
        (invert ? ' · 反色' : '') + '</span>';

      // 存储坐标映射供交互
      this._map = { ox, oy, sx: d.px * scale, sy: d.py * scale, d, dpr };
    }

    toPlanePixel(clientX, clientY) {
      const r = this.el.getBoundingClientRect();
      const m = this._map;
      if (!m) return null;
      return { x: (clientX - r.left - m.ox / m.dpr) / (m.sx / m.dpr), y: (clientY - r.top - m.oy / m.dpr) / (m.sy / m.dpr) };
    }

    _bind() {
      const el = this.el;
      el.style.touchAction = 'none';
      el.addEventListener('pointerdown', (e) => this._down(e));
      el.addEventListener('pointermove', (e) => this._move(e));
      el.addEventListener('pointerup', (e) => this._up(e));
      el.addEventListener('pointercancel', (e) => this._up(e));
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.view.setActive(this);
        if (e.ctrlKey) {
          this.zoom = U.clamp(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 40);
          this.render();
        } else {
          this.view.nudge(this.plane, e.deltaY > 0 ? 1 : -1);
        }
      }, { passive: false });
      el.addEventListener('dblclick', () => { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.render(); });
      el.addEventListener('pointerleave', () => { if (this._hover) { this._hover = false; this.render(); } });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      this.pointers = new Map();
    }

    _down(e) {
      this.view.setActive(this);
      e.preventDefault();
      try { this.el.setPointerCapture(e.pointerId); } catch (err) { }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        this._gesture = this._two();
        this._drag = null;
        return;
      }
      const shiftPan = e.shiftKey || e.button === 1;
      this._drag = {
        mode: e.button === 2 ? 'zoom' : shiftPan ? 'pan' : 'cross',
        sx: e.clientX, sy: e.clientY, zoom: this.zoom, pan: { ...this.pan }
      };
      if (this._drag.mode === 'cross') {
        const pt = this.toPlanePixel(e.clientX, e.clientY);
        if (pt) this.view.setCross(this.plane, pt);
      }
    }
    _two() {
      const ps = Array.from(this.pointers.values());
      return { dist: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), zoom: this.zoom, cx: (ps[0].x + ps[1].x) / 2, cy: (ps[0].y + ps[1].y) / 2, pan: { ...this.pan } };
    }
    _move(e) {
      // 悬停读数: 标签尾部显示 坐标 + 值
      if (this.pointers.size === 0 && this.view.vol && this._map && e.pointerType === 'mouse') {
        const pt = this.toPlanePixel(e.clientX, e.clientY);
        const d = this.dims();
        if (pt && pt.x >= 0 && pt.y >= 0 && pt.x < d.w && pt.y < d.h) {
          const v = this.sample(Math.round(pt.x), Math.round(pt.y));
          this.label.innerHTML = PLANE_LABEL[this.plane] +
            '<span class="mpr-sub"> · ' + (this.idx() + 1) + '/' + this.axisMax() + ' · WC ' + Math.round(this.view.wc) + '/WW ' + Math.round(this.view.ww) +
            ' · (' + Math.round(pt.x) + ',' + Math.round(pt.y) + ') ' + Math.round(v) + '</span>';
          this._hover = true;
          return;
        }
      }
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size >= 2 && this._gesture) {
        const ps = Array.from(this.pointers.values());
        const dist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        const cx = (ps[0].x + ps[1].x) / 2, cy = (ps[0].y + ps[1].y) / 2;
        if (this._gesture.dist > 10) this.zoom = U.clamp(this._gesture.zoom * dist / this._gesture.dist, 0.1, 40);
        this.pan.x = this._gesture.pan.x + (cx - this._gesture.cx);
        this.pan.y = this._gesture.pan.y + (cy - this._gesture.cy);
        this.render();
        return;
      }
      const d = this._drag;
      if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (d.mode === 'cross') {
        const pt = this.toPlanePixel(e.clientX, e.clientY);
        if (pt) this.view.setCross(this.plane, pt);
      } else if (d.mode === 'pan') {
        this.pan.x = d.pan.x + dx; this.pan.y = d.pan.y + dy;
        this.render();
      } else if (d.mode === 'zoom') {
        this.zoom = U.clamp(d.zoom * (1 + dy * 0.005), 0.1, 40);
        this.render();
      }
    }
    _up(e) {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this._gesture = null;
      this._drag = null;
    }
  }

  /* ============ MPR 总视图 ============ */
  class MprView {
    constructor(container, stack, opts) {
      this.container = container;
      this.stack = stack;
      this.opts = opts || {};
      this.vol = null;
      this.wc = 0; this.ww = 1; this.invert = false;
      this.cross = { x: 0, y: 0, z: 0 };
      this.planes = [];
      this.destroyed = false;
      this.root = U.el('div', { class: 'panes mpr-layout' });
      container.appendChild(this.root);
      ['axial', 'coronal', 'sagittal'].forEach((p) => {
        const pl = new MprPlane(this, p);
        this.planes.push(pl);
        this.root.appendChild(pl.el);
      });
      this.setActive(this.planes[0]);
    }

    async build(onProgress) {
      this.vol = await buildVolume(this.stack, onProgress);
      if (this.destroyed) return;
      this.wc = this.vol.wc; this.ww = this.vol.ww;
      // 十字线初始居中
      this.cross = { x: Math.floor(this.vol.nx / 2), y: Math.floor(this.vol.ny / 2), z: Math.floor(this.vol.nz / 2) };
      this.planes.forEach((p) => p.render());
      if (this.opts.onready) this.opts.onready(this);
    }

    setActive(pl) {
      this.active = pl;
      this.planes.forEach((p) => p.el.classList.toggle('active', p === pl));
    }

    /** 移动平面索引(axial→z, coronal→y, sagittal→x), 并同步渲染全部 */
    nudge(plane, dir) {
      const key = plane === 'axial' ? 'z' : plane === 'coronal' ? 'y' : 'x';
      const max = key === 'z' ? this.vol.nz : key === 'y' ? this.vol.ny : this.vol.nx;
      this.cross[key] = U.clamp(this.cross[key] + dir, 0, max - 1);
      this.renderAll();
    }

    /** 由某平面的像素坐标设置十字线(其余两轴) */
    setCross(plane, pt) {
      const d = this.planes.find((p) => p.plane === plane).dims();
      const x = U.clamp(Math.round(pt.x), 0, d.w - 1);
      const y = U.clamp(Math.round(pt.y), 0, d.h - 1);
      this.cross[d.ax] = x;
      this.cross[d.ay] = y;
      this.renderAll();
    }

    applyVoi(wc, ww) { this.wc = wc; this.ww = ww; this.renderAll(); }
    invertToggle() { this.invert = !this.invert; this.renderAll(); }
    renderAll() { this.planes.forEach((p) => p.render()); }

    state() {
      const a = this.planes[0];
      return {
        idx: this.cross.z + 1, total: this.vol ? this.vol.nz : 1,
        ww: this.ww, wl: this.wc, cine: false,
        seriesDesc: (this.stack.info.desc || '') + ' · MPR',
        hasFrame: true, mpr: true
      };
    }

    destroy() {
      this.destroyed = true;
      this.planes.forEach((p) => p.destroy());
      this.root.remove();
    }
  }

  MV.mpr = { MprView, buildVolume };
})();

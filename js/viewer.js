/* MV.viewer — 影像视口: 渲染 + 常规读图工具
 * WW/WL、缩放、平移、滚轮/滑动翻层、CINE、反色、旋转、翻转、复位、
 * 长度/角度/矩形ROI/椭圆ROI/像素探针/箭头/文字标注(支持触屏)
 */
(function () {
  'use strict';
  window.MV = window.MV || {};
  const U = MV.U;

  // 全局图像插值开关(放大时平滑/像素化), 由工具栏"平滑"按钮切换
  MV.imageSmooth = true;

  const ANNO_COLORS = ['#ffd83d', '#4dd964', '#ff6b81', '#61d9ff', '#ff9f43', '#c56cf0'];
  let annoSeq = 1;

  // 非图像序列类型(结构化报告/注释/关键对象等, 无像素数据)
  const NON_IMAGE_MODALITIES = ['SR', 'PR', 'KO', 'DOC', 'REG', 'PLAN', 'TRIPLET'];

  /* ================= Stack:一个序列 ================= */
  class Stack {
  /** info: {uid, number, desc, modality, files:[{sop, instNo, frames, getBytes()}], patient} */
  constructor(info) {
    this.info = info;
    this.patientOverride = info.patient || null;   // 库中(用户核对后)的患者信息, 优先于文件头
      this.files = (info.files || []).slice().sort((a, b) => (a.instNo || 0) - (b.instNo || 0));
      this.images = [];
      this.files.forEach((f) => {
        const n = Math.max(1, f.frames || 1);
        for (let i = 0; i < n; i++) this.images.push({ file: f, frame: i, key: f.sop + '#' + i });
      });
      this.instCache = new U.LRU(16);
      this.annos = new Map();     // imageKey -> [anno]
      this.header = null;         // 首个实例的数据集(用于显示信息)
      this.err = null;
    }

    async instance(file) {
      if (this.instCache.has(file.sop)) return this.instCache.get(file.sop);
      const bytes = await file.getBytes();
      const ds = MV.dicom.parse(bytes);
      const dec = await MV.decoder.decodeInstance(ds);
      const inst = { ds, dec };
      this.instCache.set(file.sop, inst);
      if (!this.header) this.header = ds;
      return inst;
    }

    annosOf(key) {
      let a = this.annos.get(key);
      if (!a) { a = []; this.annos.set(key, a); }
      return a;
    }
  }

  /* ================= Pane:一个视口 ================= */
  class Pane {
    constructor(viewer, el, idx) {
      this.viewer = viewer;
      this.el = el;
      this.idx = idx;
      this.stack = null;
      this.imgIdx = 0;
      this.ww = 400; this.wl = 40;
      this.invert = false;
      this.rot = 0; this.flipH = false; this.flipV = false;
      this.zoom = 1; this.pan = { x: 0, y: 0 };
      this.scale = 1; // 屏幕像素/图像像素
      this.frame = null;       // {pixels, kind, rows, cols}
      this.frameCanvas = document.createElement('canvas');
      this.frameCtx = this.frameCanvas.getContext('2d');
      this.lut = null; this.lutKey = '';
      this.loading = false;
      this.loadToken = 0;
      this.selected = -1;
      this.pendingAnno = null;  // 点击式标注进行中
      this.pointers = new Map();
      this.gesture = null;
      this.lastTap = 0; this.lastCompleted = 0;

      this.canvas = U.el('canvas', { class: 'vp-canvas' });
      this.roiRect = null;          // ROI 自动窗的临时预览框(图像坐标)
      this.probeInfo = null;        // 悬停读数 {x, y, v}(图像坐标 + 有效值)
      this.corners = {};
      ['tl', 'tr', 'bl', 'br'].forEach((k) => {
        this.corners[k] = U.el('div', { class: 'corner corner-' + k });
      });
      this.loadMask = U.el('div', { class: 'vp-load', text: '加载中…' });
      el.appendChild(this.canvas);
      el.appendChild(this.corners.tl); el.appendChild(this.corners.tr);
      el.appendChild(this.corners.bl); el.appendChild(this.corners.br);
      el.appendChild(this.loadMask);
      this.ctx = this.canvas.getContext('2d');

      this._bind();
      this._lastW = 0; this._lastH = 0;
      // 尺寸自适应: ResizeObserver + 轮询双保险(部分嵌入式 WebView 不触发 RO)
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(el);
      this._sizeTimer = setInterval(() => {
        if (this.el.clientWidth !== this._lastW || this.el.clientHeight !== this._lastH) this._resize();
      }, 350);
    }

    destroy() {
      this._ro.disconnect();
      clearInterval(this._sizeTimer);
      this.el.innerHTML = '';
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
      this._lastW = this.el.clientWidth; this._lastH = this.el.clientHeight;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.fit();
    }

    setStack(stack, keepView) {
      this.stack = stack;
      this.imgIdx = 0;
      this.selected = -1; this.pendingAnno = null;
      this._defaultVoi = null; this._userVoi = false; this._invertTouched = false;
      if (!keepView) {
        this.rot = 0; this.flipH = false; this.flipV = false;
        this.zoom = 1; this.pan = { x: 0, y: 0 };
      }
      this.showImage(0, true);
    }

    get total() { return this.stack ? this.stack.images.length : 0; }
    get image() { return this.stack ? this.stack.images[this.imgIdx] : null; }

    async showImage(i, resetView) {
      if (!this.stack || !this.total) return;
      const token = ++this.loadToken;
      i = U.clamp(i, 0, this.total - 1);
      this.imgIdx = i;
      const img = this.stack.images[i];
      this.loading = !this.stack.instCache.has(img.file.sop);
      this.loadMask.style.display = this.loading ? '' : 'none';
      try {
        const inst = await this.stack.instance(img.file);
        if (token !== this.loadToken) return;
        const frame = await inst.dec.getFrame(img.frame);
        if (token !== this.loadToken) return;
        this.frame = frame;
        if (!this._invertTouched) this.invert = inst.ds.p ? !!inst.ds.p.defaultInvert : false;

        // 默认窗宽窗位
        const p = inst.ds.p;
        if (this._defaultVoi == null) {
          let wc = p.wc, ww = p.ww;
          if (!(isFinite(wc) && isFinite(ww) && ww > 0)) {
            if (inst.dec.stats) { wc = (inst.dec.stats.min + inst.dec.stats.max) / 2; ww = Math.max(1, inst.dec.stats.max - inst.dec.stats.min); }
            else { wc = 128; ww = 256; }
          }
          this._defaultVoi = { wc, ww };
        }
        this.ww = this._userVoi ? this.ww : this._defaultVoi.ww;
        this.wl = this._userVoi ? this.wl : this._defaultVoi.wc;

        if (resetView) { this.zoom = 1; this.pan = { x: 0, y: 0 }; this._userVoi = false; }
        this.lutKey = '';
        this.fit();
        this.viewer._notify();
        this.viewer._syncSiblings(this);
        this._prefetch(i);
      } catch (err) {
        if (token !== this.loadToken) return;
        this.frame = null;
        this.loadMask.textContent = '加载失败: ' + (err && err.message || err);
        this.loadMask.style.display = '';
        U.toast('图像加载失败: ' + (err && err.message || err), 'error');
      }
    }

    _prefetch(i) {
      if (!this.stack) return;
      const imgs = this.stack.images;
      for (let d = 1; d <= 3; d++) {
        [i + d, i - d].forEach((j) => {
          if (j >= 0 && j < imgs.length && !this.stack.instCache.has(imgs[j].file.sop)) {
            this.stack.instance(imgs[j].file).catch(() => { });
          }
        });
      }
    }

    fit() {
      if (!this.frame) { this.render(); return; }
      const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
      const margin = 0.97;
      let s = Math.min(w / this.frame.cols, h / this.frame.rows) * margin;
      if (!isFinite(s) || s <= 0) s = 1;
      this.scale = s * this.zoom;
      this.render();
    }

    /* ---------- 窗宽窗位 LUT ---------- */
    buildLUT() {
      if (!this.frame) return;
      const kind = this.frame.kind;
      let key = kind + '|' + this.ww + '|' + this.wl + '|' + this.invert;
      if (key === this.lutKey && this.lut) return;
      this.lutKey = key;
      const ds = this.stack.instCache.get(this.image.file.sop);
      const p = ds ? ds.ds.p : { slope: 1, intercept: 0, signed: false };
      const size = kind === 'gray16' ? 65536 : 256;
      const lut = new Uint8Array(size);
      const lo = this.wl - this.ww / 2, hi = this.wl + this.ww / 2;
      const range = Math.max(1e-6, hi - lo);
      for (let i = 0; i < size; i++) {
        let v = i;
        if (kind === 'gray16') {
          if (p.signed && i > 32767) v = i - 65536;
          v = v * p.slope + p.intercept;
        }
        let t = (v - lo) / range;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        t = Math.round(t * 255);
        lut[i] = this.invert ? 255 - t : t;
      }
      this.lut = lut;
    }

    /* ---------- 变换 ---------- */
    _transform() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.el.clientWidth, h = this.el.clientHeight;
      return { dpr, w, h, cx: w / 2 + this.pan.x, cy: h / 2 + this.pan.y, s: this.scale, rot: this.rot, fh: this.flipH, fv: this.flipV };
    }

    imageToScreen(t, x, y) {
      let dx = x, dy = y;
      const r = this.frame ? this.frame.rows / 2 : 0, c = this.frame ? this.frame.cols / 2 : 0;
      dx -= c; dy -= r;
      if (t.fh) dx = -dx;
      if (t.fv) dy = -dy;
      const rad = t.rot * Math.PI / 2;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      let rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
      rx *= t.s; ry *= t.s;
      return { x: t.cx + rx, y: t.cy + ry };
    }
    screenToImage(t, sx, sy) {
      let dx = sx - t.cx, dy = sy - t.cy;
      dx /= t.s; dy /= t.s;
      const rad = -t.rot * Math.PI / 2;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      let rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
      if (t.fh) rx = -rx;
      if (t.fv) ry = -ry;
      const r = this.frame ? this.frame.rows / 2 : 0, c = this.frame ? this.frame.cols / 2 : 0;
      return { x: rx + c, y: ry + r };
    }

    /* ---------- 渲染 ---------- */
    render(targetCtx, W, H) {
      const ctx = targetCtx || this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const w = targetCtx ? W / dpr : this.el.clientWidth;
      const h = targetCtx ? H / dpr : this.el.clientHeight;
      if (w <= 0 || h <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      if (!this.frame) {
        // 空视口提示(多视图布局下未加载序列的格子)
        if (!this.stack) {
          ctx.fillStyle = 'rgba(141, 153, 171, .55)';
          ctx.font = '13px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('空视口', w / 2, h / 2 - 10);
          ctx.font = '11.5px system-ui, sans-serif';
          ctx.fillText('先点击此处激活, 再点击左侧序列载入', w / 2, h / 2 + 12);
          ctx.textAlign = 'left';
        }
        this._updateCorners();
        return;
      }

      // LUT 应用到帧画布
      this.buildLUT();
      const fr = this.frame;
      if (this.frameCanvas.width !== fr.cols || this.frameCanvas.height !== fr.rows) {
        this.frameCanvas.width = fr.cols; this.frameCanvas.height = fr.rows;
        this.imgData = this.frameCtx.createImageData(fr.cols, fr.rows);
      }
      const n = fr.cols * fr.rows;
      const out = this.imgData.data;
      if (fr.kind === 'rgb') {
        const src = fr.pixels, lut = this.lut;
        if (this.invert) {
          for (let i = 0, j = 0; i < n; i++, j += 4) {
            out[j] = lut[src[j]]; out[j + 1] = lut[src[j + 1]]; out[j + 2] = lut[src[j + 2]]; out[j + 3] = 255;
          }
        } else {
          out.set(src.subarray(0, n * 4));
          for (let i = 3; i < n * 4; i += 4) out[i] = 255;
        }
      } else {
        const lut = this.lut, src = fr.pixels;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          const v = lut[src[i]];
          out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
        }
      }
      this.frameCtx.putImageData(this.imgData, 0, 0);

      const t = this._transform();
      ctx.save();
      ctx.translate(t.cx, t.cy);
      ctx.rotate(t.rot * Math.PI / 2);
      ctx.scale(t.s * (t.fh ? -1 : 1), t.s * (t.fv ? -1 : 1));
      ctx.imageSmoothingEnabled = MV.imageSmooth !== false;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.frameCanvas, -fr.cols / 2, -fr.rows / 2);
      ctx.restore();

      this._drawAnnotations(ctx, t);
      // ROI 自动窗预览框
      if (this.roiRect) {
        const a = this.imageToScreen(t, this.roiRect.x0, this.roiRect.y0);
        const b = this.imageToScreen(t, this.roiRect.x1, this.roiRect.y1);
        ctx.save();
        ctx.strokeStyle = '#ffd83d';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.restore();
      }
      this._updateCorners();
      this.viewer._notify();
    }

    _spacing() {
      const inst = this.stack && this.stack.instCache.get(this.image.file.sop);
      const p = inst ? inst.ds.p : null;
      return { sx: p && p.spacingX > 0 ? p.spacingX : 0, sy: p && p.spacingY > 0 ? p.spacingY : 0 };
    }
    _calibrated() { const s = this._spacing(); return s.sx > 0 && s.sy > 0; }

    _fmtLen(px) {
      const s = this._spacing();
      if (s.sx > 0 && s.sy > 0) {
        // 输入 px 是 dx,dy 的 hypot,按各向同近似;精确值在标注里单独计算
        return px.toFixed(1);
      }
      return px.toFixed(0) + 'px';
    }

    _updateCorners() {
      if (!this.stack) return;
      const inst = this.stack.instCache.get(this.image.file.sop);
      const ds = inst ? inst.ds : this.stack.header;
      const TAG = MV.TAG;
      const c = this.corners;
      if (ds) {
        const ov = this.stack.patientOverride || {};
        const name = ov.name || U.fmtPN(ds.str(TAG.PatientName));
        const pid = ov.id != null ? ov.id : ds.str(TAG.PatientID);
        const sex = ov.sex != null && ov.sex !== '' ? ov.sex : ds.str(TAG.PatientSex);
        const birth = ov.birth || ds.str(TAG.BirthDate);
        const studyDate = ds.str(TAG.StudyDate);
        const sexText = U.fmtSex(sex);
        const birthText = U.fmtDate(birth);
        const ageRaw = (ov.birth ? U.age(ov.birth, studyDate) : '') || ds.str(TAG.PatientAge) || U.age(birth, studyDate);
        const age = /^0+Y?$/.test(ageRaw.trim()) ? '' : ageRaw;
        c.tl.innerHTML =
          U.esc(name || '未知姓名') + '<br>' +
          U.esc((pid ? 'ID ' + pid : '')) +
          (sexText ? ' · ' + U.esc(sexText) : '') + (birthText ? ' · ' + U.esc(birthText) : '') +
          (age ? ' · ' + U.esc(age) : '');
        const p = ds.p;
        c.tr.innerHTML =
          U.esc(this.stack.info.desc || ('序列 ' + (this.stack.info.number || ''))) + '<br>' +
          U.esc(ds.str(TAG.StudyDescription) || '检查') + ' · ' + U.esc(U.fmtDate(ds.str(TAG.StudyDate)));
        c.br.innerHTML =
          '图 ' + (this.imgIdx + 1) + '/' + this.total +
          (p && p.thickness ? ' · 层厚 ' + p.thickness.toFixed(1) + 'mm' : '') +
          (p && p.spacingX ? ' · ' + p.spacingX.toFixed(2) + '×' + p.spacingY.toFixed(2) + 'mm' : '') +
          (ds.str(TAG.Modality) ? ' · ' + U.esc(ds.str(TAG.Modality)) : '');
      }
      const zoomStr = (this.scale / (this.frame ? Math.min(this.el.clientWidth / this.frame.cols, this.el.clientHeight / this.frame.rows) : 1)).toFixed(2);
      let probeStr = '';
      if (this.probeInfo && this.frame) {
        const instH = this.stack.instCache.get(this.image.file.sop);
        const unit = instH && instH.ds.p && instH.ds.p.intercept ? ' HU' : '';
        probeStr = '<br>(' + this.probeInfo.x + ', ' + this.probeInfo.y + ') ' + Math.round(this.probeInfo.v) + unit;
      }
      c.bl.innerHTML =
        'WC ' + Math.round(this.wl) + ' / WW ' + Math.round(this.ww) + '<br>' +
        '放大 ' + zoomStr + 'x' + (this.invert ? ' · 反色' : '') + probeStr;
    }

    /* ---------- 标注 ---------- */
    _drawAnnotations(ctx, t) {
      if (!this.stack) return;
      const list = this.stack.annosOf(this.image.key).slice();
      const items = list.map((a, i) => ({ a, i }));
      if (this.pendingAnno) items.push({ a: this.pendingAnno, i: -2 });
      items.forEach(({ a, i }) => {
        const sel = i === this.selected;
        const color = a.color || ANNO_COLORS[0];
        const pts = a.pts.map((p) => this.imageToScreen(t, p.x, p.y));
        ctx.save();
        ctx.lineWidth = sel ? 2.5 : 1.8;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.setLineDash(i === -2 ? [5, 4] : []);
        ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 3;

        const drawLabel = (text, x, y) => {
          ctx.font = '12px system-ui, sans-serif';
          const w = ctx.measureText(text).width;
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(0,0,0,.65)';
          ctx.fillRect(x - 2, y - 13, w + 8, 17);
          ctx.fillStyle = color;
          ctx.fillText(text, x + 2, y);
          ctx.fillStyle = color;
        };

        if (a.type === 'length' && pts.length >= 2) {
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
          const mm = this._annoLen(a);
          drawLabel(mm, (pts[0].x + pts[1].x) / 2 + 4, (pts[0].y + pts[1].y) / 2 - 6);
        } else if (a.type === 'arrow' && pts.length >= 2) {
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
          const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
          const hl = 10;
          ctx.beginPath();
          ctx.moveTo(pts[1].x, pts[1].y);
          ctx.lineTo(pts[1].x - hl * Math.cos(ang - 0.4), pts[1].y - hl * Math.sin(ang - 0.4));
          ctx.lineTo(pts[1].x - hl * Math.cos(ang + 0.4), pts[1].y - hl * Math.sin(ang + 0.4));
          ctx.closePath(); ctx.fill();
          if (a.text) drawLabel(a.text, pts[1].x + 6, pts[1].y - 6);
        } else if (a.type === 'angle' && pts.length >= 3) {
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.stroke();
          const deg = this._annoAngle(a);
          drawLabel(deg, pts[1].x + 6, pts[1].y - 8);
        } else if (a.type === 'angle' && pts.length === 2) {
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
        } else if (a.type === 'rect' && pts.length >= 2) {
          const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
          const w = Math.abs(pts[1].x - pts[0].x), h = Math.abs(pts[1].y - pts[0].y);
          ctx.strokeRect(x, y, w, h);
          drawLabel(this._annoRectStat(a).label, x, y - 6);
        } else if (a.type === 'ellipse' && pts.length >= 2) {
          const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
          const rx = Math.abs(pts[1].x - pts[0].x) / 2, ry = Math.abs(pts[1].y - pts[0].y) / 2;
          ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
          drawLabel(this._annoRectStat(a).label, cx - rx, cy - ry - 6);
        } else if (a.type === 'probe' && pts.length >= 1) {
          const v = this._probeVal(a);
          drawLabel(v, pts[0].x + 8, pts[0].y - 8);
          ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 2.5, 0, Math.PI * 2); ctx.fill();
        } else if (a.type === 'text' && pts.length >= 1) {
          drawLabel(a.text || '文字', pts[0].x, pts[0].y - 6);
        }

        // 控制点
        if (i >= 0) {
          pts.forEach((p) => {
            ctx.shadowBlur = 0;
            ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = sel ? '#fff' : color; ctx.fill();
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
          });
        }
        // 选中: 删除按钮
        if (sel && i >= 0) {
          const c = pts[Math.floor(pts.length / 2)];
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#e74c3c';
          ctx.beginPath(); ctx.arc(c.x + 14, c.y - 14, 8, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(c.x + 10, c.y - 18); ctx.lineTo(c.x + 18, c.y - 10);
          ctx.moveTo(c.x + 18, c.y - 18); ctx.lineTo(c.x + 10, c.y - 10);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    _effAt(x, y) {
      if (!this.frame) return NaN;
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= this.frame.cols || y >= this.frame.rows) return NaN;
      const raw = this.frame.pixels[y * this.frame.cols + x];
      const inst = this.stack.instCache.get(this.image.file.sop);
      return inst ? inst.ds.eff(raw) : raw;
    }
    _spacingPx() { const s = this._spacing(); return { sx: s.sx || 1, sy: s.sy || 1, cal: this._calibrated() }; }

    _annoLen(a) {
      const dx = a.pts[1].x - a.pts[0].x, dy = a.pts[1].y - a.pts[0].y;
      const s = this._spacingPx();
      if (s.cal) {
        const mm = Math.sqrt((dx * s.sx) ** 2 + (dy * s.sy) ** 2);
        return mm.toFixed(1) + ' mm';
      }
      return Math.sqrt(dx * dx + dy * dy).toFixed(0) + ' px';
    }
    _annoAngle(a) {
      const [A, B, C] = a.pts;
      const v1 = { x: A.x - B.x, y: A.y - B.y }, v2 = { x: C.x - B.x, y: C.y - B.y };
      const d = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
      return (Math.acos(U.clamp(d, -1, 1)) * 180 / Math.PI).toFixed(1) + '°';
    }
    _annoRectStat(a) {
      const x0 = Math.min(a.pts[0].x, a.pts[1].x), x1 = Math.max(a.pts[0].x, a.pts[1].x);
      const y0 = Math.min(a.pts[0].y, a.pts[1].y), y1 = Math.max(a.pts[0].y, a.pts[1].y);
      const s = this._spacingPx();
      let sum = 0, sum2 = 0, n = 0, mn = Infinity, mx = -Infinity;
      const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 200));
      const test = (x, y) => {
        const v = this._effAt(x, y);
        if (isFinite(v)) { sum += v; sum2 += v * v; n++; if (v < mn) mn = v; if (v > mx) mx = v; }
      };
      if (a.type === 'rect') {
        for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) test(x, y);
      } else {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
        for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
          const nx = (x - cx) / rx, ny = (y - cy) / ry;
          if (nx * nx + ny * ny <= 1) test(x, y);
        }
      }
      const areaPx = a.type === 'rect' ? (x1 - x0) * (y1 - y0) : Math.PI * ((x1 - x0) / 2) * ((y1 - y0) / 2);
      const area = s.cal ? (areaPx * s.sx * s.sy / 100).toFixed(1) + ' cm²' : Math.round(areaPx) + ' px²';
      if (!n) return { label: area };
      const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      return { label: area + '  均值 ' + mean.toFixed(1) + ' ±' + sd.toFixed(1), mean, sd, mn, mx, n };
    }
    _probeVal(a) {
      const p = a.pts[0];
      const v = this._effAt(p.x, p.y);
      const inst = this.stack.instCache.get(this.image.file.sop);
      const unit = inst && inst.ds.p && inst.ds.p.intercept ? ' HU' : '';
      return (isFinite(v) ? v.toFixed(0) : '?') + unit + ' (' + Math.round(p.x) + ',' + Math.round(p.y) + ')';
    }

    /* ---------- 交互 ---------- */
    _bind() {
      const el = this.el;
      el.style.touchAction = 'none';
      el.addEventListener('pointerdown', (e) => this._down(e));
      el.addEventListener('pointermove', (e) => this._move(e));
      el.addEventListener('pointerup', (e) => this._up(e));
      el.addEventListener('pointercancel', (e) => this._up(e));
      el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      el.addEventListener('dblclick', (e) => {
        if (Date.now() - this.lastCompleted < 400) return;
        this.reset();
      });
      el.addEventListener('pointerleave', () => { this.probeInfo = null; this._updateCorners(); });
      el.addEventListener('pointerleave', () => { if (this.pendingAnno && this.pendingAnno._preview) { /* 保留 */ } });
    }

    _local(e) {
      const r = this.el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _down(e) {
      this.viewer.setActive(this.idx);
      e.preventDefault();
      try { this.el.setPointerCapture(e.pointerId); } catch (err) { }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointers.size === 2) {
        // 双指手势: 缩放 + 平移
        this._cancelPending();
        this.gesture = this._twoPointerState();
        this._drag = null;
        return;
      }
      if (this.pointers.size > 2) return;

      const tool = this.viewer.tool;
      const pos = this._local(e);
      const t = this._transform();

      // 选中已有标注(点控制点或删除按钮)
      if (this._trySelect(pos, t, e)) return;

      const mk = (type, extra) => {
        const ip = this.screenToImage(t, pos.x, pos.y);
        return Object.assign({ id: annoSeq++, type, pts: [ip], color: ANNO_COLORS[annoSeq % ANNO_COLORS.length] }, extra || {});
      };

      if (tool === 'length' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse') {
        const ip = this.screenToImage(t, pos.x, pos.y);
        this.pendingAnno = mk(tool, { pts: [ip, { x: ip.x, y: ip.y }] });
        this._drag = { mode: 'newAnno' };
      } else if (tool === 'angle') {
        const ip = this.screenToImage(t, pos.x, pos.y);
        if (!this.pendingAnno || this.pendingAnno.type !== 'angle') {
          this.pendingAnno = mk('angle', { pts: [ip, ip] });          // 第1点
        } else if (this.pendingAnno.pts.length <= 2) {
          this.pendingAnno.pts.push(ip);                               // 第2点(顶点)
          if (this.pendingAnno.pts.length >= 3) this._completePending();
        }
        this.render();
      } else if (tool === 'roivoi') {
        // ROI 自动窗: 左键拉框, 松开按 ROI 内直方图自动窗宽窗位
        const ip = this.screenToImage(t, pos.x, pos.y);
        this.roiRect = { x0: ip.x, y0: ip.y, x1: ip.x, y1: ip.y };
        this._drag = { mode: 'roivoi' };
      } else if (tool === 'probe' || tool === 'text') {
        if (tool === 'text') {
          const ip = this.screenToImage(t, pos.x, pos.y);
          U.prompt('输入标注文字', '').then((txt) => {
            if (txt) {
              this.stack.annosOf(this.image.key).push({ id: annoSeq++, type: 'text', pts: [ip], text: txt, color: ANNO_COLORS[annoSeq % ANNO_COLORS.length] });
              this.render();
            }
          });
        } else {
          const ip = this.screenToImage(t, pos.x, pos.y);
          this.stack.annosOf(this.image.key).push({ id: annoSeq++, type: 'probe', pts: [ip], color: ANNO_COLORS[annoSeq % ANNO_COLORS.length] });
          this.lastCompleted = Date.now();
          this.render();
        }
      } else {
        // 常规拖拽工具: 右键=缩放, 中键/Shift+左键=平移, 左键=当前工具
        this._drag = {
          mode: (e.button === 1 || (e.button === 0 && e.shiftKey)) ? 'pan' : e.button === 2 ? 'zoom' : tool,
          sx: e.clientX, sy: e.clientY, ww: this.ww, wl: this.wl, pan: { ...this.pan }, zoom: this.zoom
        };
        if (this._drag.mode === 'wl') this._userVoi = true;
      }
    }

    _twoPointerState() {
      const ps = Array.from(this.pointers.values());
      const a = ps[0], b = ps[1];
      return {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
        zoom: this.zoom, pan: { ...this.pan }
      };
    }

    _move(e) {
      // 悬停读数(无按键时): 左下角显示 坐标 + 灰度/HU
      if (this.pointers.size === 0 && this.frame && e.pointerType === 'mouse') {
        const pos = this._local(e);
        const t = this._transform();
        const ip = this.screenToImage(t, pos.x, pos.y);
        const v = this._effAt(ip.x, ip.y);
        this.probeInfo = isFinite(v) ? { x: Math.round(ip.x), y: Math.round(ip.y), v } : null;
        this._updateCorners();
      }
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointers.size >= 2 && this.gesture) {
        const ps = Array.from(this.pointers.values());
        const a = ps[0], b = ps[1];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (this.gesture.dist > 10) {
          this.zoom = U.clamp(this.gesture.zoom * dist / this.gesture.dist, 0.05, 60);
        }
        this.pan.x = this.gesture.pan.x + (cx - this.gesture.cx);
        this.pan.y = this.gesture.pan.y + (cy - this.gesture.cy);
        this.fit();
        return;
      }

      const pos = this._local(e);
      const t = this._transform();
      // 角度标注预览: 最后一个点跟随光标
      if (this.pendingAnno && this.pendingAnno.type === 'angle' && !this._drag) {
        const ip = this.screenToImage(t, pos.x, pos.y);
        const n = this.pendingAnno.pts.length;
        if (n === 1) this.pendingAnno.pts.push(ip);
        else this.pendingAnno.pts[n - 1] = ip;
        this.render();
        return;
      }
      if (this.pendingAnno && this.pendingAnno._preview && !this._drag) {
        const ip = this.screenToImage(t, pos.x, pos.y);
        this.pendingAnno.pts[1] = ip;
        this.render();
        return;
      }

      if (!this._drag) return;
      const d = this._drag;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;

      if (d.mode === 'newAnno') {
        const ip = this.screenToImage(t, pos.x, pos.y);
        if (this.pendingAnno) { this.pendingAnno.pts[1] = ip; d.moved = true; }
        this.render();
        return;
      }
      if (d.mode === 'roivoi') {
        const ip = this.screenToImage(t, pos.x, pos.y);
        if (this.roiRect) { this.roiRect.x1 = ip.x; this.roiRect.y1 = ip.y; d.moved = true; }
        this.render();
        return;
      }
      if (d.mode === 'wl') {
        this.ww = Math.max(1, d.ww + dx * 2);
        this.wl = d.wl + dy * 2;
        this._userVoi = true;
        this.render();
      } else if (d.mode === 'pan') {
        this.pan.x = d.pan.x + dx; this.pan.y = d.pan.y + dy;
        this.render();
      } else if (d.mode === 'zoom') {
        this.zoom = U.clamp(d.zoom * (1 + dy * 0.005), 0.05, 60);
        this.fit();
      } else if (d.mode === 'scroll') {
        const step = Math.round(dy / 12);
        const target = U.clamp(this.imgIdx + step, 0, this.total - 1);
        if (target !== this.imgIdx) {
          d.sy = e.clientY;
          this.showImage(target);
        }
      } else if (d.mode === 'editPt') {
        const ip = this.screenToImage(t, pos.x, pos.y);
        const list = this.stack.annosOf(this.image.key);
        const a = list[d.annoIdx];
        if (a) { a.pts[d.ptIdx] = ip; this.render(); }
      } else if (d.mode === 'moveAnno') {
        const ip = this.screenToImage(t, pos.x, pos.y);
        const list = this.stack.annosOf(this.image.key);
        const a = list[d.annoIdx];
        if (a) {
          const dxI = ip.x - d.startI.x, dyI = ip.y - d.startI.y;
          d.origPts.forEach((op, k) => { a.pts[k] = { x: op.x + dxI, y: op.y + dyI }; });
          this.render();
        }
      }
    }

    _up(e) {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.gesture = null;
      if (this.pointers.size === 1) { this.gesture = null; }

      const d = this._drag;
      this._drag = null;
      if (!d) {
        // 单击完成点击式标注(双击式)
        return;
      }
      if (d.mode === 'roivoi') {
        const r = this.roiRect;
        this.roiRect = null;
        if (r && d.moved && Math.abs(r.x1 - r.x0) > 4 && Math.abs(r.y1 - r.y0) > 4) {
          this.autoVoiRegion(r.x0, r.y0, r.x1, r.y1);
          U.toast('ROI 自动窗: WC ' + Math.round(this.wl) + ' / WW ' + Math.round(this.ww), 'info', 1600);
        }
        this.render();
        return;
      }
      if (d.mode === 'newAnno' && this.pendingAnno) {
        const moved = d.moved && Math.hypot(
          this.pendingAnno.pts[1].x - this.pendingAnno.pts[0].x,
          this.pendingAnno.pts[1].y - this.pendingAnno.pts[0].y) > 3;
        if (moved) this._completePending();
        else {
          // 转为点击-点击模式,等待第二次点击
          this.pendingAnno._preview = true;
          this.lastTap = Date.now();
          this.render();
        }
      }
    }

    _completePending() {
      if (!this.pendingAnno) return;
      const a = this.pendingAnno;
      delete a._preview;
      // 屏蔽太小的标注(误触)
      if (a.pts.length >= 2 && a.type !== 'angle' && a.type !== 'probe' && a.type !== 'text') {
        const size = Math.hypot(a.pts[1].x - a.pts[0].x, a.pts[1].y - a.pts[0].y);
        if (size < 3) { this.pendingAnno = null; this.render(); return; }
      }
      this.stack.annosOf(this.image.key).push(a);
      this.selected = this.stack.annosOf(this.image.key).length - 1;
      this.pendingAnno = null;
      this.lastCompleted = Date.now();
      this.render();
    }
    _cancelPending() {
      if (this.pendingAnno && this.pendingAnno._preview) { this.pendingAnno = null; this.render(); }
      else if (this.pendingAnno && this.pendingAnno.type === 'angle' && this.pendingAnno.pts.length < 3) {
        this.pendingAnno = null; this.render();
      }
    }

    _trySelect(pos, t, e) {
      const list = this.stack ? this.stack.annosOf(this.image.key) : [];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const pts = a.pts.map((p) => this.imageToScreen(t, p.x, p.y));
        // 删除按钮
        if (i === this.selected) {
          const c = pts[Math.floor(pts.length / 2)];
          if (Math.hypot(pos.x - (c.x + 14), pos.y - (c.y - 14)) < 12) {
            list.splice(i, 1);
            this.selected = -1;
            this.render();
            return true;
          }
        }
        // 控制点
        for (let k = 0; k < pts.length; k++) {
          if (Math.hypot(pos.x - pts[k].x, pos.y - pts[k].y) < 11) {
            this.selected = i;
            this._drag = { mode: 'editPt', annoIdx: i, ptIdx: k };
            this.render();
            return true;
          }
        }
      }
      // 标注本体 → 选中并可整体拖动
      for (let i = 0; i < list.length; i++) {
        if (this._hitAnno(list[i], pos, t)) {
          this.selected = i;
          this._drag = { mode: 'moveAnno', annoIdx: i, startI: this.screenToImage(t, pos.x, pos.y), origPts: list[i].pts.map((p) => ({ ...p })) };
          this.render();
          return true;
        }
      }
      // 点击空白: 再点一次完成点击式标注
      if (this.pendingAnno && this.pendingAnno._preview) {
        const ip = this.screenToImage(t, pos.x, pos.y);
        this.pendingAnno.pts[1] = ip;
        this._completePending();
        return true;
      }
      this.selected = -1;
      return false;
    }

    _hitAnno(a, pos, t) {
      const pts = a.pts.map((p) => this.imageToScreen(t, p.x, p.y));
      const distSeg = (p, a1, a2) => {
        const dx = a2.x - a1.x, dy = a2.y - a1.y;
        const L2 = dx * dx + dy * dy;
        let tt = L2 ? ((p.x - a1.x) * dx + (p.y - a1.y) * dy) / L2 : 0;
        tt = U.clamp(tt, 0, 1);
        return Math.hypot(p.x - (a1.x + tt * dx), p.y - (a1.y + tt * dy));
      };
      if (a.type === 'length' || a.type === 'arrow') return distSeg(pos, pts[0], pts[1]) < 8;
      if (a.type === 'angle') return distSeg(pos, pts[0], pts[1]) < 8 || distSeg(pos, pts[1], pts[2]) < 8;
      if (a.type === 'rect') {
        const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
        const w = Math.abs(pts[1].x - pts[0].x), h = Math.abs(pts[1].y - pts[0].y);
        return pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h;
      }
      if (a.type === 'ellipse') {
        const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
        const rx = Math.abs(pts[1].x - pts[0].x) / 2, ry = Math.abs(pts[1].y - pts[0].y) / 2;
        if (rx < 1 || ry < 1) return false;
        const nx = (pos.x - cx) / rx, ny = (pos.y - cy) / ry;
        return nx * nx + ny * ny <= 1;
      }
      if (a.type === 'probe' || a.type === 'text') return Math.hypot(pos.x - pts[0].x, pos.y - pts[0].y) < 14;
      return false;
    }

    _wheel(e) {
      e.preventDefault();
      this.viewer.setActive(this.idx);
      if (e.ctrlKey) {
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoom = U.clamp(this.zoom * f, 0.05, 60);
        this.fit();
      } else {
        const d = e.deltaY > 0 ? 1 : -1;
        if (e.shiftKey) {
          this.ww = Math.max(1, this.ww + d * 20);
          this._userVoi = true;
          this.render();
        } else {
          this.showImage(this.imgIdx + d);
        }
      }
    }

    autoVoi() {
      // 按当前帧像素动态范围自动窗宽窗位
      this.autoVoiRegion(0, 0, this.frame ? this.frame.cols - 1 : 0, this.frame ? this.frame.rows - 1 : 0);
    }

    /** ROI 区域直方图自动窗宽窗位(2%~98% 分位) */
    autoVoiRegion(x0, y0, x1, y1) {
      if (!this.frame) return;
      const inst = this.stack.instCache.get(this.image.file.sop);
      const p = inst ? inst.ds.p : null;
      const src = this.frame.pixels;
      const cols = this.frame.cols;
      const signed = p && p.signed;
      const slope = p ? p.slope : 1, inter = p ? p.intercept : 0;
      const xa = Math.max(0, Math.floor(Math.min(x0, x1))), xb = Math.min(this.frame.cols - 1, Math.ceil(Math.max(x0, x1)));
      const ya = Math.max(0, Math.floor(Math.min(y0, y1))), yb = Math.min(this.frame.rows - 1, Math.ceil(Math.max(y0, y1)));
      if (xb <= xa || yb <= ya) return;
      // 收集有效值(大区域下采样)
      const vals = [];
      const step = Math.max(1, Math.floor(((xb - xa + 1) * (yb - ya + 1)) / 65536));
      for (let y = ya; y <= yb; y += step) {
        for (let x = xa; x <= xb; x += step) {
          let v = src[y * cols + x];
          if (signed && v > 32767) v -= 65536;
          vals.push(v * slope + inter);
        }
      }
      if (vals.length < 16) return;
      vals.sort((a, b) => a - b);
      const q = (t) => vals[Math.min(vals.length - 1, Math.floor(t * (vals.length - 1)))];
      const p2 = q(0.02), p98 = q(0.98);
      this.wl = (p2 + p98) / 2;
      this.ww = Math.max(1, p98 - p2);
      this._userVoi = true;
      this.render();
      this.viewer._notify();
    }

    reset() {
      this.zoom = 1; this.pan = { x: 0, y: 0 };
      this.rot = 0; this.flipH = false; this.flipV = false;
      this._userVoi = false; this._invertTouched = false;
      if (this._defaultVoi) { this.ww = this._defaultVoi.ww; this.wl = this._defaultVoi.wc; }
      this.fit();
    }

    applyVoi(wc, ww) {
      this.wl = wc; this.ww = ww;
      this._userVoi = true;
      this.render();
      this.viewer._notify();
    }

    exportPNG() {
      if (!this.frame) return null;
      const src = this.canvas;
      const out = document.createElement('canvas');
      out.width = src.width; out.height = src.height;
      const ctx = out.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      this.render(ctx, src.width, src.height);
      return out.toDataURL('image/png');
    }
  }

  /* ================= Viewer:布局与工具管理 ================= */
  class Viewer {
    constructor(rootEl, opts) {
      this.root = rootEl;
      this.opts = opts || {};
      this.onstate = this.opts.onstate || null;
      this.panes = [];
      this.layout = 1;
      this.active = 0;
      this.tool = 'wl';
      this.cineTimer = null;
      this.cineFps = 12;
      this._notify = U.throttle(() => {
        if (this.onstate) this.onstate(this.state());
      }, 120);
      this.buildLayout(1);
    }

    state() {
      const p = this.panes[this.active];
      if (!p || !p.stack) return null;
      return {
        idx: p.imgIdx + 1, total: p.total,
        ww: p.ww, wl: p.wl,
        cine: !!this.cineTimer,
        seriesDesc: p.stack.info.desc || ('序列 ' + (p.stack.info.number || '')),
        instNo: p.image ? p.image.file.instNo : 0,
        modality: p.stack.info.modality || '',
        hasFrame: !!p.frame
      };
    }

    buildLayout(n) {
      const oldStacks = this.panes.map((p) => p.stack);
      const oldStates = this.panes.map((p) => ({ ww: p.ww, wl: p.wl, zoom: p.zoom, pan: { ...p.pan }, rot: p.rot, flipH: p.flipH, flipV: p.flipV, idx: p.imgIdx, uv: p._userVoi }));
      this.panes.forEach((p) => p.destroy());
      this.panes = [];
      this.root.innerHTML = '';
      this.root.className = 'panes layout-' + n;
      const count = n;
      for (let i = 0; i < count; i++) {
        const el = U.el('div', { class: 'pane' + (i === 0 ? ' active' : '') });
        this.root.appendChild(el);
        const pane = new Pane(this, el, i);
        this.panes.push(pane);
        const st = oldStacks[i] || oldStacks[0];
        if (st) {
          pane.setStack(st);
          const os = oldStates[i] || oldStates[0];
          if (os) {
            pane.ww = os.ww; pane.wl = os.wl; pane.zoom = os.zoom; pane.pan = { ...os.pan };
            pane.rot = os.rot; pane.flipH = os.flipH; pane.flipV = os.flipV; pane._userVoi = os.uv;
            if (st && os.idx != null) pane.imgIdx = U.clamp(os.idx, 0, pane.total - 1);
            pane.showImage(pane.imgIdx);
          }
        }
      }
      this.layout = n;
      this.active = Math.min(this.active, count - 1);
      this._notify();
    }

    setActive(i) {
      if (this.active === i) return;
      this.active = i;
      this.panes.forEach((p, k) => p.el.classList.toggle('active', k === i));
      this._notify();
    }

    activePane() { return this.panes[this.active]; }

    setSeries(stack, paneIdx) {
      const i = paneIdx == null ? this.active : paneIdx;
      const p = this.panes[i];
      if (!p) return;
      p._defaultVoi = null;
      p.setStack(stack);
    }

    setTool(t) { this.tool = t; }

    /** 成对子序列(如 DWI [1/2]/[2/2])同步: 其他视口加载同基础 UID 序列时, 跟随当前层号与窗宽窗位 */
    _syncSiblings(pane) {
      if (this._syncing) return;
      this._syncing = true;
      try {
        const base = baseUid(pane.stack && pane.stack.info.uid);
        this.panes.forEach((p) => {
          if (p === pane || !p.stack) return;
          if (baseUid(p.stack.info.uid) !== base) return;
          if (p.imgIdx !== pane.imgIdx || p.ww !== pane.ww || p.wl !== pane.wl) {
            p._userVoi = true;
            p.ww = pane.ww; p.wl = pane.wl;
            p.showImage(pane.imgIdx);
            p.render();
          }
        });
      } finally { this._syncing = false; }
    }

    /* CINE */
    cineToggle() { this.cineTimer ? this.cineStop() : this.cineStart(); }
    cineStart() {
      if (this.cineTimer) return;
      const p = this.activePane();
      if (!p || p.total < 2) return;
      this.cineTimer = setInterval(() => {
        const pp = this.activePane();
        if (!pp || !pp.stack) { this.cineStop(); return; }
        pp.showImage((pp.imgIdx + 1) % pp.total);
      }, Math.max(16, 1000 / this.cineFps));
      this._notify();
    }
    cineStop() {
      if (this.cineTimer) clearInterval(this.cineTimer);
      this.cineTimer = null;
      this._notify();
    }
    cineSetFps(fps) { this.cineFps = fps; if (this.cineTimer) { this.cineStop(); this.cineStart(); } }

    /* 当前视口操作 */
    _op(fn) {
      const p = this.activePane();
      if (!p || !p.stack) return;
      fn(p);
    }
    invert() { this._op((p) => { p.invert = !p.invert; p._invertTouched = true; p.render(); }); }
    rotate(dir) { this._op((p) => { p.rot = ((p.rot + dir) % 4 + 4) % 4; p.fit(); }); }
    flipH() { this._op((p) => { p.flipH = !p.flipH; p.render(); }); }
    flipV() { this._op((p) => { p.flipV = !p.flipV; p.render(); }); }
    reset() { this._op((p) => p.reset()); }
    preset(wc, ww) { this._op((p) => p.applyVoi(wc, ww)); }
    /** 预设: null=文件默认 | 'auto'=动态范围 | 'wide'/'narrow'=窗宽×2/÷2 | [wc,ww]=数值 */
    applyPreset(v) {
      if (v == null) {
        this._op((p) => {
          p._userVoi = false;
          if (p._defaultVoi) { p.ww = p._defaultVoi.ww; p.wl = p._defaultVoi.wc; }
          p.render();
        });
      } else if (v === 'auto') {
        this._op((p) => p.autoVoi());
      } else if (v === 'wide') {
        this._op((p) => { p.ww = Math.min(65535, p.ww * 2); p._userVoi = true; p.render(); });
      } else if (v === 'narrow') {
        this._op((p) => { p.ww = Math.max(1, p.ww / 2); p._userVoi = true; p.render(); });
      } else {
        this.preset(v[0], v[1]);
      }
    }
    zoomBy(f) { this._op((p) => { p.zoom = U.clamp(p.zoom * f, 0.05, 60); p.fit(); }); }
    gotoImage(i) { this._op((p) => p.showImage(i - 1)); }
    step(d) { this._op((p) => p.showImage(p.imgIdx + d)); }
    exportPNG() {
      const p = this.activePane();
      if (!p || !p.frame) { U.toast('当前没有图像', 'error'); return; }
      const url = p.exportPNG();
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = (p.stack.info.desc || 'image').replace(/[\\/:*?"<>|]/g, '_') + '_' + (p.imgIdx + 1) + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    hasAnnotations() {
      const p = this.activePane();
      return p && p.stack && p.stack.annos.size > 0;
    }
    clearAnnotations() {
      this._op((p) => { p.stack.annos.clear(); p.selected = -1; p.pendingAnno = null; p.render(); });
    }
    deleteSelected() {
      this._op((p) => {
        const list = p.stack ? p.stack.annosOf(p.image.key) : [];
        if (p.selected >= 0 && list[p.selected]) {
          list.splice(p.selected, 1);
          p.selected = -1;
          p.render();
        }
      });
    }
    cancelPendingAnno() {
      this._op((p) => p._cancelPending());
    }

    destroy() {
      this.cineStop();
      this.panes.forEach((p) => p.destroy());
      this.root.innerHTML = '';
    }
  }

  /**
   * 通用序列缩略图: 解码序列首帧 → 小尺寸 dataURL(供列表/工作列表使用)
   * stack: MV.viewer.Stack(只需 files[0] 可加载)
   */
  async function thumbFromStack(stack, size) {
    size = size || 64;
    const inst = await stack.instance(stack.files[0]);
    const fr = await inst.dec.getFrame(0);
    const ds = inst.ds;
    const s = size / Math.max(fr.rows, fr.cols);
    const w = Math.max(1, Math.round(fr.cols * s)), h = Math.max(1, Math.round(fr.rows * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    const id = cx.createImageData(w, h);
    const src = fr.pixels;
    const npix = fr.rows * fr.cols;

    if (fr.kind === 'rgb') {
      // 采样取色
      const sample = (ix, iy) => {
        const sx = Math.min(fr.cols - 1, ix), sy = Math.min(fr.rows - 1, iy);
        const si = (sy * fr.cols + sx) * 4;
        return [src[si], src[si + 1], src[si + 2]];
      };
      for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        const px = sample(Math.floor((i % w) * fr.cols / w), Math.floor(i / w * fr.rows / h));
        id.data[j] = px[0]; id.data[j + 1] = px[1]; id.data[j + 2] = px[2]; id.data[j + 3] = 255;
      }
    } else {
      let lo = 0, hi = 255, slope = 1, inter = 0, signed = false;
      if (fr.kind === 'gray16') {
        const p = ds.p || {};
        slope = p.slope || 1; inter = p.intercept || 0; signed = !!p.signed;
        if (isFinite(p.wc) && isFinite(p.ww) && p.ww > 0) { lo = p.wc - p.ww / 2; hi = p.wc + p.ww / 2; }
        else {
          let mn = Infinity, mx = -Infinity;
          for (let i = 0; i < src.length; i += 7) {
            let v = src[i];
            if (signed && v > 32767) v -= 65536;
            v = v * slope + inter;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          lo = mn; hi = Math.max(mx, mn + 1);
        }
      }
      const range = Math.max(1e-6, hi - lo);
      const lut = new Uint8Array(fr.kind === 'gray16' ? 65536 : 256);
      for (let i = 0; i < lut.length; i++) {
        let v = i;
        if (fr.kind === 'gray16') {
          if (signed && i > 32767) v = i - 65536;
          v = v * slope + inter;
        }
        let t = (v - lo) / range;
        lut[i] = Math.round((t < 0 ? 0 : t > 1 ? 1 : t) * 255);
      }
      for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        const sx = Math.min(fr.cols - 1, Math.floor((i % w) * fr.cols / w));
        const sy = Math.min(fr.rows - 1, Math.floor(i / w * fr.rows / h));
        const v = lut[src[sy * fr.cols + sx]];
        id.data[j] = id.data[j + 1] = id.data[j + 2] = v; id.data[j + 3] = 255;
      }
    }
    cx.putImageData(id, 0, 0);
    return c.toDataURL();
  }

  const baseUid = (u) => String(u || '').replace(/\.(s\d+|x\d+)$/, '');

  MV.viewer = { Viewer, Stack, Pane, thumbFromStack, NON_IMAGE_MODALITIES, baseUid };
})();

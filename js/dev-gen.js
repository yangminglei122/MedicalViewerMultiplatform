/* MV.gen — 浏览器内合成 DICOM 演示/测试数据生成器
 * 生成两个研究: CT 胸部(GB18030 患者名,32层) 与 MR 头颅(UTF-8 患者名,24层)
 * 兼作开发测试数据源
 */
(function () {
  'use strict';
  window.MV = window.MV || {};

  const UID_ROOT = '1.2.826.0.1.3680043.8.7';
  // GBK 编码(仅演示数据用到的字符)
  const GBK = {
    '张': [0xD5, 0xC5], '伟': [0xCE, 0xB0], '民': [0xC3, 0xF1],
    '李': [0xC0, 0xEE], '秀': [0xD0, 0xE3], '英': [0xD3, 0xA2],
    '胸': [0xD0, 0xD8], '部': [0xB2, 0xBF], '平': [0xC6, 0xBD], '扫': [0xC9, 0xA8],
    '头': [0xCD, 0xB7], '颅': [0xC2, 0xAD]
  };
  function gbkBytes(str) {
    const out = [];
    for (const ch of str) {
      if (GBK[ch]) GBK[ch].forEach((b) => out.push(b));
      else out.push(ch.charCodeAt(0) & 0x7f);
    }
    return out;
  }
  function utf8Bytes(str) {
    return Array.from(new TextEncoder().encode(str));
  }

  /* ---------- 显式 VR 小端 DICOM 写入器 ---------- */
  const LONG = { OB: 1, OW: 1, OF: 1, SQ: 1, UT: 1, UN: 1 };
  function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

  class DW {
    constructor() { this.buf = []; }
    tag(g, e) { this.buf.push(...u16(g), ...u16(e)); return this; }
    vr(v) { this.buf.push(v.charCodeAt(0), v.charCodeAt(1)); this._vr = v; return this; }
    len(n) {
      if (LONG[this._vr]) { this.buf.push(0, 0, ...u32(n)); }
      else this.buf.push(...u16(n));
      return this;
    }
    str(s, enc) {
      let bytes;
      if (enc === 'gbk') bytes = gbkBytes(s);
      else if (enc === 'utf8') bytes = utf8Bytes(s);
      else {
        bytes = [];
        for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
      }
      if (bytes.length % 2) bytes.push(0x20);
      this.len(bytes.length);
      this.buf.push(...bytes);
      return this;
    }
    rawBytes(bytes) {
      const n = bytes.length;
      const pad = n % 2;
      this.len(n + pad);
      for (let i = 0; i < n; i++) this.buf.push(bytes[i]);
      if (pad) this.buf.push(0);
      return this;
    }
    us(vals) {
      const arr = Array.isArray(vals) ? vals : [vals];
      this.len(arr.length * 2);
      arr.forEach((v) => this.buf.push(...u16(v)));
      return this;
    }
    pixels(u16arr) {
      this.len(u16arr.length * 2);
      const buf = this.buf;
      for (let i = 0; i < u16arr.length; i++) {
        const v = u16arr[i];
        buf.push(v & 0xff, (v >> 8) & 0xff);
      }
      return this;
    }
    out() { return new Uint8Array(this.buf); }
  }

  /** 生成一个 DICOM 文件 */
  function makeInstance(cfg) {
    const ds = new DW();
    const TAG8 = (e) => ds.tag(0x0008, e);
    const enc = cfg.charset === 'GB18080' ? 'gbk' : (cfg.charset === 'ISO_IR 192' ? 'utf8' : 'ascii');
    // 按标签升序写入
    ds.tag(0x0008, 0x0005).vr('CS').str(cfg.charset || 'ISO_IR 100');
    TAG8(0x0008).vr('CS').str('DERIVED\SECONDARY');
    ds.tag(0x0008, 0x0016).vr('UI').str(cfg.sopClass);
    ds.tag(0x0008, 0x0018).vr('UI').str(cfg.sopUid);
    ds.tag(0x0008, 0x0020).vr('DA').str(cfg.studyDate);
    ds.tag(0x0008, 0x0021).vr('DA').str(cfg.studyDate);
    ds.tag(0x0008, 0x0030).vr('TM').str('093000');
    ds.tag(0x0008, 0x0050).vr('SH').str(cfg.accession || '');
    ds.tag(0x0008, 0x0060).vr('CS').str(cfg.modality);
    ds.tag(0x0008, 0x1030).vr('LO').str(cfg.studyDesc, enc);
    ds.tag(0x0008, 0x103e).vr('LO').str(cfg.seriesDesc, enc);
    // 患者组(0010)
    if (cfg.nameGBK) ds.tag(0x0010, 0x0010).vr('PN').rawBytes(gbkBytes(cfg.nameGBK));
    else ds.tag(0x0010, 0x0010).vr('PN').rawBytes(new TextEncoder().encode(cfg.name));
    ds.tag(0x0010, 0x0020).vr('LO').str(cfg.patientId);
    ds.tag(0x0010, 0x0030).vr('DA').str(cfg.birth);
    ds.tag(0x0010, 0x0040).vr('CS').str(cfg.sex);
    // 检查组(0018)
    ds.tag(0x0018, 0x0050).vr('DS').str(String(cfg.thickness));
    ds.tag(0x0018, 0x0088).vr('DS').str(String(cfg.spacing));
    // 检查/序列组(0020)
    ds.tag(0x0020, 0x000d).vr('UI').str(cfg.studyUid);
    ds.tag(0x0020, 0x000e).vr('UI').str(cfg.seriesUid);
    ds.tag(0x0020, 0x0010).vr('SH').str('1');
    ds.tag(0x0020, 0x0011).vr('IS').str(String(cfg.seriesNo));
    ds.tag(0x0020, 0x0013).vr('IS').str(String(cfg.instNo));
    ds.tag(0x0020, 0x0032).vr('DS').str('-127.5\\-127.5\\' + (cfg.instNo * cfg.spacing).toFixed(1));
    ds.tag(0x0020, 0x0037).vr('DS').str('1\\0\\0\\0\\1\\0');
    // 图像组(0028)
    ds.tag(0x0028, 0x0002).vr('US').us(1);
    ds.tag(0x0028, 0x0004).vr('CS').str('MONOCHROME2');
    ds.tag(0x0028, 0x0010).vr('US').us(cfg.rows);
    ds.tag(0x0028, 0x0011).vr('US').us(cfg.cols);
    ds.tag(0x0028, 0x0030).vr('DS').str(cfg.pixelSpacing[1] + '\\' + cfg.pixelSpacing[0]);
    ds.tag(0x0028, 0x0100).vr('US').us(16);
    ds.tag(0x0028, 0x0101).vr('US').us(cfg.bitsStored || 16);
    ds.tag(0x0028, 0x0102).vr('US').us((cfg.bitsStored || 16) - 1);
    ds.tag(0x0028, 0x0103).vr('US').us(cfg.signed ? 1 : 0);
    ds.tag(0x0028, 0x1050).vr('DS').str(String(cfg.wc));
    ds.tag(0x0028, 0x1051).vr('DS').str(String(cfg.ww));
    ds.tag(0x0028, 0x1052).vr('DS').str(String(cfg.intercept));
    ds.tag(0x0028, 0x1053).vr('DS').str('1');
    ds.tag(0x0028, 0x1054).vr('LO').str('HU');
    // 像素
    ds.tag(0x7fe0, 0x0010).vr('OW').pixels(cfg.pixels);
    const dataset = ds.out();

    // 文件元信息
    const meta = new DW();
    meta.tag(0x0002, 0x0001).vr('OB').rawBytes([0, 1]);
    meta.tag(0x0002, 0x0002).vr('UI').str(cfg.sopClass);
    meta.tag(0x0002, 0x0003).vr('UI').str(cfg.sopUid);
    meta.tag(0x0002, 0x0010).vr('UI').str('1.2.840.10008.1.2.1');
    meta.tag(0x0002, 0x0012).vr('UI').str(UID_ROOT + '.0');
    meta.tag(0x0002, 0x0013).vr('SH').str('MVGEN10');
    const metaBody = meta.out();
    const gl = new DW();
    gl.tag(0x0002, 0x0000).vr('UL').rawBytes(u32(metaBody.length));

    const preamble = new Uint8Array(132);
    preamble[128] = 68; preamble[129] = 73; preamble[130] = 67; preamble[131] = 77; // DICM
    const total = new Uint8Array(132 + gl.out().length + metaBody.length + dataset.length);
    total.set(preamble, 0);
    total.set(gl.out(), 132);
    total.set(metaBody, 132 + gl.out().length);
    total.set(dataset, 132 + gl.out().length + metaBody.length);
    return total;
  }

  /* ---------- 伪随机(确定性) ---------- */
  function lcg(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** CT 胸部体模: HU 体素, 存储值 = HU + 1024 */
  function ctChestSlice(rows, cols, k, n) {
    const px = new Uint16Array(rows * cols);
    const rnd = lcg(k * 7919 + 13);
    const cx = cols / 2, cy = rows / 2;
    const rz = Math.sin(Math.PI * k / (n - 1));           // z 轴位置因子
    const bodyRy = 210 + 18 * rz, bodyRx = 168 + 14 * rz;
    const lungY = 55 * (0.6 + 0.6 * rz), lungX = 52;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const dx = (x - cx) / bodyRx, dy = (y - cy) / bodyRy;
        const d = dx * dx + dy * dy;
        let hu = -1000;
        if (d < 1) {
          hu = 42 + (rnd() - 0.5) * 24;                    // 软组织
          // 肺
          const lx = (x - (cx - 62)) / lungX, ly = (y - (cy - 18)) / lungY;
          const rx2 = (x - (cx + 62)) / lungX, ry2 = ly;
          const dL = Math.min(lx * lx + ly * ly, rx2 * rx2 + ry2 * ry2);
          if (dL < 1) {
            const t = Math.sqrt(dL);
            hu = -880 + t * 180 + (rnd() - 0.5) * 60;      // 肺实质, 中心 darker
            if (t > 0.62 && rnd() < 0.22) hu = 30 + rnd() * 60; // 血管影
          }
          // 纵隔已含在软组织中;脊柱
          const dSpine = Math.hypot(x - cx, y - (cy + bodyRy * 0.72));
          if (dSpine < 34) hu = 950 + (rnd() - 0.5) * 120;
          else if (dSpine < 44) hu = 120;
          // 肋骨环
          const ring = Math.abs(Math.sqrt(d) - 0.97);
          if (ring < 0.035 && y < cy + 10) hu = 720 + (rnd() - 0.5) * 90;
          // 结节: 第12~19层
          if (k >= 12 && k <= 19) {
            const rr = 13 - Math.abs(15.5 - k) * 1.4;
            const dn = Math.hypot(x - (cx + 70), y - (cy - 26));
            if (dn < rr) hu = 130 + (1 - dn / rr) * 90;
          }
        }
        // 层位标记条(左上角)
        if (x >= 12 && x < 22 && y >= 12 && y < 12 + 8 + k * 5) hu = 2000;
        px[y * cols + x] = Math.max(0, Math.min(4095, hu + 1024));
      }
    }
    return px;
  }

  /** MR 头颅体模 */
  function mrBrainSlice(rows, cols, k, n) {
    const px = new Uint16Array(rows * cols);
    const rnd = lcg(k * 104729 + 7);
    const cx = cols / 2, cy = rows / 2;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const dx = (x - cx) / 92, dy = (y - cy) / 108;
        const d = dx * dx + dy * dy;
        let v = 8;
        if (d < 1) {
          const r = Math.sqrt(d);
          if (r > 0.94) v = 2100;                                   // 头皮/颅骨外
          else if (r > 0.88) v = 150;                               // CSF 间隙
          else if (r > 0.84) v = 1900;                              // 颅骨
          else if (r > 0.80) v = 160;                               // 颅骨内板下 CSF
          else {
            // 脑实质 + 脑沟纹理
            const gyri = Math.sin(x * 0.32 + k * 0.6) * Math.sin(y * 0.3);
            v = 880 + gyri * 160 + (rnd() - 0.5) * 50;
            if (r > 0.62) v -= 220;                                 // 边缘灰质
            // 脑室(蝴蝶形,中份层面)
            const vz = Math.sin(Math.PI * Math.min(1, Math.max(0, (k - 5) / (n - 10))));
            const v1 = Math.hypot((x - (cx - 20)) / (16 * vz + 2), (y - (cy - 8)) / (34 * vz + 2));
            const v2 = Math.hypot((x - (cx + 20)) / (16 * vz + 2), (y - (cy - 8)) / (34 * vz + 2));
            if (Math.min(v1, v2) < 1) v = 130;
          }
        }
        if (x >= 8 && x < 16 && y >= 8 && y < 8 + 6 + k * 4) v = 2600;
        px[y * cols + x] = v;
      }
    }
    return px;
  }

  /** 生成全部演示文件; opts: {ct, mr, size} 可调数量与尺寸(压测用) */
  async function generate(opts) {
    opts = opts || {};
    const files = [];
    const N_CT = opts.ct != null ? opts.ct : 32, N_MR = opts.mr != null ? opts.mr : 24;
    const CT_SIZE = opts.size || 512;

    // 研究1: CT 胸部(GB18030 中文患者,两个序列: 轴位 + 冠状位重建)
    const ctStudy = UID_ROOT + '.100.1';
    const ctSeries = UID_ROOT + '.100.2';
    const ctSeries2 = UID_ROOT + '.100.3';
    for (let i = 1; i <= N_CT; i++) {
      const sop = ctSeries + '.' + i;
      files.push({
        name: 'CT_' + String(i).padStart(3, '0') + '.dcm',
        bytes: makeInstance({
          charset: 'GB18080', nameGBK: '张伟民', patientId: 'P100234',
          birth: '19620315', sex: 'M',
          studyUid: ctStudy, seriesUid: ctSeries, sopUid: sop,
          sopClass: '1.2.840.10008.5.1.4.1.1.2',
          modality: 'CT', studyDesc: 'CT 胸部平扫', seriesDesc: 'AXIAL 5mm',
          studyDate: '20260812', accession: 'ACC2026081201',
          seriesNo: 2, instNo: i, rows: CT_SIZE, cols: CT_SIZE,
          thickness: 5, spacing: 5, pixelSpacing: [0.86, 0.86],
          wc: 40, ww: 400, intercept: -1024, signed: false, bitsStored: 16,
          pixels: ctChestSlice(CT_SIZE, CT_SIZE, i, N_CT)
        })
      });
    }
    for (let i = 1; i <= 12; i++) {
      const sop = ctSeries2 + '.' + i;
      files.push({
        name: 'CTC_' + String(i).padStart(3, '0') + '.dcm',
        bytes: makeInstance({
          charset: 'GB18080', nameGBK: '张伟民', patientId: 'P100234',
          birth: '19620315', sex: 'M',
          studyUid: ctStudy, seriesUid: ctSeries2, sopUid: sop,
          sopClass: '1.2.840.10008.5.1.4.1.1.2',
          modality: 'CT', studyDesc: 'CT 胸部平扫', seriesDesc: 'COR MPR',
          studyDate: '20260812', accession: 'ACC2026081201',
          seriesNo: 3, instNo: i, rows: 256, cols: 256,
          thickness: 5, spacing: 5, pixelSpacing: [1.4, 1.4],
          wc: 40, ww: 400, intercept: -1024, signed: false, bitsStored: 16,
          pixels: ctChestSlice(256, 256, i + 8, N_CT)
        })
      });
    }

    // 研究2: MR 头颅(UTF-8 中文患者)
    const mrStudy = UID_ROOT + '.200.1';
    const mrSeries = UID_ROOT + '.200.2';
    for (let i = 1; i <= N_MR; i++) {
      const sop = mrSeries + '.' + i;
      files.push({
        name: 'MR_' + String(i).padStart(3, '0') + '.dcm',
        bytes: makeInstance({
          charset: 'ISO_IR 192', name: '李秀英', patientId: 'P100877',
          birth: '19781102', sex: 'F',
          studyUid: mrStudy, seriesUid: mrSeries, sopUid: sop,
          sopClass: '1.2.840.10008.5.1.4.1.1.4',
          modality: 'MR', studyDesc: 'MR 头颅平扫', seriesDesc: 'T1 FLAIR AX',
          studyDate: '20260901', accession: 'ACC2026090102',
          seriesNo: 3, instNo: i, rows: 256, cols: 256,
          thickness: 6, spacing: 6, pixelSpacing: [0.9, 0.9],
          wc: 500, ww: 1600, intercept: 0, signed: false, bitsStored: 16,
          pixels: mrBrainSlice(256, 256, i, N_MR)
        })
      });
    }
    return files;
  }

  MV.gen = { generate };
})();

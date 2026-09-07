/* MV.decoder — DICOM 像素解码
 * 支持: 原始 LE/BE 8/16bit 灰度、RGB、调色板、YBR、多帧;
 *       RLE 压缩; 封装 JPEG(浏览器原生解码, baseline/extended)
 */
(function () {
  'use strict';
  window.MV = window.MV || {};

  const TS = {
    IMPLICIT_LE: '1.2.840.10008.1.2',
    EXPLICIT_LE: '1.2.840.10008.1.2.1',
    EXPLICIT_BE: '1.2.840.10008.1.2.2',
    DEFLATED: '1.2.840.10008.1.2.1.99',
    RLE: '1.2.840.10008.1.2.5',
    JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
    JPEG_EXTENDED: '1.2.840.10008.1.2.4.51',
    JPEGLS_LOSSLESS: '1.2.840.10008.1.2.4.57',
    JPEGLS_NEARLOSSLESS: '1.2.840.10008.1.2.4.81'
  };
  const isJpegLs = (ts) => /1\.2\.840\.10008\.1\.2\.4\.(57|70|80|81)$/.test(ts);
  const isJ2k = (ts) => /1\.2\.840\.10008\.1\.2\.4\.(90|91)$/.test(ts);

  /* ---------- 传统 JPEG 无损(proc14 / SV1, TS .57/.70) ----------
   * 注: 部分设备(如联影)把 JPEG-LS 的 UID 标在传统无损码流上, 故两者互为兜底 */
  let jlPromise = null;
  function ensureJpegLossless() {
    if (jlPromise) return jlPromise;
    jlPromise = new Promise((resolve, reject) => {
      const t0 = Date.now();
      const wait = () => {
        if (window.__jpegLossless) resolve(window.__jpegLossless);
        else if (Date.now() - t0 > 8000) reject(new Error('JPEG 无损解码组件加载超时'));
        else setTimeout(wait, 50);
      };
      wait();
    });
    return jlPromise;
  }
  async function decodeJpegLossless(bytes) {
    const m = await ensureJpegLossless();
    const dec = new m.Decoder();
    const out = dec.decompress(bytes.buffer, bytes.byteOffset, bytes.length);
    const fi = dec.frameInfo || {};
    const bps = fi.bitsPerSample || 16;
    const px = bps > 8 ? new Uint16Array(out) : new Uint8Array(out);
    return { pixels: px, frameInfo: { width: fi.width, height: fi.height, bitsPerSample: bps, componentCount: fi.componentCount || 1 } };
  }

  /* ---------- JPEG-LS 解码(CharLS, vendor/charls-decode.js) ---------- */
  let charlsPromise = null;
  async function ensureCharls() {
    if (charlsPromise) return charlsPromise;
    charlsPromise = (async () => {
      if (typeof window.CharLSWASM !== 'function') {
        throw new Error('JPEG-LS 解码组件未加载(charls.js)');
      }
      const m = await window.CharLSWASM();
      return m;
    })();
    return charlsPromise;
  }

  /** 解码一帧 JPEG-LS 码流 → {pixels(Uint8/Uint16Array), frameInfo} */
  async function decodeJpegLS(bytes) {
    const m = await ensureCharls();
    const dec = new m.JpegLSDecoder();
    try {
      const enc = dec.getEncodedBuffer(bytes.length);
      enc.set(bytes);
      dec.decode();
      const fi = dec.getFrameInfo();
      let px = dec.getDecodedBuffer();
      if (fi.bitsPerSample > 8 && px && px.BYTES_PER_ELEMENT === 1) {
        const n = px.length >> 1;
        const out = new Uint16Array(n);
        for (let i = 0; i < n; i++) out[i] = px[i * 2] | (px[i * 2 + 1] << 8);
        px = out;
      }
      return { pixels: px, frameInfo: fi };
    } finally {
      try { dec.delete(); } catch (e) { }
    }
  }

  /* ---------- 图像字节解码(浏览器原生) ---------- */
  async function decodeImageBytes(bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    if (window.createImageBitmap) {
      try { return await createImageBitmap(blob); } catch (e) { /* 回退 */ }
    }
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('图像数据解码失败')); };
      img.src = url;
    });
  }

  async function bitmapToRGBA(bmp) {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  /* ---------- RLE (DICOM PackBits) ---------- */
  function decodeRLESegment(u8, off, outLen) {
    const out = new Uint8Array(outLen);
    let op = 0, ip = off;
    while (op < outLen) {
      const n = u8[ip++]; // signed int8
      const sn = n > 127 ? n - 256 : n;
      if (sn >= 0) {
        const b = u8[ip++];
        const cnt = sn + 1;
        for (let i = 0; i < cnt && op < outLen; i++) out[op++] = b;
      } else if (sn >= -127) {
        const cnt = -sn + 1;
        for (let i = 0; i < cnt && op < outLen; i++) out[op++] = u8[ip++];
      } // sn === -128: 无操作
    }
    return out;
  }

  function decodeRLEFrame(ds, u8, off, frameLen, rows, cols, samples, bytesAlloc) {
    const dv = ds.dv;
    const numSeg = dv.getUint32(off, true);
    const segOff = [];
    for (let i = 0; i < 15; i++) segOff.push(dv.getUint32(off + 4 + i * 4, true));
    const npix = rows * cols;
    const out = new Uint8Array(frameLen);
    const totalSegs = samples * bytesAlloc;
    for (let s = 0; s < numSeg && s < totalSegs; s++) {
      const seg = decodeRLESegment(u8, segOff[s], npix);
      const sampleIdx = Math.floor(s / bytesAlloc);
      const byteIdx = s % bytesAlloc; // 0 = 最高字节
      for (let px = 0; px < npix; px++) {
        if (samples === 1) {
          // 小端: 低字节在后
          const b = bytesAlloc - 1 - byteIdx;
          if (b < bytesAlloc) out[px * bytesAlloc + b] = seg[px];
        } else {
          // 彩色: 每采样 plane
          const b = bytesAlloc - 1 - byteIdx;
          out[(px * samples + sampleIdx) * bytesAlloc + b] = seg[px];
        }
      }
    }
    return out;
  }

  /* ---------- 调色板 ---------- */
  function buildPalette(ds, pal) {
    const dv = ds.dv, le = ds.le;
    const lut = {};
    let maxEntries = 0;
    for (const ch of ['Red', 'Green', 'Blue']) {
      const info = pal[ch];
      const desc = [];
      for (let i = 0; i < 3; i++) desc.push(dv.getUint16(info.descOff + i * 2, le));
      const first = desc[0] || 0, n = desc[1] || 256;
      const vals = new Uint8Array(65536);
      for (let i = 0; i < n && info.dataOff + i * 2 + 2 <= ds.bytes.length; i++) {
        let v = dv.getUint16(info.dataOff + i * 2, le);
        vals[first + i] = v & 0xff;
      }
      lut[ch] = { first, n, vals };
      maxEntries = Math.max(maxEntries, first + n);
    }
    return lut;
  }

  function ybrToRgb(y, cb, cr) {
    const r = y + 1.402 * (cr - 128);
    const g = y - 0.3441 * (cb - 128) - 0.7141 * (cr - 128);
    const b = y + 1.772 * (cb - 128);
    return [r < 0 ? 0 : r > 255 ? 255 : r | 0, g < 0 ? 0 : g > 255 ? 255 : g | 0, b < 0 ? 0 : b > 255 ? 255 : b | 0];
  }

  /**
   * 解码一个实例 → 惰性帧访问器
   * 返回 { getFrame(i)→Promise<{pixels,kind,rows,cols}>, frames, kind, stats }
   */
  async function decodeInstance(ds) {
    const p = ds.p;
    if (!p || !p.rows || !p.cols) throw new Error('缺少像素数据');
    const u8 = ds.bytes;
    const N = p.frames;

    // ---- 封装(压缩)像素 ----
    if (ds.pixel.encapsulated && ds.pixel.fragments) {
      const ts = ds.tsuid;
      // 合并所有片断
      let total = 0;
      ds.pixel.fragments.forEach((f) => { total += f.len; });
      const flat = new Uint8Array(total);
      let fp = 0;
      ds.pixel.fragments.forEach((f) => { flat.set(u8.subarray(f.off, f.off + f.len), fp); fp += f.len; });

      const frameStarts = [];
      if (N > 1 && ds.pixel.bot && ds.pixel.bot.length >= N) {
        for (let i = 0; i < N; i++) frameStarts.push(ds.pixel.bot[i]);
        frameStarts.sort((a, b) => a - b);
      } else frameStarts.push(0);

      if (ts === TS.RLE) {
        const bytesAlloc = Math.ceil(p.bitsAllocated / 8);
        const frameLen = p.rows * p.cols * p.samples * bytesAlloc;
        // RLE 每帧有独立头;bot 给出各帧起始(相对 firstData)
        const startsAbs = [];
        if (N > 1 && ds.pixel.bot && ds.pixel.bot.length >= N) {
          ds.pixel.bot.forEach((o) => startsAbs.push((ds.pixel.firstDataOff - ds.pixel.firstDataOff) + o)); // 相对 flat 起点
        } else startsAbs.push(0);
        const kind = p.isColor ? 'rgb' : 'gray16';
        const cache = {};
        return {
          frames: N, kind, rows: p.rows, cols: p.cols,
          getFrame: async function (i) {
            if (cache[i]) return cache[i];
            const abs = startsAbs[Math.min(i, startsAbs.length - 1)];
            const raw = decodeRLEFrame(ds, flat, abs, frameLen, p.rows, p.cols, p.samples, bytesAlloc);
            let pixels;
            if (p.isColor) {
              pixels = new Uint8ClampedArray(p.rows * p.cols * 4);
              for (let px = 0; px < p.rows * p.cols; px++) {
                pixels[px * 4] = raw[px * 3]; pixels[px * 4 + 1] = raw[px * 3 + 1]; pixels[px * 4 + 2] = raw[px * 3 + 2]; pixels[px * 4 + 3] = 255;
              }
              return (cache[i] = { pixels, kind: 'rgb', rows: p.rows, cols: p.cols });
            }
            pixels = new Uint16Array(p.rows * p.cols);
            for (let px = 0; px < pixels.length; px++) pixels[px] = raw[px * 2] | (raw[px * 2 + 1] << 8);
            return (cache[i] = { pixels, kind: 'gray16', rows: p.rows, cols: p.cols });
          },
          stats: null
        };
      }

      if (ts === TS.JPEG_BASELINE || ts === TS.JPEG_EXTENDED || /4\.5[0-5]$/.test(ts)) {
        const isMono = !p.isColor;
        const cache = {};
        return {
          frames: frameStarts.length, kind: isMono ? 'gray8' : 'rgb', rows: p.rows, cols: p.cols,
          getFrame: async function (i) {
            if (cache[i]) return cache[i];
            const s = frameStarts[Math.min(i, frameStarts.length - 1)];
            const e = i + 1 < frameStarts.length ? frameStarts[i + 1] : flat.length;
            const bytes = flat.subarray(s, e);
            // 检查 JPEG SOI
            if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG 数据无效');
            const bmp = await decodeImageBytes(bytes, 'image/jpeg');
            const imgData = await bitmapToRGBA(bmp);
            if (bmp.close) bmp.close();
            const npix = imgData.width * imgData.height;
            if (isMono) {
              const pixels = new Uint8Array(npix);
              for (let px = 0; px < npix; px++) pixels[px] = imgData.data[px * 4];
              return (cache[i] = { pixels, kind: 'gray8', rows: imgData.height, cols: imgData.width });
            }
            return (cache[i] = { pixels: new Uint8ClampedArray(imgData.data), kind: 'rgb', rows: imgData.height, cols: imgData.width });
          },
          stats: null
        };
      }

      // ---- JPEG 无损 / JPEG-LS(两类解码器互为兜底) ----
      if (isJpegLs(ts)) {
        const isMono = !p.isColor;
        const cache = {};
        // .80/.81 为 JPEG-LS(CharLS), .57/.70 为传统 JPEG 无损 —— 按 UID 猜测优先级, 失败换另一个
        const preferLS = /4\.(80|81)$/.test(ts);
        const decodeOne = async (bytes) => {
          if (preferLS) {
            try { return await decodeJpegLS(bytes); } catch (e) { return decodeJpegLossless(bytes); }
          }
          try { return decodeJpegLossless(bytes); } catch (e) { return decodeJpegLS(bytes); }
        };
        return {
          frames: frameStarts.length, kind: isMono ? (p.bitsAllocated === 8 ? 'gray8' : 'gray16') : 'rgb',
          rows: p.rows, cols: p.cols, stats: null,
          getFrame: async function (i) {
            if (cache[i]) return cache[i];
            const s = frameStarts[Math.min(i, frameStarts.length - 1)];
            const e = i + 1 < frameStarts.length ? frameStarts[i + 1] : flat.length;
            const r = await decodeOne(flat.subarray(s, e));
            const fi = r.frameInfo || {};
            const rows = fi.height || p.rows, cols = fi.width || p.cols;
            if (isMono) {
              return (cache[i] = {
                pixels: r.pixels,
                kind: (fi.bitsPerSample || p.bitsAllocated) > 8 ? 'gray16' : 'gray8',
                rows, cols
              });
            }
            const nc = fi.componentCount || 3;
            const np = rows * cols;
            const out = new Uint8ClampedArray(np * 4);
            const sp = r.pixels;
            for (let k = 0; k < np; k++) {
              out[k * 4] = sp[k * nc];
              out[k * 4 + 1] = nc > 1 ? sp[k * nc + 1] : sp[k * nc];
              out[k * 4 + 2] = nc > 2 ? sp[k * nc + 2] : sp[k * nc];
              out[k * 4 + 3] = 255;
            }
            return (cache[i] = { pixels: out, kind: 'rgb', rows, cols });
          }
        };
      }

      let extra = '';
      if (isJ2k(ts)) extra = '(JPEG2000)';
      throw new Error('暂不支持的压缩传输语法: ' + ts + extra +
        ',请先在工作站转换为未压缩 / JPEG / JPEG-LS 格式');
    }

    // ---- 原始(未压缩)像素 ----
    const off = ds.pixel.offset;
    if (off < 0) throw new Error('缺少像素数据');
    const bytesAlloc = p.bitsAllocated === 8 ? 1 : p.bitsAllocated === 16 ? 2 : p.bitsAllocated === 32 ? 4 : p.bitsAllocated === 1 ? 1 : 2;
    const npix = p.rows * p.cols;
    const frameLen = npix * p.samples * bytesAlloc;
    const dv = ds.dv;
    const le = ds.le;
    const need = off + frameLen * N;
    const availFrames = ds.truncated ? Math.max(1, Math.floor((u8.length - off) / frameLen)) : N;

    const makeGray16 = function (base) {
      const pixels = new Uint16Array(npix);
      if (bytesAlloc === 1) { for (let i = 0; i < npix; i++) pixels[i] = u8[base + i]; }
      else if (bytesAlloc === 2) {
        if (le) for (let i = 0; i < npix; i++) pixels[i] = u8[base + i * 2] | (u8[base + i * 2 + 1] << 8);
        else for (let i = 0; i < npix; i++) pixels[i] = (u8[base + i * 2] << 8) | u8[base + i * 2 + 1];
      } else { // 32bit: 取低16位足够显示
        for (let i = 0; i < npix; i++) pixels[i] = dv.getUint32(base + i * 4, le) & 0xffff;
      }
      return pixels;
    };
    const makeRGB = function (base) {
      const out = new Uint8ClampedArray(npix * 4);
      if (bytesAlloc === 1 && p.samples === 3) {
        if (p.photometric === 'PALETTE COLOR' && p.palette) {
          const lut = buildPalette(ds, p.palette);
          for (let i = 0; i < npix; i++) {
            const v = u8[base + i];
            out[i * 4] = lut.Red.vals[v]; out[i * 4 + 1] = lut.Green.vals[v]; out[i * 4 + 2] = lut.Blue.vals[v]; out[i * 4 + 3] = 255;
          }
        } else if (p.photometric === 'YBR_FULL' || p.photometric === 'YBR_FULL_422') {
          if (p.photometric === 'YBR_FULL_422') {
            for (let i = 0; i < npix; i += 2) {
              const y1 = u8[base + i * 2], y2 = u8[base + i * 2 + 1];
              const cb = u8[base + i * 2 + 2], cr = u8[base + i * 2 + 3];
              const c1 = ybrToRgb(y1, cb, cr), c2 = ybrToRgb(y2, cb, cr);
              out[i * 4] = c1[0]; out[i * 4 + 1] = c1[1]; out[i * 4 + 2] = c1[2]; out[i * 4 + 3] = 255;
              if (i + 1 < npix) { out[(i + 1) * 4] = c2[0]; out[(i + 1) * 4 + 1] = c2[1]; out[(i + 1) * 4 + 2] = c2[2]; out[(i + 1) * 4 + 3] = 255; }
            }
          } else {
            for (let i = 0; i < npix; i++) {
              const c = ybrToRgb(u8[base + i * 3], u8[base + i * 3 + 1], u8[base + i * 3 + 2]);
              out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
            }
          }
        } else if (p.planar === 1) {
          for (let i = 0; i < npix; i++) {
            out[i * 4] = u8[base + i]; out[i * 4 + 1] = u8[base + npix + i]; out[i * 4 + 2] = u8[base + npix * 2 + i]; out[i * 4 + 3] = 255;
          }
        } else {
          for (let i = 0; i < npix; i++) {
            out[i * 4] = u8[base + i * 3]; out[i * 4 + 1] = u8[base + i * 3 + 1]; out[i * 4 + 2] = u8[base + i * 3 + 2]; out[i * 4 + 3] = 255;
          }
        }
      } else if (p.samples === 3 && bytesAlloc === 2) {
        // 16bit 彩色: 取高8位
        for (let i = 0; i < npix; i++) for (let c = 0; c < 3; c++) {
          const v = le ? (u8[base + (i * 3 + c) * 2] | (u8[base + (i * 3 + c) * 2 + 1] << 8)) : ((u8[base + (i * 3 + c) * 2] << 8) | u8[base + (i * 3 + c) * 2 + 1]);
          out[i * 4 + c] = (v >> 8) & 0xff;
        }
        for (let i = 0; i < npix; i++) out[i * 4 + 3] = 255;
      }
      return out;
    };

    const isColor = p.isColor || p.photometric === 'PALETTE COLOR';
    const kind = isColor ? 'rgb' : bytesAlloc === 1 ? 'gray8' : 'gray16';

    // 统计(默认窗宽窗位): 采样第一帧
    let stats = null;
    if (!isColor) {
      let mn = Infinity, mx = -Infinity;
      const f0 = makeGray16(off);
      const step = Math.max(1, Math.floor(npix / 65536));
      for (let i = 0; i < npix; i += step) {
        const eff = ds.eff(f0[i]);
        if (eff < mn) mn = eff;
        if (eff > mx) mx = eff;
      }
      stats = { min: mn, max: mx };
    }

    return {
      frames: availFrames, kind, rows: p.rows, cols: p.cols, stats,
      getFrame: async function (i) {
        const base = off + Math.min(i, availFrames - 1) * frameLen;
        if (isColor) return { pixels: makeRGB(base), kind: 'rgb', rows: p.rows, cols: p.cols };
        if (bytesAlloc === 1) return { pixels: u8.slice(base, base + npix), kind: 'gray8', rows: p.rows, cols: p.cols };
        return { pixels: makeGray16(base), kind: 'gray16', rows: p.rows, cols: p.cols };
      }
    };
  }

  MV.decoder = { decodeInstance, decodeImageBytes, bitmapToRGBA, TS };
})();

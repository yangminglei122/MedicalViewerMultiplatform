/* MV.dicom — 零依赖 DICOM 文件解析器
 * 支持: 显式/隐式 VR Little Endian、显式 Big Endian、Deflated、多帧、封装像素数据(JPEG/RLE)
 * 用法: const ds = MV.dicom.parse(uint8array); ds.str(0x00100010) ...
 */
(function () {
  'use strict';
  window.MV = window.MV || {};

  const T = (g, e) => ((g << 16) | e);
  const TAG = {
    MediaStorageSOPClassUID: T(0x0002, 0x0002),
    TransferSyntaxUID: T(0x0002, 0x0010),
    SpecificCharacterSet: T(0x0008, 0x0005),
    ImageType: T(0x0008, 0x0008),
    SOPClassUID: T(0x0008, 0x0016),
    SOPInstanceUID: T(0x0008, 0x0018),
    StudyDate: T(0x0008, 0x0020),
    SeriesDate: T(0x0008, 0x0021),
    StudyTime: T(0x0008, 0x0030),
    AccessionNumber: T(0x0008, 0x0050),
    Modality: T(0x0008, 0x0060),
    StudyDescription: T(0x0008, 0x1030),
    SeriesDescription: T(0x0008, 0x103e),
    PatientName: T(0x0010, 0x0010),
    PatientID: T(0x0010, 0x0020),
    BirthDate: T(0x0010, 0x0030),
    PatientSex: T(0x0010, 0x0040),
    PatientAge: T(0x0010, 0x1010),
    SliceThickness: T(0x0018, 0x0050),
    SpacingBetweenSlices: T(0x0018, 0x0088),
    ImagerPixelSpacing: T(0x0018, 0x1164),
    KVP: T(0x0018, 0x0060),
    PatientPosition: T(0x0018, 0x5100),
    StudyInstanceUID: T(0x0020, 0x000d),
    SeriesInstanceUID: T(0x0020, 0x000e),
    StudyID: T(0x0020, 0x0010),
    SeriesNumber: T(0x0020, 0x0011),
    InstanceNumber: T(0x0020, 0x0013),
    ImagePositionPatient: T(0x0020, 0x0032),
    ImageOrientationPatient: T(0x0020, 0x0037),
    SliceLocation: T(0x0020, 0x1041),
    SamplesPerPixel: T(0x0028, 0x0002),
    PhotometricInterpretation: T(0x0028, 0x0004),
    NumberOfFrames: T(0x0028, 0x0008),
    Rows: T(0x0028, 0x0010),
    Columns: T(0x0028, 0x0011),
    PlanarConfiguration: T(0x0028, 0x0006),
    PixelSpacing: T(0x0028, 0x0030),
    BitsAllocated: T(0x0028, 0x0100),
    BitsStored: T(0x0028, 0x0101),
    HighBit: T(0x0028, 0x0102),
    PixelRepresentation: T(0x0028, 0x0103),
    SmallestPixel: T(0x0028, 0x0106),
    LargestPixel: T(0x0028, 0x0107),
    PaletteRedDesc: T(0x0028, 0x1101),
    PaletteGreenDesc: T(0x0028, 0x1102),
    PaletteBlueDesc: T(0x0028, 0x1103),
    PaletteRedData: T(0x0028, 0x1201),
    PaletteGreenData: T(0x0028, 0x1202),
    PaletteBlueData: T(0x0028, 0x1203),
    WindowCenter: T(0x0028, 0x1050),
    WindowWidth: T(0x0028, 0x1051),
    RescaleIntercept: T(0x0028, 0x1052),
    RescaleSlope: T(0x0028, 0x1053),
    RescaleType: T(0x0028, 0x1054),
    PresentationLUTShape: T(0x2050, 0x0020),
    PixelData: T(0x7fe0, 0x0010)
  };
  MV.TAG = TAG;

  // 显式 VR 中 2字节保留 + 4字节长度的 VR
  const LONG_VRS = { OB: 1, OD: 1, OF: 1, OL: 1, OV: 1, OW: 1, SQ: 1, UC: 1, UR: 1, UT: 1, UN: 1, SV: 1, UV: 1 };
  const STR_VRS = { AE: 1, AS: 1, CS: 1, DA: 1, DS: 1, DT: 1, IS: 1, LO: 1, LT: 1, PN: 1, SH: 1, ST: 1, TM: 1, UC: 1, UI: 1, UT: 1, UR: 1 };

  // 隐式 VR 解析所需的 VR 字典(本程序关心的标签)
  const VR_DICT = {};
  (function () {
    const d = VR_DICT;
    d[TAG.SpecificCharacterSet] = 'CS'; d[TAG.ImageType] = 'CS'; d[TAG.SOPClassUID] = 'UI';
    d[TAG.SOPInstanceUID] = 'UI'; d[TAG.StudyDate] = 'DA'; d[TAG.SeriesDate] = 'DA';
    d[TAG.StudyTime] = 'TM'; d[TAG.AccessionNumber] = 'SH'; d[TAG.Modality] = 'CS';
    d[TAG.StudyDescription] = 'LO'; d[TAG.SeriesDescription] = 'LO';
    d[TAG.PatientName] = 'PN'; d[TAG.PatientID] = 'LO'; d[TAG.BirthDate] = 'DA';
    d[TAG.PatientSex] = 'CS'; d[TAG.PatientAge] = 'AS';
    d[TAG.SliceThickness] = 'DS'; d[TAG.SpacingBetweenSlices] = 'DS'; d[TAG.ImagerPixelSpacing] = 'DS'; d[TAG.KVP] = 'DS';
    d[TAG.PatientPosition] = 'CS';
    d[TAG.StudyInstanceUID] = 'UI'; d[TAG.SeriesInstanceUID] = 'UI'; d[TAG.StudyID] = 'SH';
    d[TAG.SeriesNumber] = 'IS'; d[TAG.InstanceNumber] = 'IS';
    d[TAG.ImagePositionPatient] = 'DS'; d[TAG.ImageOrientationPatient] = 'DS'; d[TAG.SliceLocation] = 'DS';
    d[TAG.SamplesPerPixel] = 'US'; d[TAG.PhotometricInterpretation] = 'CS'; d[TAG.NumberOfFrames] = 'IS';
    d[TAG.Rows] = 'US'; d[TAG.Columns] = 'US'; d[TAG.PlanarConfiguration] = 'US';
    d[TAG.PixelSpacing] = 'DS'; d[TAG.BitsAllocated] = 'US'; d[TAG.BitsStored] = 'US';
    d[TAG.HighBit] = 'US'; d[TAG.PixelRepresentation] = 'US';
    d[TAG.SmallestPixel] = 'US'; d[TAG.LargestPixel] = 'US';
    d[TAG.WindowCenter] = 'DS'; d[TAG.WindowWidth] = 'DS';
    d[TAG.RescaleIntercept] = 'DS'; d[TAG.RescaleSlope] = 'DS'; d[TAG.RescaleType] = 'LO';
    d[TAG.PresentationLUTShape] = 'CS';
    d[TAG.PixelData] = 'OW';
    // 常见但仅用于显示的补充标签
    d[T(0x0008, 0x0090)] = 'PN';   // 检查医师
    d[T(0x0008, 0x1090)] = 'LO';   // 设备型号
    d[T(0x0018, 0x0015)] = 'CS';   // 检查部位
    d[T(0x0018, 0x0050)] = 'DS';
    d[T(0x0018, 0x1030)] = 'LO';   // 协议名
    d[T(0x0008, 0x0022)] = 'DA'; d[T(0x0008, 0x0023)] = 'DA';
    d[T(0x0008, 0x0031)] = 'TM'; d[T(0x0008, 0x0032)] = 'TM';
  })();

  // DICOM 字符集 → TextDecoder 标签
  const CHARSET_MAP = {
    '': 'windows-1252', 'ISO_IR 100': 'windows-1252', 'ISO_IR 101': 'iso-8859-2',
    'ISO_IR 109': 'iso-8859-3', 'ISO_IR 110': 'iso-8859-4', 'ISO_IR 126': 'iso-8859-7',
    'ISO_IR 127': 'iso-8859-6', 'ISO_IR 138': 'iso-8859-8', 'ISO_IR 144': 'iso-8859-5',
    'ISO_IR 148': 'windows-1254', 'ISO_IR 203': 'windows-1252',
    'ISO_IR 58': 'gb18030', 'GB18080': 'gb18030', 'GBK': 'gb18030', 'CP936': 'gb18030',
    'ISO_IR 192': 'utf-8', 'ISO_IR 13Shift': 'shift_jis', 'Shift_JIS': 'shift_jis',
    'ISO_IR 149': 'euc-kr'
  };

  // TextDecoder 实例缓存(构造有开销, 大批量文件解码时差距显著)
  const decCache = new Map();
  function getDecoder(label, opts) {
    const key = label + (opts && opts.fatal ? '|fatal' : '');
    let d = decCache.get(key);
    if (d === undefined) {
      try { d = new TextDecoder(label, opts); } catch (e) { d = null; }
      decCache.set(key, d);
    }
    return d;
  }

  function decodeBytes(bytes, label) {
    const d = getDecoder(label) || getDecoder('windows-1252');
    if (!d) return '';
    try { return d.decode(bytes); }
    catch (e) { return ''; }
  }

  class Dataset {
    constructor() {
      this.map = new Map();          // tag -> {vr, off, len}
      this.bytes = null; this.dv = null;
      this.le = true; this.explicit = true;
      this.charset = 'windows-1252';
      this.charsetTag = '';
      this.tsuid = '';
      this.truncated = false;
      this.pixel = { encapsulated: false, offset: -1, length: 0, fragments: null, bot: null, firstDataOff: -1 };
      this.p = null;                 // 像素描述(finish 阶段填充)
    }

    el(tag) { return this.map.get(tag); }

    _strBytes(e, label) {
      const raw = this.bytes.subarray(e.off, e.off + e.len);
      let s = decodeBytes(raw, label || this.charset);
      s = s.replace(/\0/g, ' ');
      return s;
    }
    str(tag, i) {
      const e = this.map.get(tag);
      if (!e) return '';
      const parts = this._strBytes(e).split('\\');
      return (parts[i || 0] || '').trim();
    }
    strs(tag) {
      const e = this.map.get(tag);
      if (!e) return [];
      return this._strBytes(e).split('\\').map((s) => s.trim());
    }
    /** 按指定字符集解码(导入确认对话框切换字符集预览用) */
    strWith(tag, label, i) {
      const e = this.map.get(tag);
      if (!e) return '';
      const parts = this._strBytes(e, label).split('\\');
      return (parts[i || 0] || '').trim();
    }
    _num(tag, i, bytes, getter) {
      const e = this.map.get(tag);
      if (!e) return NaN;
      const n = Math.floor((i || 0));
      if (e.off + (n + 1) * bytes > this.bytes.length) return NaN;
      return getter.call(this.dv, e.off + n * bytes, this.le);
    }
    u16(tag, i) { return this._num(tag, i, 2, this.le ? DataView.prototype.getUint16 : (DataView.prototype.getUint16)); }
    s16(tag, i) { return this._num(tag, i, 2, DataView.prototype.getInt16); }
    u32(tag, i) { return this._num(tag, i, 4, DataView.prototype.getUint32); }
    int(tag, i) {
      const e = this.map.get(tag);
      if (!e) return NaN;
      if (e.vr === 'US' || e.vr === 'SS' || e.vr === 'UL' || e.vr === 'SL') return this[e.vr === 'US' ? 'u16' : e.vr === 'SS' ? 's16' : e.vr === 'UL' ? 'u32' : 's32'](tag, i);
      const v = parseInt(this.str(tag, i), 10);
      return isNaN(v) ? NaN : v;
    }
    dbl(tag, i) {
      const e = this.map.get(tag);
      if (!e) return NaN;
      if (e.vr === 'FL') return this._num(tag, i, 4, DataView.prototype.getFloat32);
      if (e.vr === 'FD') return this._num(tag, i, 8, DataView.prototype.getFloat64);
      if (e.vr === 'US' || e.vr === 'SS' || e.vr === 'UL' || e.vr === 'SL') return this.int(tag, i);
      const v = parseFloat(this.str(tag, i));
      return isNaN(v) ? NaN : v;
    }
    nums(tag) {
      const e = this.map.get(tag);
      if (!e) return [];
      const out = [];
      if (e.vr === 'US' || e.vr === 'SS' || e.vr === 'UL' || e.vr === 'SL' || e.vr === 'FL' || e.vr === 'FD') {
        const size = e.vr === 'FL' ? 4 : e.vr === 'FD' ? 8 : e.vr === 'US' || e.vr === 'SS' ? 2 : 4;
        const n = Math.floor(e.len / size);
        for (let i = 0; i < n; i++) out.push(this.dbl(tag, i));
      } else {
        this.strs(tag).forEach((s) => { const v = parseFloat(s); out.push(isNaN(v) ? 0 : v); });
      }
      return out;
    }
    /** 像素原始值 → 有效值(HU 等) */
    eff(raw) {
      const p = this.p;
      if (!p) return raw;
      if (p.signed && raw > 32767) raw -= 65536;
      return raw * p.slope + p.intercept;
    }

    /** 字符集猜测: 无声明时尝试 UTF-8 → GB18030 → Latin1 */
    guessCharset() {
      if (this.charsetTag) return CHARSET_MAP[this.charsetTag.split('\\')[0]] || 'windows-1252';
      const e = this.map.get(TAG.PatientName);
      if (!e) return 'windows-1252';
      const raw = this.bytes.subarray(e.off, e.off + e.len);
      let hasHigh = false;
      for (let i = 0; i < raw.length; i++) if (raw[i] > 0x7f) { hasHigh = true; break; }
      if (!hasHigh) return 'windows-1252';
      const fatalUtf8 = getDecoder('utf-8', { fatal: true });
      if (fatalUtf8) {
        try { fatalUtf8.decode(raw); return 'utf-8'; } catch (err) { }
      }
      return 'gb18030';
    }
  }

  function storeElem(ds, tag, vr, off, len) {
    if (len > 0x4000000) return; // 单元素 >64MB 异常,忽略
    const old = ds.map.get(tag);
    if (!old) ds.map.set(tag, { vr, off, len });
  }

  /** 读一个常规元素,返回下一个位置;数据截断/无法继续返回 -1 */
  function readElement(ds, pos, cfg, collect) {
    const dv = ds.dv, u8 = ds.bytes, le = cfg.le, end = u8.length;
    const g = dv.getUint16(pos, le), e = dv.getUint16(pos + 2, le);
    const tag = T(g, e);

    if (g === 0xfffe) { // 数据集层面出现 item/分隔符(缺陷文件),跳过
      const vl = dv.getUint32(pos + 4, le);
      return pos + 8 + (vl === 0xffffffff ? 0 : vl);
    }
    if (g > 0x7fe0) return -1;

    let vr = null, vl = 0, hdr = 8;
    if (cfg.explicit) {
      if (pos + 6 > end) return -1;
      vr = String.fromCharCode(u8[pos + 4], u8[pos + 5]);
      if (LONG_VRS[vr]) { if (pos + 12 > end) return -1; vl = dv.getUint32(pos + 8, le); hdr = 12; }
      else { if (pos + 8 > end) return -1; vl = dv.getUint16(pos + 6, le); }
    } else {
      if (pos + 8 > end) return -1;
      vl = dv.getUint32(pos + 4, le);
      vr = VR_DICT[tag] || 'UN';
    }

    if (vl === 0xffffffff) { // 未定长序列
      return walkUndefined(ds, pos + hdr, cfg, 0xe0dd);
    }
    if (pos + hdr + vl > end) return -1;
    if (collect !== false) storeElem(ds, tag, vr, pos + hdr, vl);
    return pos + hdr + vl;
  }

  /** 遍历未定长序列区域,直到遇到指定分隔符;返回序列结束后的位置或 -1 */
  function walkUndefined(ds, pos, cfg, stopDelim) {
    const dv = ds.dv, u8 = ds.bytes, le = cfg.le, end = u8.length;
    let guard = 0;
    while (pos + 8 <= end) {
      if (++guard > 500000) return -1;
      const g = dv.getUint16(pos, le), e = dv.getUint16(pos + 2, le);
      const vl = dv.getUint32(pos + 4, le);
      if (g === 0xfffe && (e === 0xe0dd || e === 0xe00d)) {
        if (e === stopDelim || stopDelim === 0xe0dd) return pos + 8;
        pos += 8; continue;
      }
      if (g === 0xfffe && e === 0xe000) { // item 开始
        if (vl === 0xffffffff) { pos = walkUndefined(ds, pos + 8, cfg, 0xe00d); if (pos < 0) return -1; }
        else pos += 8 + vl;
        continue;
      }
      pos = readElement(ds, pos, cfg, false);
      if (pos < 0) return -1;
    }
    return -1;
  }

  /** 解析封装像素数据(片断),pos 指向第一个 item */
  function parseEncapsulated(ds, pos, cfg) {
    const dv = ds.dv, le = cfg.le, end = ds.bytes.length;
    ds.pixel.encapsulated = true;
    const frags = []; const bot = [];
    let firstDataOff = -1;
    let guard = 0;
    while (pos + 8 <= end) {
      if (++guard > 100000) break;
      const g = dv.getUint16(pos, le), e = dv.getUint16(pos + 2, le), vl = dv.getUint32(pos + 4, le);
      if (g === 0xfffe && e === 0xe0dd) break; // 序列结束
      if (g !== 0xfffe || e !== 0xe000) break; // 格式异常
      if (frags.length === 0 && bot.length === 0 && firstDataOff < 0) {
        for (let o = 0; o + 4 <= vl; o += 4) bot.push(dv.getUint32(pos + 8 + o, le));
        firstDataOff = pos + 8 + vl;
      } else {
        frags.push({ off: pos + 8, len: vl });
      }
      if (vl === 0xffffffff) break;
      pos += 8 + vl;
    }
    ds.pixel.fragments = frags;
    ds.pixel.bot = bot;
    ds.pixel.firstDataOff = firstDataOff;
    ds.pixel.offset = firstDataOff;
    // 合计长度
    let total = 0;
    frags.forEach((f) => { total += f.len; });
    ds.pixel.length = total;
  }

  function finish(ds) {
    // 字符集
    const csElem = ds.map.get(TAG.SpecificCharacterSet);
    ds.charsetTag = csElem ? decodeBytes(ds.bytes.subarray(csElem.off, csElem.off + csElem.len), 'windows-1252').trim() : '';
    ds.charset = CHARSET_MAP[ds.charsetTag.split('\\')[0] || ''] || 'windows-1252';

    const p = {
      rows: ds.u16(TAG.Rows) || 0,
      cols: ds.u16(TAG.Columns) || 0,
      samples: ds.u16(TAG.SamplesPerPixel) || 1,
      photometric: ds.str(TAG.PhotometricInterpretation) || 'MONOCHROME2',
      frames: Math.max(1, parseInt(ds.str(TAG.NumberOfFrames)) || 1),
      bitsAllocated: ds.u16(TAG.BitsAllocated) || 16,
      bitsStored: ds.u16(TAG.BitsStored) || (ds.u16(TAG.BitsAllocated) || 16),
      highBit: ds.u16(TAG.HighBit),
      signed: (ds.u16(TAG.PixelRepresentation) || 0) === 1,
      planar: ds.u16(TAG.PlanarConfiguration) || 0,
      slope: isNaN(ds.dbl(TAG.RescaleSlope)) ? 1 : ds.dbl(TAG.RescaleSlope),
      intercept: isNaN(ds.dbl(TAG.RescaleIntercept)) ? 0 : ds.dbl(TAG.RescaleIntercept),
      thickness: ds.dbl(TAG.SliceThickness),
      spacingBetween: ds.dbl(TAG.SpacingBetweenSlices),
      position: ds.nums(TAG.ImagePositionPatient),
      orientation: ds.nums(TAG.ImageOrientationPatient),
      sliceLocation: ds.dbl(TAG.SliceLocation),
      wc: ds.dbl(TAG.WindowCenter), ww: ds.dbl(TAG.WindowWidth),
      smallest: ds.int(TAG.SmallestPixel), largest: ds.int(TAG.LargestPixel),
      presentationLUT: ds.str(TAG.PresentationLUTShape)
    };
    const sp = ds.nums(TAG.PixelSpacing);
    if (sp.length >= 2) { p.spacingY = sp[0]; p.spacingX = sp[1]; } // DICOM: [行间距, 列间距]
    if (!(p.spacingX > 0) || !(p.spacingY > 0)) {
      // 像素间距缺失时回退 ImagerPixelSpacing(DX 常用)
      const ips = ds.nums(TAG.ImagerPixelSpacing);
      if (ips.length >= 2) { if (!(p.spacingY > 0)) p.spacingY = ips[0]; if (!(p.spacingX > 0)) p.spacingX = ips[1]; }
    }
    p.isColor = p.samples === 3;
    p.defaultInvert = p.photometric === 'MONOCHROME1' || p.presentationLUT === 'INVERSE';
    // 调色板(PALETTE COLOR)
    if (p.photometric === 'PALETTE COLOR') {
      const pal = {};
      ['Red', 'Green', 'Blue'].forEach((ch) => {
        const dsc = ds.el(TAG['Palette' + ch + 'Desc']), dat = ds.el(TAG['Palette' + ch + 'Data']);
        if (dsc && dat) pal[ch] = { descOff: dsc.off, descLen: dsc.len, dataOff: dat.off, dataLen: dat.len };
      });
      if (pal.Red && pal.Green && pal.Blue) p.palette = pal;
      p.isColor = true;
    }
    ds.p = p;
    return ds;
  }

  /** 主入口: 解析 DICOM 文件 */
  function parse(input, opts) {
    opts = opts || {};
    let u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (u8.length < 128) throw new Error('文件太小,不是有效的 DICOM 文件');

    const ds = new Dataset();
    let pos = 0;
    let hasPreamble = false;
    if (u8.length > 132 && u8[128] === 68 && u8[129] === 73 && u8[130] === 67 && u8[131] === 77) {
      hasPreamble = true;
      pos = 132;
    }

    // ---- 文件元信息组(0002,固定显式小端) ----
    let metaEnd = pos;
    if (hasPreamble) {
      let dv0 = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      ds.dv = dv0; ds.bytes = u8;
      while (pos + 8 <= u8.length) {
        const g = dv0.getUint16(pos, true), e = dv0.getUint16(pos + 2, true);
        if (g !== 0x0002) break;
        const vr = String.fromCharCode(u8[pos + 4], u8[pos + 5]);
        let vl, hdr;
        if (LONG_VRS[vr]) { vl = dv0.getUint32(pos + 8, true); hdr = 12; }
        else { vl = dv0.getUint16(pos + 6, true); hdr = 8; }
        storeElem(ds, T(g, e), vr, pos + hdr, Math.min(vl, u8.length - pos - hdr));
        pos += hdr + vl;
        metaEnd = pos;
      }
    }

    let tsuid = '';
    const tsEl = ds.map.get(TAG.TransferSyntaxUID);
    if (tsEl) tsuid = decodeBytes(u8.subarray(tsEl.off, tsEl.off + tsEl.len), 'windows-1252').trim();
    ds.tsuid = tsuid || '1.2.840.10008.1.2';

    let cfg;
    if (tsuid === '1.2.840.10008.1.2') cfg = { explicit: false, le: true };
    else if (tsuid === '1.2.840.10008.1.2.2') cfg = { explicit: true, le: false };
    else if (tsuid === '1.2.840.10008.1.2.1.99') {
      // Deflated: 元信息之后的整个数据集为 zlib 压缩
      if (!window.pako) throw new Error('该文件使用 Deflated 传输语法,需要 pako 组件支持');
      let inflated;
      try { inflated = window.pako.inflate(u8.subarray(metaEnd)); }
      catch (err) { throw new Error('Deflated 数据解压失败'); }
      const merged = new Uint8Array(metaEnd + inflated.length);
      merged.set(u8.subarray(0, metaEnd), 0);
      merged.set(inflated, metaEnd);
      u8 = merged;
      cfg = { explicit: true, le: true };
    }
    else cfg = { explicit: true, le: true };

    // 无文件头时猜测显式/隐式
    if (!hasPreamble) {
      const c1 = u8[4], c2 = u8[5];
      const looksExplicit = (c1 >= 65 && c1 <= 90 && c2 >= 65 && c2 <= 90);
      if (!looksExplicit && tsuid === '1.2.840.10008.1.2') cfg = { explicit: false, le: true };
      else if (looksExplicit) cfg = { explicit: true, le: cfg.le };
    }

    ds.bytes = u8;
    ds.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    ds.le = cfg.le; ds.explicit = cfg.explicit;

    // ---- 数据集循环 ----
    let truncated = false;
    const end = u8.length;
    while (pos < end) {
      if (pos + 8 > end) { truncated = true; break; }
      const g = ds.dv.getUint16(pos, cfg.le), e = ds.dv.getUint16(pos + 2, cfg.le);
      const tag = T(g, e);

      if (tag === TAG.PixelData) {
        let vl = 0, hdr = 8;
        if (cfg.explicit) {
          const vr = String.fromCharCode(u8[pos + 4], u8[pos + 5]);
          if (LONG_VRS[vr]) { vl = ds.dv.getUint32(pos + 8, cfg.le); hdr = 12; }
          else { vl = ds.dv.getUint16(pos + 6, cfg.le); }
        } else {
          vl = ds.dv.getUint32(pos + 4, cfg.le);
        }
        if (vl === 0xffffffff) {
          parseEncapsulated(ds, pos + hdr, cfg);
        } else {
          ds.pixel.encapsulated = false;
          ds.pixel.offset = pos + hdr;
          ds.pixel.length = Math.min(vl, end - pos - hdr);
          if (pos + hdr + vl > end) truncated = true;
        }
        break;
      }
      if (g > 0x7fe0) break;
      const next = readElement(ds, pos, cfg, true);
      if (next < 0) { truncated = true; break; }
      pos = next;
    }

    ds.truncated = truncated;
    finish(ds);
    return ds;
  }

  MV.dicom = { parse, TAG, T, CHARSET_MAP };
})();

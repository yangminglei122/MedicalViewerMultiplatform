/* MV - Medical Viewer 工具库(零依赖) */
(function () {
  'use strict';
  window.MV = window.MV || {};

  const U = {};
  MV.U = U;

  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 创建 DOM 元素: el('div', {class:'x', text:'..', onclick:fn}, [children]) */
  U.el = function (tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else n.setAttribute(k, v);
      }
    }
    if (children != null) {
      const add = (c) => {
        if (c == null) return;
        if (Array.isArray(c)) { c.forEach(add); return; }
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      };
      add(children);
    }
    return n;
  };

  U.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  U.esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  /** DICOM DA(YYYYMMDD) → YYYY-MM-DD */
  U.fmtDate = (d) => {
    if (!d) return '';
    d = String(d).replace(/\D/g, '');
    if (d.length === 8) return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
    if (d.length === 6) return d.slice(0, 4) + '-' + d.slice(4, 6);
    return d;
  };
  /** DICOM TM(HHMMSS) → HH:MM:SS */
  U.fmtTime = (t) => {
    if (!t) return '';
    t = String(t).replace(/\D/g, '');
    if (t.length >= 6) return t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6);
    if (t.length >= 4) return t.slice(0, 2) + ':' + t.slice(2, 4);
    return t;
  };
  /** PN 格式: "张^三" → "张 三" */
  U.fmtPN = (pn) => {
    if (!pn) return '';
    return String(pn).split('\\')[0].replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();
  };
  U.fmtSex = (s) => (s === 'M' ? '男' : s === 'F' ? '女' : s === 'O' ? '其它' : s || '');
  U.fmtBytes = (n) => {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  };
  /** 生日 → 年龄(粗略) */
  U.age = (birth, at) => {
    if (!birth || birth.length !== 8) return '';
    const ref = (at || '').length === 8 ? at : String(at || '').replace(/\D/g, '').slice(0, 8) || U.todayDicom();
    if (ref.length !== 8) return '';
    let y = +ref.slice(0, 4) - +birth.slice(0, 4);
    const m = +ref.slice(4, 6) - +birth.slice(4, 6);
    if (m < 0 || (m === 0 && +ref.slice(6, 8) < +birth.slice(6, 8))) y--;
    return y > 0 && y < 130 ? y + '岁' : '';
  };
  U.todayDicom = () => {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  };

  U.debounce = (fn, ms) => {
    let t = 0;
    return function () {
      const a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, a), ms);
    };
  };

  /** 并发池: 以 concurrency 路并发依次处理 items(worker 可为 async) */
  U.runPool = async function (items, concurrency, worker) {
    let i = 0, err = null;
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    const runners = [];
    for (let k = 0; k < n; k++) {
      runners.push((async () => {
        while (err === null) {
          const idx = i++;
          if (idx >= items.length) return;
          try { await worker(items[idx], idx); }
          catch (e) { err = e; return; }
        }
      })());
    }
    await Promise.all(runners);
    if (err) throw err;
  };
  U.throttle = (fn, ms) => {
    let last = 0, timer = null;
    return function () {
      const a = arguments, self = this;
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn.apply(self, a);
      } else if (!timer) {
        // trailing: 保证最后一次调用也会送达
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(self, a);
        }, ms - (now - last));
      }
    };
  };

  U.download = (blob, filename) => {
    const a = U.el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  };

  /** 简易 LRU 缓存 */
  U.LRU = class {
    constructor(max) { this.max = max; this.map = new Map(); }
    get(k) {
      if (!this.map.has(k)) return undefined;
      const v = this.map.get(k);
      this.map.delete(k); this.map.set(k, v);
      return v;
    }
    set(k, v) {
      if (this.map.has(k)) this.map.delete(k);
      this.map.set(k, v);
      if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    has(k) { return this.map.has(k); }
    delete(k) { this.map.delete(k); }
    clear() { this.map.clear(); }
  };

  /** 全局事件总线 */
  U.bus = new EventTarget();
  U.emit = (name, data) => U.bus.dispatchEvent(new CustomEvent(name, { detail: data }));
  U.on = (name, fn) => { U.bus.addEventListener(name, (e) => fn(e.detail)); };

  /** toast 提示 */
  let toastBox = null;
  U.toast = function (msg, type, ms) {
    if (!toastBox) {
      toastBox = U.el('div', { id: 'toast-box' });
      document.body.appendChild(toastBox);
    }
    const t = U.el('div', { class: 'toast ' + (type || 'info'), text: msg });
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms || (type === 'error' ? 4200 : 2400));
  };

  /** 模态对话框 Promise 化 confirm */
  U.confirm = function (title, msg, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const overlay = U.el('div', { class: 'modal-overlay' });
      const box = U.el('div', { class: 'modal' }, [
        U.el('div', { class: 'modal-title', text: title || '确认' }),
        U.el('div', { class: 'modal-body', html: msg }),
        U.el('div', { class: 'modal-btns' }, [
          U.el('button', { class: 'btn', text: opts.cancelText || '取消', onclick: () => { overlay.remove(); resolve(false); } }),
          U.el('button', { class: 'btn primary' + (opts.danger ? ' danger' : ''), text: opts.okText || '确定', onclick: () => { overlay.remove(); resolve(true); } })
        ])
      ]);
      overlay.appendChild(box);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
      document.body.appendChild(overlay);
    });
  };

  U.prompt = function (title, defval) {
    return new Promise((resolve) => {
      const input = U.el('input', { class: 'input', value: defval || '', style: { width: '100%' } });
      const overlay = U.el('div', { class: 'modal-overlay' });
      const done = (v) => { overlay.remove(); resolve(v); };
      const box = U.el('div', { class: 'modal' }, [
        U.el('div', { class: 'modal-title', text: title }),
        U.el('div', { class: 'modal-body' }, [input]),
        U.el('div', { class: 'modal-btns' }, [
          U.el('button', { class: 'btn', text: '取消', onclick: () => done(null) }),
          U.el('button', { class: 'btn primary', text: '确定', onclick: () => done(input.value) })
        ])
      ]);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); });
      overlay.appendChild(box);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
      document.body.appendChild(overlay);
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  };

  /** SVG 图标集(24x24, stroke 风格) */
  const iconPaths = {
    import: '<path d="M12 3v10m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M12 21V11m0 10l-4-4m4 4l4-4M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7"/>',
    edit: '<path d="M4 20h4L20 8l-4-4L4 16v4zM13 7l4 4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18V3z" fill="currentColor" stroke="none"/>',
    pan: '<path d="M12 2v20M2 12h20M12 2l-3 3m3-3l3 3M12 22l-3-3m3 3l3-3M2 12l3-3m-3 3l3 3M22 12l-3-3m3 3l-3 3"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/>',
    scroll: '<rect x="8" y="3" width="8" height="18" rx="4"/><path d="M12 7v2m0 6v2"/>',
    ruler: '<rect x="2" y="9" width="20" height="6" rx="1" transform="rotate(-20 12 12)"/><path d="M7 13l1-2m3 3l1-2m3 3l1-2" transform="rotate(-20 12 12)"/>',
    angle: '<path d="M4 20L14 4m-10 16h16M14 4l.5 8"/><path d="M14 4L20 20" stroke-dasharray="2 2"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
    probe: '<circle cx="12" cy="12" r="2"/><path d="M12 4v3m0 10v3M4 12h3m10 0h3"/>',
    arrow: '<path d="M5 19L19 5m0 0h-7m7 0v7"/>',
    text: '<path d="M5 6V4h14v2M12 4v16m-3 0h6"/>',
    invert: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none"/>',
    rotateL: '<path d="M4 9a8 8 0 1 1 2 8M4 4v5h5"/>',
    rotateR: '<path d="M20 9a8 8 0 1 0-2 8M20 4v5h-5"/>',
    flipH: '<path d="M12 3v18M8 7L4 12l4 5V7zm8 0l4 5-4 5V7z"/>',
    flipV: '<path d="M3 12h18M7 8l5-4 5 4H7zm0 8l5 4 5-4H7z"/>',
    reset: '<path d="M4 4v6h6M20 20v-6h-6M4.5 10A8 8 0 0 1 19 7M19.5 14A8 8 0 0 1 5 17"/>',
    play: '<path d="M7 5l12 7-12 7V5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    layout1: '<rect x="4" y="4" width="16" height="16" rx="1"/>',
    layout2: '<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/>',
    layout4: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6m0-9v.5"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M5 17l5-4 3 2 4-4 3 3"/>',
    close: '<path d="M5 5l14 14M19 5L5 19"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    back: '<path d="M14 6l-6 6 6 6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5 9-5zm9 9l-9 5-9-5m18 4l-9 5-9-5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'
  };
  U.icon = (name, size) =>
    '<svg class="icon" viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
    '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    (iconPaths[name] || '') + '</svg>';

  U.xhrProgress = function (url, opts, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(opts.method || 'GET', url);
      if (opts.headers) for (const k in opts.headers) xhr.setRequestHeader(k, opts.headers[k]);
      if (opts.responseType) xhr.responseType = opts.responseType;
      xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onprogress = (e) => { if (onProgress && e.lengthComputable && !xhr.upload) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
        else { const err = new Error('HTTP ' + xhr.status); err.status = xhr.status; err.xhr = xhr; reject(err); }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(opts.body || null);
    });
  };
})();

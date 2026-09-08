/* MV.app — 应用入口: 路由、顶栏、阅读器页、快捷键 */
(function () {
  'use strict';
  const U = MV.U;

  const app = {
    viewer: null,
    studyData: null,     // 当前打开的 study {patient, study}
    stacks: [],
    _localStudy: null
  };

  /** 服务器图像文件字节获取(带缓存), ref = {pd,st,se,f} */
  const bytesCache = new U.LRU(400);
  MV.getBytes = async function (ref) {
    const key = ref.pd + '/' + ref.st + '/' + ref.se + '/' + ref.f;
    if (bytesCache.has(key)) return new Uint8Array(bytesCache.get(key));
    const r = await fetch(MV.api.fileUrl(ref), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('获取图像文件失败');
    const buf = await r.arrayBuffer();
    bytesCache.set(key, buf);
    return new Uint8Array(buf);
  };

  /* ============ 启动 ============ */
  async function boot() {
    buildTopbar();
    window.addEventListener('hashchange', route);
    bindDrop();
    bindKeys();
    U.on('library-changed', () => {
      if (!U.$('#page-library').classList.contains('hidden')) MV.library.refresh();
    });

    await MV.api.init();
    buildUserBox();
    if (MV.api.serverMode && MV.api.needLogin) showLogin();
    else route();
  }

  /* ============ 顶栏用户区 ============ */
  function buildUserBox() {
    const box = U.$('#user-box');
    if (!box) return;
    box.innerHTML = '';
    if (!MV.api.serverMode || !MV.api.user) return;
    const items = [];
    if (MV.api.role === 'admin') {
      items.push(U.el('button', {
        class: 'btn sm', title: '账号管理',
        html: U.icon('user', 15) + ' 账号管理',
        onclick: showAccounts
      }));
    }
    items.push(U.el('span', { class: 'muted', style: { fontSize: '12.5px' }, text: MV.api.user }));
    items.push(U.el('button', {
      class: 'btn sm ghost', title: '退出登录', text: '退出',
      onclick: async () => {
        await MV.api.logout();
        U.toast('已退出', 'ok');
        showLogin();
      }
    }));
    items.forEach((i) => box.appendChild(i));
  }

  function route() {
    const h = location.hash || '#/';
    if (h.startsWith('#/viewer')) openViewerFromHash();
    else showLibrary();
  }

  function showLibrary() {
    exitMpr();
    if (app.viewer) { app.viewer.destroy(); app.viewer = null; }
    U.$('#page-viewer').classList.add('hidden');
    U.$('#page-library').classList.remove('hidden');
    U.$('#btn-import').classList.remove('hidden');
    U.$('#search-box').classList.remove('hidden');
    MV.library.refresh();
  }

  /* ============ 顶栏 ============ */
  function buildTopbar() {
    const importBtn = U.$('#btn-import');
    const fileInput = U.el('input', { type: 'file', multiple: '', accept: '.dcm,.zip,application/dicom,application/zip', class: 'hidden' });
    const dirInput = U.el('input', { type: 'file', multiple: '', webkitdirectory: '', class: 'hidden' });
    document.body.appendChild(fileInput);
    document.body.appendChild(dirInput);
    importBtn.addEventListener('click', () => {
      // 手机上优先文件选择;桌面提供菜单
      const isMobile = window.matchMedia('(max-width: 860px)').matches;
      if (isMobile || !dirInput.webkitdirectory) { fileInput.click(); return; }
      const menu = U.el('div', { class: 'modal-overlay' }, [
        U.el('div', { class: 'modal', style: { maxWidth: '360px' } }, [
          U.el('div', { class: 'modal-title', text: '导入 DICOM' }),
          U.el('div', { class: 'modal-body' }, [
            U.el('button', { class: 'btn', style: { width: '100%', marginBottom: '10px', justifyContent: 'flex-start' }, html: U.icon('import') + ' 选择文件(.dcm / .zip)', onclick: () => { menu.remove(); fileInput.click(); } }),
            U.el('button', { class: 'btn', style: { width: '100%', justifyContent: 'flex-start' }, html: U.icon('folder') + ' 选择整个文件夹', onclick: () => { menu.remove(); dirInput.click(); } })
          ])
        ])
      ]);
      document.body.appendChild(menu);
      menu.addEventListener('mousedown', (e) => { if (e.target === menu) menu.remove(); });
    });
    const handle = (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) MV.import.start(files);
    };
    fileInput.addEventListener('change', handle);
    dirInput.addEventListener('change', handle);

    const search = U.$('#search-input');
    search.addEventListener('input', U.debounce(() => {
      MV.library.setSearch(search.value.trim());
    }, 250));
  }

  /* ============ 拖拽导入 ============ */
  function bindDrop() {
    let overlay = null, depth = 0, hideTimer = null;
    const files = [];
    function showOverlay() {
      clearTimeout(hideTimer);
      if (!overlay) {
        overlay = U.el('div', { id: 'drop-overlay', text: '松开导入 DICOM 文件 / 文件夹 / ZIP' });
        document.body.appendChild(overlay);
      }
    }
    function hideOverlaySoon() {
      // 延迟移除: 拖拽经过子元素时 enter/leave 高频交替, 避免闪烁
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (overlay) { overlay.remove(); overlay = null; }
        depth = 0;
      }, 150);
    }
    async function collect(entry) {
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { files.push(f); res(); }, res));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        await new Promise((res) => {
          const read = () => reader.readEntries(async (ents) => {
            if (!ents.length) return res();
            for (const e of ents) await collect(e);
            read();
          }, res);
          read();
        });
      }
    }
    window.addEventListener('dragover', (e) => { e.preventDefault(); showOverlay(); });
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      showOverlay();
    });
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      depth--;
      if (depth <= 0) hideOverlaySoon();
    });
    // 捕获阶段全局接管拖拽: 任何位置/任何时刻都不让浏览器执行默认行为
    // (默认行为会把文件当 URL 打开/交给系统, 导致"跳出浏览器")
    ['dragenter', 'dragover', 'dragexit', 'dragend'].forEach((ev) => {
      window.addEventListener(ev, (e) => { e.preventDefault(); }, true);
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      clearTimeout(hideTimer);
      if (overlay) { overlay.remove(); overlay = null; }
      depth = 0;
      const dt = e.dataTransfer;
      const items = dt.items ? Array.from(dt.items) : [];
      const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      if (entries.length) {
        files.length = 0;
        for (const en of entries) await collect(en);
        if (files.length) MV.import.start(files);
      } else if (dt.files && dt.files.length) {
        MV.import.start(dt.files);
      }
    }, true);
  }

  /* ============ 快捷键 ============ */
  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!app.viewer || U.$('#page-viewer').classList.contains('hidden')) return;
      if (/input|textarea|select/i.test(document.activeElement.tagName)) return;
      const v = app.viewer;
      switch (e.key) {
        case 'ArrowDown': v.step(1); e.preventDefault(); break;
        case 'ArrowUp': v.step(-1); e.preventDefault(); break;
        case 'PageDown': v.step(10); e.preventDefault(); break;
        case 'PageUp': v.step(-10); e.preventDefault(); break;
        case 'ArrowRight': v.activePane()._userVoi = true; v.activePane().wl += (e.shiftKey ? 50 : 10); v.activePane().render(); e.preventDefault(); break;
        case 'ArrowLeft': v.activePane()._userVoi = true; v.activePane().wl -= (e.shiftKey ? 50 : 10); v.activePane().render(); e.preventDefault(); break;
        case '+': case '=': v.zoomBy(1.2); break;
        case '-': v.zoomBy(1 / 1.2); break;
        case 'r': v.rotate(1); break;
        case 'R': v.rotate(-1); break;
        case 'i': v.invert(); break;
        case 'f': v.reset(); break;
        case ' ': v.cineToggle(); e.preventDefault(); break;
        case 'Delete': case 'Backspace': v.deleteSelected(); break;
        case 'Escape': v.cancelPendingAnno(); break;
      }
    });
  }

  /* ============ 打开检查(服务器) ============ */
  async function openStudy(uid) {
    location.hash = '#/viewer?uid=' + encodeURIComponent(uid);
  }

  async function openViewerFromHash() {
    const m = location.hash.match(/uid=([^&]+)/);
    const uid = m ? decodeURIComponent(m[1]) : '';
    if (!uid) { showLibrary(); return; }
    try {
      const data = await MV.api.get('study', { uid });
      app.studyData = data;
      buildViewerPage([data]);
    } catch (e) {
      if (MV.api.needLogin) { showLogin(); return; }
      U.toast('打开检查失败: ' + e.message, 'error');
      showLibrary();
    }
  }

  /** 本地预览(导入确认对话框"仅预览" / 演示数据) */
  function openLocalStudy(groupOrStudy, batch) {
    let data;
    if (groupOrStudy.studies) {
      // 导入分组 → 阅读器数据结构
      const series = [];
      groupOrStudy.studies.forEach((st) => {
        st.series.forEach((se) => {
          series.push({
            uid: se.uid, number: se.number, desc: se.desc, modality: se.modality,
            files: se.items.map((it) => ({
              sop: it.sop, instNo: it.no, frames: it.frames, blob: it.blob || null, stagedId: it.stagedId || null,
              getBytes: async function () {
                if (this.blob) return new Uint8Array(await this.blob.arrayBuffer());
                return MV.api.tmpMeta(this.stagedBatch || batch, this.stagedId, 32 * 1024 * 1024);
              }
            }))
          });
        });
      });
      data = {
        patient: groupOrStudy.patient,
        study: { desc: '本地预览 · ' + (groupOrStudy.patient.name || ''), series }
      };
    } else {
      data = groupOrStudy;
    }
    app.studyData = data;
    // replaceState 不触发 hashchange; 若用 location.hash 会引发路由回到列表页, 把预览视图立即拆掉
    history.replaceState(null, '', '#/local');
    buildViewerPage([data]);
  }

  /* ============ 阅读器页 ============ */
  function buildViewerPage(dataList) {
    U.$('#page-library').classList.add('hidden');
    U.$('#page-viewer').classList.remove('hidden');
    U.$('#btn-import').classList.add('hidden');
    U.$('#search-box').classList.add('hidden');

    if (app.viewer) { app.viewer.destroy(); app.viewer = null; }

    const viewer = new MV.viewer.Viewer(U.$('#vpanes'), { onstate: onViewerState });
    app.viewer = viewer;

    // 构建序列栈(过滤 SR/PR 等非图像序列)
    app.stacks = [];
    dataList.forEach((data) => {
      (data.study.series || []).forEach((se) => {
        if (MV.viewer.NON_IMAGE_MODALITIES.includes(String(se.modality || '').toUpperCase())) return;
        app.stacks.push(new MV.viewer.Stack({
          uid: se.uid, number: se.number, desc: se.desc, modality: se.modality,
          patient: data.patient ? {
            name: data.patient.name, id: data.patient.id,
            birth: data.patient.birth, sex: data.patient.sex
          } : null,
          files: (se.files || []).map((f) => ({
            sop: f.sop, instNo: f.no, frames: f.frames,
            ref: f.st != null ? f : null, blob: f.blob || null,
            getBytes: async function () {
              if (this.blob) return new Uint8Array(await this.blob.arrayBuffer());
              if (this.ref) return MV.getBytes(this.ref);
              throw new Error('文件不可用');
            }
          }))
        }));
      });
    });

    buildToolbar();
    buildSeriesList();
    buildBottom();
    if (app.stacks.length) viewer.setSeries(app.stacks[0], 0);
    if (app.stacks.length > 1 && viewer.layout === 1) { /* 单图启动,用户可切布局 */ }
  }

  function onViewerState(s) {
    if (!s) return;
    U.$('#inst-label').textContent = '图 ' + s.idx + '/' + s.total + ' · WC ' + Math.round(s.wl) + '/WW ' + Math.round(s.ww);
    const sl = U.$('#inst-slider');
    sl.max = s.total; sl.value = s.idx;
    U.$('#cine-btn').textContent = (s.cine ? '⏸' : '▶') + app.viewer.cineFps + '/秒';
    refreshPresetOptions(s.modality);
  }

  const TOOLS = [
    ['wl', 'contrast', '调窗'], ['pan', 'pan', '平移'], ['zoom', 'zoom', '缩放'], ['scroll', 'scroll', '滚动'],
    ['length', 'ruler', '长度'], ['angle', 'angle', '角度'], ['rect', 'rect', '矩形'], ['ellipse', 'ellipse', '椭圆'],
    ['text', 'text', '文字']
  ];
  // 窗宽窗位预设(按设备类型区分; null=文件默认, 'auto'=动态范围, 'wide'/'narrow'=窗宽倍增)
  const PRESET_SETS = {
    CT: [['默认窗', null], ['肺窗', -600, 1500], ['纵隔窗', 50, 350], ['骨窗', 480, 2500], ['脑窗', 40, 80], ['软组织', 40, 400]],
    MR: [['默认窗', null], ['脑 T1', 500, 1000], ['脑 T2', 600, 1500], ['脊柱/脊髓', 700, 2500], ['关节', 500, 1200], ['自动全范围', 'auto']],
    DX: [['默认窗', null], ['自动全范围', 'auto'], ['加宽 ×2(肺纹理)', 'wide'], ['收窄 ×2(软组织)', 'narrow']],
    DEFAULT: [['默认窗', null], ['自动全范围', 'auto'], ['加宽 ×2', 'wide'], ['收窄 ×2', 'narrow']]
  };
  let presetSel = null, presetMod = '';

  function refreshPresetOptions(modality) {
    if (!presetSel || modality === presetMod) return;
    presetMod = modality;
    const set = PRESET_SETS[String(modality || '').toUpperCase()] || PRESET_SETS.DEFAULT;
    presetSel.innerHTML = '';
    set.forEach(([label, a, b]) => {
      const opt = U.el('option', { text: label });
      opt._preset = (a === null) ? null : (a === 'auto' || a === 'wide' || a === 'narrow') ? a : [a, b];
      presetSel.appendChild(opt);
    });
  }

  function buildToolbar() {
    const bar = U.$('#vtoolbar');
    bar.innerHTML = '';
    // 返回 + 序列抽屉
    const back = U.el('button', { class: 'tool-btn', title: '返回列表', html: U.icon('back') + '<span class="lbl">返回</span>', onclick: () => { exitMpr(); location.hash = '#/'; } });
    bar.appendChild(back);
    const drawer = U.el('button', { class: 'tool-btn series-drawer-btn', title: '序列列表', html: U.icon('menu') + '<span class="lbl">序列</span>', onclick: () => U.$('#vseries').classList.toggle('open') });
    bar.appendChild(drawer);
    bar.appendChild(U.el('div', { class: 'vsep' }));

    // —— 窗位预设 / ROI窗 / MPR(核心模式类控件放最前, 手机不用横向滚动也能看到)——
    presetSel = U.el('select', { class: 'input wl-preset-select', title: '窗宽窗位预设(按设备类型)', style: { width: '108px', padding: '6px' } });
    presetSel.addEventListener('change', () => {
      const opt = presetSel.selectedOptions[0];
      if (!opt || opt._preset === undefined) return;
      if (mprView && mprView.vol) {
        const v = opt._preset;
        if (v == null) mprView.applyVoi(mprView.vol.wc, mprView.vol.ww);
        else if (v === 'wide') mprView.applyVoi(mprView.wc, Math.min(65535, mprView.ww * 2));
        else if (v === 'narrow') mprView.applyVoi(mprView.wc, Math.max(1, mprView.ww / 2));
        else if (v === 'auto') {
          let mn = Infinity, mx = -Infinity;
          const vol = mprView.vol.vol;
          for (let i = 0; i < vol.length; i += 131) { const q = vol[i]; if (q < mn) mn = q; if (q > mx) mx = q; }
          mprView.applyVoi((mn + mx) / 2, Math.max(1, mx - mn));
        }
        else mprView.applyVoi(v[0], v[1]);
        U.$('#inst-label').textContent = 'MPR · WC ' + Math.round(mprView.wc) + '/WW ' + Math.round(mprView.ww);
        return;
      }
      if (app.viewer) app.viewer.applyPreset(opt._preset);
    });
    bar.appendChild(presetSel);
    presetMod = null;
    refreshPresetOptions('');
    // ROI 自动窗开关: 激活后左键拉框即按 ROI 直方图自动窗宽窗位
    const roiBtn = U.el('button', { class: 'tool-btn warn', title: 'ROI 自动窗: 激活后左键拉一个矩形,按框内直方图自动计算窗宽窗位(适合 X 光)', html: U.icon('rect') + '<span class="lbl">ROI窗</span>' });
    roiBtn.onclick = () => {
      const on = roiBtn.classList.toggle('active');
      app.viewer.setTool(on ? 'roivoi' : 'wl');
      if (on) {
        U.$$('.tool-btn', bar).forEach((x) => x.classList.remove('active'));
        roiBtn.classList.add('active');
      } else {
        const wlBtn = bar.querySelector('.tool-btn');
        if (wlBtn) wlBtn.classList.add('active');
      }
    };
    bar.appendChild(roiBtn);
    // MPR: 三平面重建(需 ≥8 层的同尺寸序列)
    const mprBtn = U.el('button', {
      class: 'tool-btn warn', title: 'MPR 多平面重建: 轴位/冠状/矢状三视图 + 十字线联动(需 8 层以上序列)',
      html: U.icon('layers') + '<span class="lbl">MPR</span>'
    });
    mprBtn.onclick = () => toggleMpr(mprBtn);
    bar.appendChild(mprBtn);
    mprBtnRef = mprBtn;
    bar.appendChild(U.el('div', { class: 'vsep' }));

    TOOLS.forEach(([id, icon, label], i) => {
      const b = U.el('button', { class: 'tool-btn' + (i === 0 ? ' active' : ''), title: label, html: U.icon(icon) + '<span class="lbl">' + label + '</span>' });
      b.onclick = () => {
        app.viewer.setTool(id);
        roiBtn.classList.remove('active');
        U.$$('.tool-btn', bar).forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      };
      bar.appendChild(b);
      if (i === 3) bar.appendChild(U.el('div', { class: 'vsep' }));
    });
    bar.appendChild(U.el('div', { class: 'vsep' }));
    const mkBtn = (icon, label, fn) => {
      const b = U.el('button', { class: 'tool-btn', title: label, html: U.icon(icon) + '<span class="lbl">' + label + '</span>' });
      b.onclick = fn; bar.appendChild(b); return b;
    };
    mkBtn('invert', '反色', () => {
      if (mprView) { mprView.invertToggle(); return; }
      app.viewer.invert();
    });
    mkBtn('rotateL', '左旋', () => app.viewer.rotate(-1));
    mkBtn('rotateR', '右旋', () => app.viewer.rotate(1));
    mkBtn('flipH', '水平翻转', () => app.viewer.flipH());
    mkBtn('flipV', '垂直翻转', () => app.viewer.flipV());
    mkBtn('reset', '复位', () => {
      if (mprView) {
        mprView.planes.forEach((p) => { p.zoom = 1; p.pan = { x: 0, y: 0 }; });
        mprView.cross = { x: Math.floor(mprView.vol.nx / 2), y: Math.floor(mprView.vol.ny / 2), z: Math.floor(mprView.vol.nz / 2) };
        mprView.wc = mprView.vol.wc; mprView.ww = mprView.vol.ww; mprView.invert = false;
        mprView.renderAll();
        U.$('#inst-slider').value = mprView.cross.z + 1;
        return;
      }
      app.viewer.reset();
    });
    bar.appendChild(U.el('div', { class: 'vsep' }));
    [['layout1', '单图', 1], ['layout2', '双图', 2], ['layout4', '四图', 4]].forEach(([icon, label, n]) => {
      const b = U.el('button', { class: 'tool-btn', title: label, html: U.icon(icon) + '<span class="lbl">' + label + '</span>' });
      b.onclick = () => { app.viewer.buildLayout(n); buildSeriesList(); };
      bar.appendChild(b);
    });
    bar.appendChild(U.el('div', { class: 'vsep' }));
    mkBtn('image', '导出PNG', () => app.viewer.exportPNG());
    if (MV.api.serverMode && app.studyData && app.studyData.study) {
      const uid = app.studyData.study.uid;
      if (uid) mkBtn('download', '导出DICOM', () => { location.href = MV.api.exportStudyUrl(uid); });
    }
    mkBtn('trash', '清除标注', async () => {
      if (app.viewer.hasAnnotations()) {
        if (await U.confirm('清除标注', '确定清除当前序列上的全部标注?', { okText: '清除', danger: true })) app.viewer.clearAnnotations();
      } else U.toast('当前没有标注');
    });
  }

  function buildSeriesList() {
    const box = U.$('#vseries');
    box.innerHTML = '';
    app.stacks.forEach((st) => {
      const img = U.el('img', { alt: '', loading: 'lazy' });
      const item = U.el('div', { class: 'series-item' + (app.viewer.panes.some((p) => p.stack === st) ? ' active' : '') }, [
        img,
        U.el('div', { class: 'sinfo' }, [
          U.el('div', { class: 'sdesc', text: st.info.desc || ('序列 ' + (st.info.number || '')) }),
          U.el('div', { class: 'ssub', text: (st.info.modality ? st.info.modality + ' · ' : '') + st.images.length + ' 幅' + (framesOf(st) ? ' ×' + framesOf(st) + '帧' : '') })
        ])
      ]);
      item.onclick = () => {
        exitMpr();
        app.viewer.setSeries(st);
        buildSeriesList();
        U.$('#vseries').classList.remove('open');
      };
      box.appendChild(item);
    });
    // 滚动时继续加载进入视口的缩略图(灌注等大量序列时避免一次性全量拉取)
    if (!box._thumbScrollBound) {
      box._thumbScrollBound = true;
      box.addEventListener('scroll', U.throttle(() => renderThumbs(), 300), { passive: true });
    }
    renderThumbs();
  }

  function framesOf(st) {
    const f = st.files && st.files[0] && st.files[0].frames;
    return f > 1 ? f : 0;
  }

  let thumbToken = 0;
  async function renderThumbs() {
    const token = ++thumbToken;
    const items = U.$$('#vseries .series-item');
    const box = U.$('#vseries');
    const vb = box.getBoundingClientRect();
    let deferred = false;
    for (let i = 0; i < app.stacks.length; i++) {
      if (token !== thumbToken) return;
      const st = app.stacks[i];
      const item = items[i];
      if (!item) continue;
      const img = item.querySelector('img');
      if (!img || img.src) continue;
      const r = item.getBoundingClientRect();
      if (r.bottom < vb.top - 250 || r.top > vb.bottom + 250) { deferred = true; continue; }
      try {
        const url = await MV.viewer.thumbFromStack(st, 64);
        if (token !== thumbToken) return;
        if (!img.src) img.src = url;
      } catch (e) { /* 单个缩略图失败忽略 */ }
    }
    if (deferred && !box._thumbPend) {
      box._thumbPend = true;
      setTimeout(() => { box._thumbPend = false; renderThumbs(); }, 500);
    }
  }

  function buildBottom() {
    const sl = U.$('#inst-slider');
    sl.oninput = (e) => {
      const n = +e.target.value;
      if (mprView && mprView.vol) {
        mprView.cross.z = U.clamp(n - 1, 0, mprView.vol.nz - 1);
        mprView.renderAll();
        U.$('#inst-label').textContent = 'MPR · 轴位 ' + n + '/' + mprView.vol.nz + ' · WC ' + Math.round(mprView.wc) + '/WW ' + Math.round(mprView.ww);
        return;
      }
      if (app.viewer) app.viewer.gotoImage(n);
    };
    U.$('#cine-btn').onclick = () => {
      if (mprView) { U.toast('MPR 模式下请先退出 MPR 再播放'); return; }
      if (app.viewer) app.viewer.cineToggle();
    };
    const fpsSel = U.$('#cine-fps');
    fpsSel.title = 'CINE 播放速度(帧/秒)';
    fpsSel.onchange = (e) => {
      if (!app.viewer) return;
      app.viewer.cineSetFps(+e.target.value);
      // 未播放时也立即反馈当前帧率
      U.$('#cine-btn').textContent = (app.viewer.cineTimer ? '⏸' : '▶') + e.target.value + '/秒';
    };
  }

  /* ============ MPR 模式 ============ */
  let mprView = null;
  let mprBtnRef = null;   // MPR 按钮(退出时同步取消高亮)

  function toggleMpr(btn) {
    if (mprView) { exitMpr(btn); return; }
    const v = app.viewer;
    const pane = v && v.activePane();
    const st = pane && pane.stack;
    if (!st || !st.images.length) { U.toast('没有可重建的序列', 'error'); return; }
    const framesOfFirst = st.files[0] && st.files[0].frames || 1;
    if (st.images.length < 8) {
      U.toast('MPR 需要至少 8 层图像的序列(当前 ' + st.images.length + ' 层)', 'error');
      return;
    }
    if (framesOfFirst > 1) { U.toast('该序列为多帧文件,MPR 暂不支持', 'error'); return; }
    v.cineStop();
    const wrap = U.$('#vpanes-wrap');
    wrap.classList.add('mpr-on');
    U.$('#vpanes').style.display = 'none';
    mprView = new MV.mpr.MprView(wrap, st, {
      onready: (m) => {
        U.$('#inst-label').textContent = 'MPR · 三平面 · WC ' + Math.round(m.wc) + '/WW ' + Math.round(m.ww);
        const sl = U.$('#inst-slider');
        sl.min = 1; sl.max = m.vol.nz; sl.value = m.cross.z + 1;
      }
    });
    const mask = U.el('div', { class: 'vp-load', style: { display: '' } , text: '正在重建体数据(' + st.images.length + ' 层)…' });
    wrap.appendChild(mask);
    mprView.build((p) => { mask.textContent = '正在重建体数据 ' + Math.round(p * 100) + '%(' + st.images.length + ' 层)…'; })
      .then(() => { mask.remove(); })
      .catch((e) => {
        mask.remove();
        U.toast('MPR 失败: ' + e.message, 'error');
        exitMpr(btn);
      });
    btn.classList.add('active');
    btn._on = true;
  }

  function exitMpr(btn) {
    if (mprView) { mprView.destroy(); mprView = null; }
    U.$('#vpanes-wrap').classList.remove('mpr-on');
    U.$('#vpanes').style.display = '';
    const b = btn || mprBtnRef;
    if (b) { b.classList.remove('active'); b._on = false; }
    // 滑条/状态栏交还给普通视图
    if (app.viewer) {
      const s = app.viewer.state();
      if (s) {
        const sl = U.$('#inst-slider');
        sl.max = s.total; sl.value = s.idx;
      }
      app.viewer._notify();
    }
  }

  /* ============ 登录 ============ */
  function showLogin() {
    U.$('#login-overlay').classList.remove('hidden');
    U.$('#user-box').innerHTML = '';
    setTimeout(() => U.$('#login-user').focus(), 50);
  }
  function bindLogin() {
    U.$('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = U.$('#login-user').value.trim(), p = U.$('#login-pass').value;
      try {
        const r = await MV.api.login(u, p);
        if (r && r.ok) {
          U.$('#login-pass').value = '';
          U.$('#login-overlay').classList.add('hidden');
          buildUserBox();
          route();
        } else U.toast('登录失败', 'error');
      } catch (err) { U.toast('登录失败: ' + err.message, 'error'); }
    });
  }

  /* ============ 账号管理(admin) ============ */
  async function showAccounts() {
    let accounts;
    try { accounts = (await MV.api.accountsList()).accounts; }
    catch (e) { U.toast('加载账号失败: ' + e.message, 'error'); return; }

    const fmtExp = (s) => {
      if (!s) return '永久';
      const d = U.fmtDate(s.slice(0, 8)) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12);
      return d;
    };
    const rows = accounts.map((a) => {
      const expired = a.expired;
      return U.el('tr', {}, [
        U.el('td', { text: a.name + (a.role === 'admin' ? '(管理员)' : '') }),
        U.el('td', { text: a.note || '' }),
        U.el('td', { style: { color: expired ? 'var(--danger)' : '' }, text: fmtExp(a.expires) + (expired ? '(已过期)' : '') }),
        U.el('td', {}, [
          a.role !== 'admin' ? U.el('button', {
            class: 'btn sm', text: '+7天', title: '延长 7 天',
            onclick: async () => { try { await MV.api.accountRenew(a.name, 7); U.toast('已延长 7 天', 'ok'); overlay.remove(); showAccounts(); } catch (err) { U.toast(err.message, 'error'); } }
          }) : null,
          U.el('button', {
            class: 'btn sm', text: '改密',
            onclick: async () => {
              const np = await U.prompt('为「' + a.name + '」设置新密码(至少4位)', '');
              if (!np) return;
              try { await MV.api.accountSetPass(a.name, np); U.toast('密码已更新', 'ok'); } catch (err) { U.toast(err.message, 'error'); }
            }
          }),
          a.role !== 'admin' ? U.el('button', {
            class: 'btn sm danger', text: '删除',
            onclick: async () => {
              if (!await U.confirm('删除账号', '确定删除临时账号「' + U.esc(a.name) + '」?', { okText: '删除', danger: true })) return;
              try { await MV.api.accountDel(a.name); U.toast('已删除', 'ok'); overlay.remove(); showAccounts(); } catch (err) { U.toast(err.message, 'error'); }
            }
          }) : null
        ])
      ]);
    });

    const nameIn = U.el('input', { class: 'input', placeholder: '用户名(字母/数字)', autocomplete: 'off' });
    const passIn = U.el('input', { class: 'input', placeholder: '密码(至少4位)', type: 'text', autocomplete: 'off' });
    const daysSel = U.el('select', { class: 'input' },
      [['1', '有效期 1 天'], ['7', '有效期 7 天'], ['30', '有效期 30 天'], ['90', '有效期 90 天'], ['365', '有效期 1 年']]
        .map(([v, t]) => U.el('option', { value: v, text: t, selected: v === '7' ? '' : null })));
    const noteIn = U.el('input', { class: 'input', placeholder: '备注(给谁用)' });
    const addBtn = U.el('button', {
      class: 'btn primary sm', text: '创建临时账号',
      onclick: async () => {
        try {
          await MV.api.accountAdd(nameIn.value.trim(), passIn.value, +daysSel.value, noteIn.value.trim());
          U.toast('已创建 ' + nameIn.value.trim(), 'ok');
          overlay.remove();
          showAccounts();
        } catch (err) { U.toast(err.message, 'error'); }
      }
    });

    const tbl = U.el('table', { class: 'acc-table' }, [
      U.el('thead', {}, [U.el('tr', {}, [
        U.el('th', { text: '用户名' }), U.el('th', { text: '备注' }), U.el('th', { text: '有效期至' }), U.el('th', { text: '操作' })
      ])]),
      U.el('tbody', {}, rows)
    ]);

    const overlay = U.el('div', { class: 'modal-overlay' }, [
      U.el('div', { class: 'modal wide' }, [
        U.el('div', { class: 'modal-title', text: '账号管理(管理员)' }),
        U.el('div', { class: 'modal-body' }, [
          U.el('div', { class: 'grid2', style: { gridTemplateColumns: '1fr 1fr 1fr 1.2fr auto', gap: '8px', alignItems: 'end' } }, [
            U.el('div', { class: 'field', style: { margin: 0 } }, [U.el('label', { text: '用户名' }), nameIn]),
            U.el('div', { class: 'field', style: { margin: 0 } }, [U.el('label', { text: '密码' }), passIn]),
            U.el('div', { class: 'field', style: { margin: 0 } }, [U.el('label', { text: '有效期' }), daysSel]),
            U.el('div', { class: 'field', style: { margin: 0 } }, [U.el('label', { text: '备注' }), noteIn]),
            addBtn
          ]),
          U.el('div', { style: { maxHeight: '46vh', overflowY: 'auto', marginTop: '12px' } }, [tbl]),
          U.el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' }, text: '临时账号到期后自动失效(登录中和后续请求都会被拒绝);删除即时生效。请及时修改默认管理员密码。' })
        ]),
        U.el('div', { class: 'modal-btns' }, [
          U.el('button', { class: 'btn', text: '关闭', onclick: () => overlay.remove() })
        ])
      ])
    ]);
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  MV.app = app;
  MV.app.openStudy = openStudy;
  MV.app.openLocalStudy = openLocalStudy;
  MV.app.showLogin = showLogin;

  document.addEventListener('DOMContentLoaded', () => { boot(); bindLogin(); });
})();

/* MV.library — PACS 风格工作列表页
 * 按患者分组的检查表格 + 序列缩略图条 + 检索(关键词/日期范围/设备类型)
 */
(function () {
  'use strict';
  window.MV = window.MV || {};
  const U = MV.U;

  let allPatients = [];
  const filters = { kw: '', from: '', to: '', mods: new Set() };
  const expandedDirs = new Set();   // 已展开的患者目录
  let chipKey = '';

  const MOD_CLASS = { ct: 'ct', mr: 'mr', us: 'us', dx: 'dx', cr: 'dx', dr: 'dx', mg: 'dx', pt: 'us', nm: 'us', xa: 'ct', rf: 'mr' };

  /* ---------- 数据 ---------- */
  async function refresh() {
    if (!MV.api.serverMode) {
      renderLocalMode();
      return;
    }
    try {
      const r = await MV.api.get('list');
      allPatients = r.patients || [];
    } catch (e) {
      if (MV.api.needLogin) { MV.app.showLogin(); return; }
      U.toast('加载列表失败: ' + e.message, 'error');
      return;
    }
    buildFilterBar();
    render();
  }

  function setSearch(t) {
    filters.kw = t;
    if (U.$('#wl-kw')) U.$('#wl-kw').value = t;
    render();
  }

  /* ---------- 过滤 ---------- */
  function d8(v) { return String(v || '').replace(/\D/g, ''); }

  function studyMatches(st) {
    const dateFilterSet = filters.from || filters.to;
    if (dateFilterSet) {
      if (!st.date) return false;
      if (filters.from && st.date < filters.from) return false;
      if (filters.to && st.date > filters.to) return false;
    }
    if (filters.mods.size) {
      const mods = (st.modalities || []).filter(Boolean);
      if (!mods.some((m) => filters.mods.has(m))) return false;
    }
    return true;
  }
  function patientMatches(p) {
    if (filters.kw) {
      const kw = filters.kw.toLowerCase();
      const hay = (
        (p.name || '') + ' ' + (p.id || '') + ' ' +
        (p.studies || []).map((s) => (s.desc || '') + ' ' + (s.accession || '')).join(' ')
      ).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  }

  function filteredData() {
    const out = [];
    allPatients.forEach((p) => {
      if (!patientMatches(p)) return;
      const studies = (p.studies || []).filter(studyMatches);
      if (studies.length) out.push({ p, studies });
    });
    return out;
  }

  /* ---------- 筛选栏 ---------- */
  function allModalities() {
    const set = new Set();
    allPatients.forEach((p) => (p.studies || []).forEach((st) => (st.modalities || []).forEach((m) => m && set.add(m))));
    return Array.from(set).sort();
  }

  function buildFilterBar() {
    const mods = allModalities();
    const key = mods.join(',');
    if (key === chipKey && U.$('#wl-filter')) {
      // 数据未变,仅刷新统计
      renderStats();
      return;
    }
    chipKey = key;
    const box = U.$('#wl-filter');
    if (!box) return;
    box.innerHTML = '';

    const kw = U.el('input', { class: 'input', id: 'wl-kw', placeholder: '搜索: 姓名 / ID / 检查名称 / 检查号', value: filters.kw });
    kw.addEventListener('input', U.debounce(() => { filters.kw = kw.value.trim(); render(); }, 200));
    const from = U.el('input', { class: 'input', type: 'date', id: 'wl-from', title: '开始日期', value: filters.from });
    const to = U.el('input', { class: 'input', type: 'date', id: 'wl-to', title: '结束日期', value: filters.to });
    const applyDate = () => {
      filters.from = d8(from.value);
      filters.to = d8(to.value);
      render();
    };
    from.addEventListener('change', applyDate);
    to.addEventListener('change', applyDate);

    const chips = U.el('div', { class: 'wl-chips' });
    const mkChip = (label, val) => {
      const on = !val ? filters.mods.size === 0 : filters.mods.has(val);
      const c = U.el('button', { class: 'wl-chip' + (on ? ' on' : ''), text: label });
      c.onclick = () => {
        if (!val) filters.mods.clear();
        else if (filters.mods.has(val)) filters.mods.delete(val);
        else filters.mods.add(val);
        buildFilterBar();
        render();
      };
      return c;
    };
    chips.appendChild(mkChip('全部设备', null));
    mods.forEach((m) => chips.appendChild(mkChip(m, m)));

    box.appendChild(U.el('div', { class: 'wl-filter-row' }, [
      U.el('div', { class: 'wl-kw-box' }, [kw]),
      U.el('div', { class: 'wl-date-box' }, [
        U.el('span', { class: 'muted', text: '日期' }), from, U.el('span', { class: 'muted', text: '至' }), to
      ])
    ]));
    box.appendChild(chips);
  }

  function renderStats() {
    const groups = filteredData();
    const studies = groups.reduce((n, g) => n + g.studies.length, 0);
    const insts = groups.reduce((n, g) => n + g.studies.reduce((m, s) => m + s.instanceCount, 0), 0);
    const el = U.$('#wl-stats');
    if (el) el.textContent = '共 ' + groups.length + ' 位患者 · ' + studies + ' 次检查 · ' + insts + ' 幅图像';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const table = U.$('#wl-table');
    const empty = U.$('#library-empty');
    table.innerHTML = '';
    renderStats();

    if (!allPatients.length) {
      empty.classList.remove('hidden');
      empty.querySelector('.hint').innerHTML =
        '暂无数据。点击右上角<b>导入</b>,选择 DICOM 文件、文件夹或 ZIP 压缩包。<br>也可以先打开 <a href="demo.html" style="color:var(--accent)">演示页面</a> 体验。';
      return;
    }
    const groups = filteredData();
    if (!groups.length) {
      empty.classList.remove('hidden');
      empty.querySelector('.hint').innerHTML = '没有符合筛选条件的检查,请调整检索条件。';
      return;
    }
    empty.classList.add('hidden');

    // 表头
    table.appendChild(U.el('div', { class: 'wl-head' }, [
      U.el('span', { class: 'wl-ex' }),
      U.el('span', { text: '检查日期' }),
      U.el('span', { text: '检查描述' }),
      U.el('span', { text: '设备' }),
      U.el('span', { text: '序列/图像' }),
      U.el('span', { text: '操作' })
    ]));

    groups.forEach(({ p, studies }) => table.appendChild(groupEl(p, studies)));
  }

  function groupEl(p, studies) {
    const totalInst = studies.reduce((n, s) => n + s.instanceCount, 0);
    const age = U.age(p.birth, p.lastStudyDate);
    // 搜索时自动全部展开,否则按用户点击状态
    const expanded = filters.kw !== '' || filters.from !== '' || filters.to !== '' || filters.mods.size > 0
      ? true : expandedDirs.has(p.dir);
    if (expanded) expandedDirs.add(p.dir); else expandedDirs.delete(p.dir);

    const chevron = U.el('span', { class: 'wl-chev' + (expanded ? ' open' : ''), html: U.icon('back', 14) });
    const patEl = U.el('div', { class: 'wl-pat' + (expanded ? ' expanded' : ''), onclick: () => { if (expanded) expandedDirs.delete(p.dir); else expandedDirs.add(p.dir); render(); } }, [
      chevron,
      U.el('div', { class: 'avatar', text: (p.name || '?').trim().charAt(0) || '?' }),
      U.el('div', { class: 'wl-pat-info' }, [
        U.el('span', { class: 'wl-pat-name', text: p.name || '未知姓名' }),
        p.id ? U.el('span', { class: 'muted wl-pat-id', text: 'ID ' + p.id }) : null,
        U.el('span', { class: 'muted wl-pat-sub', text: [U.fmtSex(p.sex), U.fmtDate(p.birth), age].filter(Boolean).join(' · ') })
      ]),
      U.el('div', { class: 'wl-pat-stats muted', text: studies.length + ' 次检查 · ' + totalInst + ' 幅' }),
      U.el('div', { class: 'row-actions' }, [
        iconBtn('edit', '编辑患者信息', (e) => { e.stopPropagation(); editPatient(p); }),
        iconBtn('download', '导出全部检查', (e) => { e.stopPropagation(); location.href = MV.api.exportPatientUrl(p.dir); }),
        iconBtn('trash', '删除患者', async (e) => {
          e.stopPropagation();
          if (await U.confirm('删除患者', '确定删除患者「' + U.esc(p.name || '未知') + '」及其<b>全部 ' + studies.length + ' 次检查</b>?<br>所有原始 DICOM 文件将被删除,不可恢复。', { okText: '全部删除', danger: true })) {
            try {
              await MV.api.post('delete-patient', null, { dir: p.dir });
              U.toast('已删除', 'ok');
              refresh();
            } catch (err) { U.toast('删除失败: ' + err.message, 'error'); }
          }
        })
      ])
    ]);

    const group = U.el('div', { class: 'wl-group' }, [patEl]);
    if (expanded) studies.forEach((st) => group.appendChild(studyRowEl(st)));
    else group.appendChild(U.el('div', { class: 'wl-collapsed-hint muted', text: '共 ' + studies.length + ' 次检查,点击展开' }));
    return group;
  }

  function studyRowEl(st) {
    const ex = U.el('button', { class: 'wl-expand', title: '展开序列缩略图', html: U.icon('back', 14) });
    const row = U.el('div', { class: 'wl-study', onclick: (e) => { if (!e.target.closest('.wl-actions,.wl-expand')) MV.app.openStudy(st.sid || st.uid); } }, [
      U.el('span', { class: 'wl-ex' }, [ex]),
      U.el('span', { class: 'wl-date', text: U.fmtDate(st.date) || '—' }),
      U.el('span', { class: 'wl-desc' }, [
        U.el('div', { class: 'wl-desc-text', text: st.desc || '未命名检查' }),
        st.accession ? U.el('div', { class: 'muted wl-acc', text: 'No. ' + st.accession }) : null
      ]),
      U.el('span', { class: 'wl-mods' },
        (st.modalities || []).filter(Boolean).map((m) => U.el('span', { class: 'badge ' + (MOD_CLASS[m.toLowerCase()] || ''), text: m }))),
      U.el('span', { class: 'wl-counts muted', text: st.seriesCount + ' / ' + st.instanceCount }),
      U.el('span', { class: 'wl-actions' }, [
        iconBtn('download', '导出 DICOM ZIP', (e) => { e.stopPropagation(); location.href = MV.api.exportStudyUrl(st.uid); }),
        iconBtn('trash', '删除检查', async (e) => {
          e.stopPropagation();
          if (await U.confirm('删除检查', '确定删除「' + U.esc(st.desc || '未命名检查') + '」(' + U.fmtDate(st.date) + ')?<br>原始 DICOM 文件将一并删除,不可恢复。', { okText: '删除', danger: true })) {
            try {
              await MV.api.post('delete-study', null, { uid: st.uid });
              U.toast('已删除', 'ok');
              refresh();
            } catch (err) { U.toast('删除失败: ' + err.message, 'error'); }
          }
        })
      ])
    ]);

    const strip = U.el('div', { class: 'wl-strip hidden' });
    ex.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = strip.classList.toggle('hidden') === false;
      ex.classList.toggle('open', open);
      if (open && !strip._built) buildStrip(st, strip);
    });
    // 展开条插在该行之后
    const wrap = U.el('div', {}, [row, strip]);
    return wrap;
  }

  /** 展开的序列缩略图条(懒加载,多序列封顶) */
  async function buildStrip(st, container) {
    container._built = true;
    container.appendChild(U.el('div', { class: 'muted', style: { padding: '6px 4px', fontSize: '12px' }, text: '加载序列…' }));
    let series;
    try {
      const data = await MV.api.get('study', { uid: st.uid });
      series = data.study.series || [];
    } catch (e) {
      container.innerHTML = '';
      container.appendChild(U.el('div', { class: 'muted', style: { padding: '6px 4px' }, text: '加载失败: ' + e.message }));
      return;
    }
    container.innerHTML = '';
    const MAX = 14;
    series.filter((se) => !MV.viewer.NON_IMAGE_MODALITIES.includes(String(se.modality || '').toUpperCase()))
      .slice(0, MAX).forEach((se) => {
      const img = U.el('img', { alt: '' });
      const card = U.el('div', { class: 'wl-thumb-card', title: (se.desc || '') + '(' + se.files.length + '幅)' }, [
        img,
        U.el('div', { class: 'wl-thumb-cap' }, [
          U.el('div', { class: 'wl-thumb-desc', text: (se.number ? se.number + '·' : '') + (se.desc || '序列') }),
          U.el('div', { class: 'muted', text: se.files.length + ' 幅' })
        ])
      ]);
      card.onclick = () => MV.app.openStudy(st.sid || st.uid);
      container.appendChild(card);
      // 惰性生成缩略图
      const stack = new MV.viewer.Stack({
        uid: se.uid, number: se.number, desc: se.desc, modality: se.modality,
        files: se.files.slice(0, 1).map((f) => ({ sop: f.sop, instNo: f.no, frames: 1, getBytes: () => MV.getBytes(f) }))
      });
      MV.viewer.thumbFromStack(stack, 84).then((url) => { if (!img.src) img.src = url; }).catch(() => {
        img.replaceWith(U.el('div', { class: 'wl-thumb-ph', text: '⚠' }));
      });
    });
    if (series.length > MAX) {
      container.appendChild(U.el('div', { class: 'wl-thumb-card wl-thumb-more' }, [
        U.el('div', { class: 'wl-thumb-ph', text: '+' + (series.length - MAX) }),
        U.el('div', { class: 'wl-thumb-cap' }, [U.el('div', { class: 'wl-thumb-desc', text: '更多序列' })])
      ]));
    }
  }

  /* ---------- 本地模式 ---------- */
  function renderLocalMode() {
    const table = U.$('#wl-table');
    table.innerHTML = '';
    const empty = U.$('#library-empty');
    empty.classList.remove('hidden');
    empty.querySelector('.hint').innerHTML =
      '当前以<b>本地模式</b>运行(未检测到 PHP 后端)。<br>可直接点击右上角「导入」选择 DICOM 文件进行预览,但不会保存到服务器。' +
      '<br>若要启用数据库,请将本程序部署到支持 PHP 的环境(如群晖 Web Station)。';
    const stats = U.$('#wl-stats');
    if (stats) stats.textContent = '';
    const fb = U.$('#wl-filter');
    if (fb) fb.innerHTML = '';
  }

  function iconBtn(icon, title, onclick) {
    return U.el('button', { class: 'icon-btn', title: title, html: U.icon(icon, 17), onclick });
  }

  function editPatient(p) {
    const nameInput = U.el('input', { class: 'input', value: p.name || '' });
    const idInput = U.el('input', { class: 'input', value: p.id || '' });
    const birthInput = U.el('input', { class: 'input', type: 'date', value: U.fmtDate(p.birth) });
    const sexSel = U.el('select', { class: 'input' },
      [['', '未知'], ['M', '男'], ['F', '女'], ['O', '其它']].map(([v, t]) => U.el('option', { value: v, text: t, selected: v === (p.sex || '') ? '' : null })));
    const done = async (save) => {
      overlay.remove();
      if (!save) return;
      try {
        await MV.api.post('edit-patient', null, {
          dir: p.dir,
          name: nameInput.value.trim(),
          id: idInput.value.trim(),
          birth: birthInput.value.replace(/\D/g, ''),
          sex: sexSel.value
        });
        U.toast('已保存', 'ok');
        refresh();
      } catch (e) { U.toast('保存失败: ' + e.message, 'error'); }
    };
    const overlay = U.el('div', { class: 'modal-overlay' }, [
      U.el('div', { class: 'modal' }, [
        U.el('div', { class: 'modal-title', text: '编辑患者信息' }),
        U.el('div', { class: 'modal-body' }, [
          U.el('div', { class: 'field' }, [U.el('label', { text: '患者姓名' }), nameInput]),
          U.el('div', { class: 'grid3' }, [
            U.el('div', { class: 'field' }, [U.el('label', { text: '患者ID' }), idInput]),
            U.el('div', { class: 'field' }, [U.el('label', { text: '出生日期' }), birthInput]),
            U.el('div', { class: 'field' }, [U.el('label', { text: '性别' }), sexSel])
          ]),
          U.el('div', { class: 'info-box', text: '修改仅影响数据库记录与显示,不改变原始 DICOM 文件内容。' })
        ]),
        U.el('div', { class: 'modal-btns' }, [
          U.el('button', { class: 'btn', text: '取消', onclick: () => done(false) }),
          U.el('button', { class: 'btn primary', text: '保存', onclick: () => done(true) })
        ])
      ])
    ]);
    document.body.appendChild(overlay);
  }

  MV.library = { refresh, setSearch };
})();

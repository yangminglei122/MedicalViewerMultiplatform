/* MV.import — 导入流程: 选择文件/ZIP → 解析 → 患者信息确认(可修改) → 入库
 * 服务器模式走 PHP 后端; 无服务器时仅支持本地预览
 */
(function () {
  'use strict';
  window.MV = window.MV || {};
  const U = MV.U, TAG = MV.TAG;

  const CHARSETS = [
    ['', '自动检测'],
    ['windows-1252', 'Latin-1 (默认)'],
    ['utf-8', 'UTF-8 (ISO_IR 192)'],
    ['gb18030', 'GB18030 / GBK (中文)'],
    ['big5', 'Big5 (繁体)'],
    ['shift_jis', 'Shift_JIS (日文)'],
    ['euc-kr', 'EUC-KR (韩文)']
  ];

  /* ---------- 进度框 ---------- */
  const activeProgress = [];   // 进行中的进度框(导入流程结束兜底关闭)

  function fmtEta(sec) {
    if (!isFinite(sec) || sec <= 0) return '…';
    if (sec < 90) return Math.ceil(sec) + ' 秒';
    if (sec < 5400) return Math.round(sec / 60) + ' 分钟';
    return (sec / 3600).toFixed(1) + ' 小时';
  }

  function showProgress(text) {
    const fill = U.el('div', { class: 'progress-fill' });
    const label = U.el('div', { text: text || '', style: { fontSize: '14.5px', color: 'var(--text)', margin: '10px 0', fontWeight: 500 } });
    const overlay = U.el('div', { class: 'modal-overlay', style: { backdropFilter: 'none', background: 'rgba(5,8,12,.62)' } }, [
      U.el('div', { class: 'modal', style: { maxWidth: '680px' } }, [
        U.el('div', { class: 'modal-title', text: '正在处理' }),
        U.el('div', { class: 'modal-body', style: { paddingTop: '4px' } }, [
          label,
          U.el('div', { class: 'progress-outer', style: { height: '22px', borderRadius: '8px' } }, [fill])
        ])
      ])
    ]);
    document.body.appendChild(overlay);
    // UI 更新节流: 避免高频 style 写触发 backdrop 重绘(大批文件时会造成数十秒卡顿)
    let lastUi = 0;
    const entry = {
      update(p, info) {
        const now = Date.now();
        if (now - lastUi < 80) return;
        lastUi = now;
        fill.style.width = Math.round(U.clamp(p, 0, 1) * 100) + '%';
        if (info != null) label.textContent = info;
      },
      set text(t) { label.textContent = t; },
      close() {
        overlay.remove();
        const i = activeProgress.indexOf(entry);
        if (i >= 0) activeProgress.splice(i, 1);
      }
    };
    activeProgress.push(entry);
    return entry;
  }

  /* ---------- 头部解析 ---------- */
  async function readFileHeader(file) {
    const steps = [Math.min(file.size, 2 * 1024 * 1024), Math.min(file.size, 20 * 1024 * 1024), file.size];
    let ds = null;
    for (const len of steps) {
      let buf;
      try { buf = await file.slice(0, len).arrayBuffer(); }
      catch (e) { return null; }
      try { ds = MV.dicom.parse(new Uint8Array(buf)); } catch (e) { return null; }
      if (!ds.truncated || len >= file.size) break;
    }
    return ds;
  }
  async function readStagedHeader(api, batch, id) {
    const steps = [524288, 8 * 1024 * 1024, 20 * 1024 * 1024];
    let ds = null;
    for (const len of steps) {
      let bytes;
      try { bytes = await api.tmpMeta(batch, id, len); } catch (e) { return null; }
      try { ds = MV.dicom.parse(bytes); } catch (e) { return null; }
      if (!ds.truncated || bytes.length < len) break;
    }
    return ds;
  }

  function extractMeta(ds) {
    const guess = ds.guessCharset();
    const dec = (tag) => U.fmtPN(ds.strWith(tag, guess));
    const studyUid = ds.str(TAG.StudyInstanceUID);
    const seriesUid = ds.str(TAG.SeriesInstanceUID);
    if (!studyUid || !seriesUid) return null;
    // 非图像对象(结构化报告 SR / PR / KO 等无像素数据)
    const hasPixels = ds.p.rows > 0 && (ds.pixel.offset >= 0 || ds.pixel.encapsulated);
    return {
      ds,
      hasPixels,
      charsetLabel: guess,
      charsetDeclared: ds.charsetTag,
      name: dec(TAG.PatientName),
      id: ds.str(TAG.PatientID).trim(),
      birth: ds.str(TAG.BirthDate).replace(/\D/g, ''),
      sex: ds.str(TAG.PatientSex),
      studyUid, seriesUid,
      sop: ds.str(TAG.SOPInstanceUID) || ('nosop-' + Math.random().toString(36).slice(2)),
      instNo: parseInt(ds.str(TAG.InstanceNumber)) || 0,
      frames: Math.max(1, parseInt(ds.str(TAG.NumberOfFrames)) || 1),
      studyDesc: ds.str(TAG.StudyDescription) || '未命名检查',
      studyDate: ds.str(TAG.StudyDate).replace(/\D/g, ''),
      accession: ds.str(TAG.AccessionNumber),
      seriesDesc: ds.str(TAG.SeriesDescription) || ('序列 ' + (parseInt(ds.str(TAG.SeriesNumber)) || 0)),
      seriesNo: parseInt(ds.str(TAG.SeriesNumber)) || 0,
      modality: ds.str(TAG.Modality) || ''
    };
  }

  /* ---------- 分组 ---------- */
  function newGroup(meta) {
    return {
      patient: { id: meta.id, name: meta.name, birth: meta.birth, sex: meta.sex },
      charsetLabel: meta.charsetLabel,
      charsetDeclared: meta.charsetDeclared,
      pnDs: meta.ds,
      studies: new Map()
    };
  }
  function addToGroup(group, meta, item) {
    let st = group.studies.get(meta.studyUid);
    if (!st) {
      st = { uid: meta.studyUid, date: meta.studyDate, desc: meta.studyDesc, accession: meta.accession, series: new Map() };
      group.studies.set(meta.studyUid, st);
    }
    if (st.date === '' && meta.studyDate) st.date = meta.studyDate;
    if (st.accession === '' && meta.accession) st.accession = meta.accession;
    let se = st.series.get(meta.seriesUid);
    if (!se) {
      se = { uid: meta.seriesUid, number: meta.seriesNo, desc: meta.seriesDesc, modality: meta.modality, items: [] };
      st.series.set(meta.seriesUid, se);
    }
    se.items.push(item);
  }

  /* ---------- 主入口 ---------- */
  async function start(files) {
    files = Array.from(files || []);
    if (!files.length) return;
    const api = MV.api;
    const server = api.serverMode === true;

    const prog = showProgress('正在解析文件…');
    let batch = null;
    if (server) {
      try { batch = (await api.tmpbegin()).batch; }
      catch (e) { prog.close(); U.toast('服务器错误: ' + e.message, 'error'); return; }
    }

    const groups = new Map();       // patientKey → group
    let okCount = 0, skipCount = 0, nonImageCount = 0, zipCount = 0;
    const localFiles = [];          // 本地 DICOM 文件
    const stagedFiles = [];         // ZIP 解出的服务器端暂存文件 {batch,id,name}

    const addMeta = (meta, item) => {
      if (!meta.hasPixels) { nonImageCount++; return; }   // SR/PR 等非图像对象不入库
      const key = meta.id !== '' ? 'id:' + meta.id : 'nm:' + meta.name + '|' + meta.birth;
      let g = groups.get(key);
      if (!g) { g = newGroup(meta); groups.set(key, g); }
      addToGroup(g, meta, item);
      okCount++;
    };

    try {
      // 阶段1: ZIP 上传(串行, 大文件本身耗时) — 显示即时速度/ETA
      for (const f of files) {
        if (!/\.zip$/i.test(f.name || '')) { localFiles.push(f); continue; }
        if (!server) { U.toast('本地预览模式不支持 ZIP,请选择 .dcm 文件', 'error'); continue; }
        zipCount++;
        const zt0 = Date.now();
        const zBytes = f.size || 0;
        let lastP = 0;
        const zProg = (p) => {
          const now = Date.now();
          const inst = (p * zBytes) / 1048576 / Math.max(0.001, (now - zt0) / 1000);
          const avg = (p * zBytes) / 1048576 / Math.max(0.001, (now - zt0) / 1000);
          const eta = p > 0.02 ? ((1 - p) * (now - zt0) / p / 1000) : Infinity;
          prog.update(p, '上传压缩包 ' + (f.name || '') + ' ' + Math.round(p * 100) + '%' +
            ' · 即时 ' + inst.toFixed(1) + ' MB/s · 平均 ' + avg.toFixed(1) + ' MB/s · 剩余 ' + fmtEta(eta));
          lastP = p;
        };
        let staged;
        try { staged = await api.uploadZipSmart(batch, f, f.name, zProg); }
        catch (e) { U.toast('ZIP 导入失败: ' + e.message, 'error'); continue; }
        const zb = staged.finalBatch || batch;   // 分块重启可能换批, 以实际批次为准
        staged.files.forEach((sf) => stagedFiles.push({ batch: zb, id: sf.id, name: sf.name }));
      }

      // 阶段2: 本地文件并发解析
      const totalParse = localFiles.length + stagedFiles.length;
      let parsed = 0;
      const tick = () => {
        parsed++;
        if (totalParse) prog.update(parsed / totalParse, '解析中 ' + parsed + '/' + totalParse + (zipCount ? '(含 ' + zipCount + ' 个压缩包)' : ''));
      };
      await U.runPool(localFiles, 8, async (f) => {
        const ds = await readFileHeader(f);
        const meta = ds ? extractMeta(ds) : null;
        if (meta) addMeta(meta, { blob: f, name: f.name, sop: meta.sop, no: meta.instNo, frames: meta.frames });
        else skipCount++;
        tick();
      });
      // 阶段3: 暂存文件并发读取头部并解析
      await U.runPool(stagedFiles, 6, async (sf) => {
        const ds = await readStagedHeader(api, sf.batch, sf.id);
        const meta = ds ? extractMeta(ds) : null;
        if (meta) addMeta(meta, { stagedId: sf.id, stagedBatch: sf.batch, name: sf.name, sop: meta.sop, no: meta.instNo, frames: meta.frames });
        else skipCount++;
        tick();
      });
    } finally {
      prog.close();
    }

    if (!okCount) {
      U.toast('未找到有效的 DICOM 图像' + (nonImageCount ? '(其中 ' + nonImageCount + ' 个是报告等非图像对象)' : '') + (skipCount ? ',另跳过 ' + skipCount + ' 个无效文件' : ''), 'error', 5000);
      return;
    }
    if (skipCount) U.toast('已跳过 ' + skipCount + ' 个非 DICOM 文件', 'info');
    if (nonImageCount) U.toast('已跳过 ' + nonImageCount + ' 个非图像对象(结构化报告/注释等,不含影像)', 'info', 4000);

    // 获取已有患者(用于合并提示)
    let existing = null, existingStudyUids = new Set();
    if (server) {
      try {
        const r = await api.get('list');
        existing = r.patients || [];
        existing.forEach((p) => (p.studies || []).forEach((st) => existingStudyUids.add(st.uid)));
      } catch (e) { /* 忽略 */ }
    }

    // 逐组患者确认
    const groupList = Array.from(groups.values());
    let imported = 0, previews = 0;
    for (let gi = 0; gi < groupList.length; gi++) {
      const r = await confirmDialog(groupList[gi], gi + 1, groupList.length, existing, existingStudyUids, server);
      if (r.action === 'cancel') break;
      if (r.action === 'preview') {
        previews++;
        MV.app.openLocalStudy(groupList[gi], batch);
        continue;
      }
      // 确认导入
      const res = await doImport(groupList[gi], r, batch, server);
      if (res) { imported++; U.emit('library-changed'); }
    }
    if (imported) {
      U.toast('导入完成', 'ok');
      U.emit('library-changed');
    }
  }

  /* ---------- 确认对话框 ---------- */
  function confirmDialog(group, gi, gn, existing, existingStudyUids, server) {
    return new Promise((resolve) => {
      const p = group.patient;
      const totalInstances = Array.from(group.studies.values()).reduce(
        (n, st) => n + Array.from(st.series.values()).reduce((m, se) => m + se.items.length, 0), 0);

      // 匹配已有患者
      let matched = null;
      if (existing) {
        const idLow = (p.id || '').toLowerCase();
        for (const ep of existing) {
          if (idLow !== '' && String(ep.id || '').trim().toLowerCase() === idLow) { matched = ep; break; }
        }
        if (!matched && idLow === '') {
          for (const ep of existing) {
            if ((ep.name || '') === p.name && (ep.birth || '') === p.birth) { matched = ep; break; }
          }
        }
      }

      const nameInput = U.el('input', { class: 'input', value: p.name || '' });
      const idInput = U.el('input', { class: 'input', value: p.id || '' });
      const birthInput = U.el("input", { class: "input", type: "date", value: U.fmtDate(p.birth) });
      const sexSel = U.el('select', { class: 'input' },
        [['', '未知'], ['M', '男'], ['F', '女'], ['O', '其它']].map(([v, t]) => U.el('option', { value: v, text: t, selected: v === (p.sex || '') ? '' : null })));
      const charsetSel = U.el('select', { class: 'input' },
        CHARSETS.map(([v, t]) => U.el('option', { value: v, text: t, selected: v === group.charsetLabel ? '' : null })));

      let nameDirty = false;
      nameInput.addEventListener('input', () => { nameDirty = true; });
      charsetSel.addEventListener('change', () => {
        const label = charsetSel.value === '' ? group.pnDs.guessCharset() : charsetSel.value;
        group.charsetLabel = label;
        if (!nameDirty) nameInput.value = U.fmtPN(group.pnDs.strWith(TAG.PatientName, label));
        renderMatchHint();
      });

      // 动态匹配提示: ID 匹配 → 合并提示; 未匹配但同名 → 询问是否采用库中患者
      const matchHint = U.el('div');
      function renderMatchHint() {
        matchHint.innerHTML = '';
        if (!existing) return;
        const name = nameInput.value.trim();
        const idLow = idInput.value.trim().toLowerCase();
        const byId = idLow !== '' ? existing.find((ep) => String(ep.id || '').trim().toLowerCase() === idLow) : null;
        const byNb = !byId && idLow === '' && name
          ? existing.find((ep) => (ep.name || '').trim() === name && (ep.birth || '') === birthInput.value.replace(/\D/g, ''))
          : null;
        const hit = byId || byNb;
        if (hit) {
          matched = hit;
          matchHint.appendChild(U.el('div', {
            class: 'warn-box',
            html: '数据库中已存在该患者:<b>' + U.esc(hit.name) + '</b>(ID ' + U.esc(hit.id || '无') + ',' + U.esc(U.fmtDate(hit.birth)) + '),本次检查将合并到该患者。'
          }));
          return;
        }
        matched = null;
        if (!name) return;
        const cands = existing.filter((ep) => (ep.name || '').trim() === name);
        if (!cands.length) return;
        cands.slice(0, 3).forEach((ep) => {
          const adopt = () => {
            idInput.value = ep.id || '';
            birthInput.value = U.fmtDate(ep.birth);
            sexSel.value = ep.sex || '';
            renderMatchHint();
            U.toast('已采用库中患者信息,本次检查将合并到该患者', 'ok');
          };
          matchHint.appendChild(U.el('div', {
            class: 'info-box',
            style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }
          }, [
            U.el('span', {
              html: '已录入同名患者 <b>' + U.esc(ep.name) + '</b>' +
                (ep.id ? ' · ID ' + U.esc(ep.id) : ' · 无ID') +
                (ep.birth ? ' · ' + U.esc(U.fmtDate(ep.birth)) : '') +
                ' —— 是同一人吗?'
            }),
            U.el('button', { class: 'btn sm primary', text: '采用该患者信息', onclick: adopt })
          ]));
        });
      }
      const hintRefresh = U.debounce(renderMatchHint, 250);
      nameInput.addEventListener('input', hintRefresh);
      idInput.addEventListener('input', hintRefresh);

      const body = [];
      body.push(U.el('div', {
        class: 'info-box',
        html: '第 <b>' + gi + '/' + gn + '</b> 组 · 解析到 <b>' + group.studies.size + '</b> 个检查、<b>' + totalInstances + '</b> 个文件' +
          (group.charsetDeclared ? '' : '<br>文件未声明字符集,已自动识别为「' + (CHARSETS.find(c => c[0] === group.charsetLabel) || ['', 'Latin'])[1] + '」,若姓名乱码请切换')
      }));

      if (matched) {
        nameInput.value = matched.name || '';
        idInput.value = matched.id || '';
        birthInput.value = U.fmtDate(matched.birth);
        sexSel.value = matched.sex || '';
      }
      body.push(matchHint);
      renderMatchHint();

      body.push(U.el('div', { class: 'field' }, [U.el('label', { text: '患者姓名' }), nameInput]));
      body.push(U.el('div', { class: 'grid3' }, [
        U.el('div', { class: 'field' }, [U.el('label', { text: '患者ID' }), idInput]),
        U.el('div', { class: 'field' }, [U.el('label', { text: '出生日期' }), birthInput]),
        U.el('div', { class: 'field' }, [U.el('label', { text: '性别' }), sexSel])
      ]));
      if (!group.charsetDeclared) {
        body.push(U.el('div', { class: 'field' }, [U.el('label', { text: '字符集(仅影响姓名解码,当前值可直接改)' }), charsetSel]));
      }

      body.push(U.el('div', { style: { fontWeight: 600, margin: '14px 0 2px' }, text: '本次导入的检查' }));

      const skipStudies = new Set();
      group.studies.forEach((st) => {
        const seriesCount = st.series.size;
        const instCount = Array.from(st.series.values()).reduce((m, se) => m + se.items.length, 0);
        const mods = Array.from(new Set(Array.from(st.series.values()).map(se => se.modality).filter(Boolean)));
        const exists = existingStudyUids.has(st.uid);
        const descInput = U.el('input', { class: 'input', value: st.desc, style: { flex: 1, minWidth: '110px' } });
        const dateInput = U.el('input', { class: 'input', value: U.fmtDate(st.date), style: { width: '120px' }, placeholder: 'YYYY-MM-DD' });
        const skip = U.el('input', { type: 'checkbox' });
        if (exists) {
          // 默认合并(重复图像按 SOP 自动去重); 勾选则本次跳过
          skip.addEventListener('change', () => { if (skip.checked) skipStudies.add(st.uid); else skipStudies.delete(st.uid); });
        }
        const card = U.el('div', { class: 'plan-study' }, [
          U.el('div', { class: 'head' }, [
            descInput, dateInput,
            mods.map(m => U.el('span', { class: 'badge ' + (m || '').toLowerCase(), text: m })).filter(x => x)
          ]),
          U.el('div', { class: 'muted', style: { fontSize: '12.5px' }, text: seriesCount + ' 个序列 · ' + instCount + ' 幅图像' }),
          exists ? U.el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', fontSize: '13px', color: 'var(--muted)' } }, [
            skip, U.el('span', { text: '该检查已存在,默认合并(重复图像自动去重);勾选则本次跳过' })
          ]) : null
        ]);
        st._descInput = descInput;
        st._dateInput = dateInput;
        body.push(card);
      });

      const done = (action) => {
        if (action === 'ok') {
          p.name = nameInput.value.trim();
          p.id = idInput.value.trim();
          p.birth = birthInput.value.replace(/\D/g, '');
          p.sex = sexSel.value;
          group.studies.forEach((st) => {
            st.desc = (st._descInput ? st._descInput.value : st.desc).trim() || st.desc;
            st.date = (st._dateInput ? st._dateInput.value : st.date).replace(/\D/g, '') || st.date;
          });
        }
        overlay.remove();
        resolve({ action, patient: p, skipStudies });
      };

      const btnPreview = U.el('button', { class: 'btn', text: '仅预览(不入库)', onclick: () => done('preview') });
      const btnCancel = U.el('button', { class: 'btn', text: '取消', onclick: () => done('cancel') });
      const btnOk = U.el('button', { class: 'btn primary', text: server ? '确认导入' : '确认(本地模式)', onclick: () => done('ok') });

      const overlay = U.el('div', { class: 'modal-overlay' }, [
        U.el('div', { class: 'modal wide' }, [
          U.el('div', { class: 'modal-title', text: '确认患者信息(入库前可修改)' }),
          U.el('div', { class: 'modal-body' }, body),
          U.el('div', { class: 'modal-btns' }, [btnPreview, btnCancel, btnOk])
        ])
      ]);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done('cancel'); });
      document.body.appendChild(overlay);
      setTimeout(() => nameInput.focus(), 30);
    });
  }

  /* ---------- 执行导入 ---------- */
  async function doImport(group, r, batch, server) {
    if (!server) { U.toast('当前为本地模式,数据未保存到服务器', 'error'); return false; }
    const toUpload = [];
    group.studies.forEach((st) => {
      if (r.skipStudies.has(st.uid)) return;
      st.series.forEach((se) => se.items.forEach((it) => { if (it.blob) toUpload.push(it); }));
    });

    const prog = showProgress('正在上传…');
    let localBatch = null;
    try {
      // 本地文件使用独立批次(每组一批,避免上一组 commit 清理批次影响后续组)
      if (toUpload.length) {
        localBatch = (await MV.api.tmpbegin()).batch;
      }

      // 分批: 普通文件每批 ≤24 个且 ≤32MB 批量上传; 超大单文件(>24MB)走 8MB 分块通道
      const MAX_ITEMS = 24, MAX_BYTES = 32 * 1024 * 1024, BIG = 24 * 1024 * 1024, CONCURRENCY = 3;
      const bigItems = toUpload.filter((it) => (it.blob.size || 0) > BIG);
      const normalItems = toUpload.filter((it) => (it.blob.size || 0) <= BIG);
      const batches = [];
      let cur = [], curBytes = 0;
      for (const it of normalItems) {
        const sz = it.blob.size || 0;
        if (cur.length && (cur.length >= MAX_ITEMS || curBytes + sz > MAX_BYTES)) {
          batches.push(cur); cur = []; curBytes = 0;
        }
        cur.push(it); curBytes += sz;
      }
      if (cur.length) batches.push(cur);

      let uploaded = 0, uploadedBytes = 0, batchModeFailed = false;
      const totalBytes = toUpload.reduce((n, it) => n + (it.blob.size || 0), 0);
      const t0 = Date.now();
      const tickProgress = (extraBytes) => {
        const doneB = uploadedBytes + (extraBytes || 0);
        const secs = Math.max(0.1, (Date.now() - t0) / 1000);
        const mbps = doneB / 1048576 / secs;
        const eta = doneB > 0 ? (totalBytes - doneB) / (doneB / secs) : Infinity;
        prog.update(doneB / totalBytes,
          '上传 ' + uploaded + '/' + toUpload.length + ' 个文件 · 平均 ' + mbps.toFixed(1) + ' MB/s · ' +
          (doneB / 1048576).toFixed(0) + '/' + (totalBytes / 1048576).toFixed(0) + ' MB · 预计剩余 ' + fmtEta(eta));
      };
      // 超大文件: 串行分块(服务器端顺序追加)
      for (const it of bigItems) {
        const r = await MV.api.uploadChunked(localBatch, it.blob, it.name || 'bigfile.dcm', 'file',
          (p) => {
            const doneB = uploadedBytes + p * (it.blob.size || 0);
            const secs = Math.max(0.1, (Date.now() - t0) / 1000);
            const eta = doneB > 0 ? (totalBytes - doneB) / (doneB / secs) : Infinity;
            prog.update(doneB / totalBytes,
              '大文件分块 ' + Math.round(p * 100) + '% · ' + (it.name || '') +
              ' · 平均 ' + (doneB / 1048576 / secs).toFixed(1) + ' MB/s · 预计剩余 ' + fmtEta(eta));
          });
        const f = r.files[0];
        it.stagedId = f.id;
        it.stagedBatch = r.finalBatch || localBatch;   // 分块重启可能换批, 以实际批次为准
        uploaded++; uploadedBytes += it.blob.size || 0;
        tickProgress();
      }
      await U.runPool(batches, CONCURRENCY, async (b) => {
        const batchBytes = b.reduce((n, it) => n + (it.blob.size || 0), 0);
        const runSingle = async () => {
          for (const it of b) {
            const r = await MV.api.uploadFile(localBatch, it.blob, it.name);
            it.stagedId = r.id; it.stagedBatch = localBatch;
            uploaded++; uploadedBytes += it.blob.size || 0;
          }
        };
        if (!batchModeFailed) {
          try {
            const res = await MV.api.uploadFiles(localBatch, b.map((it) => ({ blob: it.blob, name: it.name })));
            res.files.forEach((r, k) => {
              b[k].stagedId = r.id;
              b[k].stagedBatch = localBatch;
            });
            uploaded += b.length;
            uploadedBytes += batchBytes;
          } catch (e) {
            // 批量可能超出 post_max_size → 自动降级为逐个上传
            batchModeFailed = true;
            U.toast('批量上传受限(' + e.message + '),已改为逐个上传;建议在 Web Station PHP 设置中调大 post_max_size', 'info', 6000);
            await runSingle();
          }
        } else {
          await runSingle();
        }
        tickProgress();
      });
      prog.update(1, '写入数据库…');

      const payload = {
        patient: group.patient,
        studies: []
      };
      group.studies.forEach((st) => {
        if (r.skipStudies.has(st.uid)) return;
        const series = [];
        st.series.forEach((se) => {
          series.push({
            uid: se.uid, number: se.number, desc: se.desc, modality: se.modality,
            files: se.items.map((it) => ({ batch: it.stagedBatch, id: it.stagedId, sop: it.sop, no: it.no, frames: it.frames }))
          });
        });
        payload.studies.push({ uid: st.uid, date: st.date, desc: st.desc, accession: st.accession, series });
      });

      if (!payload.studies.length) {
        prog.close();
        U.toast('该患者的检查均已存在于数据库,未重复导入', 'info');
        return true;
      }

      const res = await MV.api.post('commit', null, payload);
      U.toast('已入库:新增 ' + res.added + ' 幅' + (res.dups ? ',跳过重复 ' + res.dups + ' 幅' : '') +
        (res.studiesMerged ? ',合并检查 ' + res.studiesMerged : '') +
        (res.transferredFrom ? ',检查已从「' + res.transferredFrom + '」转移至本患者' : '') +
        (res.missing ? ',⚠ 缺失 ' + res.missing + ' 幅(建议重新导入)' : ''), res.missing ? 'error' : 'ok', res.missing ? 8000 : 3500);
      return true;
    } catch (e) {
      U.toast('导入失败: ' + e.message, 'error', 5000);
      return false;
    } finally {
      prog.close();
    }
  }

  /** 由组构建本地预览用的 study 对象 */
  function groupToLocalStudy(group, batch) {
    const series = [];
    let firstStudy = null;
    group.studies.forEach((st) => {
      if (!firstStudy) firstStudy = st;
      st.series.forEach((se) => {
        const files = se.items.map((it) => ({
          sop: it.sop, instNo: it.no, frames: it.frames,
          blob: it.blob || null, stagedId: it.stagedId || null,
          getBytes: async function () {
            if (this.blob) return new Uint8Array(await this.blob.arrayBuffer());
            return MV.api.tmpMeta(batch, this.stagedId, 32 * 1024 * 1024);
          }
        }));
        series.push({ uid: se.uid, number: se.number, desc: se.desc, modality: se.modality, files });
      });
    });
    return {
      patient: group.patient,
      study: { desc: firstStudy ? firstStudy.desc : '本地预览', series }
    };
  }

  MV.import = {
    // 兜底: 无论流程如何结束, 关闭所有遗留的进度弹窗
    start: async function (files) {
      try { await start(files); }
      finally { activeProgress.slice().forEach((p) => p.close()); }
    },
    showProgress
  };
})();

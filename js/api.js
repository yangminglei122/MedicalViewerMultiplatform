/* MV.api — PHP 后端客户端 */
(function () {
  'use strict';
  window.MV = window.MV || {};
  const U = MV.U;

  const A = {
    serverMode: null,   // null=未探测 true/false
    auth: false,
    needLogin: false,

    base: function () {
      // api.php 与页面同目录
      return 'api.php';
    },

    async init() {
      try {
        const r = await fetch(this.base() + '?action=ping', { credentials: 'same-origin' });
        if (r.status === 401) { this.serverMode = true; this.needLogin = true; return false; }
        const j = await r.json();
        this.serverMode = !!(j && j.server);
        this.auth = !!(j && j.auth);
        this.user = (j && j.user) || null;
        this.role = (j && j.role) || null;
        this.canExport = !!(j && j.canExport);
        this.needLogin = this.serverMode && this.auth && !this.user;
        return this.serverMode;
      } catch (e) {
        this.serverMode = false;
        return false;
      }
    },

    async login(user, pass) {
      const r = await this.post('login', null, { user, pass });
      if (r && r.ok) {
        this.needLogin = false;
        this.user = r.user || user;
        this.role = r.role || 'user';
        this.canExport = (this.role === 'admin') ? true : !!r.canExport;
        return r;
      }
      return r;
    },

    async logout() {
      try { await this.post('logout', null, {}); } catch (e) { }
      this.user = null; this.role = null; this.needLogin = true;
    },

    accountsList() { return this.get('accounts-list'); },
    accountAdd(name, pass, days, note, canExport) { return this.post('account-add', null, { name, pass, days, note, canExport: canExport ? 1 : 0 }); },
    accountDel(name) { return this.post('account-del', null, { name }); },
    accountSetPass(name, pass) { return this.post('account-setpass', null, { name, pass }); },
    accountRenew(name, days) { return this.post('account-renew', null, { name, days }); },

    url(action, params) {
      let u = this.base() + '?action=' + encodeURIComponent(action);
      if (params) for (const k in params) if (params[k] != null) u += '&' + k + '=' + encodeURIComponent(params[k]);
      return u;
    },

    async get(action, params) {
      const r = await fetch(this.url(action, params), { credentials: 'same-origin' });
      if (r.status === 401) { this.needLogin = true; throw new Error('需要登录'); }
      const j = await r.json().catch(() => { throw new Error('服务器响应异常'); });
      if (j && j.error) throw new Error(j.error);
      return j;
    },

    async post(action, params, body) {
      const r = await fetch(this.url(action, params), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-MV': '1' },
        body: JSON.stringify(body || {})
      });
      if (r.status === 401) { this.needLogin = true; throw new Error('需要登录'); }
      const j = await r.json().catch(() => { throw new Error('服务器响应异常'); });
      if (j && j.error) throw new Error(j.error);
      return j;
    },

    fileUrl(f) {
      return this.url('file', { pd: f.pd, st: f.st, se: f.se, f: f.f });
    },
    exportStudyUrl(sid) { return this.url('export', { sid }); },
    exportPatientUrl(dir) { return this.url('export', { dir }); },

    async tmpbegin() { return this.post('tmpbegin'); },

    /** 单文件上传(带进度), 返回 {id,name,size} */
    uploadFile(batch, blob, name, onProgress) {
      return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('batch', batch);
        fd.append('name', name || 'file.dcm');
        fd.append('file', blob, name || 'file.dcm');
        U.xhrProgress(this.url('tmpfile'), { method: 'POST', body: fd, headers: { 'X-MV': '1' } }, onProgress)
          .then((xhr) => {
            try {
              const j = JSON.parse(xhr.responseText);
              if (j.error) reject(new Error(j.error));
              else resolve(j.files ? j.files[0] : j);
            } catch (e) { reject(new Error('上传响应异常')); }
          })
          .catch(reject);
      });
    },

    /** 批量上传: items = [{blob, name}], 返回 {files:[{id,name,size}]} */
    uploadFiles(batch, items, onProgress) {
      return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('batch', batch);
        items.forEach((it, i) => {
          fd.append('names[]', it.name || ('file' + i + '.dcm'));
          fd.append('files[]', it.blob, it.name || ('file' + i + '.dcm'));
        });
        U.xhrProgress(this.url('tmpfile'), { method: 'POST', body: fd, headers: { 'X-MV': '1' } }, onProgress)
          .then((xhr) => {
            try {
              const j = JSON.parse(xhr.responseText);
              if (j.error) reject(new Error(j.error));
              else resolve(j);
            } catch (e) { reject(new Error('上传响应异常')); }
          })
          .catch(reject);
      });
    },

    /** 单块发送(失败抛错) */
    _sendChunk(batch, chunk, name, kind, i, total, onChunkProgress) {
      return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('batch', batch);
        fd.append('kind', kind);
        fd.append('name', name || 'upload');
        fd.append('index', i);
        fd.append('total', total);
        fd.append('cs', chunk.size);
        fd.append('chunk', chunk, 'chunk.bin');
        U.xhrProgress(this.url('chunk'), { method: 'POST', body: fd, headers: { 'X-MV': '1' } },
          onChunkProgress || (() => { }))
          .then((xhr) => {
            try {
              const j = JSON.parse(xhr.responseText);
              if (j.error) reject(new Error(j.error));
              else resolve(j);
            } catch (e) { reject(new Error('上传响应异常')); }
          })
          .catch(reject);
      });
    },

    /** 分块上传大文件(8MB/块): 失败自动重试; 批次丢失自动换批重传整个文件 */
    async uploadChunked(batch, blob, name, kind, onProgress) {
      const CHUNK = 8 * 1024 * 1024;
      const total = Math.max(1, Math.ceil(blob.size / CHUNK));
      const maxTry = 5;
      let curBatch = batch;
      let result = null;
      let attempt = 0;   // 当前块的重试次数
      let restarts = 0;  // 整文件换批重传次数(防极端死循环)
      const maxRestarts = 3;

      for (let i = 0; i < total; ) {
        const chunk = blob.slice(i * CHUNK, Math.min((i + 1) * CHUNK, blob.size));
        try {
          result = await this._sendChunk(curBatch, chunk, name, kind, i, total,
            onProgress ? (p) => onProgress((i + p) / total) : null);
          if (i === total - 1 && !(result && Array.isArray(result.files))) {
            // 末块未返回文件清单(重试命中幂等分支/组装失败) → 换批重传整文件
            throw new Error('末块未完成组装');
          }
          i++;
          attempt = 0;
          if (onProgress) onProgress(i / total);
        } catch (e) {
          const msg = e && e.message || '';
          const needRestart = /批次不存在|乱序|不完整|末块未完成组装|不是有效的 ZIP|ZIP 中未找到/.test(msg) ||
            (i === total - 1 && attempt >= 1);   // 末块失败重试一次仍败 → 整文件重传
          if (needRestart) {
            if (++restarts > maxRestarts) throw e;
            try { curBatch = (await this.tmpbegin()).batch; } catch (e2) { throw e; }
            i = 0; attempt = 0;
            continue;
          }
          attempt++;
          if (attempt >= maxTry) throw e;
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      if (result) result.finalBatch = curBatch;   // 回报实际落盘批次(内部重启可能已换批)
      return result;
    },

    /** ZIP 上传并服务器端解压(大文件自动走分块) */
    async uploadZipSmart(batch, blob, name, onProgress) {
      if (blob.size > 16 * 1024 * 1024) {
        return this.uploadChunked(batch, blob, name, 'zip', onProgress);
      }
      return this.uploadZip(batch, blob, name, onProgress);
    },
    uploadZip(batch, blob, name, onProgress) {
      return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('batch', batch);
        fd.append('file', blob, name || 'upload.zip');
        U.xhrProgress(this.url('tmpzip'), { method: 'POST', body: fd, headers: { 'X-MV': '1' } }, onProgress)
          .then((xhr) => {
            try {
              const j = JSON.parse(xhr.responseText);
              if (j.error) reject(new Error(j.error));
              else resolve(j);
            } catch (e) { reject(new Error('上传响应异常')); }
          })
          .catch(reject);
      });
    },

    async tmpMeta(batch, id, len) {
      const r = await fetch(this.url('tmpmeta', { batch, id, len }), { credentials: 'same-origin' });
      if (!r.ok) throw new Error('读取暂存文件失败');
      return new Uint8Array(await r.arrayBuffer());
    }
  };

  MV.api = A;
})();

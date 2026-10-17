// =====================================================================
// MỤC "CÔNG VIỆC" – 4 phần: Kỹ thuật · Mật khẩu · Tài liệu · Lịch năm
// File này được index.html nạp khi bạn mở mục Công việc lần đầu.
// Cần chạy supabase/work_schema.sql trước (tạo bảng + kho chứa file).
// =====================================================================
const BUCKET = 'work-files';
const MAX_FILE = 50 * 1024 * 1024;            // 50 MB / file (khớp giới hạn của kho chứa)
const IDLE_LOCK_MS = 5 * 60 * 1000;           // tự khóa két sau 5 phút không thao tác
const REVEAL_MS = 15 * 1000;                  // mật khẩu đang hiện tự ẩn lại sau 15 giây
const PBKDF2_ITER = 600000;                   // độ "nặng" khi sinh khóa từ mật khẩu két

let C = null;                                 // { sb, getUser, toast, esc, setStatus }
let built = false, activeTab = 'tech';
const $ = (id) => document.getElementById(id);
const esc = (s) => C.esc(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const must = (r) => { if (r.error) throw r.error; return r.data; };
const user = () => C.getUser();
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const todayStr = () => ymd(new Date());
const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const fmtDate = (iso) => { const d = new Date(iso); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); };
const dmy = (s) => { const p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; };
const DOW_LONG = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

async function track(fn) {
  C.setStatus('saving');
  try { return await fn(); } finally { C.setStatus('ok'); }
}
function fail(e) {
  let msg = (e && e.message) ? e.message : String(e);
  if (/relation .* does not exist|schema cache|Could not find the table/i.test(msg)) msg = 'Chưa tạo bảng dữ liệu. Hãy chạy file supabase/work_schema.sql trong Supabase.';
  else if (/Bucket not found/i.test(msg)) msg = 'Chưa có kho chứa file. Hãy chạy file supabase/work_schema.sql trong Supabase.';
  else if (/row-level security|permission denied|not authorized|violates row/i.test(msg)) msg = 'Không có quyền ghi. Hãy chắc là đã chạy file supabase/work_schema.sql.';
  C.toast(msg, true);
}

/* ---------------------------------------------------------------------
   Cửa sổ dùng chung (hộp thoại, xác nhận, xem ảnh lớn)
--------------------------------------------------------------------- */
let dlgClose = null;
function openDlg(html, opts) {
  const m = $('wmDlg');
  const sh0 = m.querySelector('.sheet'); sh0.onclick = sh0.onchange = sh0.onkeydown = null;
  m.querySelector('.sheet').className = 'sheet' + (opts && opts.wide ? ' wm-wide' : '');
  m.querySelector('.sheet').innerHTML = html;
  m.classList.add('on'); document.body.classList.add('lock');
  dlgClose = (opts && opts.onClose) || null;
  const first = m.querySelector('[data-autofocus]');
  if (first) setTimeout(() => first.focus(), 80);
}
function closeDlg() {
  const m = $('wmDlg');
  if (!m.classList.contains('on')) return;
  m.classList.remove('on');
  if (!document.querySelector('.modal.on')) document.body.classList.remove('lock');
  const f = dlgClose; dlgClose = null; if (f) f();
}
function askConfirm(text, okLabel) {
  return new Promise((resolve) => {
    const m = $('wmAsk');
    m.querySelector('.wm-ask-t').textContent = text;
    m.querySelector('[data-ok]').textContent = okLabel || 'Xóa';
    m.classList.add('on'); document.body.classList.add('lock');
    const done = (v) => {
      m.classList.remove('on'); m.onclick = null;
      if (!document.querySelector('.modal.on')) document.body.classList.remove('lock');
      resolve(v);
    };
    m.onclick = (e) => {
      if (e.target.closest('[data-ok]')) done(true);
      else if (e.target.closest('[data-no]') || e.target === m) done(false);
    };
  });
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((res, rej) => {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy') ? res() : rej(new Error('copy')); } catch (e) { rej(e); } finally { t.remove(); }
  });
}

/* ---------------------------------------------------------------------
   Kho ảnh/file riêng tư: đường dẫn ký tạm thời (signed URL)
--------------------------------------------------------------------- */
const urlCache = new Map();                     // path -> { url, exp }
async function signedMany(paths) {
  const now = Date.now(), need = [];
  paths.forEach((p) => { const c = urlCache.get(p); if (!c || c.exp < now + 60000) need.push(p); });
  if (need.length) {
    const r = await C.sb.storage.from(BUCKET).createSignedUrls(need, 3600);
    if (r.error) throw r.error;
    (r.data || []).forEach((x) => { if (x && x.signedUrl && !x.error) urlCache.set(x.path, { url: x.signedUrl, exp: now + 3500 * 1000 }); });
  }
  const out = {}; paths.forEach((p) => { const c = urlCache.get(p); out[p] = c ? c.url : ''; });
  return out;
}
async function signedOne(path, opts) {
  const r = await C.sb.storage.from(BUCKET).createSignedUrl(path, 120, opts);
  if (r.error) throw r.error;
  return r.data.signedUrl;
}
async function removeFiles(paths) {
  if (!paths.length) return;
  const r = await C.sb.storage.from(BUCKET).remove(paths);
  if (r.error) console.warn('Không xóa được file trên kho:', r.error.message);
  paths.forEach((p) => urlCache.delete(p));
}

/* ---------------------------------------------------------------------
   Khung chính + chuyển phần
--------------------------------------------------------------------- */
const TABS = [['tech', 'Kỹ thuật'], ['vault', 'Mật khẩu'], ['docs', 'Tài liệu'], ['cal', 'Lịch năm']];

function build() {
  $('work').innerHTML =
    '<div class="wm-tabs seg" id="wmTabs">' + TABS.map((t) => '<button type="button" data-t="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>' +
    TABS.map((t) => '<section class="wm-panel hidden" id="wm-' + t[0] + '"></section>').join('');
  if (!$('wmDlg')) {
    document.body.insertAdjacentHTML('beforeend',
      '<div class="modal wm-modal" id="wmDlg"><div class="sheet"></div></div>' +
      '<div class="modal wm-modal wm-askm" id="wmAsk"><div class="sheet wm-asksheet"><div class="wm-ask-t"></div>' +
      '<div class="twin"><button class="btn" data-no type="button">Hủy</button><button class="btn danger" data-ok type="button">Xóa</button></div></div></div>' +
      '<div class="wm-light" id="wmLight"><button class="wm-lx" type="button" aria-label="Đóng" data-x>✕</button>' +
      '<button class="wm-ln wm-lp" type="button" aria-label="Ảnh trước" data-p>‹</button><img alt=""><button class="wm-ln wm-lnx" type="button" aria-label="Ảnh sau" data-n>›</button></div>');
    $('wmDlg').addEventListener('mousedown', (e) => { if (e.target === $('wmDlg')) closeDlg(); });
    bindLight();
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('wmLight').classList.contains('on')) closeLight(); else closeDlg();
    });
  }
  $('wmTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchTab(b.getAttribute('data-t')); });
  initTech(); initVault(); initDocs(); initCal();
  built = true;
}

function switchTab(t) {
  activeTab = t;
  try { localStorage.setItem('work_tab', t); } catch (e) {}
  Array.prototype.forEach.call($('wmTabs').children, (b) => b.classList.toggle('on', b.getAttribute('data-t') === t));
  TABS.forEach((x) => $('wm-' + x[0]).classList.toggle('hidden', x[0] !== t));
  if (t === 'tech') loadTech(); else if (t === 'vault') openVault(); else if (t === 'docs') loadDocs(); else loadCal();
}

export function initWork(ctx) { C = ctx; }
export function openWork() {
  if (!built) build();
  let t = 'tech'; try { t = localStorage.getItem('work_tab') || 'tech'; } catch (e) {}
  if (!TABS.some((x) => x[0] === t)) t = 'tech';
  switchTab(t);
}
export function leaveWork() { closeDlg(); closeLight(); lockVault(true); }

/* =====================================================================
   1) KỸ THUẬT – linh kiện, chức năng, cách sửa, ảnh
===================================================================== */
const T = { loaded: false, rows: [], q: '', tag: '' };
let E = null;                                    // trạng thái form đang sửa

function initTech() {
  $('wm-tech').innerHTML =
    '<div class="wm-bar"><div class="wm-search"><input id="tQ" type="search" placeholder="Tìm tên linh kiện, chức năng, cách sửa…" autocomplete="off"></div>' +
    '<button class="btn primary" id="tAdd" type="button">＋ Thêm mục</button></div>' +
    '<div class="chips wm-tags" id="tTags"></div><div class="wm-grid" id="tGrid"></div><div class="wm-empty hidden" id="tEmpty"></div>';
  $('tQ').addEventListener('input', () => { T.q = $('tQ').value.trim().toLowerCase(); renderTech(); });
  $('tAdd').onclick = () => editTech(null);
  $('tTags').addEventListener('click', (e) => { const b = e.target.closest('[data-tag]'); if (!b) return; T.tag = T.tag === b.getAttribute('data-tag') ? '' : b.getAttribute('data-tag'); renderTech(); });
  $('tGrid').addEventListener('click', (e) => { const c = e.target.closest('[data-id]'); if (c) viewTech(c.getAttribute('data-id')); });
}
async function loadTech() {
  if (T.loaded) { renderTech(); return; }
  $('tGrid').innerHTML = '<div class="sk" style="height:120px"></div><div class="sk" style="height:120px"></div>';
  try {
    T.rows = must(await C.sb.from('tech_notes').select('*').order('updated_at', { ascending: false }));
    T.loaded = true; renderTech();
  } catch (e) { $('tGrid').innerHTML = ''; fail(e); }
}
function allTags() {
  const cnt = {};
  T.rows.forEach((r) => (r.tags || []).forEach((t) => { cnt[t] = (cnt[t] || 0) + 1; }));
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || (a < b ? -1 : 1));
}
function renderTech() {
  const tags = allTags();
  $('tTags').innerHTML = tags.map((t) => '<button type="button" class="chip' + (T.tag === t ? ' on' : '') + '" data-tag="' + esc(t) + '">' + esc(t) + '</button>').join('');
  const rows = T.rows.filter((r) => {
    if (T.tag && (r.tags || []).indexOf(T.tag) < 0) return false;
    if (!T.q) return true;
    return (r.title + ' ' + r.model + ' ' + r.function_text + ' ' + r.repair_text + ' ' + (r.tags || []).join(' ')).toLowerCase().indexOf(T.q) >= 0;
  });
  const empty = $('tEmpty');
  if (!rows.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = T.rows.length ? 'Không có mục nào khớp.' : 'Chưa có ghi chú kỹ thuật nào.<br>Bấm <b>＋ Thêm mục</b> để lưu tên linh kiện, chức năng, ảnh và cách sửa chữa.';
  } else empty.classList.add('hidden');
  $('tGrid').innerHTML = rows.map((r) => {
    const cover = (r.images || [])[0];
    const sub = [r.model, (r.function_text || '').split('\n')[0]].filter(Boolean).join(' · ');
    return '<article class="wm-card wm-note" data-id="' + esc(r.id) + '" tabindex="0">' +
      '<div class="wm-cover">' + (cover ? '<img data-p="' + esc(cover.t || cover.p) + '" alt="" loading="lazy">' : '<span class="wm-noimg">' + GEAR + '</span>') +
      ((r.images || []).length > 1 ? '<i class="wm-count">' + r.images.length + ' ảnh</i>' : '') + '</div>' +
      '<div class="wm-card-b"><h3>' + esc(r.title) + '</h3>' + (sub ? '<p>' + esc(sub) + '</p>' : '') +
      ((r.tags || []).length ? '<div class="wm-tl">' + r.tags.slice(0, 3).map((t) => '<span>' + esc(t) + '</span>').join('') + '</div>' : '') + '</div></article>';
  }).join('');
  fillImgs($('tGrid'));
}
async function fillImgs(root) {
  const imgs = Array.prototype.slice.call(root.querySelectorAll('img[data-p]'));
  if (!imgs.length) return;
  try {
    const urls = await signedMany(Array.from(new Set(imgs.map((i) => i.getAttribute('data-p')))));
    imgs.forEach((i) => { const u = urls[i.getAttribute('data-p')]; if (u) i.src = u; });
  } catch (e) { /* ảnh không tải được thì bỏ qua */ }
}
const GEAR = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>';

function multiline(t) { return esc(t).replace(/\n/g, '<br>'); }
function viewTech(id) {
  const r = T.rows.find((x) => x.id === id); if (!r) return;
  const imgs = r.images || [];
  openDlg('<div class="wm-dh"><h2>' + esc(r.title) + '</h2>' + (r.model ? '<div class="sub">Mã / model: ' + esc(r.model) + '</div>' : '') +
    ((r.tags || []).length ? '<div class="wm-tl wm-tl-big">' + r.tags.map((t) => '<span>' + esc(t) + '</span>').join('') + '</div>' : '') + '</div>' +
    (imgs.length ? '<div class="wm-gal">' + imgs.map((im, i) => '<button type="button" data-i="' + i + '"><img data-p="' + esc(im.t || im.p) + '" alt=""></button>').join('') + '</div>' : '') +
    '<div class="wm-sec"><h4>Chức năng</h4><div class="wm-txt">' + (r.function_text ? multiline(r.function_text) : '<span class="muted">Chưa ghi.</span>') + '</div></div>' +
    '<div class="wm-sec"><h4>Cách sửa chữa</h4><div class="wm-txt">' + (r.repair_text ? multiline(r.repair_text) : '<span class="muted">Chưa ghi.</span>') + '</div></div>' +
    '<div class="hint">Cập nhật ' + fmtDate(r.updated_at) + '</div>' +
    '<div class="twin"><button class="btn danger" data-del type="button">Xóa</button><button class="btn" data-edit type="button">Sửa</button><button class="btn primary" data-close type="button">Đóng</button></div>', { wide: true });
  const sh = $('wmDlg').querySelector('.sheet');
  fillImgs(sh);
  sh.onclick = async (e) => {
    const g = e.target.closest('.wm-gal button');
    if (g) { openLight(imgs, Number(g.getAttribute('data-i'))); return; }
    if (e.target.closest('[data-close]')) closeDlg();
    else if (e.target.closest('[data-edit]')) editTech(r.id);
    else if (e.target.closest('[data-del]')) {
      if (!(await askConfirm('Xóa "' + r.title + '" cùng toàn bộ ảnh? Không thể hoàn tác.'))) return;
      try {
        await track(async () => {
          await removeFiles(imgs.reduce((a, im) => a.concat([im.p, im.t].filter(Boolean)), []));
          must(await C.sb.from('tech_notes').delete().eq('id', r.id));
        });
        T.rows = T.rows.filter((x) => x.id !== r.id); closeDlg(); renderTech(); C.toast('Đã xóa');
      } catch (er) { fail(er); }
    }
  };
}

/* ---- xử lý ảnh: thu nhỏ trước khi tải lên cho nhẹ và nhanh ---- */
async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
  }
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { res(im); URL.revokeObjectURL(u); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Không đọc được ảnh')); };
    im.src = u;
  });
}
function toJpeg(bmp, max, q) {
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight, k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Không nén được ảnh'))), 'image/jpeg', q));
}
async function prepImage(file) {
  const bmp = await loadBitmap(file);
  const full = await toJpeg(bmp, 1600, 0.82), thumb = await toJpeg(bmp, 420, 0.75);
  if (bmp.close) bmp.close();
  return { isNew: true, full, thumb, preview: URL.createObjectURL(thumb) };
}

function editTech(id) {
  const r = id ? T.rows.find((x) => x.id === id) : null;
  E = { id: id, images: ((r && r.images) || []).map((im) => ({ isNew: false, p: im.p, t: im.t })), removed: [], busy: false };
  openDlg('<h2>' + (r ? 'Sửa mục kỹ thuật' : 'Thêm mục kỹ thuật') + '</h2>' +
    '<div class="field"><label for="eTitle2">Tên linh kiện / thiết bị *</label><input id="eTitle2" data-autofocus maxlength="200" placeholder="vd: Tụ lọc nguồn 470µF, Máy hàn khò 858D"></div>' +
    '<div class="field"><label for="eModel">Mã / model (nếu có)</label><input id="eModel" maxlength="200" placeholder="vd: C1203, Samsung SM-A52"></div>' +
    '<div class="field"><label for="eTags">Thẻ phân loại (cách nhau bằng dấu phẩy)</label><input id="eTags" placeholder="vd: nguồn, mainboard, máy in">' +
    '<div class="chips" id="eTagSug"></div></div>' +
    '<div class="field"><label for="eFn">Chức năng</label><textarea id="eFn" rows="3" placeholder="Linh kiện này dùng để làm gì…"></textarea></div>' +
    '<div class="field"><label for="eRepair">Cách sửa chữa</label><textarea id="eRepair" rows="6" placeholder="Triệu chứng, nguyên nhân, các bước xử lý…"></textarea></div>' +
    '<div class="field"><label>Ảnh</label><div class="wm-photos" id="ePhotos"></div>' +
    '<input type="file" id="eFile" accept="image/*" multiple hidden></div>' +
    '<div class="prev bad" id="eErr"></div>' +
    '<div class="twin"><button class="btn" data-cancel type="button">Hủy</button><button class="btn primary" data-save type="button">Lưu</button></div>', { wide: true, onClose: () => { releasePreviews(); E = null; } });
  $('eTitle2').value = r ? r.title : ''; $('eModel').value = r ? r.model : '';
  $('eTags').value = r ? (r.tags || []).join(', ') : '';
  $('eFn').value = r ? r.function_text : ''; $('eRepair').value = r ? r.repair_text : '';
  $('eTagSug').innerHTML = allTags().slice(0, 10).map((t) => '<button type="button" class="chip" data-tg="' + esc(t) + '">' + esc(t) + '</button>').join('');
  renderPhotos();
  const sh = $('wmDlg').querySelector('.sheet');
  $('eFile').onchange = async () => {
    const files = Array.prototype.slice.call($('eFile').files); $('eFile').value = '';
    for (const f of files) {
      if (!E) return;
      if (!/^image\//.test(f.type)) { C.toast('"' + f.name + '" không phải ảnh', true); continue; }
      try { const im = await prepImage(f); if (!E) { URL.revokeObjectURL(im.preview); return; } E.images.push(im); renderPhotos(); } catch (er) { C.toast('Không đọc được ảnh "' + f.name + '"', true); }
    }
  };
  sh.onclick = (e) => {
    const tg = e.target.closest('[data-tg]');
    if (tg) { const v = $('eTags').value.trim().replace(/,\s*$/, ''); $('eTags').value = v ? v + ', ' + tg.getAttribute('data-tg') : tg.getAttribute('data-tg'); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) { const im = E.images.splice(Number(rm.getAttribute('data-rm')), 1)[0]; if (im.isNew) URL.revokeObjectURL(im.preview); else E.removed.push(im.p, im.t); renderPhotos(); return; }
    if (e.target.closest('[data-addph]')) { $('eFile').click(); return; }
    if (e.target.closest('[data-cancel]')) closeDlg();
    else if (e.target.closest('[data-save]')) saveTech(r);
  };
}
function releasePreviews() { if (E) E.images.forEach((im) => { if (im.isNew) URL.revokeObjectURL(im.preview); }); }
function renderPhotos() {
  $('ePhotos').innerHTML = E.images.map((im, i) => '<div class="wm-ph"><img ' + (im.isNew ? 'src="' + im.preview + '"' : 'data-p="' + esc(im.t || im.p) + '"') + ' alt=""><button type="button" data-rm="' + i + '" aria-label="Bỏ ảnh">✕</button></div>').join('') +
    '<button type="button" class="wm-addph" data-addph><span>＋</span>Thêm ảnh</button>';
  fillImgs($('ePhotos'));
}
async function saveTech(old) {
  if (E.busy) return;
  const title = $('eTitle2').value.trim();
  if (!title) { $('eErr').textContent = 'Hãy nhập tên linh kiện / thiết bị.'; $('eTitle2').focus(); return; }
  $('eErr').textContent = ''; E.busy = true;
  const btn = $('wmDlg').querySelector('[data-save]'); btn.disabled = true; btn.textContent = 'Đang lưu…';
  const id = E.id || uid(), uploaded = [];
  try {
    await track(async () => {
      const imgs = [];
      for (const im of E.images) {
        if (!im.isNew) { imgs.push({ p: im.p, t: im.t }); continue; }
        const base = user().id + '/tech/' + id + '/' + uid();
        const p = base + '.jpg', t = base + '_t.jpg';
        let r1 = await C.sb.storage.from(BUCKET).upload(p, im.full, { contentType: 'image/jpeg', upsert: false }); if (r1.error) throw r1.error; uploaded.push(p);
        let r2 = await C.sb.storage.from(BUCKET).upload(t, im.thumb, { contentType: 'image/jpeg', upsert: false }); if (r2.error) throw r2.error; uploaded.push(t);
        imgs.push({ p, t });
      }
      const tags = Array.from(new Set($('eTags').value.split(/[,;]/).map((x) => x.trim()).filter(Boolean)));
      const row = { title, model: $('eModel').value.trim(), tags, function_text: $('eFn').value.trim(), repair_text: $('eRepair').value.trim(), images: imgs, updated_at: new Date().toISOString() };
      let saved;
      if (old) saved = must(await C.sb.from('tech_notes').update(row).eq('id', id).select().single());
      else saved = must(await C.sb.from('tech_notes').insert(Object.assign({ id }, row)).select().single());
      await removeFiles(E.removed.filter(Boolean));
      const i = T.rows.findIndex((x) => x.id === id);
      if (i >= 0) T.rows.splice(i, 1);
      T.rows.unshift(saved);
    });
    closeDlg(); renderTech(); C.toast('Đã lưu');
  } catch (e) {
    await removeFiles(uploaded);
    fail(e); E.busy = false; btn.disabled = false; btn.textContent = 'Lưu';
  }
}

/* ---- xem ảnh lớn ---- */
let lightList = [], lightIdx = 0;
async function openLight(list, i) {
  lightList = list; lightIdx = i; $('wmLight').classList.add('on'); showLight();
}
async function showLight() {
  const im = lightList[lightIdx], box = $('wmLight'), img = box.querySelector('img');
  img.removeAttribute('src');
  box.querySelector('[data-p]').style.display = box.querySelector('[data-n]').style.display = lightList.length > 1 ? '' : 'none';
  try { const u = await signedMany([im.p]); if (box.classList.contains('on')) img.src = u[im.p]; } catch (e) {}
}
function closeLight() { $('wmLight').classList.remove('on'); }
function bindLight() {
  $('wmLight').addEventListener('click', (e) => {
    if (e.target.closest('[data-p]')) { lightIdx = (lightIdx + lightList.length - 1) % lightList.length; showLight(); }
    else if (e.target.closest('[data-n]')) { lightIdx = (lightIdx + 1) % lightList.length; showLight(); }
    else if (e.target.tagName !== 'IMG') closeLight();
  });
}

/* =====================================================================
   2) MẬT KHẨU – két mã hóa ngay trên trình duyệt (AES-GCM + PBKDF2)
===================================================================== */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encObj(key, obj, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decObj(key, iv, ct, aad) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, key, unb64(ct));
  return JSON.parse(dec.decode(pt));
}

const V = { state: 'loading', meta: null, key: null, items: [], q: '', reveal: new Map(), lastAct: 0, timer: null };

function initVault() {
  const p = $('wm-vault');
  p.addEventListener('click', vaultClick);
  p.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target.id; if (f === 'vSetupForm') doSetup(); else if (f === 'vUnlockForm') doUnlock(); });
  p.addEventListener('input', (e) => { if (e.target.id === 'vQ') { V.q = e.target.value.trim().toLowerCase(); renderVaultList(); } touchVault(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') idleCheck(); });
  ['pointerdown', 'keydown'].forEach((ev) => $('work').addEventListener(ev, touchVault, true));
}
function touchVault() { V.lastAct = Date.now(); }
function idleCheck() { if (V.key && Date.now() - V.lastAct > IDLE_LOCK_MS) { lockVault(false); C.toast('Két đã tự khóa do lâu không thao tác'); } }
export function lockVault(silent) {
  V.key = null; V.items = []; V.reveal.forEach((t) => clearTimeout(t)); V.reveal.clear(); V.q = '';
  if (V.timer) { clearInterval(V.timer); V.timer = null; }
  if (built && V.meta) { V.state = 'locked'; if (!silent || activeTab === 'vault') renderVault(); }
}
async function openVault() {
  if (V.key) { renderVault(); return; }
  V.state = 'loading'; renderVault();
  try {
    V.meta = must(await C.sb.from('vault_meta').select('*').maybeSingle());
    V.state = V.meta ? 'locked' : 'setup'; renderVault();
  } catch (e) { fail(e); $('wm-vault').innerHTML = '<div class="wm-empty">Không tải được. Hãy thử lại sau.</div>'; }
}
function renderVault() {
  const p = $('wm-vault');
  if (V.state === 'loading') { p.innerHTML = '<div class="sk" style="height:160px"></div>'; return; }
  if (V.state === 'setup') {
    p.innerHTML = '<div class="card wm-lock"><div class="wm-lockico">' + LOCK + '</div><h2>Tạo mật khẩu két</h2>' +
      '<p class="hint">Mật khẩu của các thiết bị được <b>mã hóa ngay trên máy bạn</b> bằng mật khẩu két này rồi mới lưu lên Supabase, nên không ai đọc được, kể cả khi lộ tài khoản.</p>' +
      '<div class="wm-warn"><b>Rất quan trọng:</b> nếu quên mật khẩu két thì <b>không thể khôi phục</b> dữ liệu trong két. Hãy chọn mật khẩu dễ nhớ nhưng khó đoán (ít nhất 8 ký tự) và ghi ra giấy cất ở nơi an toàn.</div>' +
      '<form id="vSetupForm" autocomplete="off"><div class="field"><label for="vP1">Mật khẩu két</label><input id="vP1" type="password" autocomplete="new-password" data-autofocus></div>' +
      '<div class="field"><label for="vP2">Nhập lại mật khẩu két</label><input id="vP2" type="password" autocomplete="new-password"></div>' +
      '<div class="prev bad" id="vErr"></div><button class="btn primary block" id="vGo" type="submit">Tạo két</button></form></div>';
    return;
  }
  if (V.state === 'locked') {
    p.innerHTML = '<div class="card wm-lock"><div class="wm-lockico">' + LOCK + '</div><h2>Két đang khóa</h2>' +
      '<form id="vUnlockForm" autocomplete="off"><div class="field"><label for="vP1">Mật khẩu két</label><input id="vP1" type="password" autocomplete="off" data-autofocus></div>' +
      '<div class="prev bad" id="vErr"></div><button class="btn primary block" id="vGo" type="submit">Mở khóa</button></form></div>';
    const f = $('vP1'); if (f && activeTab === 'vault') setTimeout(() => f.focus(), 60);
    return;
  }
  p.innerHTML = '<div class="wm-bar"><div class="wm-search"><input id="vQ" type="search" placeholder="Tìm thiết bị, vị trí, tài khoản…" autocomplete="off"></div>' +
    '<button class="btn primary" data-v="add" type="button">＋ Thêm thiết bị</button></div>' +
    '<div class="wm-vtools"><span class="hint" style="margin:0">Két mở • tự khóa sau 5 phút không thao tác</span><span><button class="chip" data-v="pw" type="button">Đổi mật khẩu két</button> <button class="chip" data-v="lock" type="button">🔒 Khóa ngay</button></span></div>' +
    '<div class="wm-vlist" id="vList"></div>';
  $('vQ').value = V.q;
  renderVaultList();
}
const LOCK = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.5" r="1.4"/></svg>';

async function doSetup() {
  const a = $('vP1').value, b = $('vP2').value;
  if (a.length < 8) { $('vErr').textContent = 'Mật khẩu két cần ít nhất 8 ký tự.'; return; }
  if (a !== b) { $('vErr').textContent = 'Hai lần nhập chưa giống nhau.'; return; }
  $('vErr').textContent = ''; $('vGo').disabled = true; $('vGo').textContent = 'Đang tạo…';
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(a, salt, PBKDF2_ITER);
    const chk = await encObj(key, 'vault-ok', 'check');
    const meta = must(await track(async () => C.sb.from('vault_meta').insert({ salt: b64(salt), iter: PBKDF2_ITER, check_iv: chk.iv, check_ct: chk.ct }).select().single()));
    V.meta = meta; V.key = key; V.items = []; V.state = 'open'; touchVault(); startIdle(); renderVault();
    C.toast('Đã tạo két. Nhớ ghi mật khẩu két ra giấy!');
  } catch (e) { fail(e); $('vGo').disabled = false; $('vGo').textContent = 'Tạo két'; }
}
async function doUnlock() {
  const a = $('vP1').value; if (!a) return;
  $('vErr').textContent = ''; $('vGo').disabled = true; $('vGo').textContent = 'Đang mở…';
  try {
    const key = await deriveKey(a, unb64(V.meta.salt), V.meta.iter);
    let ok = false;
    try { ok = (await decObj(key, V.meta.check_iv, V.meta.check_ct, 'check')) === 'vault-ok'; } catch (e) { ok = false; }
    if (!ok) { $('vErr').textContent = 'Sai mật khẩu két.'; $('vGo').disabled = false; $('vGo').textContent = 'Mở khóa'; $('vP1').select(); return; }
    const rows = must(await C.sb.from('vault_items').select('*').order('name'));
    V.key = key;
    V.items = await Promise.all(rows.map(async (r) => { let data = null; try { data = await decObj(key, r.iv, r.ct, r.id); } catch (e) {} return Object.assign({}, r, { data }); }));
    V.state = 'open'; touchVault(); startIdle(); renderVault();
  } catch (e) { fail(e); const g = $('vGo'); if (g) { g.disabled = false; g.textContent = 'Mở khóa'; } }
}
function startIdle() { if (V.timer) clearInterval(V.timer); V.timer = setInterval(idleCheck, 15000); }

function renderVaultList() {
  const box = $('vList'); if (!box) return;
  const q = V.q;
  const rows = V.items.filter((r) => !q || (r.name + ' ' + r.location + ' ' + (r.data ? r.data.user : '')).toLowerCase().indexOf(q) >= 0);
  if (!rows.length) { box.innerHTML = '<div class="wm-empty">' + (V.items.length ? 'Không có mục nào khớp.' : 'Két còn trống.<br>Bấm <b>＋ Thêm thiết bị</b> để lưu tài khoản và mật khẩu của thiết bị công ty.') + '</div>'; return; }
  box.innerHTML = rows.map((r) => {
    const d = r.data, shown = V.reveal.has(r.id);
    if (!d) return '<article class="wm-card wm-vi" data-id="' + esc(r.id) + '"><div class="wm-vh"><h3>' + esc(r.name) + '</h3></div><p class="muted">Không giải mã được mục này.</p><div class="wm-va"><button class="chip" data-v="del" type="button">Xóa</button></div></article>';
    return '<article class="wm-card wm-vi" data-id="' + esc(r.id) + '"><div class="wm-vh"><div><h3>' + esc(r.name) + '</h3>' + (r.location ? '<div class="sub">' + esc(r.location) + '</div>' : '') + '</div>' +
      '<div class="wm-va"><button class="wm-ib" data-v="edit" type="button" aria-label="Sửa">✎</button><button class="wm-ib bad" data-v="del" type="button" aria-label="Xóa">✕</button></div></div>' +
      (d.user ? '<div class="wm-vr"><span class="wm-vl">Tài khoản</span><span class="wm-vv">' + esc(d.user) + '</span><button class="chip" data-v="cu" type="button">Chép</button></div>' : '') +
      '<div class="wm-vr"><span class="wm-vl">Mật khẩu</span><span class="wm-vv wm-pw">' + (shown ? esc(d.pass) : '••••••••••') + '</span>' +
      '<button class="chip" data-v="show" type="button">' + (shown ? 'Ẩn' : 'Hiện') + '</button><button class="chip" data-v="cp" type="button">Chép</button></div>' +
      (d.note ? '<div class="wm-vnote">' + multiline(d.note) + '</div>' : '') + '</article>';
  }).join('');
}
function vaultClick(e) {
  const b = e.target.closest('[data-v]'); if (!b) return;
  touchVault();
  const act = b.getAttribute('data-v'), card = b.closest('[data-id]'), id = card ? card.getAttribute('data-id') : null;
  const it = id ? V.items.find((x) => x.id === id) : null;
  if (act === 'add') editVault(null);
  else if (act === 'lock') lockVault(false);
  else if (act === 'pw') changeMaster();
  else if (act === 'edit' && it) editVault(it);
  else if (act === 'del' && it) delVault(it);
  else if (act === 'show' && it) {
    if (V.reveal.has(id)) { clearTimeout(V.reveal.get(id)); V.reveal.delete(id); }
    else V.reveal.set(id, setTimeout(() => { V.reveal.delete(id); renderVaultList(); }, REVEAL_MS));
    renderVaultList();
  } else if ((act === 'cu' || act === 'cp') && it && it.data) {
    copyText(act === 'cu' ? it.data.user : it.data.pass).then(() => C.toast(act === 'cu' ? 'Đã chép tài khoản' : 'Đã chép mật khẩu'), () => C.toast('Không chép được, hãy bấm Hiện rồi chép tay', true));
  }
}
function genPass() {
  const cs = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?', a = crypto.getRandomValues(new Uint32Array(16));
  return Array.prototype.map.call(a, (n) => cs[n % cs.length]).join('');
}
function editVault(it) {
  const d = (it && it.data) || { user: '', pass: '', note: '' };
  openDlg('<h2>' + (it ? 'Sửa thiết bị' : 'Thêm thiết bị') + '</h2>' +
    '<div class="field"><label for="xName">Tên thiết bị *</label><input id="xName" data-autofocus maxlength="200" placeholder="vd: Router tầng 2, Camera cổng, Máy chủ NAS"></div>' +
    '<div class="field"><label for="xLoc">Vị trí / địa chỉ IP</label><input id="xLoc" maxlength="200" placeholder="vd: 192.168.1.1, phòng kỹ thuật"></div>' +
    '<div class="field"><label for="xUser">Tài khoản</label><input id="xUser" autocomplete="off" maxlength="300"></div>' +
    '<div class="field"><label for="xPass">Mật khẩu</label><div class="wm-pwrow"><input id="xPass" type="password" autocomplete="new-password" maxlength="500"><button class="chip" data-x="eye" type="button">Hiện</button><button class="chip" data-x="gen" type="button">Tạo ngẫu nhiên</button></div></div>' +
    '<div class="field"><label for="xNote">Ghi chú (cũng được mã hóa)</label><textarea id="xNote" rows="3" maxlength="2000" placeholder="vd: đổi mật khẩu mỗi 6 tháng, tài khoản quản trị…"></textarea></div>' +
    '<div class="prev bad" id="xErr"></div><div class="twin"><button class="btn" data-x="cancel" type="button">Hủy</button><button class="btn primary" data-x="save" type="button">Lưu</button></div>');
  $('xName').value = it ? it.name : ''; $('xLoc').value = it ? it.location : '';
  $('xUser').value = d.user; $('xPass').value = d.pass; $('xNote').value = d.note;
  const sh = $('wmDlg').querySelector('.sheet');
  sh.onclick = async (e) => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const a = b.getAttribute('data-x');
    if (a === 'cancel') closeDlg();
    else if (a === 'eye') { const f = $('xPass'); f.type = f.type === 'password' ? 'text' : 'password'; b.textContent = f.type === 'password' ? 'Hiện' : 'Ẩn'; }
    else if (a === 'gen') { const f = $('xPass'); f.value = genPass(); f.type = 'text'; sh.querySelector('[data-x="eye"]').textContent = 'Ẩn'; }
    else if (a === 'save') {
      const name = $('xName').value.trim(); if (!name) { $('xErr').textContent = 'Hãy nhập tên thiết bị.'; return; }
      b.disabled = true; b.textContent = 'Đang lưu…';
      try {
        const id = it ? it.id : uid();
        const data = { user: $('xUser').value, pass: $('xPass').value, note: $('xNote').value.trim() };
        const c = await encObj(V.key, data, id);
        const row = { name, location: $('xLoc').value.trim(), iv: c.iv, ct: c.ct, updated_at: new Date().toISOString() };
        const saved = must(await track(async () => (it ? C.sb.from('vault_items').update(row).eq('id', id).select().single() : C.sb.from('vault_items').insert(Object.assign({ id }, row)).select().single())));
        const item = Object.assign({}, saved, { data });
        const i = V.items.findIndex((x) => x.id === id);
        if (i >= 0) V.items[i] = item; else V.items.push(item);
        V.items.sort((x, y) => x.name.localeCompare(y.name, 'vi'));
        closeDlg(); renderVaultList(); C.toast('Đã lưu');
      } catch (er) { fail(er); b.disabled = false; b.textContent = 'Lưu'; }
    }
  };
}
async function delVault(it) {
  if (!(await askConfirm('Xóa "' + it.name + '" khỏi két? Không thể hoàn tác.'))) return;
  try {
    await track(async () => must(await C.sb.from('vault_items').delete().eq('id', it.id)));
    V.items = V.items.filter((x) => x.id !== it.id); renderVaultList(); C.toast('Đã xóa');
  } catch (e) { fail(e); }
}
function changeMaster() {
  openDlg('<h2>Đổi mật khẩu két</h2><p class="hint">Toàn bộ mục sẽ được mã hóa lại bằng mật khẩu mới. Quên mật khẩu mới thì không thể khôi phục.</p>' +
    '<div class="field"><label for="mOld">Mật khẩu két hiện tại</label><input id="mOld" type="password" autocomplete="off" data-autofocus></div>' +
    '<div class="field"><label for="mNew1">Mật khẩu két mới</label><input id="mNew1" type="password" autocomplete="new-password"></div>' +
    '<div class="field"><label for="mNew2">Nhập lại mật khẩu mới</label><input id="mNew2" type="password" autocomplete="new-password"></div>' +
    '<div class="prev bad" id="mErr"></div><div class="twin"><button class="btn" data-m="cancel" type="button">Hủy</button><button class="btn primary" data-m="go" type="button">Đổi mật khẩu</button></div>');
  $('wmDlg').querySelector('.sheet').onclick = async (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.getAttribute('data-m') === 'cancel') { closeDlg(); return; }
    const o = $('mOld').value, n1 = $('mNew1').value, n2 = $('mNew2').value;
    if (n1.length < 8) { $('mErr').textContent = 'Mật khẩu mới cần ít nhất 8 ký tự.'; return; }
    if (n1 !== n2) { $('mErr').textContent = 'Hai lần nhập mật khẩu mới chưa giống nhau.'; return; }
    if (V.items.some((x) => !x.data)) { $('mErr').textContent = 'Có mục không giải mã được, không thể đổi mật khẩu lúc này.'; return; }
    b.disabled = true; b.textContent = 'Đang xử lý…'; $('mErr').textContent = '';
    try {
      const oldKey = await deriveKey(o, unb64(V.meta.salt), V.meta.iter);
      let ok = false; try { ok = (await decObj(oldKey, V.meta.check_iv, V.meta.check_ct, 'check')) === 'vault-ok'; } catch (er) {}
      if (!ok) { $('mErr').textContent = 'Mật khẩu hiện tại chưa đúng.'; b.disabled = false; b.textContent = 'Đổi mật khẩu'; return; }
      const salt = crypto.getRandomValues(new Uint8Array(16)), key = await deriveKey(n1, salt, PBKDF2_ITER), chk = await encObj(key, 'vault-ok', 'check');
      const items = await Promise.all(V.items.map(async (x) => Object.assign({ id: x.id }, await encObj(key, x.data, x.id))));
      await track(async () => must(await C.sb.rpc('vault_rekey', { p_meta: { salt: b64(salt), iter: PBKDF2_ITER, check_iv: chk.iv, check_ct: chk.ct }, p_items: items })));
      V.meta = Object.assign({}, V.meta, { salt: b64(salt), iter: PBKDF2_ITER, check_iv: chk.iv, check_ct: chk.ct });
      V.key = key; closeDlg(); C.toast('Đã đổi mật khẩu két');
    } catch (er) { fail(er); b.disabled = false; b.textContent = 'Đổi mật khẩu'; }
  };
}

/* =====================================================================
   3) TÀI LIỆU – tải lên và lưu giấy tờ, file của công ty
===================================================================== */
const D = { loaded: false, rows: [], q: '', cat: '' };
const DEFAULT_CATS = ['Hợp đồng', 'Hóa đơn', 'Bảo hành', 'Hướng dẫn', 'Sơ đồ', 'Khác'];

function initDocs() {
  $('wm-docs').innerHTML =
    '<div class="wm-bar"><div class="wm-search"><input id="dQ" type="search" placeholder="Tìm tên file, nhóm, ghi chú…" autocomplete="off"></div>' +
    '<button class="btn primary" id="dAdd" type="button">⬆ Tải lên</button><input type="file" id="dFile" multiple hidden></div>' +
    '<div class="chips wm-tags" id="dCats"></div>' +
    '<div class="wm-drop" id="dDrop">Kéo thả file vào đây, hoặc bấm <b>Tải lên</b><br><span class="hint">Mỗi file tối đa 50 MB • PDF, Word, Excel, ảnh, file nén…</span></div>' +
    '<div id="dList"></div><div class="hint" id="dUsage"></div>';
  $('dQ').addEventListener('input', () => { D.q = $('dQ').value.trim().toLowerCase(); renderDocs(); });
  $('dAdd').onclick = () => $('dFile').click();
  $('dFile').onchange = () => { const f = Array.prototype.slice.call($('dFile').files); $('dFile').value = ''; if (f.length) uploadDialog(f); };
  $('dCats').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; D.cat = D.cat === b.getAttribute('data-cat') ? '' : b.getAttribute('data-cat'); renderDocs(); });
  const drop = $('dDrop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('on'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('on'); }));
  drop.addEventListener('drop', (e) => { const f = Array.prototype.slice.call(e.dataTransfer.files || []); if (f.length) uploadDialog(f); });
  drop.addEventListener('click', () => $('dFile').click());
  $('dList').addEventListener('click', docClick);
}
async function loadDocs() {
  if (D.loaded) { renderDocs(); return; }
  $('dList').innerHTML = '<div class="sk" style="height:70px"></div><div class="sk" style="height:70px;margin-top:8px"></div>';
  try { D.rows = must(await C.sb.from('documents').select('*').order('created_at', { ascending: false })); D.loaded = true; renderDocs(); }
  catch (e) { $('dList').innerHTML = ''; fail(e); }
}
function extInfo(name, mime) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name), ext = m ? m[1].toLowerCase() : '';
  let kind = 'file';
  if (/pdf/.test(ext) || /pdf/.test(mime)) kind = 'pdf';
  else if (/^(doc|docx|odt|rtf|txt)$/.test(ext)) kind = 'doc';
  else if (/^(xls|xlsx|csv|ods)$/.test(ext)) kind = 'xls';
  else if (/^(ppt|pptx)$/.test(ext)) kind = 'ppt';
  else if (/^(jpg|jpeg|png|gif|webp|heic|bmp)$/.test(ext) || /^image\//.test(mime)) kind = 'img';
  else if (/^(zip|rar|7z|tar|gz)$/.test(ext)) kind = 'zip';
  return { ext: (ext || 'file').toUpperCase().slice(0, 4), kind };
}
function allCats() { return Array.from(new Set(DEFAULT_CATS.concat(D.rows.map((r) => r.category)))).filter(Boolean); }
function renderDocs() {
  const used = D.rows.reduce((a, r) => a + Number(r.size || 0), 0);
  $('dUsage').textContent = D.rows.length ? D.rows.length + ' file • đã dùng ' + fmtSize(used) + ' (gói Supabase miễn phí có 1 GB)' : '';
  const cats = Array.from(new Set(D.rows.map((r) => r.category)));
  $('dCats').innerHTML = cats.map((c) => '<button type="button" class="chip' + (D.cat === c ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('');
  const rows = D.rows.filter((r) => (!D.cat || r.category === D.cat) && (!D.q || (r.name + ' ' + r.category + ' ' + r.note).toLowerCase().indexOf(D.q) >= 0));
  if (!rows.length) { $('dList').innerHTML = '<div class="wm-empty">' + (D.rows.length ? 'Không có file nào khớp.' : 'Chưa có file nào. Kéo thả file vào khung phía trên để lưu trữ.') + '</div>'; return; }
  const groups = {};
  rows.forEach((r) => { (groups[r.category] = groups[r.category] || []).push(r); });
  $('dList').innerHTML = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'vi')).map((g) =>
    '<div class="wm-grp"><h4>' + esc(g) + ' <span>' + groups[g].length + '</span></h4>' + groups[g].map((r) => {
      const x = extInfo(r.name, r.mime);
      return '<article class="wm-card wm-doc" data-id="' + esc(r.id) + '"><div class="wm-fi k-' + x.kind + '">' + esc(x.ext) + '</div>' +
        '<div class="wm-dm"><h3>' + esc(r.name) + '</h3><div class="sub">' + fmtSize(Number(r.size)) + ' • ' + fmtDate(r.created_at) + (r.note ? ' • ' + esc(r.note) : '') + '</div></div>' +
        '<div class="wm-da"><button class="chip" data-d="open" type="button">Mở</button><button class="chip" data-d="dl" type="button">Tải về</button>' +
        '<button class="wm-ib" data-d="edit" type="button" aria-label="Sửa">✎</button><button class="wm-ib bad" data-d="del" type="button" aria-label="Xóa">✕</button></div></article>';
    }).join('') + '</div>').join('');
}
async function docClick(e) {
  const b = e.target.closest('[data-d]'); if (!b) return;
  const id = b.closest('[data-id]').getAttribute('data-id'), r = D.rows.find((x) => x.id === id); if (!r) return;
  const a = b.getAttribute('data-d');
  try {
    if (a === 'open') {
      const w = window.open('', '_blank');
      const u = await signedOne(r.path);
      if (w) { w.opener = null; w.location = u; } else location.href = u;
    } else if (a === 'dl') {
      const u = await signedOne(r.path, { download: r.name });
      const l = document.createElement('a'); l.href = u; l.download = r.name; document.body.appendChild(l); l.click(); l.remove();
    } else if (a === 'edit') editDoc(r);
    else if (a === 'del') {
      if (!(await askConfirm('Xóa file "' + r.name + '"? Không thể hoàn tác.'))) return;
      await track(async () => { await removeFiles([r.path]); must(await C.sb.from('documents').delete().eq('id', r.id)); });
      D.rows = D.rows.filter((x) => x.id !== r.id); renderDocs(); C.toast('Đã xóa');
    }
  } catch (er) { fail(er); }
}
function catField(id, val) {
  return '<input id="' + id + '" list="' + id + 'L" maxlength="80" placeholder="vd: Hợp đồng" value="' + esc(val) + '"><datalist id="' + id + 'L">' + allCats().map((c) => '<option value="' + esc(c) + '">').join('') + '</datalist>';
}
function editDoc(r) {
  openDlg('<h2>Sửa thông tin file</h2><div class="field"><label for="fName">Tên file</label><input id="fName" maxlength="300" data-autofocus value="' + esc(r.name) + '"></div>' +
    '<div class="field"><label for="fCat">Nhóm</label>' + catField('fCat', r.category) + '</div>' +
    '<div class="field"><label for="fNote">Ghi chú</label><input id="fNote" maxlength="500" value="' + esc(r.note) + '"></div><div class="prev bad" id="fErr"></div>' +
    '<div class="twin"><button class="btn" data-f="cancel" type="button">Hủy</button><button class="btn primary" data-f="save" type="button">Lưu</button></div>');
  $('wmDlg').querySelector('.sheet').onclick = async (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    if (b.getAttribute('data-f') === 'cancel') { closeDlg(); return; }
    const name = $('fName').value.trim(); if (!name) { $('fErr').textContent = 'Tên file không được để trống.'; return; }
    try {
      const row = { name, category: $('fCat').value.trim() || 'Khác', note: $('fNote').value.trim() };
      const saved = must(await track(async () => C.sb.from('documents').update(row).eq('id', r.id).select().single()));
      Object.assign(r, saved); closeDlg(); renderDocs(); C.toast('Đã lưu');
    } catch (er) { fail(er); }
  };
}
function uploadDialog(files) {
  const ok = [], bad = [];
  files.forEach((f) => (f.size > MAX_FILE ? bad : ok).push(f));
  if (bad.length) C.toast('Bỏ qua ' + bad.length + ' file lớn hơn 50 MB: ' + bad.map((f) => f.name).join(', '), true);
  if (!ok.length) return;
  openDlg('<h2>Tải lên ' + ok.length + ' file</h2><div class="wm-fl">' + ok.map((f, i) => '<div class="wm-fli" data-i="' + i + '"><span>' + esc(f.name) + '</span><em>' + fmtSize(f.size) + '</em><i></i></div>').join('') + '</div>' +
    '<div class="field"><label for="uCat">Nhóm</label>' + catField('uCat', D.cat || '') + '</div>' +
    '<div class="field"><label for="uNote">Ghi chú (áp dụng cho tất cả file này)</label><input id="uNote" maxlength="500" placeholder="vd: hợp đồng thuê máy chủ 2026"></div>' +
    '<div class="prev" id="uMsg"></div><div class="twin"><button class="btn" data-u="cancel" type="button">Hủy</button><button class="btn primary" data-u="go" type="button">Tải lên</button></div>');
  let busy = false;
  $('wmDlg').querySelector('.sheet').onclick = async (e) => {
    const b = e.target.closest('[data-u]'); if (!b || busy) return;
    if (b.getAttribute('data-u') === 'cancel') { closeDlg(); return; }
    busy = true; b.disabled = true; b.textContent = 'Đang tải…';
    const cat = $('uCat').value.trim() || 'Khác', note = $('uNote').value.trim();
    let done = 0, failed = 0;
    for (let i = 0; i < ok.length; i++) {
      const f = ok[i], row = $('wmDlg').querySelector('.wm-fli[data-i="' + i + '"]');
      $('uMsg').textContent = 'Đang tải ' + (i + 1) + '/' + ok.length + '…'; row.classList.add('run');
      try {
        const m = /\.([A-Za-z0-9]{1,8})$/.exec(f.name), path = user().id + '/docs/' + uid() + (m ? '.' + m[1].toLowerCase() : '');
        await track(async () => {
          const up = await C.sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false });
          if (up.error) throw up.error;
          try {
            const saved = must(await C.sb.from('documents').insert({ name: f.name, category: cat, note, path, size: f.size, mime: f.type || '' }).select().single());
            D.rows.unshift(saved);
          } catch (er) { await removeFiles([path]); throw er; }
        });
        row.classList.remove('run'); row.classList.add('ok'); done++;
      } catch (er) { row.classList.remove('run'); row.classList.add('err'); failed++; fail(er); }
    }
    renderDocs();
    $('uMsg').textContent = failed ? 'Xong: ' + done + ' thành công, ' + failed + ' lỗi.' : 'Đã tải lên ' + done + ' file.';
    b.disabled = false; b.textContent = 'Đóng'; b.setAttribute('data-u', 'cancel'); busy = false;
  };
}

/* =====================================================================
   4) LỊCH NĂM – ghi chú theo ngày
===================================================================== */
const K = { year: new Date().getFullYear(), notes: {}, upcoming: [], loadedYear: null };
const COLORS = [['blue', 'Xanh dương'], ['green', 'Xanh lá'], ['pink', 'Hồng'], ['amber', 'Vàng'], ['purple', 'Tím']];

function initCal() {
  $('wm-cal').innerHTML =
    '<div class="wm-bar wm-calbar"><div class="wm-yr"><button class="wm-ib" data-c="prev" type="button" aria-label="Năm trước">‹</button><b id="cYear"></b><button class="wm-ib" data-c="next" type="button" aria-label="Năm sau">›</button></div>' +
    '<button class="chip" data-c="today" type="button">Hôm nay</button><span class="hint" style="margin:0">Bấm vào một ngày để ghi chú</span></div>' +
    '<div class="wm-months" id="cMonths"></div><div class="wm-up card" id="cUp"></div>';
  $('wm-cal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (b) { const a = b.getAttribute('data-c'); if (a === 'prev') setYear(K.year - 1); else if (a === 'next') setYear(K.year + 1); else if (a === 'today') { K.year = new Date().getFullYear(); setYear(K.year); setTimeout(() => { const t = document.querySelector('.wm-d.today'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 120); } return; }
    const d = e.target.closest('[data-day]'); if (d) openDay(d.getAttribute('data-day'));
    const u = e.target.closest('[data-up]'); if (u) openDay(u.getAttribute('data-up'));
  });
}
async function setYear(y) { K.year = y; await loadCal(true); }
async function loadCal(force) {
  $('cYear').textContent = K.year;
  if (K.loadedYear === K.year && !force) { renderCal(); return; }
  renderCal();
  try {
    const rows = must(await C.sb.from('calendar_notes').select('*').gte('day', K.year + '-01-01').lte('day', K.year + '-12-31').order('created_at'));
    K.notes = {}; rows.forEach((r) => { (K.notes[r.day] = K.notes[r.day] || []).push(r); });
    K.loadedYear = K.year;
    K.upcoming = must(await C.sb.from('calendar_notes').select('*').gte('day', todayStr()).eq('done', false).order('day').limit(8));
    renderCal();
  } catch (e) { fail(e); }
}
function renderCal() {
  $('cYear').textContent = K.year;
  const today = todayStr(), names = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
  let html = '';
  for (let m = 0; m < 12; m++) {
    const first = (new Date(Date.UTC(K.year, m, 1)).getUTCDay() + 6) % 7, dim = new Date(Date.UTC(K.year, m + 1, 0)).getUTCDate();
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<i class="wm-dv"></i>';
    for (let d = 1; d <= dim; d++) {
      const key = K.year + '-' + pad2(m + 1) + '-' + pad2(d), ns = K.notes[key] || [];
      cells += '<button type="button" class="wm-d' + (key === today ? ' today' : '') + (ns.length ? ' has' : '') + ((first + d - 1) % 7 === 6 ? ' sun' : '') + '" data-day="' + key + '"' +
        (ns.length ? ' title="' + esc(ns.map((n) => n.text).join(' • ')) + '"' : '') + '><span>' + d + '</span>' +
        (ns.length ? '<em>' + ns.slice(0, 3).map((n) => '<b class="c-' + esc(n.color) + (n.done ? ' dn' : '') + '"></b>').join('') + '</em>' : '') + '</button>';
    }
    html += '<section class="wm-mon' + (K.year === new Date().getFullYear() && m === new Date().getMonth() ? ' now' : '') + '"><h4>' + names[m] + '</h4><div class="wm-wd"><i>T2</i><i>T3</i><i>T4</i><i>T5</i><i>T6</i><i>T7</i><i class="sun">CN</i></div><div class="wm-dg">' + cells + '</div></section>';
  }
  $('cMonths').innerHTML = html;
  const total = Object.keys(K.notes).reduce((a, k) => a + K.notes[k].length, 0);
  $('cUp').innerHTML = '<h4>Sắp tới</h4>' + (K.upcoming.length ? K.upcoming.map((n) =>
    '<button type="button" class="wm-ui" data-up="' + n.day + '"><b class="c-' + esc(n.color) + '"></b><span class="wm-ud">' + dmy(n.day) + '</span><span class="wm-ut">' + esc(n.text) + '</span></button>').join('') :
    '<div class="wm-empty" style="padding:8px 0">Chưa có ghi chú sắp tới.</div>') + '<div class="hint">Năm ' + K.year + ' có ' + total + ' ghi chú.</div>';
}
function openDay(day) {
  const dt = new Date(day + 'T00:00:00');
  const draw = () => {
    const ns = K.notes[day] || [];
    $('wmDlg').querySelector('.sheet').innerHTML =
      '<h2>' + DOW_LONG[dt.getDay()] + ', ' + dmy(day) + '</h2><div class="wm-nl">' + (ns.length ? ns.map((n) =>
        '<div class="wm-ni" data-nid="' + esc(n.id) + '"><label class="chk wm-nck"><input type="checkbox" data-n="done"' + (n.done ? ' checked' : '') + ' aria-label="Xong"><span>✓</span></label>' +
        '<b class="c-' + esc(n.color) + '"></b><input class="wm-nt' + (n.done ? ' dn' : '') + '" data-n="text" value="' + esc(n.text) + '" maxlength="1000"><button class="wm-ib bad" data-n="del" type="button" aria-label="Xóa">✕</button></div>').join('') :
        '<div class="wm-empty" style="padding:10px 0">Chưa có ghi chú cho ngày này.</div>') + '</div>' +
      '<div class="field"><label for="nNew">Thêm ghi chú</label><input id="nNew" maxlength="1000" placeholder="vd: Bảo trì máy chủ, họp với nhà cung cấp…"></div>' +
      '<div class="wm-cols" id="nCols">' + COLORS.map((c, i) => '<button type="button" class="c-' + c[0] + (i === 0 ? ' on' : '') + '" data-col="' + c[0] + '" aria-label="' + c[1] + '"></button>').join('') + '</div>' +
      '<div class="twin"><button class="btn" data-n="close" type="button">Đóng</button><button class="btn primary" data-n="add" type="button">Thêm</button></div>';
  };
  openDlg('', { onClose: () => { renderCal(); refreshUpcoming(); } }); draw();
  let color = 'blue';
  const sh = $('wmDlg').querySelector('.sheet');
  const addNote = async () => {
    const v = $('nNew').value.trim(); if (!v) return;
    try {
      const saved = must(await track(async () => C.sb.from('calendar_notes').insert({ day, text: v, color }).select().single()));
      (K.notes[day] = K.notes[day] || []).push(saved); draw(); $('nNew').focus();
    } catch (e) { fail(e); }
  };
  sh.onkeydown = (e) => { if (e.key === 'Enter' && e.target.id === 'nNew') { e.preventDefault(); addNote(); } };
  sh.onclick = async (e) => {
    const col = e.target.closest('[data-col]');
    if (col) { color = col.getAttribute('data-col'); Array.prototype.forEach.call($('nCols').children, (x) => x.classList.toggle('on', x === col)); return; }
    const b = e.target.closest('[data-n]'); if (!b) return;
    const a = b.getAttribute('data-n');
    if (a === 'close') closeDlg();
    else if (a === 'add') addNote();
    else if (a === 'del') {
      const id = b.closest('[data-nid]').getAttribute('data-nid');
      try { await track(async () => must(await C.sb.from('calendar_notes').delete().eq('id', id))); K.notes[day] = (K.notes[day] || []).filter((n) => n.id !== id); if (!K.notes[day].length) delete K.notes[day]; draw(); } catch (er) { fail(er); }
    }
  };
  sh.onchange = async (e) => {
    const row = e.target.closest('[data-nid]'); if (!row) return;
    const id = row.getAttribute('data-nid'), n = (K.notes[day] || []).find((x) => x.id === id); if (!n) return;
    try {
      if (e.target.getAttribute('data-n') === 'done') { n.done = e.target.checked; must(await track(async () => C.sb.from('calendar_notes').update({ done: n.done }).eq('id', id))); draw(); }
      else if (e.target.getAttribute('data-n') === 'text') {
        const v = e.target.value.trim(); if (!v) { e.target.value = n.text; return; }
        n.text = v; must(await track(async () => C.sb.from('calendar_notes').update({ text: v }).eq('id', id)));
      }
    } catch (er) { fail(er); }
  };
  setTimeout(() => { const f = $('nNew'); if (f && !ns0()) f.focus(); }, 120);
  function ns0() { return (K.notes[day] || []).length > 0 && window.innerWidth < 700; }
}
async function refreshUpcoming() {
  try { K.upcoming = must(await C.sb.from('calendar_notes').select('*').gte('day', todayStr()).eq('done', false).order('day').limit(8)); renderCal(); } catch (e) {}
}

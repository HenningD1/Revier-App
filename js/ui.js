// Kleine UI-Helfer: Toast, Bestätigung, Formular-Dialog, Bottom-Sheet, Datei-Ausgabe.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let toastTimer = null;
export function toast(msg, { ms = 3000, action = null } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.onClick(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(ms, 8000) : ms);
}

/**
 * Formular in einem modalen Dialog.
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.body       HTML mit <input name="..."> usw.
 * @param {string} [o.submit]   Beschriftung des Speichern-Knopfs
 * @param {function} o.onSubmit (data: object, form: HTMLFormElement) => Promise<boolean|void>;
 *                              false zurückgeben = Dialog offen lassen
 * @param {function} [o.onOpen] (form) => void, z. B. für zusätzliche Knöpfe
 */
export function openForm({ title, body, submit = 'Speichern', onSubmit, onOpen, danger = null, dialog = '#dlg' }) {
  const dlg = $(dialog);
  dlg.innerHTML = `
    <form class="dlg-form" novalidate>
      <header><h2>${esc(title)}</h2></header>
      <div class="dlg-body">${body}</div>
      <footer>
        ${danger ? `<button type="button" class="btn danger" data-danger>${esc(danger.label)}</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-cancel>Abbrechen</button>
        <button type="submit" class="btn primary">${esc(submit)}</button>
      </footer>
    </form>`;
  const form = dlg.querySelector('form');
  return new Promise(resolve => {
    const close = val => { dlg.close(); resolve(val); };
    form.querySelector('[data-cancel]').onclick = () => close(null);
    if (danger) form.querySelector('[data-danger]').onclick = async () => { if (await danger.onClick() !== false) close(null); };
    form.onsubmit = async ev => {
      ev.preventDefault();
      // Pflichtfelder selbst prüfen (Safari zeigt native Hinweise im Dialog unzuverlässig)
      const missing = Array.from(form.querySelectorAll('[required]')).find(el => !String(el.value).trim());
      if (missing) { missing.focus(); missing.classList.add('invalid'); return; }
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const ok = await onSubmit(data, form);
        if (ok !== false) close(data);
      } catch (e) {
        console.error(e);
        toast('Fehler: ' + e.message, { ms: 6000 });
      }
    };
    dlg.oncancel = ev => { ev.preventDefault(); close(null); };
    if (onOpen) onOpen(form);
    dlg.showModal();
  });
}

export function confirmDialog(title, text, okLabel = 'OK') {
  // Eigener Dialog, damit eine Rückfrage ein offenes Formular nicht ersetzt
  return openForm({ title, body: `<p>${esc(text)}</p>`, submit: okLabel, onSubmit: async () => true, dialog: '#dlg2' })
    .then(v => v !== null);
}

/** Bottom-Sheet (Handy) bzw. Seitenleiste (PC) */
export const sheet = {
  open(title, html) {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false;
    document.body.classList.add('sheet-open');
  },
  close() {
    $('#sheet').hidden = true;
    document.body.classList.remove('sheet-open');
  },
  get isOpen() { return !$('#sheet').hidden; }
};

/**
 * Datei ausgeben. Auf dem iPhone über das Teilen-Menü (dort "In Dateien sichern",
 * OneDrive, AirDrop ...), am PC als normaler Download.
 * Muss synchron aus einem Klick heraus aufgerufen werden (Browser-Vorgabe fürs Teilen).
 */
export function deliverFile(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const touch = matchMedia('(pointer: coarse)').matches;
  try {
    const file = new File([blob], filename, { type: mime });
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: filename }).catch(e => {
        if (e.name !== 'AbortError') download(blob, filename);
      });
      return;
    }
  } catch (_) { /* weiter mit Download */ }
  download(blob, filename);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function fmtDateTime(ms) {
  return new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** ms -> Wert für <input type="datetime-local"> (lokale Zeit) */
export function toLocalInput(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function options(list, selected, { value = x => x.id ?? x, label = x => x.name ?? x } = {}) {
  return list.map(x => {
    const v = value(x);
    return `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(label(x))}</option>`;
  }).join('');
}

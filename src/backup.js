// Backup of everything the app keeps in the browser storage: profiles, macros,
// key assignments, favorite colors and settings. The keyboard's own memory
// (macros, remaps, debounce) is not part of the file.

import { invoke, isTauri } from '@tauri-apps/api/core';

const KEYS = [
  'rampage-profiles', 'rampage-macros', 'rampage-remaps', 'rampage-favorites',
  'rampage-settings', 'rampage-perkey', 'rampage-theme'
];
const FORMAT = 'rampage-w-granite-backup';

function backupName() {
  return `rampage-yedek-${new Date().toISOString().slice(0, 10)}.json`;
}

/** Save the backup and return where it went, or null if the user cancelled.
 *  `beforeExport` flushes live state. */
export async function exportBackup(beforeExport) {
  if (beforeExport) beforeExport();
  const storage = {};
  KEYS.forEach(key => {
    const value = localStorage.getItem(key);
    if (value !== null) storage[key] = value;
  });
  const text = JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), storage }, null, 2);

  // Let the user pick the file (native "Save as" dialog).
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: backupName(),
        types: [{ description: 'Rampage yedeği', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return handle.name;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // Dialog unavailable: fall back to the Downloads folder below.
    }
  }

  if (isTauri()) return await invoke('save_backup', { fileName: backupName(), contents: text });

  // Browser preview: normal download.
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = backupName();
  link.click();
  URL.revokeObjectURL(url);
  return link.download;
}

/** Validate and apply a backup file. Macros and key assignments come back as
 *  "not written", because the keyboard may not hold them. */
export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    throw new Error('Dosya okunamadı; geçerli bir yedek değil.');
  }
  if (!data || data.format !== FORMAT || typeof data.storage !== 'object' || data.storage === null) {
    throw new Error('Bu dosya bir Rampage yedeği değil.');
  }

  const entries = Object.entries(data.storage).filter(([key]) => KEYS.includes(key));
  // Everything is JSON except the theme name.
  for (const [key, value] of entries) {
    if (typeof value !== 'string') throw new Error('Yedek dosyası bozuk.');
    if (key === 'rampage-theme') continue;
    let parsed;
    try { parsed = JSON.parse(value); } catch (e) { throw new Error('Yedek dosyası bozuk.'); }
    if ((key === 'rampage-macros' || key === 'rampage-remaps') && !Array.isArray(parsed)) {
      throw new Error('Yedek dosyası bozuk.');
    }
  }

  entries.forEach(([key, value]) => {
    let out = value;
    if (key === 'rampage-macros' || key === 'rampage-remaps') {
      out = JSON.stringify(JSON.parse(value).map(item => ({ ...item, synced: false })));
    }
    localStorage.setItem(key, out);
  });
  return entries.length;
}

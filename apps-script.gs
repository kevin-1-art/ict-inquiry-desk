/**
 * Endpoint for the ICT Inquiry Desk: receives client inquiries and shares assignments.
 *
 * Install: create a new Google Sheet > Extensions > Apps Script,
 * paste this file, change SECRET, then Deploy > New deployment > Web app:
 *   Execute as: Me      Who has access: Anyone
 * Copy the web-app URL into CONFIG.submitUrl AND CONFIG.syncUrl, and the same secret into CONFIG.syncKey.
 *
 * Anyone may POST {op:"submit"} (the client form). Reading inquiries or touching
 * assignments needs the secret. Inquiries go on a sheet called "Inquiries"; do not
 * delete or re-sort its rows, because ticket numbers (INQ-0001...) follow row order.
 *
 * Assignments keep one row per inquiry on a sheet called "Assignments" and refuse a
 * "claim" when someone else already holds that inquiry, which is what keeps
 * first-in-first-out fair when two agents press the button at the same moment.
 */
const SECRET = 'change-this-to-a-long-random-string';
const SHEET_NAME = 'Assignments';
const INQ_SHEET = 'Inquiries';
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const MAX_PER_HOUR = 120;     // whole-desk limit
const MIN_SECONDS_PER_EMAIL = 30;

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(SHEET_NAME);
  if (!s) { s = ss.insertSheet(SHEET_NAME); s.appendRow(['id', 'agent', 'status', 'updated', 'json']); }
  return s;
}

function inqSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(INQ_SHEET);
  if (!s) { s = ss.insertSheet(INQ_SHEET); s.appendRow(['Timestamp', 'Name', 'Email', 'Phone', 'Subject', 'Priority', 'Message']); }
  return s;
}

// Stop spreadsheet formulas being run from typed text.
function safe_(t) {
  t = String(t == null ? '' : t).trim();
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function submit_(b) {
  if (b.website) return { ok: true, ref: 'INQ-0000' };            // honeypot: pretend success to bots
  const name = String(b.name || '').trim().slice(0, 100);
  const email = String(b.email || '').trim().slice(0, 120);
  const subject = String(b.subject || '').trim().slice(0, 150);
  const message = String(b.message || '').trim().slice(0, 4000);
  const phone = String(b.phone || '').trim().slice(0, 30);
  const priority = PRIORITIES.indexOf(b.priority) > -1 ? b.priority : 'Normal';
  if (!name || !subject || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'invalid' };

  const cache = CacheService.getScriptCache();
  const ek = 'em:' + email.toLowerCase();
  if (cache.get(ek)) return { ok: false, error: 'rate' };
  const n = Number(cache.get('hour') || 0);
  if (n >= MAX_PER_HOUR) return { ok: false, error: 'busy' };

  const s = inqSheet_();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  s.appendRow([stamp, safe_(name), safe_(email), safe_(phone), safe_(subject), priority, safe_(message)]);
  cache.put(ek, '1', MIN_SECONDS_PER_EMAIL);
  cache.put('hour', String(n + 1), 3600);
  const num = s.getLastRow() - 1;
  return { ok: true, ref: 'INQ-' + ('0000' + num).slice(-4) };
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (!e.parameter || e.parameter.key !== SECRET) return out_({ ok: false, error: 'forbidden' });
  if (e.parameter.what === 'inquiries') {
    const rows = inqSheet_().getDataRange().getValues().slice(1);
    return out_({ ok: true, inquiries: rows.map(function (r) {
      return { ts: String(r[0]), name: r[1], email: r[2], phone: r[3], subject: r[4], priority: r[5], message: r[6] };
    }) });
  }
  const v = sheet_().getDataRange().getValues();
  const records = {};
  for (let i = 1; i < v.length; i++) {
    try { records[v[i][0]] = JSON.parse(v[i][4]); } catch (err) {}
  }
  return out_({ ok: true, records: records });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.op === 'submit') return out_(submit_(b));
    if (b.key !== SECRET) return out_({ ok: false, error: 'forbidden' });
    const s = sheet_();
    const v = s.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < v.length; i++) { if (v[i][0] === b.id) { row = i + 1; break; } }

    if (b.op === 'claim' && row > 0) {
      let existing = {};
      try { existing = JSON.parse(v[row - 1][4]); } catch (err) {}
      if (existing.agent) return out_({ ok: false, conflict: true, record: existing });
    }

    const r = b.record || {};
    const line = [b.id, r.agent || '', r.status || '', r.updated || 0, JSON.stringify(r)];
    if (row > 0) s.getRange(row, 1, 1, 5).setValues([line]); else s.appendRow(line);
    return out_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

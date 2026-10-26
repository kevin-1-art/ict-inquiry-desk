/**
 * Endpoint for the ICT Inquiry Desk: receives client inquiries and shares assignments.
 *
 * Install: create a new Google Sheet > Extensions > Apps Script,
 * paste this file, change SECRET, then Deploy > New deployment > Web app:
 *   Execute as: Me      Who has access: Anyone
 * Copy the web-app URL into CONFIG.submitUrl AND CONFIG.syncUrl, and the same secret into CONFIG.syncKey.
 *
 * Anyone may POST {op:"submit"} (the client form). Reading inquiries, sending client
 * replies, or touching assignments needs the secret. Inquiries go on a sheet called "Inquiries"; do not
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

function authorizeEmail() {
  return MailApp.getRemainingDailyQuota();
}

function sendEmail_(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'ICT Inquiry Desk' });
    return { emailSent: true };
  } catch (err) {
    Logger.log('Email delivery failed: ' + err.message);
    return { emailSent: false, emailError: 'Email delivery failed. Check the script authorization and daily email quota.' };
  }
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
  const ref = 'INQ-' + String(num).padStart(4, '0');
  const mailSubject = subject.replace(/[\r\n]+/g, ' ').slice(0, 150);
  return {
    ok: true,
    ref: ref,
    emailTo: email,
    emailSubject: 'ICT inquiry received: ' + ref,
    emailBody: 'Hello ' + name + ',\n\nWe received your ICT inquiry "' + mailSubject + '".\n' +
      'Your reference number is ' + ref + '. Our team will follow up at this email address.\n\n' +
      'Please keep this reference for future correspondence.\n\nICT Inquiry Desk'
  };
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
  const b = JSON.parse(e.postData.contents);
  if (b.op === 'submit') {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let result;
    try {
      result = submit_(b);
    } finally {
      lock.releaseLock();
    }
    if (result.ok && result.emailTo) {
      const mail = sendEmail_(result.emailTo, result.emailSubject, result.emailBody);
      result.emailSent = mail.emailSent;
      result.emailError = mail.emailError || '';
      delete result.emailTo;
      delete result.emailSubject;
      delete result.emailBody;
    }
    return out_(result);
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (b.key !== SECRET) return out_({ ok: false, error: 'forbidden' });
    if (b.op === 'reply') {
      const id = String(b.id || '');
      const message = String(b.message || '').trim();
      if (!/^INQ-\d{4,}$/.test(id) || !message || message.length > 5000) return out_({ ok: false, error: 'invalid' });
      const inquiries = inqSheet_().getDataRange().getValues();
      const inquiryIndex = Number(id.slice(4));
      if (inquiryIndex < 1 || inquiryIndex >= inquiries.length) return out_({ ok: false, error: 'not_found' });
      const inquiry = inquiries[inquiryIndex];
      const email = String(inquiry[2] || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return out_({ ok: false, error: 'invalid_email' });
      const subject = String(inquiry[4] || 'ICT inquiry').replace(/[\r\n]+/g, ' ').slice(0, 150);
      const mail = sendEmail_(email, 'ICT update for ' + id + ': ' + subject,
        'Hello ' + String(inquiry[1] || '') + ',\n\n' +
        'The ICT team has replied to your inquiry "' + subject + '" (' + id + '):\n\n' +
        message + '\n\nICT Inquiry Desk');
      if (!mail.emailSent) return out_({ ok: false, error: 'email_failed', message: mail.emailError });

      const recordRow = sheet_().getDataRange().getValues();
      let assignmentRow = -1, record = {};
      for (let i = 1; i < recordRow.length; i++) {
        if (recordRow[i][0] === id) {
          assignmentRow = i + 1;
          try { record = JSON.parse(recordRow[i][4]) || {}; } catch (err) { record = {}; }
          break;
        }
      }
      record.replies = (record.replies || []).concat([{
        by: String(b.by || '').slice(0, 32),
        at: Date.now(),
        text: message
      }]);
      record.updated = Date.now();
      const line = [id, record.agent || '', record.status || '', record.updated, JSON.stringify(record)];
      if (assignmentRow > 0) sheet_().getRange(assignmentRow, 1, 1, 5).setValues([line]);
      else sheet_().appendRow(line);
      return out_({ ok: true, emailSent: true, record: record });
    }
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

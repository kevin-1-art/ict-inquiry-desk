/**
 * Endpoint for the ICT Inquiry Desk: receives client inquiries and shares assignments.
 *
 * Install: create a new Google Sheet > Extensions > Apps Script,
 * paste this file, change SECRET, then Deploy > New deployment > Web app:
 *   Execute as: Me      Who has access: Anyone
 * Copy the web-app URL into CONFIG.submitUrl AND CONFIG.syncUrl, and the same secret into CONFIG.syncKey.
 *
 * Anyone may POST {op:"submit"} (the client form). Reading inquiries, sending client
 * replies, or touching assignments needs the secret. Staff/agent email recipients are
 * configured below. Inquiries go on a sheet called "Inquiries"; do not
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
const STAFF_NOTIFICATION_EMAILS = []; // Add admin/desk notification addresses here.
const AGENT_EMAILS = {}; // Map usernames to email addresses, e.g. { "agent1": "agent1@example.org" }.

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

function sendNotifications_(recipients, subject, body) {
  const unique = Array.from(new Set((recipients || []).map(function (email) {
    return String(email || '').trim().toLowerCase();
  }).filter(function (email) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  })));
  const failures = [];
  unique.forEach(function (email) {
    const result = sendEmail_(email, subject, body);
    if (!result.emailSent) failures.push(result.emailError);
  });
  return failures;
}

function staffRecipients_(agents) {
  const recipients = STAFF_NOTIFICATION_EMAILS.slice();
  Object.keys(AGENT_EMAILS).forEach(function (username) {
    recipients.push(AGENT_EMAILS[username]);
  });
  (Array.isArray(agents) ? agents : [agents]).forEach(function (agent) {
    if (agent && AGENT_EMAILS[agent]) recipients.push(AGENT_EMAILS[agent]);
  });
  return recipients;
}

function notifyStaff_(subject, body, agents) {
  const requestedAgents = Array.isArray(agents) ? agents : [agents];
  const failures = requestedAgents.filter(function (agent) {
    return agent && !AGENT_EMAILS[agent];
  }).map(function (agent) {
    return 'No email address is configured for assigned agent "' + agent + '".';
  });
  const recipients = staffRecipients_(requestedAgents);
  if (!recipients.some(function (email) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || '').trim());
  })) {
    failures.push('No valid staff notification addresses are configured in apps-script.gs.');
    return failures;
  }
  return failures.concat(sendNotifications_(recipients, subject, body));
}

function inquiryFor_(id) {
  const match = /^INQ-(\d{4,})$/.exec(String(id || ''));
  if (!match) return null;
  const row = Number(match[1]) + 1;
  const rows = inqSheet_().getDataRange().getValues();
  if (row < 2 || row >= rows.length + 1) return null;
  return { row: rows[row - 1], index: row };
}

function ticketSubject_(inquiry) {
  return String(inquiry[4] || 'ICT inquiry').replace(/[\r\n]+/g, ' ').slice(0, 150);
}

function notifyClientStatus_(id, inquiry, status) {
  const email = String(inquiry[2] || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return ['Client notification could not be sent because the ticket email address is invalid.'];
  }
  const subject = ticketSubject_(inquiry);
  const resolved = status === 'Resolved';
  const heading = resolved ? 'Your ICT inquiry has been resolved' : 'Your ICT inquiry status was updated';
  const body = 'Hello ' + String(inquiry[1] || '') + ',\n\n' +
    'The status of your ICT inquiry "' + subject + '" (' + id + ') is now ' + status + '.\n\n' +
    (resolved ? 'If you still need help, please submit a new inquiry and include this reference.\n\n' : '') +
    'ICT Inquiry Desk';
  const result = sendEmail_(email, heading + ': ' + id, body);
  return result.emailSent ? [] : [result.emailError];
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
      'Please keep this reference for future correspondence.\n\nICT Inquiry Desk',
    staffSubject: 'New ICT inquiry: ' + ref + ' — ' + mailSubject,
    staffBody: 'A new ICT inquiry was submitted.\n\nReference: ' + ref + '\nName: ' + name +
      '\nEmail: ' + email + '\nPriority: ' + priority + '\nSubject: ' + mailSubject +
      '\n\nMessage:\n' + message
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
      result.notificationErrors = notifyStaff_(result.staffSubject, result.staffBody);
      delete result.emailTo;
      delete result.emailSubject;
      delete result.emailBody;
      delete result.staffSubject;
      delete result.staffBody;
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
      const subject = ticketSubject_(inquiry);
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
      const notificationErrors = notifyStaff_(
        'Client reply sent: ' + id,
        'A client reply was sent for ticket ' + id + ' "' + subject + '".\nReplied by: ' +
          String(b.by || 'ICT staff') + '\n\n' + message,
        record.agent || ''
      );
      return out_({ ok: true, emailSent: true, record: record, notificationErrors: notificationErrors });
    }
    const s = sheet_();
    const v = s.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < v.length; i++) { if (v[i][0] === b.id) { row = i + 1; break; } }

    let previous = {};
    if (row > 0) {
      try { previous = JSON.parse(v[row - 1][4]) || {}; } catch (err) {}
    }
    if (b.op === 'claim' && row > 0) {
      if (previous.agent) return out_({ ok: false, conflict: true, record: previous });
    }

    const r = b.record || {};
    const line = [b.id, r.agent || '', r.status || '', r.updated || 0, JSON.stringify(r)];
    if (row > 0) s.getRange(row, 1, 1, 5).setValues([line]); else s.appendRow(line);
    const ticket = inquiryFor_(b.id);
    const notifications = [];
    if (ticket) {
      const subject = ticketSubject_(ticket.row);
      const previousAgent = String(previous.agent || '');
      const nextAgent = String(r.agent || '');
      const previousStatus = String(previous.status || 'Open');
      const nextStatus = String(r.status || 'Open');
      const notes = Array.isArray(r.notes) ? r.notes : [];
      const previousNotes = Array.isArray(previous.notes) ? previous.notes : [];

      if (nextAgent !== previousAgent && (nextAgent || previousAgent)) {
        const assignmentAction = !nextAgent ? 'returned to the queue' : previousAgent ? 'reassigned' : 'assigned';
        notifications.push.apply(notifications, notifyStaff_(
          'ICT inquiry ' + assignmentAction + ': ' + b.id,
          'Ticket ' + b.id + ' "' + subject + '" was ' + assignmentAction +
            (nextAgent ? ' to ' + nextAgent : '') + '.\nStatus: ' + nextStatus,
          [previousAgent, nextAgent]
        ));
      }
      if (nextStatus !== previousStatus) {
        notifications.push.apply(notifications, notifyClientStatus_(b.id, ticket.row, nextStatus));
        notifications.push.apply(notifications, notifyStaff_(
          'ICT inquiry status changed: ' + b.id,
          'Ticket ' + b.id + ' "' + subject + '" changed status from ' + previousStatus + ' to ' + nextStatus +
            (nextAgent ? '.\nAssigned agent: ' + nextAgent : ''),
          nextAgent
        ));
      }
      if (notes.length > previousNotes.length) {
        const note = notes[notes.length - 1] || {};
        notifications.push.apply(notifications, notifyStaff_(
          'Internal note added: ' + b.id,
          'An internal note was added to ticket ' + b.id + ' "' + subject + '".\nBy: ' +
            String(note.by || 'ICT staff') + '\n\n' + String(note.text || ''),
          nextAgent
        ));
      }
    }
    return out_({ ok: true, notificationErrors: notifications });
  } finally {
    lock.releaseLock();
  }
}

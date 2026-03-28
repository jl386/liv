/**
 * Apple PIM Bridge
 * Executes JXA (JavaScript for Automation) on the host to interact with
 * Calendar.app, Notes.app, and Reminders.app via the assistant's iCloud account.
 *
 * Main-group only. Reads account name from data/apple-pim-config.json.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const CONFIG_PATH = path.join(DATA_DIR, 'apple-pim-config.json');
const OSASCRIPT_TIMEOUT = 15_000;

export interface ApplePimConfig {
  /** iCloud account name as it appears in Calendar/Notes/Reminders (e.g. "liv-assistant@icloud.com") */
  accountName: string;
}

interface ApplePimRequest {
  id: string;
  domain: 'calendar' | 'notes' | 'reminders';
  action: string;
  params: Record<string, unknown>;
}

interface ApplePimResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

function loadConfig(): ApplePimConfig | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    logger.warn('Failed to read apple-pim config');
    return null;
  }
}

function runJxa(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: OSASCRIPT_TIMEOUT, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr)
          logger.debug({ stderr: stderr.slice(0, 500) }, 'JXA stderr');
        if (err) return reject(err);
        resolve(stdout.trim());
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Calendar JXA
// ---------------------------------------------------------------------------

function jxaCalendarList(account: string): string {
  return `
    const app = Application("Calendar");
    const cals = app.calendars().filter(c => {
      try { return c.description().includes("${account}") || c.name() !== undefined; } catch { return false; }
    });
    const result = cals.map(c => ({ name: c.name(), uid: c.uid(), writable: c.writable() }));
    JSON.stringify(result);
  `;
}

function jxaCalendarEvents(
  account: string,
  calendarName: string,
  startDate: string,
  endDate: string,
): string {
  return `
    const app = Application("Calendar");
    const cal = app.calendars.whose({name: "${calendarName}"})[0];
    const start = new Date("${startDate}");
    const end = new Date("${endDate}");
    const events = cal.events.whose({
      _and: [
        { startDate: { _greaterThan: start } },
        { endDate: { _lessThan: end } }
      ]
    })();
    const result = events.map(e => ({
      uid: e.uid(),
      summary: e.summary(),
      startDate: e.startDate().toISOString(),
      endDate: e.endDate().toISOString(),
      location: e.location(),
      description: e.description(),
      allDayEvent: e.alldayEvent(),
      status: e.status(),
    }));
    JSON.stringify(result);
  `;
}

function jxaCalendarCreateEvent(
  calendarName: string,
  summary: string,
  startDate: string,
  endDate: string,
  location?: string,
  description?: string,
  allDay?: boolean,
): string {
  const props = [
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    `startDate: new Date("${startDate}")`,
    `endDate: new Date("${endDate}")`,
  ];
  if (location) props.push(`location: "${location.replace(/"/g, '\\"')}"`);
  if (description)
    props.push(`description: "${description.replace(/"/g, '\\"')}"`);
  if (allDay) props.push(`alldayEvent: true`);

  return `
    const app = Application("Calendar");
    const cal = app.calendars.whose({name: "${calendarName}"})[0];
    const evt = app.Event({${props.join(', ')}});
    cal.events.push(evt);
    JSON.stringify({ uid: evt.uid(), summary: evt.summary(), startDate: evt.startDate().toISOString() });
  `;
}

function jxaCalendarUpdateEvent(
  calendarName: string,
  eventUid: string,
  updates: Record<string, unknown>,
): string {
  const setLines: string[] = [];
  if (updates.summary)
    setLines.push(
      `evt.summary = "${String(updates.summary).replace(/"/g, '\\"')}";`,
    );
  if (updates.startDate)
    setLines.push(`evt.startDate = new Date("${updates.startDate}");`);
  if (updates.endDate)
    setLines.push(`evt.endDate = new Date("${updates.endDate}");`);
  if (updates.location !== undefined)
    setLines.push(
      `evt.location = "${String(updates.location).replace(/"/g, '\\"')}";`,
    );
  if (updates.description !== undefined)
    setLines.push(
      `evt.description = "${String(updates.description).replace(/"/g, '\\"')}";`,
    );

  return `
    const app = Application("Calendar");
    const cal = app.calendars.whose({name: "${calendarName}"})[0];
    const evts = cal.events.whose({uid: "${eventUid}"})();
    if (evts.length === 0) throw new Error("Event not found");
    const evt = evts[0];
    ${setLines.join('\n    ')}
    JSON.stringify({ uid: evt.uid(), summary: evt.summary(), startDate: evt.startDate().toISOString() });
  `;
}

function jxaCalendarDeleteEvent(
  calendarName: string,
  eventUid: string,
): string {
  return `
    const app = Application("Calendar");
    const cal = app.calendars.whose({name: "${calendarName}"})[0];
    const evts = cal.events.whose({uid: "${eventUid}"})();
    if (evts.length === 0) throw new Error("Event not found");
    app.delete(evts[0]);
    JSON.stringify({ deleted: true });
  `;
}

// ---------------------------------------------------------------------------
// Notes JXA
// ---------------------------------------------------------------------------

function jxaNotesListFolders(account: string): string {
  return `
    const app = Application("Notes");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const folders = acct.folders();
    const result = folders.map(f => ({
      name: f.name(),
      id: f.id(),
      noteCount: f.notes.length,
    }));
    JSON.stringify(result);
  `;
}

function jxaNotesListNotes(account: string, folderName: string): string {
  return `
    const app = Application("Notes");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const folder = acct.folders.whose({name: "${folderName}"})[0];
    const notes = folder.notes();
    const result = notes.map(n => ({
      id: n.id(),
      name: n.name(),
      modificationDate: n.modificationDate().toISOString(),
      creationDate: n.creationDate().toISOString(),
    }));
    JSON.stringify(result);
  `;
}

function jxaNotesRead(account: string, noteId: string): string {
  return `
    const app = Application("Notes");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const note = acct.notes.whose({id: "${noteId}"})[0];
    JSON.stringify({
      id: note.id(),
      name: note.name(),
      body: note.plaintext(),
      modificationDate: note.modificationDate().toISOString(),
    });
  `;
}

function jxaNotesCreate(
  account: string,
  folderName: string,
  title: string,
  body: string,
): string {
  const escapedBody = body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  const escapedTitle = title.replace(/"/g, '\\"');
  return `
    const app = Application("Notes");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const folder = acct.folders.whose({name: "${folderName}"})[0];
    const note = app.Note({ name: "${escapedTitle}", body: "${escapedBody}" });
    folder.notes.push(note);
    JSON.stringify({ id: note.id(), name: note.name() });
  `;
}

function jxaNotesUpdate(
  account: string,
  noteId: string,
  updates: Record<string, unknown>,
): string {
  const setLines: string[] = [];
  if (updates.name)
    setLines.push(
      `note.name = "${String(updates.name).replace(/"/g, '\\"')}";`,
    );
  if (updates.body !== undefined) {
    const escapedBody = String(updates.body)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    setLines.push(`note.body = "${escapedBody}";`);
  }

  return `
    const app = Application("Notes");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const note = acct.notes.whose({id: "${noteId}"})[0];
    ${setLines.join('\n    ')}
    JSON.stringify({ id: note.id(), name: note.name() });
  `;
}

// ---------------------------------------------------------------------------
// Reminders JXA
// ---------------------------------------------------------------------------

function jxaRemindersListLists(account: string): string {
  return `
    const app = Application("Reminders");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const lists = acct.lists();
    const result = lists.map(l => ({
      name: l.name(),
      id: l.id(),
      reminderCount: l.reminders.length,
    }));
    JSON.stringify(result);
  `;
}

function jxaRemindersListReminders(
  account: string,
  listName: string,
  includeCompleted?: boolean,
): string {
  return `
    const app = Application("Reminders");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const list = acct.lists.whose({name: "${listName}"})[0];
    let reminders = list.reminders();
    ${!includeCompleted ? 'reminders = reminders.filter(r => !r.completed());' : ''}
    const result = reminders.map(r => ({
      id: r.id(),
      name: r.name(),
      body: r.body(),
      completed: r.completed(),
      dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
      priority: r.priority(),
      modificationDate: r.modificationDate().toISOString(),
    }));
    JSON.stringify(result);
  `;
}

function jxaRemindersCreate(
  account: string,
  listName: string,
  name: string,
  dueDate?: string,
  body?: string,
  priority?: number,
): string {
  const props = [`name: "${name.replace(/"/g, '\\"')}"`];
  if (body) props.push(`body: "${body.replace(/"/g, '\\"')}"`);
  if (dueDate) props.push(`dueDate: new Date("${dueDate}")`);
  if (priority !== undefined) props.push(`priority: ${priority}`);

  return `
    const app = Application("Reminders");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const list = acct.lists.whose({name: "${listName}"})[0];
    const reminder = app.Reminder({${props.join(', ')}});
    list.reminders.push(reminder);
    JSON.stringify({ id: reminder.id(), name: reminder.name() });
  `;
}

function jxaRemindersUpdate(
  account: string,
  listName: string,
  reminderId: string,
  updates: Record<string, unknown>,
): string {
  const setLines: string[] = [];
  if (updates.name)
    setLines.push(`r.name = "${String(updates.name).replace(/"/g, '\\"')}";`);
  if (updates.body !== undefined)
    setLines.push(`r.body = "${String(updates.body).replace(/"/g, '\\"')}";`);
  if (updates.completed !== undefined)
    setLines.push(`r.completed = ${updates.completed};`);
  if (updates.dueDate)
    setLines.push(`r.dueDate = new Date("${updates.dueDate}");`);
  if (updates.priority !== undefined)
    setLines.push(`r.priority = ${updates.priority};`);

  return `
    const app = Application("Reminders");
    const acct = app.accounts.whose({name: "${account}"})[0];
    const list = acct.lists.whose({name: "${listName}"})[0];
    const r = list.reminders.whose({id: "${reminderId}"})[0];
    ${setLines.join('\n    ')}
    JSON.stringify({ id: r.id(), name: r.name(), completed: r.completed() });
  `;
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

export async function processApplePimRequest(
  request: ApplePimRequest,
): Promise<ApplePimResponse> {
  const config = loadConfig();
  if (!config) {
    return {
      id: request.id,
      success: false,
      error: 'Apple PIM not configured. Run /add-apple-pim to set up.',
    };
  }

  const account = config.accountName;

  try {
    let jxa: string;
    const p = request.params;

    switch (`${request.domain}.${request.action}`) {
      // Calendar
      case 'calendar.list':
        jxa = jxaCalendarList(account);
        break;
      case 'calendar.events':
        jxa = jxaCalendarEvents(
          account,
          p.calendarName as string,
          p.startDate as string,
          p.endDate as string,
        );
        break;
      case 'calendar.create_event':
        jxa = jxaCalendarCreateEvent(
          p.calendarName as string,
          p.summary as string,
          p.startDate as string,
          p.endDate as string,
          p.location as string | undefined,
          p.description as string | undefined,
          p.allDay as boolean | undefined,
        );
        break;
      case 'calendar.update_event':
        jxa = jxaCalendarUpdateEvent(
          p.calendarName as string,
          p.eventUid as string,
          p.updates as Record<string, unknown>,
        );
        break;
      case 'calendar.delete_event':
        jxa = jxaCalendarDeleteEvent(
          p.calendarName as string,
          p.eventUid as string,
        );
        break;

      // Notes
      case 'notes.list_folders':
        jxa = jxaNotesListFolders(account);
        break;
      case 'notes.list_notes':
        jxa = jxaNotesListNotes(account, p.folderName as string);
        break;
      case 'notes.read':
        jxa = jxaNotesRead(account, p.noteId as string);
        break;
      case 'notes.create':
        jxa = jxaNotesCreate(
          account,
          p.folderName as string,
          p.title as string,
          p.body as string,
        );
        break;
      case 'notes.update':
        jxa = jxaNotesUpdate(
          account,
          p.noteId as string,
          p.updates as Record<string, unknown>,
        );
        break;

      // Reminders
      case 'reminders.list_lists':
        jxa = jxaRemindersListLists(account);
        break;
      case 'reminders.list_reminders':
        jxa = jxaRemindersListReminders(
          account,
          p.listName as string,
          p.includeCompleted as boolean | undefined,
        );
        break;
      case 'reminders.create':
        jxa = jxaRemindersCreate(
          account,
          p.listName as string,
          p.name as string,
          p.dueDate as string | undefined,
          p.body as string | undefined,
          p.priority as number | undefined,
        );
        break;
      case 'reminders.update':
        jxa = jxaRemindersUpdate(
          account,
          p.listName as string,
          p.reminderId as string,
          p.updates as Record<string, unknown>,
        );
        break;

      default:
        return {
          id: request.id,
          success: false,
          error: `Unknown action: ${request.domain}.${request.action}`,
        };
    }

    const raw = await runJxa(jxa);
    const data = JSON.parse(raw);
    return { id: request.id, success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { domain: request.domain, action: request.action, err },
      'Apple PIM JXA error',
    );
    return { id: request.id, success: false, error: msg };
  }
}

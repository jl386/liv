/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const REQUESTS_DIR = path.join(IPC_DIR, 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z.string().optional().describe('Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Apple PIM: request/response helpers (main group only)
// ---------------------------------------------------------------------------

const PIM_RESPONSE_POLL_MS = 200;
const PIM_RESPONSE_TIMEOUT_MS = 20_000;

function sendPimRequest(
  domain: string,
  action: string,
  params: Record<string, unknown>,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const request = { id, domain, action, params };

  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  const tempPath = path.join(REQUESTS_DIR, `${id}.json.tmp`);
  const requestPath = path.join(REQUESTS_DIR, `${id}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(request));
  fs.renameSync(tempPath, requestPath);

  // Poll for response
  return new Promise((resolve) => {
    const responsePath = path.join(RESPONSES_DIR, `${id}.json`);
    const start = Date.now();

    const poll = () => {
      if (fs.existsSync(responsePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          resolve(data);
        } catch {
          resolve({ success: false, error: 'Failed to parse response' });
        }
        return;
      }
      if (Date.now() - start > PIM_RESPONSE_TIMEOUT_MS) {
        resolve({ success: false, error: 'Request timed out waiting for host response' });
        return;
      }
      setTimeout(poll, PIM_RESPONSE_POLL_MS);
    };
    poll();
  });
}

function pimResult(resp: { success: boolean; data?: unknown; error?: string }) {
  if (resp.success) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(resp.data, null, 2) }],
    };
  }
  return {
    content: [{ type: 'text' as const, text: `Error: ${resp.error}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Calendar tools
// ---------------------------------------------------------------------------

if (isMain) {
  server.tool(
    'calendar_list',
    "List all calendars available on the assistant's iCloud account.",
    {},
    async () => pimResult(await sendPimRequest('calendar', 'list', {})),
  );

  server.tool(
    'calendar_events',
    'Query calendar events within a date range.',
    {
      calendar_name: z.string().describe('Name of the calendar'),
      start_date: z.string().describe('Start date in ISO format (e.g., "2026-03-27T00:00:00")'),
      end_date: z.string().describe('End date in ISO format (e.g., "2026-03-28T00:00:00")'),
    },
    async (args) => pimResult(await sendPimRequest('calendar', 'events', {
      calendarName: args.calendar_name,
      startDate: args.start_date,
      endDate: args.end_date,
    })),
  );

  server.tool(
    'calendar_create_event',
    'Create a new calendar event.',
    {
      calendar_name: z.string().describe('Name of the calendar to add the event to'),
      summary: z.string().describe('Event title/summary'),
      start_date: z.string().describe('Start date in ISO format'),
      end_date: z.string().describe('End date in ISO format'),
      location: z.string().optional().describe('Event location'),
      description: z.string().optional().describe('Event description/notes'),
      all_day: z.boolean().optional().describe('Whether this is an all-day event'),
    },
    async (args) => pimResult(await sendPimRequest('calendar', 'create_event', {
      calendarName: args.calendar_name,
      summary: args.summary,
      startDate: args.start_date,
      endDate: args.end_date,
      location: args.location,
      description: args.description,
      allDay: args.all_day,
    })),
  );

  server.tool(
    'calendar_update_event',
    'Update an existing calendar event. Only provided fields are changed.',
    {
      calendar_name: z.string().describe('Name of the calendar containing the event'),
      event_uid: z.string().describe('UID of the event to update (from calendar_events)'),
      summary: z.string().optional().describe('New event title'),
      start_date: z.string().optional().describe('New start date in ISO format'),
      end_date: z.string().optional().describe('New end date in ISO format'),
      location: z.string().optional().describe('New location (empty string to clear)'),
      description: z.string().optional().describe('New description (empty string to clear)'),
    },
    async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.summary !== undefined) updates.summary = args.summary;
      if (args.start_date !== undefined) updates.startDate = args.start_date;
      if (args.end_date !== undefined) updates.endDate = args.end_date;
      if (args.location !== undefined) updates.location = args.location;
      if (args.description !== undefined) updates.description = args.description;
      return pimResult(await sendPimRequest('calendar', 'update_event', {
        calendarName: args.calendar_name,
        eventUid: args.event_uid,
        updates,
      }));
    },
  );

  server.tool(
    'calendar_delete_event',
    'Delete a calendar event.',
    {
      calendar_name: z.string().describe('Name of the calendar containing the event'),
      event_uid: z.string().describe('UID of the event to delete (from calendar_events)'),
    },
    async (args) => pimResult(await sendPimRequest('calendar', 'delete_event', {
      calendarName: args.calendar_name,
      eventUid: args.event_uid,
    })),
  );

  // ---------------------------------------------------------------------------
  // Notes tools
  // ---------------------------------------------------------------------------

  server.tool(
    'notes_list_folders',
    "List all note folders in the assistant's iCloud account.",
    {},
    async () => pimResult(await sendPimRequest('notes', 'list_folders', {})),
  );

  server.tool(
    'notes_list',
    'List notes in a specific folder.',
    {
      folder_name: z.string().describe('Name of the notes folder'),
    },
    async (args) => pimResult(await sendPimRequest('notes', 'list_notes', {
      folderName: args.folder_name,
    })),
  );

  server.tool(
    'notes_read',
    'Read the full content of a note.',
    {
      note_id: z.string().describe('ID of the note (from notes_list)'),
    },
    async (args) => pimResult(await sendPimRequest('notes', 'read', {
      noteId: args.note_id,
    })),
  );

  server.tool(
    'notes_create',
    'Create a new note in a folder.',
    {
      folder_name: z.string().describe('Name of the folder to create the note in'),
      title: z.string().describe('Note title'),
      body: z.string().describe('Note body text'),
    },
    async (args) => pimResult(await sendPimRequest('notes', 'create', {
      folderName: args.folder_name,
      title: args.title,
      body: args.body,
    })),
  );

  server.tool(
    'notes_update',
    'Update an existing note. Only provided fields are changed.',
    {
      note_id: z.string().describe('ID of the note to update (from notes_list)'),
      name: z.string().optional().describe('New note title'),
      body: z.string().optional().describe('New note body (replaces entire body)'),
    },
    async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.body !== undefined) updates.body = args.body;
      return pimResult(await sendPimRequest('notes', 'update', {
        noteId: args.note_id,
        updates,
      }));
    },
  );

  // ---------------------------------------------------------------------------
  // Reminders tools
  // ---------------------------------------------------------------------------

  server.tool(
    'reminders_list_lists',
    "List all reminder lists in the assistant's iCloud account.",
    {},
    async () => pimResult(await sendPimRequest('reminders', 'list_lists', {})),
  );

  server.tool(
    'reminders_list',
    'List reminders in a specific list.',
    {
      list_name: z.string().describe('Name of the reminder list'),
      include_completed: z.boolean().optional().describe('Include completed reminders (default: false, shows only incomplete)'),
    },
    async (args) => pimResult(await sendPimRequest('reminders', 'list_reminders', {
      listName: args.list_name,
      includeCompleted: args.include_completed,
    })),
  );

  server.tool(
    'reminders_create',
    'Create a new reminder.',
    {
      list_name: z.string().describe('Name of the reminder list to add to'),
      name: z.string().describe('Reminder title'),
      due_date: z.string().optional().describe('Due date in ISO format (e.g., "2026-03-28T09:00:00")'),
      body: z.string().optional().describe('Reminder notes/body'),
      priority: z.number().optional().describe('Priority: 0=none, 1=high, 5=medium, 9=low'),
    },
    async (args) => pimResult(await sendPimRequest('reminders', 'create', {
      listName: args.list_name,
      name: args.name,
      dueDate: args.due_date,
      body: args.body,
      priority: args.priority,
    })),
  );

  server.tool(
    'reminders_update',
    'Update an existing reminder. Use this to complete reminders too.',
    {
      list_name: z.string().describe('Name of the reminder list containing the reminder'),
      reminder_id: z.string().describe('ID of the reminder to update (from reminders_list)'),
      name: z.string().optional().describe('New reminder title'),
      body: z.string().optional().describe('New reminder notes'),
      completed: z.boolean().optional().describe('Set to true to mark as completed'),
      due_date: z.string().optional().describe('New due date in ISO format'),
      priority: z.number().optional().describe('New priority: 0=none, 1=high, 5=medium, 9=low'),
    },
    async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.body !== undefined) updates.body = args.body;
      if (args.completed !== undefined) updates.completed = args.completed;
      if (args.due_date !== undefined) updates.dueDate = args.due_date;
      if (args.priority !== undefined) updates.priority = args.priority;
      return pimResult(await sendPimRequest('reminders', 'update', {
        listName: args.list_name,
        reminderId: args.reminder_id,
        updates,
      }));
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

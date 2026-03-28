---
name: apple-pim
description: Read, create, and update iCloud calendars, shared notes, and reminders via the assistant's own iCloud account. Main group only.
---

# Apple PIM (Calendar, Notes, Reminders)

You have access to the assistant's iCloud account for managing calendars, notes, and reminders. Items shared between the user and the assistant appear in both accounts automatically via iCloud sharing.

**Important:** These tools are only available in the main group.

## Calendar Tools

| Tool | Purpose |
|------|---------|
| `calendar_list` | List all calendars on the assistant's account |
| `calendar_events` | Query events by date range |
| `calendar_create_event` | Create a new event |
| `calendar_update_event` | Update an existing event |
| `calendar_delete_event` | Delete an event |

### Usage patterns

**Check today's schedule:**
```
calendar_events(calendar_name: "Shared", start_date: "2026-03-27T00:00:00", end_date: "2026-03-28T00:00:00")
```

**Create an event:**
```
calendar_create_event(calendar_name: "Shared", summary: "Team standup", start_date: "2026-03-28T09:00:00", end_date: "2026-03-28T09:30:00", location: "Zoom")
```

**Update an event** (use the `uid` from `calendar_events`):**
```
calendar_update_event(calendar_name: "Shared", event_uid: "ABC-123", summary: "Updated title")
```

## Notes Tools

| Tool | Purpose |
|------|---------|
| `notes_list_folders` | List all note folders |
| `notes_list` | List notes in a folder |
| `notes_read` | Read a note's full content |
| `notes_create` | Create a new note |
| `notes_update` | Update a note's title or body |

### Usage patterns

**Read a shared note:**
```
notes_list(folder_name: "Shared")
notes_read(note_id: "x-coredata://...")
```

**Create a note:**
```
notes_create(folder_name: "Shared", title: "Meeting Notes", body: "Key points from today...")
```

## Reminders Tools

| Tool | Purpose |
|------|---------|
| `reminders_list_lists` | List all reminder lists |
| `reminders_list` | List reminders in a list (incomplete by default) |
| `reminders_create` | Create a new reminder |
| `reminders_update` | Update or complete a reminder |

### Usage patterns

**Check pending reminders:**
```
reminders_list(list_name: "Shared")
```

**Create a reminder with a due date:**
```
reminders_create(list_name: "Shared", name: "Review PR", due_date: "2026-03-28T09:00:00", priority: 1)
```

**Mark a reminder as done:**
```
reminders_update(list_name: "Shared", reminder_id: "x-apple-reminder://...", completed: true)
```

## How It Works

These tools communicate with the host via IPC request/response files. The host executes JXA (JavaScript for Automation) scripts against Calendar.app, Notes.app, and Reminders.app. Responses typically arrive within 1-2 seconds.

## Guidelines

- Always use `calendar_list`, `notes_list_folders`, or `reminders_list_lists` first if you don't know the exact calendar/folder/list name
- Event UIDs and note/reminder IDs are opaque strings — get them from list/query operations
- Dates should be in ISO format without timezone suffix (local time assumed)
- When creating events, always include both `start_date` and `end_date`
- For all-day events, set `all_day: true` and use midnight-to-midnight dates
- Priority values for reminders: 0=none, 1=high, 5=medium, 9=low

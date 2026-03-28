---
name: add-apple-pim
description: Add iCloud Calendar, Notes, and Reminders integration. The assistant gets its own iCloud account and accesses items shared by the user via Apple's native sharing.
---

# Add Apple PIM (Calendar, Notes, Reminders)

Adds the ability for the main-group agent to read, create, and update iCloud calendars, shared notes, and shared reminders. The assistant operates through its own iCloud account — only items explicitly shared by the user are accessible.

## Prerequisites

- macOS host (uses JXA via `osascript`)
- A dedicated Apple ID for the assistant (e.g., `your-assistant@icloud.com`)
- The assistant's iCloud account added to the Mac

## Phase 1: Pre-flight

1. Check if already applied:
   ```bash
   test -f src/apple-pim.ts && echo "ALREADY_APPLIED" || echo "NOT_APPLIED"
   ```
   If `ALREADY_APPLIED`, ask the user if they want to reconfigure. Skip to Phase 3.

2. Verify macOS:
   ```bash
   uname -s
   ```
   Must be `Darwin`. If not, inform the user this skill requires macOS.

3. Verify `osascript` is available:
   ```bash
   which osascript
   ```

## Phase 2: Apply Code Changes

1. Merge the skill branch:
   ```bash
   git fetch https://github.com/qwibitai/nanoclaw-apple-pim.git skill/apple-pim
   git merge FETCH_HEAD --no-edit
   ```

2. Validate the merge:
   ```bash
   npm install && npm run build && npm test
   ```
   If tests fail, investigate and fix before proceeding.

## Phase 3: Configure the Assistant's iCloud Account

Ask the user:
> What is the iCloud account name (email) for the assistant? This should match the account name shown in System Settings > Internet Accounts.

Use AskUserQuestion to get the account name.

1. Write the config:
   ```bash
   mkdir -p data
   cat > data/apple-pim-config.json << 'CONF'
   {
     "accountName": "ACCOUNT_NAME_HERE"
   }
   CONF
   ```
   Replace `ACCOUNT_NAME_HERE` with the user's answer.

2. If the account hasn't been added to the Mac yet, guide the user:
   > To add the assistant's iCloud account:
   > 1. Open **System Settings** > **Internet Accounts**
   > 2. Click **Add Account** > **iCloud**
   > 3. Sign in with the assistant's Apple ID
   > 4. Enable **Calendar**, **Notes**, and **Reminders** (disable Mail, Contacts, etc.)

## Phase 4: Set Up Sharing

Guide the user to share items with the assistant's account:

### Calendar
> To share a calendar with the assistant:
> 1. Open **Calendar.app**
> 2. Right-click the calendar you want to share > **Share Calendar...**
> 3. Add the assistant's iCloud email
> 4. Set permission to **View & Edit**

### Notes
> To share a notes folder with the assistant:
> 1. Open **Notes.app**
> 2. Right-click the folder you want to share > **Share Folder...**
> 3. Add the assistant's iCloud email
> 4. Set permission to **Can make changes**

### Reminders
> To share a reminder list with the assistant:
> 1. Open **Reminders.app**
> 2. Right-click the list you want to share > **Share List...**
> 3. Add the assistant's iCloud email
> 4. Set permission to **View & Edit**

Ask the user to confirm they've completed sharing for each app they want to use.

## Phase 5: Verify

1. Test calendar access:
   ```bash
   osascript -l JavaScript -e '
     const app = Application("Calendar");
     const cals = app.calendars();
     JSON.stringify(cals.map(c => c.name()));
   '
   ```
   Verify the shared calendar appears in the output.

2. Test notes access:
   ```bash
   osascript -l JavaScript -e '
     const app = Application("Notes");
     const accts = app.accounts();
     JSON.stringify(accts.map(a => ({ name: a.name(), folders: a.folders().map(f => f.name()) })));
   '
   ```
   Verify the assistant's account and shared folder appear.

3. Test reminders access:
   ```bash
   osascript -l JavaScript -e '
     const app = Application("Reminders");
     const accts = app.accounts();
     JSON.stringify(accts.map(a => ({ name: a.name(), lists: a.lists().map(l => l.name()) })));
   '
   ```
   Verify the assistant's account and shared list appear.

4. Rebuild and restart:
   ```bash
   npm run build
   ./container/build.sh
   ```

   Restart the service:
   ```bash
   # macOS
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

## Phase 6: Test End-to-End

Send a message to the main group asking the assistant to list calendars, read a note, or check reminders. Verify the agent can successfully use the tools.

## Troubleshooting

### "Apple PIM not configured" error
The config file is missing. Create it:
```bash
echo '{"accountName": "your-assistant@icloud.com"}' > data/apple-pim-config.json
```

### JXA permission errors
macOS may prompt for Calendar/Notes/Reminders access. Grant access in:
**System Settings > Privacy & Security > Automation** — allow Terminal (or your shell) to control Calendar, Notes, and Reminders.

### Shared items not visible
- Verify the sharing invitation was accepted on the assistant's account
- Open Calendar/Notes/Reminders and check the assistant's account shows the shared items
- iCloud sync may take a few minutes after sharing

### Timeout errors
JXA scripts have a 15-second timeout. If Calendar/Notes/Reminders has many items, queries may be slow. Use narrower date ranges for calendar queries.

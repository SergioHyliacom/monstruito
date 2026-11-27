<p align="center">
  <img src="assets/logo.png" width="180" alt="Monstruito, a black cat looking up">
</p>

<h1 align="center">Monstruito</h1>

An [Orca](https://github.com/stablyai/orca) plugin that gets your projects ready to work on, and wraps up the day when you finish. In every project you select, in this order:

1. **Git**: pulls the current branch's changes, or only fetches them, or leaves git alone.
2. **Dependencies**: if moving forward changed a lockfile, or if they are missing (a fresh clone), installs them and waits for it to finish.
3. **Setup commands**: the project's background commands (`docker compose up -d`, migrations…), waiting for each one.
4. **Worktrees**: if you ask for it, tells how many commits each of the other worktrees is behind.
5. **Agent**: opens Claude (or another agent) the way you choose. With the **brief**, the agent finishes the job: it upgrades dependencies, fixes what failed and tells you the next item (see [Brief and wrap-up](#brief-and-wrap-up)).
6. **Tab commands**: the project's long-running commands (`npm run dev`…), each in its own tab, and if you want it opens their web page in Orca's browser.

When it finishes it can show you a project to start working there. At the end of the day, **Wrap up** asks each agent for a note for tomorrow, reports what is not committed or pushed, and closes agents and tabs.

## Install

```sh
orca plugin install SergioHyliacom/monstruito
```

Monstruito runs code on your machine (git, installs, commands), so Orca asks you to approve its permissions: the command above answers with the exact command, with `--approve`, to do it. Then the **Monstruito** panel shows up in the sidebar (cat icon).

Requires Orca 1.4.274 or later.

The first time you open the panel it asks whether to start when Orca opens or only by hand.

## Usage

In the **Monstruito** panel (cat icon):

- **Profile:** choose which set of projects you work with (for example Work or Home), or create one with **+**.
- **Choosing projects:** tick the boxes in the tree. It goes by folders, from most to least recent according to your activity in Orca; folders collapse and the open ones are remembered. **Select all N** selects a whole folder. Selected projects move to a separate list at the top.
- **Run now:** does the same as when Orca opens, with the chosen profile. While it runs, the panel shows which project is at which step.
- **Check commits:** fetches and counts the commits not applied, without moving anything or opening agents.
- **Wrap up:** the end-of-day routine (see [Brief and wrap-up](#brief-and-wrap-up)).
- **Stop:** stops what is running. What's done stays; what's left doesn't start.
- **History:** the last run and, collapsed, the 9 before it. The last run follows what you do afterwards: commits you pull by hand stop showing as not applied, and with the brief each project shows **Ready** and its next item once the agent is done.
- **Reload projects** (↻): asks Orca for the projects again and clears the search. The panel also updates on its own when Orca reports that a workspace was created or removed.
- **Settings** (⚙): those of all profiles or of the chosen profile, plus export and import.
- **A project's settings and commands:** the gear next to it.
- **Close tabs (N):** closes at once the command tabs Monstruito opened. Agents stay open: **Wrap up** closes them after their note.

## Commands

Each project has its own list of commands, in its gear, **Commands** tab. They apply in every profile; a profile can turn them all off with "Run each project's commands".

- **Type:** *in its own tab* (servers, watchers: opened at the end and not waited for) or *setup* (in the background before opening the agent, waiting for it to finish; if it fails, it's reported and the rest goes on).
- **When:** always, only when commits come in, or only when certain files change. Files are relative to the project root, separated by commas: `folder/` is everything inside, and `*` (within a folder) and `**` (at any depth) work. For example `database/migrations/` for `php artisan migrate`.
- **Restart if already open:** closes its tab and opens it again. It only works with the tabs Monstruito opened.
- **Open the web page when it's ready:** before opening the tab it looks at the workspace's ports; then it waits (up to 2 minutes) for a new one and opens its address in Orca's browser, in the background, without moving you from where you are.
- **Suggestions:** when you open the gear it suggests commands based on the project. First the ones the agent proposed during a brief (marked *Claude*), then the ones from fixed rules: scripts from `package.json` (with npm, pnpm, yarn or bun depending on the lockfile) and `composer.json`, Laravel (`artisan`), docker compose, Makefile, Flutter, Django, Cargo and Go. One click adds them; nothing runs until you add it.

A command tab is called "Monstruito: name" (or the command, if it has no name); that's how it knows whether it's already open.

The status bar shows the summary of the last run or check. Clicking it runs the startup.

By default no project is selected, so installing it does nothing until you choose.

## Brief and wrap-up

The routine above is mechanical. The brief and the wrap-up hand the rest to the agent, and make a loop from one day to the next.

**Start.** Set **What the agent does** to *Get the project ready (brief)*. After git, dependencies and setup commands, Monstruito sends each project's agent one brief:

1. Upgrade the dependencies within their declared ranges, design systems, fonts and UI libraries included, run the project's checks, and roll back any upgrade that breaks something.
2. Update the plugins the project uses.
3. Clean up only what tools regenerate (caches, build output).
4. Fix what failed in the routine.
5. Find the next item: from yesterday's wrap-up note first, then the open requests of the [Requests](https://github.com/sydneydesign/requests) plugin for that project, then branches, TODOs and recent commits.
6. If the project has no commands in Monstruito yet, propose them, without running them.

The brief tells the agent never to delete your files, commit, push, reset or stash without asking. If the agent is already open and idle, the brief goes to it; if it is working, it is left alone. Each agent writes `.monstruito/ready.md` when it is done. The panel shows **Ready** and the next item per project, and you get one notification when every project is ready (or after 90 minutes). With the brief, that notification replaces the usual one at the end of the run.

**Wrap up.** At the end of the day, **Wrap up** goes through the selected projects:

1. It asks each idle agent to write `.monstruito/next.md`: where you stopped and what comes next. An agent that is working is not interrupted.
2. It reports uncommitted files, new files and unpushed commits. It only looks: it never commits or pushes.
3. It closes the agents that wrote their note and the command tabs Monstruito opened. Orca only lets a plugin close the terminals it opened, or the ones in the workspace on screen, so others stay open and are counted.

The next brief reads that note. Both notes live in `.monstruito/` in each project, which Monstruito adds to the repository's local exclude file (`.git/info/exclude`), so git never sees them and they are never committed.

## Profiles

Each profile has its selected projects and also:

- **Days:** when Orca opens on those days that profile is used (for example Work Monday to Friday and Home at weekends). A day can only belong to one profile; on days without a profile the one chosen in the panel is used.
- **When done, show:** nothing, the most recently used selected project, or a specific one. Only when Orca opens, so it doesn't move you around when you run it by hand.
- **Own settings:** any general setting can be different in that profile.

Settings apply in three layers: **all profiles** (the ones in Settings) → **the profile** → **the project**. A project's settings apply in every profile, because they describe the project (its startup command, for example).

Projects selected with earlier versions move to a "Main" profile.

## Export and import

In **Settings → Export or import**:

- **Export** saves the profiles, the settings of all profiles and those of each project to a file.
- **Import:** paste the file's contents (Orca panels can't open files). Projects are matched by path and, failing that, by name, so it works on another machine; if two have the same name, it doesn't guess. It replaces what's there, but saves a copy first: **Undo the last import** brings it back.

## Settings

All of them can be changed in a profile. The column says which ones can also be changed per project.

| Setting | Per project | What it does |
| --- | --- | --- |
| Run when Orca opens | no | Off by default; the panel asks the first time. When off, it only runs by hand |
| Delay when Orca opens | no | Seconds Orca gets to load before starting |
| Projects at a time | no | How many projects are processed in parallel |
| Notify when done | no | Notification with the summary, and when the periodic check finds new commits |
| Check for new commits every | no | While Orca is open, checks every so many minutes (0 = never) |
| Seconds between agents | no | Wait between opening one agent and the next |
| What to do with git | yes | Fetch and fast-forward the branch · Fetch only, without moving the branch · Don't touch git |
| Rebase if the branch has diverged | yes | Off by default. If you have local commits and the remote has new ones, `git rebase --no-autostash @{u}`; on a conflict, `git rebase --abort` and the branch stays as it was |
| Skip if there are uncommitted changes | yes | Pulls nothing if tracked files are modified |
| All branches, and prune deleted ones | yes | `git fetch --all --prune` |
| Update submodules | yes | `git submodule update --init --recursive` after moving forward |
| Report unpushed commits | yes | On by default. Counts the local commits that are not on the remote (`@{u}..HEAD`); read-only |
| Report on the other worktrees | yes | How many commits each one is behind; doesn't move them |
| Agent | yes | Claude, Codex, Copilot, Cursor, OpenCode… |
| What the agent does | yes | Open and wait · Summarize the new commits · Always send my prompt · Resume the last session · Get the project ready (brief) · Don't open an agent |
| Only if there are new commits | yes | The agent only opens where commits came in |
| Startup prompt | yes | Variables: `{project}`, `{branch}`, `{upstream}`, `{n_commits}`, `{commits}` (the Spanish names from earlier versions still work). With the brief, it is added as extra instructions |
| Install dependencies when they change | yes | Root lockfiles → `npm install`, `pnpm install`, `yarn install`, `bun install`, `composer install`, `flutter pub get`/`dart pub get`, `bundle install`, `poetry install`, `uv sync` |
| Install missing dependencies | yes | No `node_modules`, `vendor`, `.dart_tool` or `.venv` → its install, even when git brings nothing |
| Run each project's commands | yes | When off, none of its commands run |

To keep the agent out of it, set **What the agent does** to *Don't open an agent*; *Open and wait* opens it without sending anything.

## What it never does

- **It never commits or pushes.** Neither the run nor the wrap-up does, and the brief tells the agent to ask you before committing, pushing, deleting, resetting or stashing. With the brief, the agent does upgrade dependencies, so lockfiles change.
- **It doesn't merge branches or rebase, unless you ask for it:** fast-forward only (`git merge --ff-only --no-autostash @{u}`). If the branch has diverged, or if moving forward would overwrite uncommitted changes, git refuses and the project stays as it was. With "Rebase if the branch has diverged" on, a diverged branch is rebased onto the remote; on a conflict it's undone with `git rebase --abort`, and Stop never cuts a rebase halfway.
- **It doesn't touch branches without an upstream.**
- **It doesn't ask for credentials:** if git needs them, the fetch fails and it's reported.
- **It doesn't open a second agent** in a project that already has one open, or a second tab for a command (unless you ask to restart it). It never writes to an agent that is working.
- **It doesn't repeat the startup** if the plugin's worker restarts while Orca is open. It only runs again when Orca opens again or after restarting the computer.
- **It only acts on each project's main checkout.** The other worktrees are, at most, queried.

The prompt is sent as a single line: line breaks become spaces so the agent doesn't get it in pieces.

## How it works

Orca starts the plugin's worker as soon as the plugin is active (when Orca opens), because the manifest declares a status bar item. The worker's `activate` function is therefore the "when Orca opens" moment.

| File | What it does |
| --- | --- |
| `orca-plugin.json` | Manifest: panel, commands, status bar, events, settings and permissions |
| `src/worker.ts` | Startup, protection against repeats, profiles, progress and Stop, history, periodic check, notifications and panel requests |
| `src/run.ts` | One run: git, dependencies, setup, worktrees, agent and tabs, project by project |
| `src/commands.ts` | Each project's commands: safe reading, tab title and when they apply |
| `src/suggest.ts` | Which commands to suggest by looking at package.json, composer.json, Makefile… |
| `src/cli.ts` | What goes through Orca's CLI: the agent with a model, ports and the browser |
| `src/profiles.ts` | Profiles: safe reading, the day's profile and what to show when done |
| `src/transfer.ts` | Export and import, matching projects by path and name |
| `src/git.ts` | Fetch, fast-forward (or rebase if asked), submodules, commits not applied and unpushed, uncommitted work |
| `src/brief.ts` | The brief sent to the agent, and the wrap-up request |
| `src/notes.ts` | The agent's notes in `.monstruito/`, their local git exclude, proposed commands and the Requests list |
| `src/deps.ts` | What to install (lockfiles that changed or missing dependencies) and running it |
| `src/settings.ts` | Defaults, validation, per-project inheritance, panel fields and prompt variables |
| `src/tree.ts` | The panel's folder tree |
| `src/describe.ts` | The texts of the panel, the status bar and the notifications |
| `src/panel.tsx` | The panel |
| `src/protocol.ts` | The contract between panel and worker |

Permissions it asks for:

| Permission | What for |
| --- | --- |
| `workspace:read` | See your projects and workspaces, and learn about the ones created or removed |
| `workspace:write` | Show a project when the startup finishes |
| `agent:read` | See whether an agent is already open |
| `agent:launch` | Open or resume the agent |
| `history:read` | Find your last session (titles and dates only, never the conversation) |
| `terminal:send` | Open the commands in their tabs and close the ones it opened, and send the brief or the wrap-up request to an agent that is already open and idle |
| `notifications:show` | The notification when done |
| `storage:own` and `settings:own` | Save the selection, own settings, results and settings |

The worker runs as a Node process under your user (`trusted-worker`): that's what lets it run `git` and the installs.

## Development

```sh
orca plugin validate .     # checks the manifest, without running code
orca plugin test .         # tests in src/*.test.ts(x) with orca/testing
orca plugin check .        # renders the panel in each scenario of src/panel.check.ts
orca plugin dev load .     # loads this folder into Orca; reloads on save
orca plugin logs local.monstruito   # when loaded as a development folder
```

`orca plugin test` and `orca plugin check` run the plugin's code on your machine, outside Orca's sandbox.

## Credits

- The panel icon is the cat from [Lucide](https://lucide.dev), under the ISC license (© Lucide Icons and Contributors).

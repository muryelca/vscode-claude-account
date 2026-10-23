# DJ Claude Account Switcher

Use more than one [Claude Code](https://code.claude.com) account in VS Code, one per window. Name your accounts (for example **Work** and **Personal**), pick one for each window, and every Claude Code chat in that window uses that account. The status bar shows the active account and your session and weekly usage limits.

## Features

- **Guided setup.** On first run the extension finds the Claude Code accounts already signed in on your computer, lets you choose and name them, and adds new ones for you to sign in to.
- **One account per window.** Each VS Code window remembers its own profile. Parallel workspaces never interfere with each other.
- **Every chat follows the window.** New Claude Code chats, the Claude Code panel after a reload, and new integrated terminals (`claude` in the terminal) all use the selected account.
- **Usage at a glance.** The status bar shows the 5-hour session and 7-day weekly usage. The tooltip adds per-model limits, reset times, plan and organization.
- **Shared setup.** Skills, agents, plugins, memory, history and `settings.json` stay shared between profiles. Only the sign-in is separate.
- **Color warnings.** The status bar turns yellow when a limit reaches your threshold and red at 100%.
- **Safe by design.** The extension never refreshes, writes or logs tokens.

## Requirements

- VS Code `>= 1.90.0`.
- The [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension.
- One Claude account per profile (Pro, Max, Team or Enterprise).

## How it works

Claude Code reads its sign-in and configuration from the directory in the `CLAUDE_CONFIG_DIR` environment variable, which defaults to `~/.claude`. The Claude Code extension starts a new CLI process for each chat and passes it the environment of the VS Code extension host.

DJ Claude Account Switcher starts with the window, before the first chat, and sets `CLAUDE_CONFIG_DIR` in that environment to the directory of the profile chosen for the window. The default profile keeps the regular `~/.claude`.

The first time you switch to a profile with its own directory, the extension prepares it:

1. It creates the directory, for example `~/.claude-profiles/personal`.
2. It links every folder of `~/.claude` (projects, skills, agents, plugins and the rest) into it with junctions on Windows and symbolic links elsewhere, so memory and history stay shared.
3. It copies `.claude.json` without the account, API keys and caches.
4. It keeps `settings.json`, `CLAUDE.md` and `skills-lock.json` identical on both sides. The newest copy wins and the replaced one is saved as `.bak`.

Credentials are never copied. You sign in once per profile and the token stays in that profile's directory.

## Getting started

1. Install the extension. A notification offers **Set Up Accounts** (you can also run **DJ Claude Account: Set Up Accounts** at any time).
2. **Choose accounts.** The extension lists every Claude Code account it finds on this computer, with its email and organization. Keep the ones you want.
3. **Name them.** Give each account the name you want to see in the status bar. Suggestions are filled in for you.
4. **Add new accounts.** Add any account that is not signed in on this computer yet. The extension creates a profile directory for it.
5. **Pick the default** for windows that have not chosen a profile yet.
6. To sign in to a new account, switch a window to it (the extension offers to do it) and sign in from the Claude Code panel. The sign-in is saved in that profile only.
7. From then on, click the account item in the status bar to switch the window to another profile, and reload the window when asked. New chats use the new account right away; open chats, open terminals and the Claude Code panel pick it up after the reload.

Add more accounts later with **DJ Claude Account: Add Account**.

## Status bar

| Item | Meaning |
|---|---|
| `Work  5h 12%  7d 34%` | Profile name, 5-hour session usage and 7-day weekly usage. |
| `Opus 92%` | A per-model limit, shown only when it crosses your warning threshold. |
| History icon | The usage data is more than an hour old. |
| Warning icon and `signed out` | The profile has no sign-in on this machine yet. |
| Alert icon | The directory is signed in with a different account than expected, or something overrides the profile (see Troubleshooting). |
| Restart icon and `reload` | You switched profiles. Reload the window to move open chats and terminals. |

Hover the item for the full picture: email, organization, plan, every limit with its reset time, where the data came from and how old it is, and the profile directory. Click it for the menu.

## Usage data

Usage comes first from the cache Claude Code itself writes to `.claude.json` every time it opens a chat. When that cache is more than five minutes old, the extension asks `https://api.anthropic.com/api/oauth/usage` with the profile's token:

- at most once every five minutes per profile, coordinated across all windows,
- honoring `Retry-After`, and pausing five minutes after a `429`,
- pausing after a `401` until the profile signs in again.

This endpoint shares its rate limit with the `/usage` command of Claude Code, so the pace is deliberately conservative. Set `claudeAccount.usage.liveQueries` to `false` if you prefer that nothing but Claude Code uses the account token; the status bar then shows only the cached data.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `claudeAccount.profiles` | array | `[]` (filled in by **Set Up Accounts**) | Profiles with `name`, an optional `email` used to detect a wrong sign-in, and `configDir` (empty means `~/.claude`). |
| `claudeAccount.defaultProfile` | string | `""` | Profile used by a window that has not picked one yet. Empty uses the first profile. |
| `claudeAccount.usage.liveQueries` | boolean | `true` | Fetch live usage when the Claude Code cache is stale. |
| `claudeAccount.usage.liveMinIntervalMinutes` | number | `5` | Minimum minutes between live requests for the same profile, across all windows. |
| `claudeAccount.usage.refreshIntervalSeconds` | number | `60` | Seconds between local reads of the cache and the credentials. |
| `claudeAccount.usage.warnAtPercent` | number | `80` | Percentage that turns the status bar yellow. |
| `claudeAccount.applyToTerminals` | boolean | `true` | Apply the profile to integrated terminals created after the selection. |
| `claudeAccount.profileDir.syncFiles` | array | `settings.json`, `CLAUDE.md`, `skills-lock.json` | Files kept identical between `~/.claude` and each profile. Credentials, `.claude.json` and `config.json` are always refused. |

The setup writes these settings for you. You can also edit them by hand:

```json
"claudeAccount.profiles": [
  { "name": "Work", "email": "me@company.com" },
  { "name": "Personal", "email": "me@gmail.com", "configDir": "~/.claude-profiles/personal" }
],
"claudeAccount.defaultProfile": "Work"
```

## Commands

| Command | Title |
|---|---|
| `claudeAccount.setup` | DJ Claude Account: Set Up Accounts |
| `claudeAccount.addAccount` | DJ Claude Account: Add Account |
| `claudeAccount.menu` | DJ Claude Account: Account Menu |
| `claudeAccount.switch` | DJ Claude Account: Switch Profile for This Window |
| `claudeAccount.refreshUsage` | DJ Claude Account: Refresh Usage |
| `claudeAccount.repairProfile` | DJ Claude Account: Prepare or Repair Profile Directory |
| `claudeAccount.showLogs` | DJ Claude Account: Show Logs |

## Troubleshooting

| Symptom | Fix |
|---|---|
| A chat still uses the previous account. | Reload the window. Chats that were already open keep the account they started with. |
| The `claude` command in a terminal uses the wrong account. | Close the terminal and open a new one. Only terminals created after the switch get the new profile. |
| `signed out` in the status bar. | Open Claude Code in that window and sign in with the profile's account. |
| Alert icon with "Signed in here as ...". | The profile directory is signed in with another account. Sign out in Claude Code and sign in with the right one. |
| Alert icon about `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `apiKeyHelper`. | These override any profile sign-in in every window. Remove them to let the profiles work. |
| Alert icon about `claudeCode.environmentVariables`. | That Claude Code setting applies to every window. Remove `CLAUDE_CONFIG_DIR` from it. |
| Usage shows the history icon and does not update. | Live requests are paused after a rate limit or a rejected token. Use a chat once, or run **Refresh Usage**. |
| Anything else. | Run **DJ Claude Account: Show Logs**. Every step is logged, tokens never are. |

## Known limitations

- A switch applies to new processes. Open chats and terminals keep the previous account until the window reloads.
- `claudeCode.environmentVariables` and `claudeCode.claudeProcessWrapper` are machine-wide Claude Code settings and win over this extension in every window. The status bar warns when they are set.
- Plans without a weekly or per-model limit show only the limits the API returns.
- The extension activates on startup (`*`) on purpose: it must set the environment before Claude Code opens its first chat.

## Privacy

The extension reads the profile's `.claude.json` and credentials locally. The only network request it makes is the usage request to `api.anthropic.com`, with the profile's own token, and you can turn it off. Nothing is sent anywhere else.

## License

[MIT](LICENSE)

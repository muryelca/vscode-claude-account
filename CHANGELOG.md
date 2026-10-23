# Changelog

All notable changes to the **DJ Claude Account Switcher** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-23

### Added

- Initial release.
- Guided setup on first run: detects the Claude Code accounts signed in on the computer, lets the user choose and name them, adds new accounts and picks the default profile. Commands **Set Up Accounts** and **Add Account**.
- One Claude Code profile per VS Code window, stored in the workspace state and applied through `CLAUDE_CONFIG_DIR` to the extension host and to new integrated terminals.
- Profile directories with junctions (symbolic links outside Windows) to every folder of `~/.claude`, a `.claude.json` seeded without the account, API keys and caches, and `settings.json`, `CLAUDE.md` and `skills-lock.json` kept in sync by modification time with a `.bak` of the replaced copy.
- Status bar item with the profile name, 5-hour session usage and 7-day weekly usage, plus a tooltip with per-model limits, reset times, plan, organization, data age and profile directory.
- Usage read first from the Claude Code cache, with conservative live requests to `/api/oauth/usage` coordinated across windows, honoring `Retry-After` and pausing after `429` and `401`.
- Credentials read from the file or from Windows Credential Manager, including chunked entries.
- Warnings when `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper` or machine-wide Claude Code settings override the profile sign-in.
- Commands: Set Up Accounts, Add Account, Account Menu, Switch Profile for This Window, Refresh Usage, Prepare or Repair Profile Directory, Show Logs.

[Unreleased]: https://github.com/muryelca/vscode-claude-account/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/muryelca/vscode-claude-account/releases/tag/v1.0.0

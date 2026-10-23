import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { prepareProfileDir } from './claudeDir';
import { PowerShellRunner, runPowerShell } from './credman';
import { EnvVars, InheritedEnvCapture, applyToProcessEnv, captureInheritedEnv, envVarsFor, terminalVarsFor } from './env';
import { StatusView } from './format';
import { AccountSnapshot, readAccountSnapshot } from './monitor';
import { detectAuthOverrides } from './overrides';
import { Profile, ProfilePaths, defaultConfigDir, findProfile, normalizeProfiles, profilePaths, resolveActiveProfile } from './profiles';
import { runAddAccount, runSetupWizard } from './setupWizard';
import { AccountStatusBar } from './statusBar';

export interface ControllerDeps {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly runPowerShell: PowerShellRunner;
  readonly now: () => number;
}

export const EXTENSION_ID = 'muryelca.dj-claude-account-switcher';
const SECTION = 'claudeAccount';
const STORED_PROFILE_KEY = 'claudeAccount.profileName';
const SETUP_DISMISSED_KEY = 'claudeAccount.setupDismissed';
const SETUP_PROMPTED_AT_KEY = 'claudeAccount.setupPromptedAt';
const SETUP_PROMPT_COOLDOWN_MS = 10 * 60_000;
const FALLBACK_PROFILE: Profile = { name: 'Default' };
const DEFAULT_PROFILE_NAME = '';
const DEFAULT_SYNC_FILES = ['settings.json', 'CLAUDE.md', 'skills-lock.json'];
const FILE_WATCH_INTERVAL_MS = 5000;
const FOCUS_REFRESH_AFTER_MS = 60_000;
const FOCUS_SYNC_AFTER_MS = 5 * 60_000;
const OPEN_CLAUDE_COMMAND = 'claude-vscode.editor.openLast';

interface Settings {
  readonly profiles: readonly Profile[];
  readonly defaultProfile: string;
  readonly refreshIntervalSeconds: number;
  readonly warnAtPercent: number;
  readonly applyToTerminals: boolean;
  readonly syncFiles: readonly string[];
  readonly liveQueries: boolean;
  readonly liveMinIntervalMs: number;
}

interface MenuItem extends vscode.QuickPickItem {
  readonly run?: () => unknown;
}

interface InFlightRefresh {
  readonly generation: number;
  readonly promise: Promise<void>;
}

interface WatchedFile {
  readonly file: string;
  readonly listener: () => void;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function readSettings(home: string): Settings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const rawSync = config.get<unknown>('profileDir.syncFiles');
  const rawDefault = config.get<unknown>('defaultProfile');
  return {
    profiles: normalizeProfiles(config.get<unknown>('profiles'), home),
    defaultProfile: typeof rawDefault === 'string' && rawDefault.trim() ? rawDefault.trim() : DEFAULT_PROFILE_NAME,
    refreshIntervalSeconds: clampNumber(config.get<unknown>('usage.refreshIntervalSeconds'), 60, 30, 3600),
    warnAtPercent: clampNumber(config.get<unknown>('usage.warnAtPercent'), 80, 1, 100),
    applyToTerminals: config.get<unknown>('applyToTerminals') !== false,
    syncFiles: Array.isArray(rawSync) ? rawSync.filter((name): name is string => typeof name === 'string') : DEFAULT_SYNC_FILES,
    liveQueries: config.get<unknown>('usage.liveQueries') !== false,
    liveMinIntervalMs: clampNumber(config.get<unknown>('usage.liveMinIntervalMinutes'), 5, 2, 120) * 60_000,
  };
}

export class AccountController implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly statusBar: AccountStatusBar;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly inherited: InheritedEnvCapture;
  private settings: Settings;
  private profile: Profile = FALLBACK_PROFILE;
  private paths: ProfilePaths;
  private envVars: EnvVars = {};
  private snapshot?: AccountSnapshot;
  private overrideWarnings: string[] = [];
  private loading = true;
  private pendingReload = false;
  private generation = 0;
  private inFlight?: InFlightRefresh;
  private timer?: NodeJS.Timeout;
  private watched: WatchedFile[] = [];
  private lastRefreshAt = 0;
  private lastSyncAt = 0;
  private loginHintShown = false;
  private switching = false;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: ControllerDeps,
  ) {
    this.output = vscode.window.createOutputChannel('DJ Claude Account Switcher');
    this.disposables.push(this.output);
    this.settings = readSettings(deps.home);
    const knownDirs = this.settings.profiles.map((profile) => profile.configDir).filter((dir): dir is string => dir !== undefined);
    this.inherited = captureInheritedEnv(deps.env, knownDirs, deps.platform);
    if (this.inherited.discardedReason) {
      this.log(`activating; ${this.inherited.discardedReason}, value discarded`);
    } else {
      this.log(`activating; CLAUDE_CONFIG_DIR inherited from VS Code: ${this.inherited.configDir ?? '(none)'}`);
    }
    const stored = context.workspaceState.get<string>(STORED_PROFILE_KEY);
    const resolution = resolveActiveProfile(this.settings.profiles, stored, this.settings.defaultProfile);
    if (!resolution) {
      this.log('no profile configured in claudeAccount.profiles, using the default directory');
    } else if (resolution.staleStoredName) {
      this.log(`stored profile "${resolution.staleStoredName}" no longer exists, using "${resolution.profile.name}" (${resolution.reason})`);
    } else {
      this.log(`profile for this window: "${resolution.profile.name}" (${resolution.reason})`);
    }
    this.paths = profilePaths(FALLBACK_PROFILE, this.inherited, deps.home);
    this.applyProfile(resolution?.profile ?? FALLBACK_PROFILE);
    this.statusBar = new AccountStatusBar();
    this.disposables.push(this.statusBar);
    this.render();
  }

  start(): void {
    this.registerCommands();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(SECTION) || event.affectsConfiguration('claudeCode')) {
          void this.onSettingsChanged();
        }
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.onFocus();
        }
      }),
    );
    this.startTimer();
    void this.checkOverrides()
      .then(() => this.ensureProfileDir(false))
      .then(() => this.refresh('activation'))
      .then(() => (this.maybePromptSetup() ? undefined : this.maybeShowLoginHint()));
  }

  needsSetup(): boolean {
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>('profiles');
    return inspected?.globalValue === undefined && this.settings.profiles.length === 0;
  }

  private maybePromptSetup(): boolean {
    if (!this.needsSetup() || this.context.globalState.get<boolean>(SETUP_DISMISSED_KEY)) {
      return false;
    }
    const lastPrompt = this.context.globalState.get<number>(SETUP_PROMPTED_AT_KEY) ?? 0;
    if (this.deps.now() - lastPrompt < SETUP_PROMPT_COOLDOWN_MS) {
      return true;
    }
    void this.context.globalState.update(SETUP_PROMPTED_AT_KEY, this.deps.now());
    void vscode.window
      .showInformationMessage(
        'DJ Claude Account Switcher: set up your Claude accounts to use a different one in each window. Accounts already signed in on this computer are detected for you.',
        'Set Up Accounts',
        'Later',
        "Don't Ask Again",
      )
      .then((choice) => {
        if (choice === 'Set Up Accounts') {
          void this.runSetup();
        } else if (choice === "Don't Ask Again") {
          void this.context.globalState.update(SETUP_DISMISSED_KEY, true);
        }
      });
    return true;
  }

  async runSetup(): Promise<void> {
    const result = await runSetupWizard(this.deps.home, this.inherited.configDir, (message) => this.log(message));
    if (!result) {
      this.log('setup cancelled');
      return;
    }
    const config = vscode.workspace.getConfiguration(SECTION);
    await config.update('profiles', result.profiles, vscode.ConfigurationTarget.Global);
    await config.update('defaultProfile', result.defaultProfile, vscode.ConfigurationTarget.Global);
    await this.context.globalState.update(SETUP_DISMISSED_KEY, true);
    this.log(`setup saved: ${result.profiles.map((profile) => profile.name).join(', ')} (default ${result.defaultProfile})`);
    await this.onSettingsChanged();
    const firstNew = result.newAccounts[0];
    const summary = `${result.profiles.length} account(s) set up. This window uses "${this.profile.name}".`;
    if (!firstNew) {
      void vscode.window.showInformationMessage(`${summary} Click the account in the status bar to switch.`);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `${summary} To sign in to "${firstNew}", switch this window to it and sign in in Claude Code.`,
      `Switch to ${firstNew}`,
      'Later',
    );
    const target = findProfile(this.settings.profiles, firstNew);
    if (choice === `Switch to ${firstNew}` && target) {
      await this.switchTo(target);
    }
  }

  async addAccount(): Promise<void> {
    if (this.needsSetup()) {
      await this.runSetup();
      return;
    }
    const profile = await runAddAccount(this.deps.home, this.settings.profiles);
    if (!profile) {
      return;
    }
    const config = vscode.workspace.getConfiguration(SECTION);
    const current = config.get<unknown>('profiles');
    const list = Array.isArray(current) ? [...current, profile] : [profile];
    await config.update('profiles', list, vscode.ConfigurationTarget.Global);
    this.settings = readSettings(this.deps.home);
    this.log(`account "${profile.name}" added`);
    const target = findProfile(this.settings.profiles, profile.name);
    const choice = await vscode.window.showInformationMessage(`Account "${profile.name}" added. Switch this window to it and sign in in Claude Code?`, `Switch to ${profile.name}`, 'Later');
    if (choice === `Switch to ${profile.name}` && target) {
      await this.switchTo(target);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.unwatchFiles();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  currentProfileName(): string {
    return this.profile.name;
  }

  currentEnvVars(): EnvVars {
    return this.envVars;
  }

  refresh(reason: string, manual: boolean = false): Promise<void> {
    const generation = this.generation;
    if (this.inFlight && this.inFlight.generation === generation && !manual) {
      return this.inFlight.promise;
    }
    const previous = this.inFlight?.promise ?? Promise.resolve();
    const promise = previous.catch(() => undefined).then(() => this.doRefresh(reason, manual, generation));
    const entry: InFlightRefresh = { generation, promise };
    this.inFlight = entry;
    void promise.finally(() => {
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    });
    return promise;
  }

  async switchTo(profile: Profile): Promise<void> {
    if (this.switching) {
      void vscode.window.showInformationMessage('Wait for the current profile switch to finish.');
      return;
    }
    if (profile.name === this.profile.name) {
      void vscode.window.showInformationMessage(`Profile "${profile.name}" is already active in this window.`);
      return;
    }
    this.switching = true;
    try {
      const previousProfile = this.profile;
      const previousSnapshot = this.snapshot;
      this.applyProfile(profile);
      this.snapshot = undefined;
      this.loading = true;
      this.render();
      if (!(await this.ensureProfileDir(true))) {
        this.applyProfile(previousProfile);
        this.snapshot = previousSnapshot;
        this.loading = false;
        this.render();
        void this.refresh('switch rollback');
        return;
      }
      await this.context.workspaceState.update(STORED_PROFILE_KEY, profile.name);
      this.pendingReload = true;
      this.loginHintShown = false;
      this.log(`this window now uses "${profile.name}" (stored in workspaceState)`);
      await this.refresh('profile switch');
      this.maybeShowLoginHint();
      const openTerminals = vscode.window.terminals.length > 0;
      void vscode.window
        .showInformationMessage(
          `Profile "${profile.name}" is active in this window. New Claude Code chats already use this account. Reload the window so open chats${openTerminals ? ', open terminals' : ''} and the Claude Code panel pick it up too.`,
          'Reload Window',
          'Later',
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    } finally {
      this.switching = false;
    }
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date(this.deps.now()).toISOString()}] ${message}`);
  }

  private applyProfile(profile: Profile): void {
    this.generation += 1;
    this.profile = profile;
    this.paths = profilePaths(profile, this.inherited, this.deps.home);
    this.envVars = envVarsFor(profile, this.inherited, this.deps.platform);
    const changes = applyToProcessEnv(this.envVars, this.deps.env);
    this.log(`profile "${profile.name}" applied to the extension host${changes.length ? `: ${changes.join(', ')}` : ' (environment unchanged)'}`);
    this.applyTerminalEnv();
    this.watchFiles();
  }

  private applyTerminalEnv(): void {
    const collection = this.context.environmentVariableCollection;
    collection.description = 'Claude Code profile selected for this window (applies to new terminals)';
    if (!this.settings.applyToTerminals) {
      collection.clear();
      return;
    }
    for (const [name, value] of Object.entries(terminalVarsFor(this.envVars))) {
      if (value === undefined) {
        collection.delete(name);
      } else {
        collection.replace(name, value);
      }
    }
  }

  private watchFiles(): void {
    this.unwatchFiles();
    if (this.disposed) {
      return;
    }
    for (const file of [this.paths.credentialsFile, this.paths.configFile]) {
      const listener = () => {
        this.log(`${path.basename(file)} changed, refreshing`);
        void this.refresh('file changed');
      };
      fs.watchFile(file, { interval: FILE_WATCH_INTERVAL_MS, persistent: false }, listener);
      this.watched.push({ file, listener });
    }
  }

  private unwatchFiles(): void {
    for (const { file, listener } of this.watched.splice(0)) {
      fs.unwatchFile(file, listener);
    }
  }

  private startTimer(): void {
    this.stopTimer();
    if (this.disposed) {
      return;
    }
    this.timer = setInterval(() => void this.refresh('interval'), this.settings.refreshIntervalSeconds * 1000);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private view(): StatusView {
    return {
      profile: this.profile,
      paths: this.paths,
      account: this.snapshot?.account,
      credential: this.snapshot?.credential,
      loggedIn: this.snapshot?.loggedIn ?? true,
      usage: this.snapshot?.usage,
      usageError: this.snapshot?.usageError,
      usageNote: this.snapshot?.usageNote,
      mismatch: this.snapshot?.mismatch,
      overrideWarnings: this.overrideWarnings,
      pendingReload: this.pendingReload,
      loading: this.loading,
      warnAtPercent: this.settings.warnAtPercent,
      now: new Date(this.deps.now()),
    };
  }

  private render(): void {
    this.statusBar.render(this.view());
  }

  private async doRefresh(reason: string, manual: boolean, generation: number): Promise<void> {
    if (generation !== this.generation) {
      this.log(`refresh (${reason}) discarded: the profile changed`);
      return;
    }
    const profile = this.profile;
    const paths = this.paths;
    const envVars = this.envVars;
    this.log(`refreshing (${reason})`);
    try {
      const snapshot = await readAccountSnapshot(
        profile,
        paths,
        envVars,
        {
          platform: this.deps.platform,
          fetchImpl: this.deps.fetchImpl,
          runPowerShell: this.deps.runPowerShell,
          log: (message) => this.log(message),
          now: () => new Date(this.deps.now()),
          sharedDir: path.join(this.context.globalStorageUri.fsPath, 'usage'),
          liveQueries: this.settings.liveQueries,
          liveMinIntervalMs: this.settings.liveMinIntervalMs,
          forceCredentialManager: this.deps.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === '1',
        },
        manual,
      );
      if (generation !== this.generation) {
        this.log('result discarded: the profile changed during the request');
        return;
      }
      this.snapshot = snapshot;
      this.lastRefreshAt = this.deps.now();
    } catch (error) {
      this.log(`unexpected error while refreshing: ${(error as Error).stack ?? String(error)}`);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async checkOverrides(): Promise<void> {
    let settingsJsonText: string | undefined;
    try {
      settingsJsonText = await fs.promises.readFile(path.join(this.paths.configDir, 'settings.json'), 'utf8');
    } catch {
      settingsJsonText = undefined;
    }
    const claudeCode = vscode.workspace.getConfiguration('claudeCode');
    this.overrideWarnings = detectAuthOverrides({
      env: this.deps.env,
      inheritedDiscarded: this.inherited.discardedReason !== undefined,
      environmentVariablesSetting: claudeCode.get<unknown>('environmentVariables'),
      processWrapperSetting: claudeCode.get<unknown>('claudeProcessWrapper'),
      settingsJsonText,
    });
    for (const warning of this.overrideWarnings) {
      this.log(`warning: ${warning}`);
    }
    this.render();
  }

  private async ensureProfileDir(interactive: boolean): Promise<boolean> {
    if (this.paths.isDefault) {
      return true;
    }
    const baseDir = this.inherited.configDir ? path.resolve(this.inherited.configDir) : defaultConfigDir(this.deps.home);
    const baseConfigFile = this.inherited.configDir ? path.join(baseDir, '.claude.json') : path.join(this.deps.home, '.claude.json');
    const run = async () => {
      const report = await prepareProfileDir({
        baseDir,
        baseConfigFile,
        profileDir: this.paths.configDir,
        syncFiles: this.settings.syncFiles,
        platform: this.deps.platform,
        now: this.deps.now,
        log: (message) => this.log(message),
      });
      for (const warning of report.warnings) {
        this.log(`warning: ${warning}`);
      }
      if (interactive) {
        const summary = report.skipped
          ? `Profile "${this.profile.name}": preparation postponed.`
          : `Profile "${this.profile.name}": ${report.junctionsCreated.length} new junction(s), ${report.junctionsKept} kept, ${report.synced.length} file(s) synced${report.seeded ? ', .claude.json seeded' : ''}.`;
        if (report.warnings.length) {
          void vscode.window.showWarningMessage(`${summary} Warnings: ${report.warnings.join('; ')}`);
        } else {
          void vscode.window.showInformationMessage(summary);
        }
      }
      return true;
    };
    try {
      if (interactive) {
        return await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Preparing the directory of profile "${this.profile.name}"` },
          run,
        );
      }
      return await run();
    } catch (error) {
      this.log(`failed to prepare ${this.paths.configDir}: ${(error as Error).stack ?? String(error)}`);
      if (interactive) {
        void vscode.window.showErrorMessage(`Could not prepare the directory of profile "${this.profile.name}": ${(error as Error).message}`);
      }
      return false;
    } finally {
      this.lastSyncAt = this.deps.now();
    }
  }

  private async onSettingsChanged(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.settings = readSettings(this.deps.home);
    const updated = findProfile(this.settings.profiles, this.profile.name);
    if (updated && updated.configDir !== this.profile.configDir) {
      this.log(`definition of profile "${this.profile.name}" changed, reapplying`);
      this.applyProfile(updated);
      this.pendingReload = true;
      await this.ensureProfileDir(false);
    } else if (updated) {
      this.profile = updated;
      this.applyTerminalEnv();
    } else {
      const resolution = resolveActiveProfile(this.settings.profiles, this.context.workspaceState.get<string>(STORED_PROFILE_KEY), this.settings.defaultProfile);
      const next = resolution?.profile ?? FALLBACK_PROFILE;
      const directoryChanged = next.configDir !== this.profile.configDir;
      this.log(`profile "${this.profile.name}" is no longer configured, this window now uses "${next.name}"`);
      this.applyProfile(next);
      if (directoryChanged) {
        this.pendingReload = true;
        await this.ensureProfileDir(false);
      }
    }
    this.startTimer();
    await this.checkOverrides();
    await this.refresh('settings changed');
  }

  private async onFocus(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const now = this.deps.now();
    if (!this.paths.isDefault && now - this.lastSyncAt > FOCUS_SYNC_AFTER_MS) {
      await this.ensureProfileDir(false);
    }
    if (now - this.lastRefreshAt > FOCUS_REFRESH_AFTER_MS) {
      await this.refresh('window focused');
    }
  }

  private maybeShowLoginHint(): void {
    if (this.loginHintShown || !this.snapshot || this.snapshot.loggedIn) {
      return;
    }
    this.loginHintShown = true;
    const who = this.profile.email ? ` with ${this.profile.email}` : '';
    void vscode.window
      .showWarningMessage(`Profile "${this.profile.name}" is not signed in on this machine yet. Open Claude Code in this window and sign in${who}.`, 'Open Claude Code')
      .then((choice) => {
        if (choice === 'Open Claude Code') {
          void this.openClaude();
        }
      });
  }

  private async openClaude(): Promise<void> {
    try {
      await vscode.commands.executeCommand(OPEN_CLAUDE_COMMAND);
    } catch (error) {
      this.log(`could not open Claude Code: ${(error as Error).message}`);
      void vscode.window.showWarningMessage('The Claude Code command was not found. Open the Claude Code panel manually.');
    }
  }

  private profileItems(): MenuItem[] {
    const profiles = this.settings.profiles.length ? this.settings.profiles : [FALLBACK_PROFILE];
    return profiles.map((profile) => ({
      label: `${profile.name === this.profile.name ? '$(check)' : '$(account)'} ${profile.name}`,
      description: profile.email,
      detail: `${profilePaths(profile, this.inherited, this.deps.home).configDir}${profile.configDir ? '' : ' (default)'}`,
      run: () => this.switchTo(profile),
    }));
  }

  private async showSwitchPicker(): Promise<void> {
    const picked = await vscode.window.showQuickPick(this.profileItems(), { placeHolder: 'Claude Code profile for this window', title: 'Switch Profile' });
    await picked?.run?.();
  }

  private async showMenu(): Promise<void> {
    const items: MenuItem[] = [
      ...this.profileItems(),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(person-add) Add account', run: () => this.addAccount() },
      { label: '$(sync) Refresh usage now', run: () => this.refresh('manual request', true) },
      { label: '$(comment-discussion) Open Claude Code', run: () => this.openClaude() },
    ];
    if (!this.paths.isDefault) {
      items.push({ label: '$(tools) Prepare or repair the profile directory', run: () => this.ensureProfileDir(true) });
    }
    items.push(
      { label: '$(debug-restart) Reload window', run: () => vscode.commands.executeCommand('workbench.action.reloadWindow') },
      { label: '$(output) Show logs', run: () => this.output.show(true) },
      { label: '$(wand) Set up accounts again', run: () => this.runSetup() },
      { label: '$(settings-gear) Settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`) },
    );
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `Active profile: ${this.profile.name}`, title: 'DJ Claude Account Switcher' });
    await picked?.run?.();
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('claudeAccount.menu', () => this.showMenu()),
      vscode.commands.registerCommand('claudeAccount.switch', () => this.showSwitchPicker()),
      vscode.commands.registerCommand('claudeAccount.refreshUsage', () => this.refresh('command', true)),
      vscode.commands.registerCommand('claudeAccount.repairProfile', async () => {
        if (this.paths.isDefault) {
          void vscode.window.showInformationMessage(`Profile "${this.profile.name}" uses the default Claude Code directory, there is nothing to prepare.`);
          return;
        }
        await this.ensureProfileDir(true);
        await this.refresh('repair');
      }),
      vscode.commands.registerCommand('claudeAccount.showLogs', () => this.output.show(true)),
      vscode.commands.registerCommand('claudeAccount.setup', () => this.runSetup()),
      vscode.commands.registerCommand('claudeAccount.addAccount', () => this.addAccount()),
    );
  }
}

export function createAccountController(context: vscode.ExtensionContext, overrides: Partial<ControllerDeps> = {}): AccountController {
  return new AccountController(context, {
    home: os.homedir(),
    platform: process.platform,
    env: process.env,
    fetchImpl: fetch,
    runPowerShell,
    now: Date.now,
    ...overrides,
  });
}

let controller: AccountController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = createAccountController(context);
  context.subscriptions.push(controller);
  controller.start();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

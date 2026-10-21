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
import { AccountStatusBar } from './statusBar';

export interface ControllerDeps {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly runPowerShell: PowerShellRunner;
  readonly now: () => number;
}

const SECTION = 'claudeAccount';
const STORED_PROFILE_KEY = 'claudeAccount.profileName';
const FALLBACK_PROFILE: Profile = { name: 'Padrão' };
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
    defaultProfile: typeof rawDefault === 'string' && rawDefault.trim() ? rawDefault.trim() : 'Empresa',
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: ControllerDeps,
  ) {
    this.output = vscode.window.createOutputChannel('Claude Account');
    this.disposables.push(this.output);
    this.settings = readSettings(deps.home);
    const knownDirs = this.settings.profiles.map((profile) => profile.configDir).filter((dir): dir is string => dir !== undefined);
    this.inherited = captureInheritedEnv(deps.env, knownDirs, deps.platform);
    if (this.inherited.discardedReason) {
      this.log(`ativando; ${this.inherited.discardedReason}; valor descartado`);
    } else {
      this.log(`ativando; CLAUDE_CONFIG_DIR herdada do VS Code: ${this.inherited.configDir ?? '(nenhuma)'}`);
    }
    const stored = context.workspaceState.get<string>(STORED_PROFILE_KEY);
    const resolution = resolveActiveProfile(this.settings.profiles, stored, this.settings.defaultProfile);
    if (!resolution) {
      this.log('nenhum perfil configurado em claudeAccount.profiles; usando o diretório padrão');
    } else if (resolution.staleStoredName) {
      this.log(`perfil guardado «${resolution.staleStoredName}» não existe mais; usando «${resolution.profile.name}» (${resolution.reason})`);
    } else {
      this.log(`perfil desta janela: «${resolution.profile.name}» (${resolution.reason})`);
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
      .then(() => this.refresh('ativação'))
      .then(() => this.maybeShowLoginHint());
  }

  dispose(): void {
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
      void vscode.window.showInformationMessage('Aguarde a troca de perfil anterior terminar.');
      return;
    }
    if (profile.name === this.profile.name) {
      void vscode.window.showInformationMessage(`O perfil «${profile.name}» já está ativo nesta janela.`);
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
        void this.refresh('reversão da troca');
        return;
      }
      await this.context.workspaceState.update(STORED_PROFILE_KEY, profile.name);
      this.pendingReload = true;
      this.loginHintShown = false;
      this.log(`janela agora usa «${profile.name}» (guardado no workspaceState)`);
      await this.refresh('troca de perfil');
      this.maybeShowLoginHint();
      const openTerminals = vscode.window.terminals.length > 0;
      void vscode.window
        .showInformationMessage(
          `Perfil «${profile.name}» ativo nesta janela. Novos chats do Claude Code já usam esta conta. Recarregue a janela para os chats abertos${openTerminals ? ', os terminais já abertos' : ''} e o painel do Claude Code refletirem a troca.`,
          'Recarregar janela',
          'Depois',
        )
        .then((choice) => {
          if (choice === 'Recarregar janela') {
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
    this.log(`perfil «${profile.name}» aplicado ao extension host${changes.length ? `: ${changes.join(', ')}` : ' (sem mudança de env)'}`);
    this.applyTerminalEnv();
    this.watchFiles();
  }

  private applyTerminalEnv(): void {
    const collection = this.context.environmentVariableCollection;
    collection.description = 'Perfil do Claude Code escolhido nesta janela (vale para terminais novos)';
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
    for (const file of [this.paths.credentialsFile, this.paths.configFile]) {
      const listener = () => {
        this.log(`${path.basename(file)} mudou; atualizando`);
        void this.refresh('arquivo alterado');
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
    this.timer = setInterval(() => void this.refresh('intervalo'), this.settings.refreshIntervalSeconds * 1000);
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
      this.log(`atualização (${reason}) descartada: o perfil mudou`);
      return;
    }
    const profile = this.profile;
    const paths = this.paths;
    const envVars = this.envVars;
    this.log(`atualizando (${reason})`);
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
        this.log('resultado descartado: o perfil mudou durante a consulta');
        return;
      }
      this.snapshot = snapshot;
      this.lastRefreshAt = this.deps.now();
    } catch (error) {
      this.log(`falha inesperada ao atualizar: ${(error as Error).stack ?? String(error)}`);
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
      this.log(`aviso: ${warning}`);
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
        this.log(`aviso: ${warning}`);
      }
      if (interactive) {
        const summary = report.skipped
          ? `Perfil «${this.profile.name}»: preparação adiada.`
          : `Perfil «${this.profile.name}»: ${report.junctionsCreated.length} junction(s) nova(s), ${report.junctionsKept} mantida(s), ${report.synced.length} arquivo(s) sincronizado(s)${report.seeded ? ', .claude.json semeado' : ''}.`;
        if (report.warnings.length) {
          void vscode.window.showWarningMessage(`${summary} Avisos: ${report.warnings.join('; ')}`);
        } else {
          void vscode.window.showInformationMessage(summary);
        }
      }
      return true;
    };
    try {
      if (interactive) {
        return await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Preparando o diretório do perfil «${this.profile.name}»` },
          run,
        );
      }
      return await run();
    } catch (error) {
      this.log(`falha ao preparar ${this.paths.configDir}: ${(error as Error).stack ?? String(error)}`);
      if (interactive) {
        void vscode.window.showErrorMessage(`Não foi possível preparar o diretório do perfil «${this.profile.name}»: ${(error as Error).message}`);
      }
      return false;
    } finally {
      this.lastSyncAt = this.deps.now();
    }
  }

  private async onSettingsChanged(): Promise<void> {
    this.settings = readSettings(this.deps.home);
    const updated = findProfile(this.settings.profiles, this.profile.name);
    if (updated && updated.configDir !== this.profile.configDir) {
      this.log(`definição do perfil «${this.profile.name}» mudou; reaplicando`);
      this.applyProfile(updated);
      this.pendingReload = true;
      await this.ensureProfileDir(false);
    } else if (updated) {
      this.profile = updated;
      this.applyTerminalEnv();
    }
    this.startTimer();
    await this.checkOverrides();
    await this.refresh('configuração alterada');
  }

  private async onFocus(): Promise<void> {
    const now = this.deps.now();
    if (!this.paths.isDefault && now - this.lastSyncAt > FOCUS_SYNC_AFTER_MS) {
      await this.ensureProfileDir(false);
    }
    if (now - this.lastRefreshAt > FOCUS_REFRESH_AFTER_MS) {
      await this.refresh('janela em foco');
    }
  }

  private maybeShowLoginHint(): void {
    if (this.loginHintShown || !this.snapshot || this.snapshot.loggedIn) {
      return;
    }
    this.loginHintShown = true;
    const who = this.profile.email ? ` com ${this.profile.email}` : '';
    void vscode.window
      .showWarningMessage(`O perfil «${this.profile.name}» ainda não tem login nesta máquina. Abra o Claude Code nesta janela e entre${who}.`, 'Abrir Claude Code')
      .then((choice) => {
        if (choice === 'Abrir Claude Code') {
          void this.openClaude();
        }
      });
  }

  private async openClaude(): Promise<void> {
    try {
      await vscode.commands.executeCommand(OPEN_CLAUDE_COMMAND);
    } catch (error) {
      this.log(`não foi possível abrir o Claude Code: ${(error as Error).message}`);
      void vscode.window.showWarningMessage('Não encontrei o comando do Claude Code. Abra o painel do Claude Code manualmente.');
    }
  }

  private profileItems(): MenuItem[] {
    const profiles = this.settings.profiles.length ? this.settings.profiles : [FALLBACK_PROFILE];
    return profiles.map((profile) => ({
      label: `${profile.name === this.profile.name ? '$(check)' : '$(account)'} ${profile.name}`,
      description: profile.email,
      detail: `${profilePaths(profile, this.inherited, this.deps.home).configDir}${profile.configDir ? '' : ' (padrão)'}`,
      run: () => this.switchTo(profile),
    }));
  }

  private async showSwitchPicker(): Promise<void> {
    const picked = await vscode.window.showQuickPick(this.profileItems(), { placeHolder: 'Perfil do Claude Code para esta janela', title: 'Trocar perfil' });
    await picked?.run?.();
  }

  private async showMenu(): Promise<void> {
    const items: MenuItem[] = [
      ...this.profileItems(),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(sync) Atualizar uso agora', run: () => this.refresh('pedido manual', true) },
      { label: '$(comment-discussion) Abrir o Claude Code', run: () => this.openClaude() },
    ];
    if (!this.paths.isDefault) {
      items.push({ label: '$(tools) Preparar ou reparar o diretório do perfil', run: () => this.ensureProfileDir(true) });
    }
    items.push(
      { label: '$(debug-restart) Recarregar a janela', run: () => vscode.commands.executeCommand('workbench.action.reloadWindow') },
      { label: '$(output) Mostrar logs', run: () => this.output.show(true) },
      { label: '$(settings-gear) Configurações do Claude Account', run: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:muryelca.claude-account-switcher') },
    );
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `Perfil ativo: ${this.profile.name}`, title: 'Claude Account' });
    await picked?.run?.();
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('claudeAccount.menu', () => this.showMenu()),
      vscode.commands.registerCommand('claudeAccount.switch', () => this.showSwitchPicker()),
      vscode.commands.registerCommand('claudeAccount.refreshUsage', () => this.refresh('comando', true)),
      vscode.commands.registerCommand('claudeAccount.repairProfile', async () => {
        if (this.paths.isDefault) {
          void vscode.window.showInformationMessage(`O perfil «${this.profile.name}» usa o diretório padrão do Claude Code; não há nada para preparar.`);
          return;
        }
        await this.ensureProfileDir(true);
        await this.refresh('reparo');
      }),
      vscode.commands.registerCommand('claudeAccount.showLogs', () => this.output.show(true)),
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

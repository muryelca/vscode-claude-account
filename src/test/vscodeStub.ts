import Module from 'node:module';

type Listener<T> = (event: T) => void;

export interface StubEvents {
  readonly messages: string[];
  readonly warnings: string[];
  readonly errors: string[];
  readonly executed: string[][];
  readonly statusTexts: string[];
  readonly collectionCalls: string[];
  readonly configChangeListeners: Listener<{ affectsConfiguration: (section: string) => boolean }>[];
  readonly windowStateListeners: Listener<{ focused: boolean }>[];
  readonly commands: Map<string, (...args: unknown[]) => unknown>;
  readonly quickPickAnswers: Array<(items: Array<{ label: string }>) => unknown>;
  readonly messageAnswers: string[];
  terminals: unknown[];
}

export interface StubContext {
  readonly workspaceState: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void>; store: Map<string, unknown> };
  readonly environmentVariableCollection: { description: string; replace(name: string, value: string): void; delete(name: string): void; clear(): void; values: Map<string, string> };
  readonly globalStorageUri: { fsPath: string };
  readonly subscriptions: Array<{ dispose(): void }>;
}

class MarkdownString {
  isTrusted: unknown;
  constructor(public value: string, public supportThemeIcons?: boolean) {}
}

class ThemeColor {
  constructor(public id: string) {}
}

export function installVscodeStub(configuration: Record<string, unknown>, globalStoragePath: string): { events: StubEvents; context: StubContext; config: Record<string, unknown> } {
  const events: StubEvents = {
    messages: [],
    warnings: [],
    errors: [],
    executed: [],
    statusTexts: [],
    collectionCalls: [],
    configChangeListeners: [],
    windowStateListeners: [],
    commands: new Map(),
    quickPickAnswers: [],
    messageAnswers: [],
    terminals: [],
  };
  const config = configuration;
  const getConfiguration = (section: string) => ({
    get: (key: string, fallback?: unknown) => {
      const value = config[`${section}.${key}`];
      return value === undefined ? fallback : value;
    },
    inspect: () => undefined,
  });
  const stub = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    MarkdownString,
    ThemeColor,
    window: {
      get terminals() {
        return events.terminals;
      },
      createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
      createStatusBarItem: () => {
        const item = {
          text: '',
          tooltip: undefined as unknown,
          backgroundColor: undefined as unknown,
          name: '',
          command: '',
          show: () => undefined,
          dispose: () => undefined,
        };
        return new Proxy(item, {
          set(target, property, value) {
            if (property === 'text') {
              events.statusTexts.push(String(value));
            }
            return Reflect.set(target, property, value);
          },
        });
      },
      showInformationMessage: async (message: string) => {
        events.messages.push(message);
        return events.messageAnswers.shift();
      },
      showWarningMessage: async (message: string) => {
        events.warnings.push(message);
        return events.messageAnswers.shift();
      },
      showErrorMessage: async (message: string) => {
        events.errors.push(message);
        return undefined;
      },
      showQuickPick: async (items: Array<{ label: string }>) => {
        const answer = events.quickPickAnswers.shift();
        return answer ? answer(items) : undefined;
      },
      withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
      onDidChangeWindowState: (listener: Listener<{ focused: boolean }>) => {
        events.windowStateListeners.push(listener);
        return { dispose: () => undefined };
      },
    },
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: (listener: Listener<{ affectsConfiguration: (section: string) => boolean }>) => {
        events.configChangeListeners.push(listener);
        return { dispose: () => undefined };
      },
    },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        events.commands.set(id, handler);
        return { dispose: () => events.commands.delete(id) };
      },
      executeCommand: async (id: string, ...args: unknown[]) => {
        events.executed.push([id, ...args.map(String)]);
        const handler = events.commands.get(id);
        return handler ? handler(...args) : undefined;
      },
    },
  };
  const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return stub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const store = new Map<string, unknown>();
  const values = new Map<string, string>();
  const context: StubContext = {
    workspaceState: {
      store,
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
      },
    },
    environmentVariableCollection: {
      description: '',
      values,
      replace: (name, value) => {
        events.collectionCalls.push(`replace ${name}=${value}`);
        values.set(name, value);
      },
      delete: (name) => {
        events.collectionCalls.push(`delete ${name}`);
        values.delete(name);
      },
      clear: () => {
        events.collectionCalls.push('clear');
        values.clear();
      },
    },
    globalStorageUri: { fsPath: globalStoragePath },
    subscriptions: [],
  };
  return { events, context, config };
}

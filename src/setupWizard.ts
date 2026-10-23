import * as vscode from 'vscode';
import { DiscoveredAccount, discoverAccounts, newProfileDir, suggestProfileName, toConfigDirSetting, uniqueName } from './discovery';
import { Profile } from './profiles';

export interface SetupResult {
  readonly profiles: Profile[];
  readonly defaultProfile: string;
  readonly newAccounts: string[];
}

interface ProfileDraft {
  readonly name: string;
  readonly email?: string;
  readonly configDir?: string;
  readonly isNew: boolean;
}

interface AccountItem extends vscode.QuickPickItem {
  readonly account: DiscoveredAccount;
}

function accountLabel(account: DiscoveredAccount): string {
  return account.email ? `$(account) ${account.email}` : '$(circle-slash) Not signed in';
}

async function askName(prompt: string, suggestion: string, taken: readonly string[]): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'DJ Claude Account Switcher: Set Up Accounts',
    prompt,
    value: suggestion,
    valueSelection: [0, suggestion.length],
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Enter a name.';
      }
      if (taken.some((name) => name.toLowerCase() === trimmed.toLowerCase())) {
        return 'This name is already in use.';
      }
      return undefined;
    },
  });
}

async function pickExisting(accounts: readonly DiscoveredAccount[]): Promise<DiscoveredAccount[] | undefined> {
  if (accounts.length === 0) {
    return [];
  }
  const items: AccountItem[] = accounts.map((account) => ({
    label: accountLabel(account),
    description: account.organizationName,
    detail: account.displayDir,
    picked: account.signedIn,
    account,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'DJ Claude Account Switcher: Set Up Accounts (1/3)',
    placeHolder: 'Claude Code accounts found on this computer. Select the ones you want to use.',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  return picked?.map((item) => item.account);
}

async function nameExisting(accounts: readonly DiscoveredAccount[], drafts: ProfileDraft[]): Promise<boolean> {
  for (const account of accounts) {
    const taken = drafts.map((draft) => draft.name);
    const who = account.email ?? account.displayDir;
    const name = await askName(`Name for the account ${who} (shown in the status bar)`, suggestProfileName(account, taken), taken);
    if (name === undefined) {
      return false;
    }
    drafts.push({ name: name.trim(), email: account.email, configDir: account.configDir, isNew: false });
  }
  return true;
}

async function addNewAccounts(home: string, drafts: ProfileDraft[]): Promise<boolean> {
  for (;;) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(check) Done', id: 'done' },
        { label: '$(add) Add another Claude account', description: 'You sign in to it after setup', id: 'add' },
      ],
      {
        title: 'DJ Claude Account Switcher: Set Up Accounts (2/3)',
        placeHolder: drafts.length ? `${drafts.length} account(s) ready. Add another one?` : 'No account selected yet. Add one?',
        ignoreFocusOut: true,
      },
    );
    if (!choice) {
      return false;
    }
    if (choice.id === 'done') {
      return true;
    }
    const taken = drafts.map((draft) => draft.name);
    const name = await askName('Name for the new account (for example Work, Personal or a client name)', uniqueName(drafts.length ? 'Personal' : 'Work', taken), taken);
    if (name === undefined) {
      continue;
    }
    const dirs = drafts.map((draft) => draft.configDir).filter((dir): dir is string => dir !== undefined);
    drafts.push({ name: name.trim(), configDir: newProfileDir(home, name.trim(), dirs), isNew: true });
  }
}

async function pickDefault(drafts: readonly ProfileDraft[]): Promise<string | undefined> {
  if (drafts.length === 1) {
    return drafts[0].name;
  }
  const picked = await vscode.window.showQuickPick(
    drafts.map((draft) => ({ label: draft.name, description: draft.email ?? (draft.isNew ? 'new account' : undefined) })),
    {
      title: 'DJ Claude Account Switcher: Set Up Accounts (3/3)',
      placeHolder: 'Default profile for windows that have not picked one yet',
      ignoreFocusOut: true,
    },
  );
  return picked?.label;
}

export async function runSetupWizard(home: string, inheritedConfigDir: string | undefined, log: (message: string) => void): Promise<SetupResult | undefined> {
  const accounts = await discoverAccounts(home, inheritedConfigDir);
  log(`setup: found ${accounts.length} Claude Code directory(ies), ${accounts.filter((account) => account.signedIn).length} signed in`);
  const selected = await pickExisting(accounts);
  if (selected === undefined) {
    return undefined;
  }
  const drafts: ProfileDraft[] = [];
  if (!(await nameExisting(selected, drafts))) {
    return undefined;
  }
  if (!(await addNewAccounts(home, drafts))) {
    return undefined;
  }
  if (drafts.length === 0) {
    void vscode.window.showWarningMessage('No account was set up. Run "DJ Claude Account: Set Up Accounts" when you are ready.');
    return undefined;
  }
  const defaultProfile = await pickDefault(drafts);
  if (!defaultProfile) {
    return undefined;
  }
  return {
    profiles: drafts.map((draft) => {
      const configDir = toConfigDirSetting(home, draft.configDir);
      return { name: draft.name, ...(draft.email ? { email: draft.email } : {}), ...(configDir ? { configDir } : {}) };
    }),
    defaultProfile,
    newAccounts: drafts.filter((draft) => draft.isNew).map((draft) => draft.name),
  };
}

export async function runAddAccount(home: string, existing: readonly Profile[]): Promise<Profile | undefined> {
  const taken = existing.map((profile) => profile.name);
  const name = await askName('Name for the new account (for example Work, Personal or a client name)', uniqueName('Personal', taken), taken);
  if (name === undefined) {
    return undefined;
  }
  const dirs = existing.map((profile) => profile.configDir).filter((dir): dir is string => dir !== undefined);
  return { name: name.trim(), configDir: toConfigDirSetting(home, newProfileDir(home, name.trim(), dirs)) };
}

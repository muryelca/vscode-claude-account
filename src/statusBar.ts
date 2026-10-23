import * as vscode from 'vscode';
import { StatusView, statusBarText, statusSeverity, tooltipMarkdown } from './format';

const TOOLTIP_COMMANDS = ['claudeAccount.switch', 'claudeAccount.refreshUsage', 'claudeAccount.menu'];

export class AccountStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('claudeAccount.status', vscode.StatusBarAlignment.Right, 150);
    this.item.name = 'DJ Claude Account Switcher';
    this.item.command = 'claudeAccount.menu';
    this.item.text = '$(account) Claude';
    this.item.show();
  }

  render(view: StatusView): void {
    this.item.text = statusBarText(view);
    const tooltip = new vscode.MarkdownString(tooltipMarkdown(view), true);
    tooltip.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
    this.item.tooltip = tooltip;
    const severity = statusSeverity(view);
    this.item.backgroundColor =
      severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

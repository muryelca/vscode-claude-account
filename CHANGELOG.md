# Changelog

## 0.1.0

- Perfil do Claude Code por janela do VS Code, guardado no workspaceState e aplicado por `CLAUDE_CONFIG_DIR` no extension host e nos terminais novos.
- Diretório de perfil com junctions para os subdiretórios de `~/.claude` (menos `backups`), `.claude.json` semeado sem a conta, chaves de API e caches, e sincronização por mtime de `settings.json`, `CLAUDE.md` e `skills-lock.json` com cópia `.bak`.
- Barra de status com perfil, uso da sessão (5h) e da semana (7d), tooltip com limites por modelo, origem e idade do dado, diretório e avisos de variáveis que vencem o login.
- Uso cache-first a partir do `.claude.json` do Claude Code, com consulta ao vivo conservadora a `/api/oauth/usage` coordenada entre janelas; leitura das credenciais em arquivo ou no Windows Credential Manager (entradas simples e em partes).

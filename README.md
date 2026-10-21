# Claude Account Switcher

Extensão do VS Code para quem usa o Claude Code com mais de uma conta. Cada janela do VS Code escolhe o seu perfil (por exemplo `Empresa` e `Pessoal`), a escolha fica guardada por workspace, todos os chats do Claude Code daquela janela usam a conta escolhida, e a barra de status mostra a conta ativa com o uso da sessão (5h) e da semana (7d).

## Como funciona

O Claude Code lê a variável `CLAUDE_CONFIG_DIR` para decidir onde ficam as credenciais (`.credentials.json`), o `.claude.json` e o resto da configuração. A extensão oficial do Claude Code sobe o CLI herdando o `process.env` do extension host do VS Code a cada chat novo (verificado no código da versão 2.1.304: a função que monta o ambiente parte de `{...process.env}` em todo spawn e não guarda cópia). Esta extensão ativa junto com a janela e, antes de qualquer chat nascer, define `CLAUDE_CONFIG_DIR` (e `CLAUDE_SECURESTORAGE_CONFIG_DIR` no Windows) no `process.env` com o diretório do perfil escolhido para a janela. Para o perfil padrão as variáveis voltam ao valor herdado do VS Code.

- A escolha fica no `workspaceState` da janela: janelas diferentes (workspaces diferentes) não sabem uma da outra.
- Os terminais integrados criados depois da escolha recebem as mesmas variáveis (`environmentVariableCollection`), então `claude` no terminal usa a mesma conta. Terminais já abertos precisam ser reiniciados.
- Um perfil com `configDir` próprio guarda só o seu login. Os subdiretórios de `~/.claude` (`projects`, `skills`, `agents`, `plugins`, `ide` e os demais, menos `backups`) viram junctions dentro do diretório do perfil, então memória, histórico, skills e plugins continuam compartilhados. `settings.json`, `CLAUDE.md` e `skills-lock.json` são mantidos iguais nos dois lados (o mais recente vence, o substituído fica em `.bak`, JSON vazio ou quebrado nunca propaga). O `.claude.json` do perfil nasce como cópia do original sem `oauthAccount`, sem chaves de API e sem caches. Credenciais e `config.json` nunca são copiados.
- O uso vem primeiro do que o próprio Claude Code guarda em `.claude.json` (`cachedUsageUtilization`, atualizado a cada chat que o CLI abre). Quando esse dado tem mais de cinco minutos, a extensão consulta `GET https://api.anthropic.com/api/oauth/usage` com o token do perfil, no máximo uma vez a cada cinco minutos por perfil, coordenado entre todas as janelas por um arquivo em `globalStorage`, respeitando `Retry-After`, segurando uma hora depois de um 401 até o login mudar e cinco minutos depois de um 429. Esse endpoint divide o orçamento de chamadas com o `/usage` do próprio CLI, por isso o ritmo é conservador. A extensão nunca renova nem grava tokens; o token só vive em memória durante a chamada.
- `claudeAccount.usage.liveQueries: false` desliga a consulta ao vivo: a barra passa a mostrar só o cache do Claude Code. Use esta opção se preferir que nenhum programa além do Claude Code use o token da conta.

## Uso

1. Clique no item `$(account) <perfil>` da barra de status, ou rode `Claude Account: Trocar perfil desta janela`.
2. Escolha o perfil. Na primeira troca para um perfil com diretório próprio a extensão prepara o diretório (junctions, cópia do `.claude.json`, sincronização dos arquivos).
3. Recarregue a janela quando a extensão pedir. Chats novos já usam a conta nova sem recarregar, mas os chats abertos, os terminais abertos e o painel do Claude Code só refletem a troca depois do reload. Até lá a barra mostra `recarregar`.
4. Se o perfil ainda não tem login nesta máquina, abra o Claude Code nessa janela e entre com a conta do perfil. O login fica no diretório do perfil.

A tooltip da barra traz e-mail, organização, plano, cada limite com a hora em que renova (ou renovou), a origem do dado (ao vivo ou cache, e a idade), o diretório em uso e avisos quando algo vence o login do perfil (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `claudeCode.environmentVariables`, `apiKeyHelper`). A cor muda para amarelo a partir de `claudeAccount.usage.warnAtPercent` e para vermelho em 100%.

## Configurações

| Chave | Padrão | Descrição |
|---|---|---|
| `claudeAccount.profiles` | `Empresa` (padrão) e `Pessoal` (`~/.claude-profiles/pessoal`) | Lista de perfis com `name`, `email` (opcional, para avisar quando o login é de outra conta) e `configDir` (vazio usa `~/.claude`). |
| `claudeAccount.defaultProfile` | `Empresa` | Perfil de uma janela que ainda não escolheu o seu. |
| `claudeAccount.usage.liveQueries` | `true` | Consulta o uso ao vivo quando o cache do Claude Code está velho. |
| `claudeAccount.usage.liveMinIntervalMinutes` | `5` | Intervalo mínimo entre consultas ao vivo de um perfil, em todas as janelas. |
| `claudeAccount.usage.refreshIntervalSeconds` | `60` | Intervalo das leituras locais (cache, credenciais, estado compartilhado). |
| `claudeAccount.usage.warnAtPercent` | `80` | Limiar do amarelo. |
| `claudeAccount.applyToTerminals` | `true` | Aplica o perfil aos terminais integrados criados depois da escolha. |
| `claudeAccount.profileDir.syncFiles` | `settings.json`, `CLAUDE.md`, `skills-lock.json` | Arquivos mantidos iguais entre `~/.claude` e o perfil. Credenciais, `.claude.json` e `config.json` são recusados. |

## Comandos

- `Claude Account: Menu da conta` (clique na barra de status)
- `Claude Account: Trocar perfil desta janela`
- `Claude Account: Atualizar uso` (consulta ao vivo, no máximo uma por minuto)
- `Claude Account: Preparar ou reparar o diretório do perfil`
- `Claude Account: Mostrar logs` (canal de saída `Claude Account`, com cada passo registrado; tokens nunca aparecem)

## Limites conhecidos

- A troca vale para processos novos. Chats e terminais já abertos continuam na conta anterior até o reload da janela, e a extensão oficial só refaz a leitura da conta mostrada no painel quando a janela recarrega.
- A extensão ativa com `*` e com os eventos da extensão oficial (`onWebviewPanel:claudeVSCodePanel`, `onView:claudeVSCodeSidebar*`), para rodar antes do primeiro chat. Se mesmo assim a extensão oficial subir um chat antes, esse chat fica na conta padrão até o reload.
- `claudeCode.environmentVariables` e `claudeCode.claudeProcessWrapper` têm escopo de máquina e vencem esta extensão em todas as janelas; a barra avisa quando estão definidos.
- Quando o Claude Code passar a guardar credenciais no Windows Credential Manager (flag `tengu_windows_credman`), a extensão lê `<serviço>/claude-code-user`, inclusive entradas em partes (`#m`, `#0..#n`), via PowerShell, e cai para o arquivo se não achar. Esse caminho foi testado só com entradas sintéticas.
- Um plano Team ou Enterprise pode não ter todos os limites; a barra mostra só os que a API devolve.

## Desenvolvimento

```bash
npm install
npm run compile
npm test
npm run package            # gera o .vsix
npm run install-local      # gera e instala no VS Code (code --install-extension)
```

Depois de instalar, recarregue a janela. `F5` abre um Extension Development Host com a extensão. Os testes rodam com `node:test` e cobrem a lógica pura e o controlador com um stub do módulo `vscode`.

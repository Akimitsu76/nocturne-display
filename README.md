# Nocturne Display — Vigília do Monitor

AppImage Linux (x86_64) que agenda **apagar** e **acender** o monitor sem desligar o PC.
Feito para quem usa **Sunshine + Tailscale + Moonlight**: você dorme com a tela apagada e,
no horário escolhido, ela desperta sozinha para você conectar de fora de casa.

> **Abre zerado:** nenhum horário vem pré-configurado e a tela não é alterada ao iniciar.
> Você cria quantos agendamentos quiser, como alarmes de celular: cada um com horário,
> ação (apagar ou acender), ligação/desligação própria e botão de excluir.

> Interface gótica com estética Frutiger Aero: vidro fosco, velas de altar, runas,
> cruzes, molduras ornamentais, partículas, fonte Cinzel e transições suaves.

## Download

Baixe o AppImage na aba [**Releases**](../../releases). Também é possível compilar localmente:

```bash
npm install
npm run build
# sai em dist/Nocturne-Display-1.5.0-x86_64.AppImage
```

## Uso

```bash
chmod +x Nocturne-Display-1.5.0-x86_64.AppImage
./Nocturne-Display-1.5.0-x86_64.AppImage
```

1. No **Altar**, escolha o horário, escolha **Apagar** ou **Acender** e clique em **Adicionar**.
2. Repita para criar outros alarmes — por exemplo `08:00` apagar e `19:00` acender.
3. Use o interruptor de cada linha para **ligar/desligar** aquele agendamento sem apagá-lo;
   o botão `✕` remove o agendamento.
4. Teste com **Apagar agora** / **Acender agora** (sempre imediatos).
5. Em **Rituais**, ative **Iniciar com o sistema** e **Iniciar oculto na bandeja**.
6. O botão `×` apenas esconde a janela: o app continua na bandeja mantendo a agenda.

Horários *cross-midnight* funcionam naturalmente: o estado é definido pelo alarme mais
recente antes de agora. O app reavalia os alarmes ao voltar da suspensão.

### Agendamentos com confirmação

Ao adicionar ou alterar o horário/ação de um alarme, o app abre a confirmação
**Aplicar horário HH:MM?** com **Sim** / **Não**. Nada é salvo e nenhum comando é enviado
ao monitor antes do `Sim`; `Não` (ou `Esc`) descarta a alteração. Ligar, desligar e excluir
um alarme são ações imediatas, como no aplicativo de alarme do celular.

O alarme confirmado entra em vigor apenas no **próximo limite**, nunca de forma retroativa.
Se você estiver com a tela acesa às `01:00` e criar um alarme para apagar às `00:00`,
a tela **não apaga na hora**: segue acesa até o próximo horário. Um aviso no **Altar**
mostra quando o ciclo começa, e esse estado sobrevive a uma reinicialização do app.

### Configuração antiga

Configurações do formato antigo (`enabled`, `offTime`, `onTime`) são descartadas na
primeira execução desta versão. Nenhum alarme é criado a partir delas: o app abre zerado
e mantém as demais preferências (backend, saída, autostart, áudio, atualizações).

### Como o estado é decidido

Com vários alarmes ativos, o estado desejado é a **ação do alarme mais recente antes de agora**.
Se houver dois alarmes no mesmo horário, **acender** tem prioridade sobre **apagar**.
Sem nenhum alarme ativo o app não toma nenhuma atitude automática: a tela fica como você a deixou.

## Atualizações automáticas

A aba **Atualizações** consulta a API de releases do GitHub ao iniciar e a cada 30 minutos.
Quando existe uma versão mais nova, o AppImage é baixado e substituído em segundo plano —
a vigília e a sessão do Moonlight continuam ativas. O reinício é manual: use o botão
**Reiniciar agora** quando for conveniente.

- Ative/desative em **Atualizações → Instalar atualizações automáticas** (opção `autoUpdate` em `config.json`).
- **Verificar agora** consulta o GitHub sem instalar; **Baixar e instalar** aplica manualmente.
- **Ver no GitHub** abre as notas do release.
- A substituição é atômica (download temporário + `rename` no mesmo diretório) e valida `sha256` quando o release informa o digest.
- A instalação automática exige o AppImage original em diretório com permissão de escrita. Em modo de desenvolvimento, `electron .`, ou `--appimage-extract-and-run`, o app mostra o aviso mas não substitui o executável.

## Backends suportados (detecção automática)

| Sessão | Backend | Comando |
|---|---|---|
| Niri (Wayland) | IPC nativo | `niri msg output ... on/off` |
| KDE Wayland | KScreen | `kscreen-doctor` |
| Sway / Hyprland / wlroots | wlroots | `wlr-randr` |
| X11 | xrandr | `xrandr --output ... --off / --auto` |
| Monitor DDC/CI | ddcutil | `ddcutil setvcp d6 00/01` |
| X11 (alternativa) | DPMS | `xset dpms force off/on` |

No Niri, o app usa o IPC nativo (`niri msg --json outputs` para listar/ler o estado) e
`niri msg output <nome> on|off` para ligar/desligar. Isso evita o `wlr-randr`, que falha
ao desligar saídas no Niri por ele não implementar `wlr-output-management`.

Se nada for detectado, instale um destes: `niri`, `kscreen-doctor` (KDE), `wlr-randr`
(wlroots), `xorg-xrandr` (X11) ou `ddcutil` (DDC/CI). Também é possível forçar o
backend manualmente na aba **Saídas**. Em sessões Niri sem host de bandeja, o botão
`×` minimiza a janela em vez de escondê-la, para você sempre poder restaurá-la.

## Moonlight / Sunshine

- O modo **DPMS** apaga a luz de fundo, mas mantém a saída ativa no compositor — costuma
  ser a opção mais segura se o Sunshine perder a captura quando a saída é desligada.
- Se ainda assim o streaming falhar sem monitor ativo, use um dummy plug / saída virtual.
- Quando o Moonlight tenta acordar o PC, o app detecta a conexão ao Sunshine nas portas
  `47984/47989/47990`, acende a tela, garante que o Sunshine está ativo e mantém o override
  manual até o próximo horário programado.

### Restart unificado do Sunshine

Sempre que o monitor é acendido pelo agendador, pelo Moonlight ou manualmente — e também no
evento `resume` após suspend/hibernate — o app chama a mesma rotina
`ensureSunshineReady()`. Ela espera o Niri reportar uma saída com `current_mode` e `logical`
válidos e só então executa `systemctl --user restart sunshine` (com fallback para
`pkill -x sunshine` + `sunshine` quando não há serviço de usuário). Isso evita o erro
`failed to initialize video capture/encoding` causado por um Sunshine iniciado sem saída.

O restart é idempotente: múltiplos eventos no mesmo ciclo geram apenas um restart, e uma
sessão de streaming já establishada nunca é interrompida. O log registra
`PC acordou — Sunshine reiniciado com a tela ligada; captura pronta.` no caminho de `resume`.
Com o backend Niri, o app mantém `capture = wlr` em `~/.config/sunshine/sunshine.conf`, sem
sobrescrever outras opções do arquivo.

## Teste rápido de compatibilidade

```bash
./Nocturne-Display-1.5.0-x86_64.AppImage --check
./Nocturne-Display-1.5.0-x86_64.AppImage --check-json
```

Verifica distro/sessão, FUSE, bibliotecas faltando, backend, saídas, agenda, autostart
e se o Sunshine está rodando. O prompt pronto para pedir esse teste a um agente de IA
está em [`PROMPT-TESTE-RAPIDO.md`](PROMPT-TESTE-RAPIDO.md).

## Arquivos de configuração

- `~/.config/nocturne-display/config.json`
- `~/.config/autostart/nocturne-display.desktop`

Se o AppImage não abrir por falta de `libfuse2`:

```bash
./Nocturne-Display-1.5.0-x86_64.AppImage --appimage-extract-and-run
```

## Licença

MIT — veja [LICENSE](LICENSE).

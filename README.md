# Nocturne Display — Vigília do Monitor

AppImage Linux (x86_64) que agenda **apagar** e **acender** o monitor sem desligar o PC.
Feito para quem usa **Sunshine + Tailscale + Moonlight**: você dorme com a tela apagada e,
no horário escolhido, ela desperta sozinha para você conectar de fora de casa.

> Interface gótica com estética Frutiger Aero: vidro fosco, partículas flutuantes,
> rosácea animada, fonte Cinzel, orbes pulsantes e transições suaves.

## Download

Baixe o AppImage na aba [**Releases**](../../releases). Também é possível compilar localmente:

```bash
npm install
npm run build
# sai em dist/Nocturne-Display-1.2.0-x86_64.AppImage
```

## Uso

```bash
chmod +x Nocturne-Display-1.2.0-x86_64.AppImage
./Nocturne-Display-1.2.0-x86_64.AppImage
```

1. No **Altar**, defina os horários (ex.: `08:00` apagar, `19:00` acender).
2. Ative o **Agendamento ativo**.
3. Teste com **Apagar agora** / **Acender agora**.
4. Em **Rituais**, ative **Iniciar com o sistema** e **Iniciar oculto na bandeja**.
5. O botão `×` apenas esconde a janela: o app continua na bandeja mantendo a agenda.

Horários *cross-midnight* funcionam (ex.: `22:00` → `06:00`). O app reavalia a agenda
ao voltar da suspensão.

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

## Teste rápido de compatibilidade

```bash
./Nocturne-Display-1.2.0-x86_64.AppImage --check
./Nocturne-Display-1.2.0-x86_64.AppImage --check-json
```

Verifica distro/sessão, FUSE, bibliotecas faltando, backend, saídas, agenda, autostart
e se o Sunshine está rodando. O prompt pronto para pedir esse teste a um agente de IA
está em [`PROMPT-TESTE-RAPIDO.md`](PROMPT-TESTE-RAPIDO.md).

## Arquivos de configuração

- `~/.config/nocturne-display/config.json`
- `~/.config/autostart/nocturne-display.desktop`

Se o AppImage não abrir por falta de `libfuse2`:

```bash
./Nocturne-Display-1.2.0-x86_64.AppImage --appimage-extract-and-run
```

## Licença

MIT — veja [LICENSE](LICENSE).

# Nocturne Display — Vigília do Monitor

AppImage (Linux x86_64) que agenda **apagar** e **acender** o monitor sem desligar o PC.
Feito para quem usa **Sunshine + Tailscale + Moonlight**: você dorme com a tela apagada e,
no horário escolhido, ela desperta sozinha para você conectar de fora de casa.

## Como usar

```bash
chmod +x Nocturne-Display-1.5.0-x86_64.AppImage
./Nocturne-Display-1.5.0-x86_64.AppImage
```

1. O app abre **zerado**: não existe horário pré-configurado e a tela não é mexida na abertura.
2. No **Altar**, escolha o horário, escolha **Apagar** ou **Acender** e clique em **Adicionar**.
3. Crie quantos alarmes quiser (ex.: `08:00` apagar, `19:00` acender, `02:00` acender).
4. Cada linha tem interruptor para **ligar/desligar** o alarme e `✕` para **apagá-lo**.
5. Use **Apagar agora** / **Acender agora** para testar.
6. Em **Rituais**, ative **Iniciar com o sistema** e **Iniciar oculto na bandeja**.
7. Feche a janela com `×` — o app continua na bandeja do sistema mantendo os alarmes.

Horários **cross-midnight** funcionam: o estado é o do alarme mais recente antes de agora.

### Confirmação dos horários

Ao adicionar ou alterar o horário/ação de um alarme, aparece a pergunta
**Aplicar horário HH:MM?** com **Sim** e **Não**. Sem o `Sim`, nada é salvo e nada é
enviado ao monitor. Após confirmar, o alarme só entra em vigor no próximo limite:
se são `01:00` e você cria um alarme para desligar às `00:00`, a tela **não apaga na
hora**. Um aviso no **Altar** mostra o horário de início. Ligar, desligar e excluir
alarmes são imediatos. **Apagar agora** e **Acender agora** também são imediatos.

### Configuração antiga

Se o app ainda tiver `enabled`, `offTime` ou `onTime` no `config.json`, eles são removidos
automaticamente na primeira execução e **nenhum alarme é criado a partir deles**. As demais
preferências são preservadas. Sem alarmes ativos, o app nunca altera a tela sozinho.

## Atualizações

A aba **Atualizações** verifica releases do GitHub ao abrir o app e a cada 30 minutos.
Com `Instalar atualizações automáticas` ativado, um novo AppImage é baixado e aplicado
em segundo plano, sem interromper a vigília nem o Moonlight. O reinício é manual pelo
botão **Reiniciar agora**. Também há **Verificar agora**, **Baixar e instalar** e
**Ver no GitHub**. A opção fica em `~/.config/nocturne-display/config.json` como `autoUpdate`.

## Backends suportados (detecção automática)

| Sessão | Backend | Comando usado |
|---|---|---|
| Niri (Wayland) | IPC nativo | `niri msg output ... on/off` |
| KDE Wayland | KScreen | `kscreen-doctor` |
| Sway / Hyprland / wlroots | wlroots | `wlr-randr` |
| X11 | xrandr | `xrandr --output ... --off / --auto` |
| Monitor com DDC/CI | ddcutil | `ddcutil setvcp d6 00/01` |
| X11 (alternativa) | DPMS | `xset dpms force off/on` |

Se nada for detectado, instale um destes pacotes: `kscreen-doctor` (KDE),
`wlr-randr` (wlroots), `xorg-xrandr` (X11) ou `ddcutil` (DDC/CI).
Você também pode forçar um backend na aba **Saídas**.

## Moonlight / Sunshine

- O modo **DPMS** apaga a luz de fundo mas mantém a saída ativa no compositor — costuma ser
  a opção mais segura se o Sunshine perder a captura quando a saída é desligada de vez.
- Se mesmo assim o streaming não funcionar sem monitor físico ativo, use um **dummy plug/Dummy
  HDMI** ou uma saída virtual, mantendo o PC ligado.
- O app reavalia a agenda ao voltar da suspensão (`powerMonitor.resume`).
- **Restart unificado:** ao acender o monitor pelo horário, pelo Moonlight ou manualmente, e
  também no `resume`, o app espera o Niri reportar `current_mode`/`logical` válidos e reinicia
  o Sunshine (`systemctl --user restart sunshine`, com fallback para `pkill` + `sunshine`).
  Isso recria a captura com a tela ligada e evita o erro de `video capture/encoding`.
- O restart é feito apenas uma vez por ciclo e nunca durante uma sessão de streaming ativa.
  No log aparece: `PC acordou — Sunshine reiniciado com a tela ligada; captura pronta.`
- No Niri, o app mantém `capture = wlr` no `~/.config/sunshine/sunshine.conf` sem apagar
  as outras configurações.

## Dados e inicialização

- Configuração: `~/.config/nocturne-display/config.json`
- Autostart: `~/.config/autostart/nocturne-display.desktop`

## Teste rápido de compatibilidade (útil antes de usar no PC do Sunshine)

```bash
./Nocturne-Display-1.5.0-x86_64.AppImage --check        # relatório legível
./Nocturne-Display-1.5.0-x86_64.AppImage --check-json   # relatório em JSON
```

Verifica distro/sessão, FUSE, bibliotecas faltando, backend, saídas detectadas, agenda, autostart e se o Sunshine está rodando. O prompt pronto para pedir esse teste a um agente de IA está em `~/PROMPT-TESTE-RAPIDO.md`.

## Se o AppImage não abrir

Sistemas sem `libfuse2` podem rodar com:

```bash
./Nocturne-Display-1.5.0-x86_64.AppImage --appimage-extract-and-run
```

Código-fonte: `~/projetos/nocturne-display/` (`npm run build` regenera o AppImage em `dist/`).

# Prompt — teste rápido na máquina do Sunshine

Copie o bloco abaixo e cole para o agente de IA na máquina onde estão o Sunshine + Tailscale + Moonlight.

---

Você está na máquina Linux que roda **Sunshine + Tailscale** e recebe conexões **Moonlight**. Acabei de instalar nela o app `Nocturne-Display-1.0.0-x86_64.AppImage` (ele agenda apagar/acender o monitor sem desligar o PC). Preciso de um **teste rápido de compatibilidade e funcionamento**, porque o app precisa funcionar em **qualquer Linux** (X11, Wayland KDE, wlroots, DDC/CI).

**Regras:** não use `sudo` sem me pedir; não deixe a tela apagada no fim; não altere minha config permanentemente; restaure tudo e apague arquivos temporários. Relate com ✅ / ⚠️ / ❌ e evidências (comando + saída).

Caminho do app: `~/Nocturne-Display-1.0.0-x86_64.AppImage` (se estiver em outro lugar, descubra com `find ~ -name 'Nocturne-Display*.AppImage'`).

## 1. Diagnóstico embutido

```bash
chmod +x ~/Nocturne-Display-1.0.0-x86_64.AppImage
~/Nocturne-Display-1.0.0-x86_64.AppImage --check
```

Analise cada item: sistema/sessão, FUSE, bibliotecas faltando, backend detectado, saídas encontradas, agenda, autostart e se o processo `sunshine` está ativo. Se der erro de FUSE, rode com `--appimage-extract-and-run --check` e diga isso no relatório. Para leitura fácil, `--check-json` também funciona.

## 2. Confira se o backend bate com o monitor do Sunshine

- Se `XDG_SESSION_TYPE=wayland` e KDE: confira `kscreen-doctor -o`.
- Se for sway/Hyprland: `wlr-randr`.
- Se for X11: `xrandr --query`.
- DDC/CI: `ddcutil detect --brief` e `/dev/i2c-*`.

O app deve listar **a mesma saída** que o Sunshine captura. Se listar saída errada ou nenhuma, proponha a correção (instalar `kscreen-doctor`, `wlr-randr`, `xorg-xrandr`, `ddcutil`, ou forçar backend na aba *Saídas*).

## 3. Teste funcional SEGURO (sem apagar a tela de verdade)

Crie um backend falso em `/tmp` que só registre os argumentos recebidos, coloque esse diretório **primeiro no PATH**, abra o app com `--remote-debugging-port=9222` e use o CDP (Node tem `WebSocket` nativo) para chamar `window.api.apply('off')` e depois `window.api.apply('on')`. Confira:

- os comandos gerados estão no formato correto do backend (`output.<id>.disable/enable`, `--off/--on`, `setvcp d6 00/01`, `dpms force off/on`);
- o log do diário muda e o estado na interface acompanha;
- **nenhum comando real foi enviado ao monitor**.

Modelo de shim (adapte ao backend detectado):

```bash
mkdir -p /tmp/nocturne-test
cat > /tmp/nocturne-test/kscreen-doctor <<'EOF'
#!/bin/bash
echo "$*" >> /tmp/nocturne-test/comandos.log
STATE=/tmp/nocturne-test/estado
[ -f "$STATE" ] || echo enabled > "$STATE"
[ "$1" = "-o" ] && { echo "Output: 1 eDP-1 connected $(cat "$STATE") 1920x1080@60"; exit 0; }
for a in "$@"; do case "$a" in *.disable) echo disabled > "$STATE";; *.enable) echo enabled > "$STATE";; esac; done
EOF
chmod +x /tmp/nocturne-test/kscreen-doctor
```

## 4. Teste real (SÓ se eu autorizar)

Se eu dissim "pode testar de verdade": use **DPMS por no máximo 3 segundos** com restauração garantida por `trap` (ou os botões da interface), confirme que a tela volta e que o Moonlight consegue conectar depois. Nunca encerre deixando a tela apagada.

## 5. Agenda e persistência

- Com `enabled:false`, confirme a lógica cross-midnight (ex.: `22:00` → `06:00` resulta em alvo `off` à noite e `on` de manhã).
- Ative "Iniciar com o sistema" na aba *Rituais* e leia `~/.config/autostart/nocturne-display.desktop`: o campo `Exec=` **precisa apontar para o seu AppImage**, não para um binário de desenvolvimento. Depois desative.
- Restaure `~/.config/nocturne-display/config.json` para: `08:00` / `19:00`, `enabled:true`, `backend:auto`, `output:auto`, `autostart:false`.
- Encerre o processo do app e remova `/tmp/nocturne-test`.

## 6. Relatório final

Tabela com: item, status, evidência, ação corretiva exata (comando `sudo pacman/apt/dnf install ...` quando aplicável, mas não execute sem permissão). Conclua com uma frase: **"Vai funcionar na máquina do Sunshine?"** — sim/não/com ressalvas.

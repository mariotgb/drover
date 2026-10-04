# Remote access to Drover

**English** · [Русский](remote-access.ru.md) · [Back to README](../README.md)

Starting with Drover **0.5.0**, Settings → **Remote access** can serve your agents, chats, tasks and terminals in a browser. This guide sets up HTTPS through your own VPS, pairs an iPhone with a passkey, and explains how to keep the Mac available. No application build is required.

## How it works

```text
Safari / installed Home Screen app
        │ HTTPS, port 443
        ▼
VPS: Caddy (TLS certificate + reverse proxy)
        │ HTTP to 127.0.0.1:8780 on the VPS
        ▼
SSH reverse tunnel (the Mac initiates the connection to the VPS)
        │ encrypted connection, normally port 22
        ▼
Mac: Drover on 127.0.0.1:7780 → herdr → your agents
```

The VPS is a bridge; Drover and the agents still run on your Mac. No router port forwarding is needed. The tunnel reconnects through a macOS LaunchAgent. Drover must remain running, and the Mac must remain awake and online.

| Port | Where | Purpose |
| --- | --- | --- |
| 22/TCP (or your SSH port) | VPS, public | Administration and incoming tunnels |
| 80/TCP, 443/TCP | VPS, public | HTTPS certificate issuance, redirect and website |
| 8780 | VPS, loopback only | Caddy's tunnel upstream |
| 7780 | Mac, loopback only | Drover's web server |
| 2222 / 2223 / 2224 | VPS, loopback only | Optional SSH to Mac / Windows / Linux |

## What you need

- A Mac with Apple Silicon running macOS 13.0 or later, with Drover 0.5.0 or later, herdr and your agents installed and working locally.
- A VPS with a public IPv4 address, **Debian 12+ or Ubuntu 22.04+**, systemd, root/sudo access and SSH. A fresh VPS is easiest: the web script replaces `/etc/caddy/Caddyfile`, keeping a backup.
- Access to the VPS provider's console in case you need to recover SSH access.
- An iPhone with Safari and passkey support; **iOS 16.4+** for Home Screen web push.
- Terminal on the Mac. Commands labelled **VPS** run in an SSH session on the VPS; commands labelled **Mac** run locally.

You do **not** need to buy a domain. [sslip.io](https://sslip.io/) resolves a hostname containing an IP to that IP. For a public IP `A.B.C.D`, use `https://A-B-C-D.sslip.io`. `203.0.113.5` / `203-0-113-5.sslip.io` below are documentation examples, not working server addresses. Replace them with your own values.

## 1. Get the scripts and create Mac keys

Download this repository's **remote-web** branch with GitHub's **Code → Download ZIP**, unzip it, and keep the `remote/` directory in a permanent location, for example `~/drover-remote`. The scripts are also available in the [repository](https://github.com/mariotgb/drover/tree/remote-web/remote). The downloaded Drover app alone does not contain these scripts. You do not need Git, Node.js or Xcode.

**Mac**, from the directory containing `install.sh` and `bridge/`:

```bash
cd ~/drover-remote
export VPS_HOST='YOUR_PUBLIC_IPV4'
export VPS_PORT=22
export VPS_ADMIN=root
bash ./install.sh keys
```

Use your VPS's actual SSH port and administrative login if different. Keep these exports in the Terminal window used for the following Mac steps; repeat them in a new window. `keys` creates separate keys in `~/.ssh/` without overwriting existing ones. The basic website needs only `mac_bridge_ed25519`. Copy **public** keys (`.pub`) only. Never upload private keys to GitHub or paste them into a chat.

Connect to the VPS and compare its SSH fingerprint with the one shown in the provider's console before trusting it:

```bash
ssh -p "$VPS_PORT" "$VPS_ADMIN@$VPS_HOST"
```

In a separate **Mac** Terminal with the same exports, copy the scripts and public tunnel key:

```bash
scp -P "$VPS_PORT" -r ~/drover-remote "$VPS_ADMIN@$VPS_HOST:~/drover-remote"
scp -P "$VPS_PORT" ~/.ssh/mac_bridge_ed25519.pub "$VPS_ADMIN@$VPS_HOST:~/mac_bridge_ed25519.pub"
```

If `~/drover-remote` already contains a previous server copy, update its files deliberately rather than nesting another directory.

## 2. Set up the VPS

Keep your first administrator SSH session open throughout setup. If logged in as root on a minimal image without `sudo`, omit the `sudo` prefix (and its `--preserve-env=SSH_CONNECTION` option); the SSH session already provides `SSH_CONNECTION`.

**VPS**:

```bash
sudo apt-get update
sudo apt-get install -y openssh-server openssh-client python3 ufw curl
cd ~/drover-remote/bridge
sudo --preserve-env=SSH_CONNECTION bash ./vps-setup.sh --mac-key ~/mac_bridge_ed25519.pub
```

This creates the restricted `bridge-mac` account and installs an SSH forwarding policy. It allows only the Mac's reverse listeners on VPS loopback ports **2222 and 8780**, with no shell or SFTP for that account. The script validates effective SSH settings and rolls back configuration/keys/accounts if its transaction fails. It does not disable the administrator's password login.

Test a **new** administrator SSH login from the Mac before continuing. If the script reports conflicting SSH rules, resolve the reported policy rather than bypassing its checks. Run this check from a real SSH login (`SSH_CONNECTION` must survive sudo):

```bash
sudo --preserve-env=SSH_CONNECTION bash ./vps-setup.sh --check
```

If using the provider's console instead of SSH, supply an actual client context with `--context HOST,CLIENT_IP,VPS_IP,SSH_PORT`; invented context values do not verify your connection.

### HTTPS with Caddy

**VPS**: substitute the VPS's public IPv4:

```bash
sudo bash ./vps-web.sh --ip YOUR_PUBLIC_IPV4
```

The script installs Caddy from its official Debian/Ubuntu repository if missing, prints the resulting HTTPS address, validates the configuration, backs up the previous Caddyfile and starts/reloads Caddy. It proxies to `127.0.0.1:8780`, supports WebSockets and limits request bodies to 20 MiB. [Caddy manages HTTPS certificates automatically](https://caddyserver.com/docs/automatic-https); DNS must resolve correctly, and inbound **80/TCP and 443/TCP** must reach the VPS, including through the provider's firewall.

A **502 Bad Gateway** is expected until the Mac tunnel and Drover's web server are running. Optional `--basic-auth USERNAME` adds a separate password prompt; the standard setup uses Drover passkeys without this extra layer. Basic auth may need additional checking with the installed app and push notifications.

For your own domain, point its DNS A record to the VPS, replace the generated sslip.io site label in `/etc/caddy/Caddyfile` with that domain, then run `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` and `sudo systemctl reload caddy`. Use the same HTTPS origin in Drover. Re-running `vps-web.sh` generates the sslip.io configuration again.

### Firewall, with automatic rollback

For a fresh, dedicated VPS, **VPS**:

```bash
sudo --preserve-env=SSH_CONNECTION bash ./vps-firewall.sh --reset
```

`--reset` replaces existing UFW rules: omit it if other services need their current rules, then inspect `sudo ufw status verbose`. The script preserves actual SSH listener ports, allows 80/443, denies other incoming connections and arms a **five-minute rollback timer before changing rules**. `/etc/default/ufw` must contain `IPV6=yes`; the script refuses otherwise.

Open a **new SSH session** from the Mac within five minutes. Run the exact confirmation command printed by the script from that new session, for example:

```bash
cd ~/drover-remote/bridge
sudo --preserve-env=SSH_CONNECTION bash ./vps-firewall.sh --confirm TOKEN_PRINTED_BY_SCRIPT
```

The token is generated for your firewall change; do not use a token from another installation. Confirmation from the old session is rejected. Without confirmation, the previous UFW rules and enabled/disabled state return automatically. Do not open 8780, 7780 or 2222–2224 publicly. Provider firewalls and Docker-published ports require their own review.

## 3. Start the Mac tunnel

**Mac**, in `~/drover-remote` with the exports from step 1:

```bash
VPS_USER=bridge-mac bash ./install.sh bridge
bash ./install.sh status
```

The installer scans the VPS host key and asks you to verify its fingerprint. Obtain the trusted fingerprint in the VPS console or your already verified administrator session:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Only accept a match. The installer pins the key in `~/.ssh/mac_bridge_known_hosts`, installs `~/Library/LaunchAgents/dev.drover.bridge.plist` and loads it for the current user. launchd restarts the tunnel when it exits. Logs: `~/Library/Logs/dev.drover.bridge.log`.

The LaunchAgent runs after you log in, not before. After a reboot with FileVault, someone must unlock the disk and log in; start Drover again (optionally add Drover to macOS Login Items).

**Remote Login on the Mac is optional.** The website needs only Drover's web port; the additional SSH forward can exist while Mac port 22 is closed. For optional SSH access to the Mac, see [remote/README.md](../remote/README.md).

## 4. Enable Drover's web server

On the **Mac**, open Drover → Settings → **Remote access**:

1. Set **Port** to `7780`.
2. Set **Public HTTPS address** to the exact address printed by `vps-web.sh`, such as `https://A-B-C-D.sslip.io`. Use only the origin: no `/pair`, query string or fragment. Use a hostname, not a bare IP.
3. Enable **Works through a proxy (Caddy on VPS)**.
4. Click **Save**, then turn on **Enable remote access**. Confirm **Remote access is running**.

Keep port 7780 for this guide. If you choose another port, also change the Mac target in `bridge/dev.drover.bridge.plist.template` (`127.0.0.1:8780:127.0.0.1:7780`) and re-run `install.sh bridge`. Keep VPS listener 8780 in sync with Caddy and the VPS policy.

Caddy's default [forwarded-header handling](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers) discards untrusted incoming forwarded values. Drover's proxy setting trusts a single client IP from the local tunnel so visitors have separate rate limits. If adding another proxy in front, preserve the public Host/Origin and ensure the final proxy **replaces** `X-Forwarded-For` with one verified client IP; do not simply append browser-supplied values.

## 5. Pair the iPhone and sign in with Face ID

1. In Drover's Mac settings click **Pair phone**. Scan the QR code with the iPhone Camera and open the link in **Safari**.
2. Optionally name the device, then tap **Create passkey and connect**. Approve the passkey with Face ID, Touch ID or your device's unlock method. If passkey creation is unavailable, check that passkeys are enabled and the phone has a screen lock.
3. The link lasts **10 minutes** and is single-use after successful pairing. Generate a fresh link for each registration; a newly generated link replaces the previous pending one.
4. Later, open the same HTTPS address and tap **Sign in with passkey**. Drover does not give you a reusable website password.

Treat a QR code or pairing link as a secret: anyone who receives a valid link can register access. Do not post screenshots of it.

### Home Screen app and notifications

In Safari, open **Share → Add to Home Screen** (enable **Open as Web App** if offered). Open Drover from that new icon. If that app asks you to sign in, use your passkey at the same address.

In the web app's **Settings → Notifications**, enable **Phone notifications** (some layouts show **Enable phone notifications**) and accept the iOS permission prompt. Select notifications for finished agents and agents needing input. On iPhone, web push requires an installed Home Screen web app and iOS 16.4+, as described by [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). Also check iOS Settings → Notifications and Focus modes if alerts are hidden. The Mac, Drover and the tunnel must be online to send events.

### Open the website on the Mac itself

Use the **same public HTTPS address** in the Mac browser. Use a synced passkey if available, or create a new pairing link on the desktop and open/copy it into that browser to register it. You can also use the browser's offered phone-passkey flow.

Once a public address is configured, authenticate there: `http://localhost:7780` is useful for checking the local server, but passkey registration/login belongs to the configured public origin. Changing between localhost, IP, sslip.io and your own domain can cause passkey errors.

## 6. Keep the Mac awake

Keep it connected to power and a stable network. In macOS System Settings → Battery → Options, enable **Prevent automatic sleeping on power adapter when the display is off** if available (wording varies by macOS). The screen can turn off; the computer must stay awake. For a temporary session with the lid open:

```bash
caffeinate -i -s
```

Leave that Terminal process running; Ctrl+C stops it. This is not a guarantee of operation with a closed lid.

For optional operation **with the lid closed while charging**, the included `lid/` helper installs two root LaunchDaemons:

```bash
cd ~/drover-remote/lid
sudo bash ./install.sh
launchctl print system/dev.drover.lid-awake
launchctl print system/dev.drover.lid-awake-guard
tail -n 20 /Library/Logs/lid-awake.log
```

It disables sleep on AC power, restores sleep on battery/unknown power, and requests sleep on battery with the lid closed. A second daemon guards against a stuck sleep-blocking flag on battery. This uses `pmset disablesleep`; verify closed-lid behavior and unplugging power on **your Mac and macOS version**, with physical access. [Apple's supported closed-display setup](https://support.apple.com/en-us/102501) uses an external display; this helper goes beyond that setup.

Keep the Mac on a hard, ventilated surface. Before putting it in a bag, unplug power and confirm it really slept. To remove the helper and restore sleep:

```bash
sudo bash ./uninstall.sh
```

Details and dry-run commands: [lid README (Russian)](../remote/lid/README.ru.md). FileVault remains enabled.

## 7. Optional Linux and Windows machines for agents

These scripts give agents SSH access to other machines through the same VPS. They do **not** add native remote-herdr machine support to Drover: agents on the Mac use `ssh homeserver` / `ssh pc` to work there. The remote `agent` account has **passwordless sudo on Linux / administrator rights on Windows**.

Copy `~/.ssh/agents_ed25519.pub` to each target; retain the private key on the Mac. Copy the script directories from `remote/` as described below. Follow fingerprint prompts against a trusted VPS fingerprint.

**Linux (systemd)**: preserve sibling directories `bridge/` and `machine-home/` on the target. Run there:

```bash
sudo bash ./machine-home/install.sh --vps-host YOUR_PUBLIC_IPV4 --agent-key ./agents_ed25519.pub --keep-password-login
```

It creates `agent` and a reconnecting `drover-tunnel` systemd service to VPS loopback port **2224**. Save the printed public tunnel key in `home_tunnel.pub` on the VPS, then from `~/drover-remote/bridge` run:

```bash
sudo --preserve-env=SSH_CONNECTION bash ./vps-setup.sh --home-key ~/home_tunnel.pub
```

After testing **new key logins as both your administrator and `agent`**, repeat the Linux installer without `--keep-password-login`, adding `--key-login-confirmed`. This disables SSH passwords for all users; your administrator must already have a working key. Status: `systemctl status drover-tunnel`; logs: `journalctl -u drover-tunnel`.

**Windows 10/11**: copy `machine-pc/install.ps1` and `agents_ed25519.pub` to one directory. In **64-bit PowerShell as Administrator**, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1 -VpsHost 'YOUR_PUBLIC_IPV4' -AgentKeyFile .\agents_ed25519.pub -KeepPasswordLogin -KeepLanSsh
```

It installs OpenSSH, creates local administrator `agent`, and starts the SYSTEM scheduled task `DroverTunnel` to VPS loopback port **2223**. Save its printed public tunnel key in `pc_tunnel.pub` on the VPS and run there:

```bash
sudo --preserve-env=SSH_CONNECTION bash ./vps-setup.sh --pc-key ~/pc_tunnel.pub
```

After a **new key login as `agent`** succeeds, re-run the Windows command with `-KeyLoginConfirmed` instead of `-KeepPasswordLogin -KeepLanSsh` to disable SSH passwords and the default LAN SSH firewall rule. Check `Get-Service sshd`, `Get-ScheduledTask DroverTunnel` and `C:\ProgramData\drover-tunnel\tunnel.log`. The Windows default SSH shell is PowerShell, not bash.

**Mac → VPS → machines**: copy `agents_ed25519.pub` to the VPS and register it as the jump key:

```bash
# VPS, in ~/drover-remote/bridge
sudo --preserve-env=SSH_CONNECTION bash ./vps-setup.sh --jump-mac-key ~/agents_ed25519.pub
# Mac, in ~/drover-remote, with VPS_HOST/VPS_PORT set
bash ./install.sh ssh-config
```

The supplied SSH template uses **`agents_ed25519` for both the VPS jump and target login**. `install.sh keys` also creates `mac_jump_ed25519`; that separate key is unused by this template unless you deliberately change its `IdentityFile` and register the matching public key on the VPS.

Add the **Include line printed by the installer** at the very top of `~/.ssh/config`. First connect manually with `ssh -o StrictHostKeyChecking=ask pc` / `ssh -o StrictHostKeyChecking=ask homeserver`. Compare target fingerprints with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on Linux or `ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub` on Windows. Subsequent connections require those pinned keys. Install agent CLIs/tooling on targets yourself as needed; do not bypass host-key failures.

## Security and removing access

- Website access means **full control of your agents and their terminals**, including whatever files, credentials and permissions the agents can use. It is not a read-only dashboard. The optional machine accounts extend that access to those machines.
- On the desktop Mac, Settings → Remote access → **Paired devices → Revoke** removes that device's access and push subscriptions. Browser sign-out alone does not revoke a passkey. A synced passkey may work on several physical devices; revoking its Drover registration revokes that registration everywhere it is used.
- Turn off **Enable remote access** to stop serving the interface. Keep Drover, macOS, Caddy and VPS packages updated. The VPS terminates HTTPS, so its administrator can observe traffic; secure the VPS accordingly.
- Do not expose Drover's HTTP port or SSH reverse-listener ports to the internet. Keep the checked forwarding restrictions and host-key verification. The generated Caddy config omits access logs and redacts URI/Referer from runtime logs to avoid retaining pairing secrets; keep that policy when editing it.
- A provider-issued **root password is bootstrap access**, not your tunnel credential. Create a separate administrative SSH key on the Mac (for example `ssh-keygen -t ed25519 -f ~/.ssh/drover_vps_admin_ed25519`), add its `.pub` line to the intended VPS administrator's `~/.ssh/authorized_keys`, and confirm a fresh login with `ssh -i ~/.ssh/drover_vps_admin_ed25519 -p "$VPS_PORT" "$VPS_ADMIN@$VPS_HOST"`. Only then disable password authentication and, if using a separate sudo account, root login. Validate with `sudo sshd -t`, inspect effective `sudo sshd -T` settings and reload SSH while retaining an open session and provider-console access. The supplied VPS script restricts bridge/jump accounts; it does not harden your administrator automatically.

To remove the Mac tunnel, run `bash ./install.sh uninstall` in `~/drover-remote`; it keeps your private keys, removes the pinned VPS key and LaunchAgent, and removes the optional Mac sshd drop-in via sudo. Uninstall `lid/` separately. This does not remove VPS Caddy/UFW settings or the other-machine services. Disable remote access in Drover too.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| **502 Bad Gateway** | Keep Drover running and enable remote access on port 7780. On Mac: `bash ./install.sh status`, `tail -n 30 ~/Library/Logs/dev.drover.bridge.log`, `curl -I http://localhost:7780/login`. On VPS: `sudo ss -ltnp` should show `127.0.0.1:8780`; `curl -I -H 'Host: YOUR_HOSTNAME.sslip.io' http://127.0.0.1:8780/login`; `sudo journalctl -u caddy -n 50`. A local 200/redirect verifies a responding HTTP server, not a passkey login. |
| **Passkey error / wrong address** | Browser URL, Caddy hostname and Drover's public HTTPS address must match exactly, including any nonstandard HTTPS port. Do not sign in through a bare IP or localhost when a public origin is configured. After a hostname change, save settings and pair again at the new origin. |
| **Pairing link expired/used** | Generate a new QR on the Mac; use it within 10 minutes. A new QR invalidates the previous pending code. |
| **Certificate error / site unreachable** | Confirm DNS with `dig +short YOUR_HOSTNAME.sslip.io`, inbound 80/443 in UFW and the provider firewall, and Caddy logs. A DNS/VPN filter may block IP-derived domains; use an allowed resolver or your own domain. |
| **Tunnel keeps restarting** | Verify `bridge-mac` has the matching public key; check `vps-setup.sh --check`. `remote port forwarding failed` may mean an old session still owns 8780/2222: wait about 90 seconds for SSH keepalives to clear a dead session; do not kill unrelated sshd processes. |
| **Host key verification failed** | Verify the new fingerprint through the provider console/target machine. Only then update the appropriate known_hosts entry. For a changed VPS host/address, the existing pinned file is retained: update it deliberately before reinstalling. Never use `StrictHostKeyChecking=no`. |
| **Works locally, fails with a VPN (Happ or similar)** | On Mac and iPhone, compare with the VPN disconnected, including its **kill switch / block connections without VPN** setting. Some clients keep blocking traffic even after the tunnel is turned off. Check routing, DNS and exclusions for the VPS IP/hostname. These are diagnostics; restore the VPN configuration you need afterward. |
| **iPhone VPN conflict** | Expect only one active personal VPN tunnel at a time. Happ and Tailscale may replace/disconnect each other; use one connection path rather than assuming both personal VPNs remain active. |
| **SSH hangs through a VPN** | From Mac: `nc -vz "$VPS_HOST" "$VPS_PORT"`. A VPN or network may block **22/TCP** while HTTPS still works. Adjust VPN routing or use another actual VPS SSH listener port; set `VPS_PORT` and reinstall the Mac bridge. Use `--vps-port` / `-VpsPort` on optional targets, and allow the new port in the provider firewall before changing access. |
| **Notifications missing** | Open the Home Screen app, sign in, enable its notification setting and allow iOS permission. Check Focus and network/VPN restrictions; the Mac must be online. |
| **Offline after reboot or closing lid** | Unlock FileVault, log in and launch Drover; confirm the LaunchAgent is loaded and the Mac is awake. Test the lid helper locally before relying on it remotely. |

If port 7780 is already used, stop the conflicting service or consistently change Drover's port and the Mac tunnel target. Do not change only the Drover field.

## Alternatives without a VPS — not tested with Drover

- **[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)** can expose the local Drover port over HTTPS inside your tailnet. It needs Tailscale on both Mac and phone and an enabled HTTPS name. Set that origin in Drover and test pairing, proxy headers and notifications. Consider the iPhone VPN conflict above.
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)** can route a stable HTTPS hostname to the local port through `cloudflared` on the Mac. A production public hostname normally uses a domain managed through Cloudflare. Configure Drover's origin to match and verify Host/Origin, WebSockets and client-IP forwarding; temporary/random hostnames are unsuitable for lasting passkeys.

These are possible alternatives, **not verified installation recipes**. Neither removes the need to keep Drover and the Mac running.

# Remote access helpers

Start with the complete [English guide](../docs/remote-access.md) or [русский гайд](../docs/remote-access.ru.md). Downloaded Drover builds do not require compiling this repository.

These helpers are optional system configuration scripts. Run Mac commands as your normal logged-in user; run VPS/Linux commands through sudo; run Windows commands in an elevated 64-bit PowerShell. The website only requires `install.sh keys`, VPS setup/Caddy/firewall, and `install.sh bridge` plus Drover's settings. Mac Remote Login and the machine/lid helpers are optional.

| Path | Runs on | Purpose |
| --- | --- | --- |
| `install.sh` | Mac | Keys, pinned VPS host key, LaunchAgent, optional SSH config/hardening, status/uninstall |
| `bridge/dev.drover.bridge.plist.template` | Mac | Reverse forwards: VPS 8780 → Mac 7780, VPS 2222 → Mac SSH 22 |
| `bridge/vps-setup.sh`, `hub-config.py`, `lib.sh` | VPS | Restricted accounts/keys, validated SSH policy and transactional rollback |
| `bridge/vps-web.sh` | VPS | Caddy installation and HTTPS proxy for an IP-derived sslip.io hostname |
| `bridge/vps-firewall.sh` | VPS | UFW configuration, five-minute rollback, confirmation from a new SSH session |
| `ssh/` | Mac | Key-only sshd drop-in rendered for the current user; effective-settings check |
| `lid/` | Mac | Optional closed-lid operation on AC power; install/uninstall and battery guard |
| `machine-home/` | Linux with systemd | Privileged agent account and reverse SSH service to VPS port 2224 |
| `machine-pc/install.ps1` | Windows 10/11 | Privileged agent account and SYSTEM tunnel task to VPS port 2223 |
| `bridge/mac-ssh-config.template` | Mac | `ssh pc` / `ssh homeserver` through the restricted VPS jump user |
| `bridge/iphone-ssh-config.example` | iPhone SSH client | Optional SSH to Mac, separate from browser pairing |
| `tests/setup_checks.py` | Mac | Offline SSH policy/rollback regression checks using temporary files |

The bridge account names, labels and loopback ports are shared defaults, not personal server names. `VPS_HOST` is required; `VPS_PORT=22` and `VPS_USER=bridge-mac` are defaults. Mac paths are derived from `$HOME`; `__HOME__`, `__VPS_HOST__`, `__VPS_PORT__`, `__VPS_USER__` and `__MAC_USER__` are template placeholders. Do not install templates containing unresolved placeholders manually.

`bash ./install.sh render` prints the generated plist without installing it. `bash ./ssh/check-sshd.sh` renders the current Mac user into a temporary candidate and checks it without sudo or changes to the live SSH configuration. The VPS helpers must remain alongside `lib.sh` and `hub-config.py`; the Linux helper needs sibling `../bridge/lib.sh`.

## Optional SSH login to the Mac

This is independent of browser/passkey access. Only do it if you want an SSH shell on the Mac through the VPS.

1. Enable macOS System Settings → General → Sharing → **Remote Login**, allowing only your intended Mac account.
2. Generate a key in your phone's SSH client. Add its **public key** on the Mac with `bash ./install.sh add-key 'YOUR_COMPLETE_SSH_PUBLIC_KEY_LINE'`.
3. Copy that public key to the VPS and register it with `sudo --preserve-env=SSH_CONNECTION bash ./vps-setup.sh --jump-iphone-key /path/to/iphone.pub` from `bridge/`.
4. Configure the phone's client from `bridge/iphone-ssh-config.example`, replacing its VPS host and `__MAC_USER__` (`id -un` on Mac); add your SSH port if different. Verify both VPS and Mac host fingerprints. The Mac fingerprint is available via `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the Mac.
5. Confirm a **new key login to the Mac works**, then run `bash ./install.sh ssh` as your normal Mac user. It invokes sudo for installation, disables password/keyboard-interactive and root login, and restricts SSH to the current Mac user. Existing AllowUsers entries for others cause its exact-list check to fail: resolve that policy deliberately. Keep an existing working session open and retest a new login afterward.

Phone SSH keys and Drover browser passkeys are different credentials. Revoking one does not revoke the other. The browser setup never needs a phone SSH client.

## Checks and provenance

The scripts were copied from the existing deployment helpers with personal configuration replaced by parameters/current-user paths. VPS, Linux, Windows and lid service logic was retained. Generated Windows provisioning bundles, private/public deployment keys, one-time download links, screenshots and review reports are excluded. The Windows installer generates a tunnel key on the target; no pre-generated setup bundle is needed.

Run syntax and offline checks without installing services:

```bash
# From this directory, on macOS
find . -name '*.sh' -exec bash -n {} \;
find . \( -name '*.plist' -o -name '*.plist.template' \) -exec plutil -lint {} \;
python3 tests/setup_checks.py
```

These checks do not prove end-to-end VPS/iPhone/Windows operation. The installer also runs its own platform-specific validation when you apply it.

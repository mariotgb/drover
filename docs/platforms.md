# Desktop platforms

macOS keeps the existing Apple Silicon DMG, macOS 13 minimum, Dock behavior,
Liquid Glass/ICNS icon and launchd bridge. Linux packages target x64 and arm64:

```sh
npm ci
node node_modules/electron/install.js
npm run dist:linux
```

Linux needs a graphical desktop, herdr on PATH, and installed agent CLIs.
Use the official herdr installer at https://herdr.dev/docs/install/ . Drover
does not bundle herdr or agent executables. AppImage users must install
`xdg-utils`, `lsof`, and ImageMagick themselves; deb declares these dependencies.
HEIC/HEIF decoding also requires the distribution's ImageMagick libheif support.
AppImage may require FUSE; `--appimage-extract-and-run` works without FUSE.
Linux desktop smoke validation can run `node scripts/linux/smoke.mjs <AppImage>`
inside the disposable Docker image. It uses its own Xvfb, synthetic CLI/socket
and temporary profile, checks readline key delivery and watchdog stop behavior,
then deletes the fixture. Physical menu shortcuts still need desktop validation
if native GTK accelerators do not fire from synthetic Electron input.

App settings/logs live under `$XDG_CONFIG_HOME/Drover` (default `~/.config/Drover`),
and staged attachments under `$XDG_DATA_HOME/drover/attachments` (default
`~/.local/share/drover/attachments`). Relative XDG paths are ignored.
`DROVER_USER_DATA` still overrides the app profile. Herdr keeps its own XDG
config and session sockets. CLI transcript paths remain `~/.claude` and `~/.codex`.
The user's login shell supplies PATH; graphical session DBus/display variables
are retained. File and link opening uses Electron's Linux `xdg-open` integration.
Electron 44 uses an explicit runtime installer; run the install command above
after a clean dependency install if the runtime is missing.

The existing detached crash watchdog also runs on Linux. It watches parent EOF,
checks session ownership and stops only the named attached herdr session when
Stop herdr on quit is enabled. Herdr is not put under a restarting service that
could undo that setting.

## Build in a disposable container

Copy the tree into a temporary build context excluding `.git`, `.drover`,
`node_modules`, `out` and `release`; never copy host dependency directories.
Build with `scripts/linux/Dockerfile`. Run the container with an output mount
for `/build/release`; `npm run dist:linux -- AppImage deb --x64` or `--arm64`
selects one architecture and overrides the configured multi-architecture targets.
Build/test containers must use synthetic CLIs and isolated
profiles, not mounted home directories or live herdr sockets. The image builds
packages; it never installs or starts Drover on the host.

## Remote Linux build

On an authorized x86_64 Linux host, install Docker, buildx, git and rsync. Keep
the public checkout separate from build snapshots (`git clone
https://github.com/mariotgb/drover ~/drover`). Node runs inside
`scripts/linux/Dockerfile`; a host Node installation is unnecessary.

```sh
DROVER_LINUX_HOST=user@linux-host scripts/linux/remote-build.sh
```

The script syncs tracked and non-ignored uncommitted files into a new remote
snapshot, excluding host dependencies, outputs, local agent state and secrets.
It runs native x64 Docker typecheck/tests, builds AppImage/deb, and runs synthetic
Xvfb smoke without network access. If buildx advertises arm64 (QEMU/binfmt), it
also builds and smokes arm64 there. The arm64 smoke normalizes AppImage's ELF
padding in a disposable copy for QEMU/binfmt; delivered artifacts are unchanged.
`DROVER_LINUX_ARM64=required` fails if arm64
is unavailable; `off` skips it. In auto/off mode, matching previous local arm64
packages are required before the output directory is replaced.

Artifacts are copied back with SHA-256 verification to
`~/remote-mac/linux-packages`; logs are saved beside it. Optional environment
variables: `DROVER_LINUX_DIR` (relative remote build directory),
`DROVER_LINUX_OUTPUT` (local destination), and `DROVER_LINUX_SSH_CONFIG`
(SSH config file). SSH host-key checks stay enabled. The script never installs
binfmt, changes host configuration, or launches agents.

For an authorized, isolated Xorg/GNOME desktop check, run the smoke container
with its X11 socket and dedicated Xauthority file mounted, set `DISPLAY` and
`XAUTHORITY`, and pass `--desktop`. It targets only the fixture Drover window and
uses `xdotool` XTest keyboard input for Ctrl+Shift+B and readline keys; shortcut
failure is an assertion instead of falling back to menu dispatch. The desktop
session must be separate from any user or default herdr session.

## Optional Linux desktop SSH bridge

`remote/install.sh` dispatches Linux to `remote/bridge/linux-install.py`:

```sh
bash remote/install.sh keys
VPS_HOST=<host> bash remote/install.sh render
VPS_HOST=<host> bash remote/install.sh bridge
bash remote/install.sh status
bash remote/install.sh uninstall
```

The bridge uses the current user's systemd manager, not sudo. Verify the printed
host fingerprint before installation. Configure distro OpenSSH separately if
the optional SSH forward is needed; the Mac sshd/lid scripts remain Mac-specific.

- Unit: `dev.drover.bridge.service`, in
  `${XDG_CONFIG_HOME:-~/.config}/systemd/user/dev.drover.bridge.service`.
- Metadata: `${XDG_CONFIG_HOME:-~/.config}/drover/bridge.json`, mode 0600,
  schema `{version:1, service, host, user, port, identityFile, knownHostsFile,
  forwards:[{listenHost, listenPort, targetHost, targetPort}]}`.
- Private key: `~/.ssh/drover_bridge_ed25519`; host pins:
  `~/.ssh/drover_bridge_known_hosts`. Both mode 0600.
- Fixed loopback forwards: 2222 → localhost:22, 8780 → 127.0.0.1:7780.
- Status: `systemctl --user show dev.drover.bridge.service --property=ActiveState
  --property=SubState --property=MainPID`. Running means successful command,
  `ActiveState=active`, `SubState=running`, positive MainPID. This proves local
  tunnel lifecycle, not end-to-end phone access.
- Logs: `journalctl --user -u dev.drover.bridge.service`. Enable starts it with
  the user manager. Logout persistence requires the user to configure linger;
  the installer does not enable it. Reinstall rolls back files and prior
  enabled/running state on failure.

Machines GUI bridge adoption/provisioning currently expects the Mac LaunchAgent.
It requires a separate backend integration with this contract; Linux can use
the manual user-service installer meanwhile.

## Windows verdict and follow-up design

Upstream herdr 0.9.4 supports native Windows x64/ConPTY; WSL is optional.
Native Windows Drover is larger than a packaging change (rough estimate: 4–7
engineering days including a real Windows validation environment). No Windows
installer target is enabled until the following are implemented and verified:

1. Locate the active herdr managed release (`HERDR_HOME`, versioned install/PATH),
   resolve `.exe`/`.cmd` using PATHEXT, and obtain a Windows CLI environment
   without assuming Unix HOME/SHELL or launching a Unix login probe.
2. Adapt the NDJSON client to upstream's named-pipe endpoint. A reported
   `socket_path` is a marker file on Windows, not a Unix socket. Match herdr's
   pipe naming/identity and administrator access policy; do not interpret access
   denial as a stopped server or start another server.
3. Preserve Windows quoting for agent launch/restore commands, local cwd/image
   URLs, terminal-control subprocesses, transcript discovery, and process start
   time lookup (replace `/bin/ps` fallback). Verify fake child/watchdog pipe EOF
   and exit behavior plus real synthetic shell panes on Windows.
4. Replace ImageMagick Unix paths with Windows image tooling or a portable
   decoder; implement preview port/process discovery; validate filesystem ACLs,
   private temporary files and OpenSSH compatibility.
5. Enable an x64 NSIS target/icon, registry protocol/file open behavior and
   Windows notifications; run typecheck/tests and package smoke tests on Windows.

If WSL is chosen instead, prefer running the Linux package under WSLg initially.
A Windows Electron app controlling WSL herdr needs a helper inside one explicit
distro: forward NDJSON through `wsl.exe --distribution <name> --exec <helper>`
stdio, run terminal control there, and stage/read files via the same helper.
Translate `/mnt/<drive>` and `\\wsl.localhost\<distro>` only at file boundaries.
Keep herdr/CLI agents/transcripts/stop watchdog inside that distro. Do not expose
an unauthenticated TCP socket or rely on a Windows process understanding a Linux
Unix socket. This helper bridge adds work; native herdr is the preferred path.

Sources: [herdr install](https://herdr.dev/docs/install/),
[Windows support](https://herdr.dev/docs/windows-beta/),
[release manifest](https://herdr.dev/latest.json),
[upstream IPC](https://github.com/herdrdev/herdr/blob/v0.9.4/src/ipc.rs).

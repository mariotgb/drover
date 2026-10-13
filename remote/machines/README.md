# Machines provisioning contract (0.8 mechanism)

`src/main/machines/provision.ts` exports `createMachineProvisioner({run, onStep?})`.
The injected `run(machine, command, input?)` is the only SSH transport. It must
use the separate management key and the already confirmed host key, without
logging input or returned install commands. Root runs `/bin/bash -s`; other
administrators run `sudo -n /bin/bash -s`. Allow a provisioning timeout long
enough to install Debian/Ubuntu packages. The module uses bundled raw resources;
`assetsDir` is an optional test override, not a packaging requirement.

- `setupBridge(machine, [{machine, tunnelPublicKey}], agentsPublicKey,
  {caddy, publicOrigin?, phonePort?}, onStep?)` validates unique target ports,
  provisions accounts, replaces the jump key and awaits progress callbacks.
- `bridgeTunnelUser(machine)` is `dt-` plus the first 16 hex characters of
  SHA256(machine.id). Every target uses its own tunnel public key and
  `127.0.0.1:<machine.bridgePort>`. `BRIDGE_JUMP_USER` is `drover-jump`:
  local forwarding only to those target ports, no shell, SFTP or reverse ports.
  Rotation stops existing sessions of that dedicated jump account.
- `retireBridge(bridge)` clears only recorded Drover tunnel/jump keys, terminates
  those sessions and revokes capabilities. It does not recreate accounts, reset
  configuration or stop unrelated services. For a target removal, remove its
  agents/management key through the old tunnel **before** `removeTargets` closes
  that tunnel. Preserve a pending cleanup record until both operations succeed.
- `installCommand({machine, bridge, agentsPublicKey, managementPublicKey,
  bridgeHostKey, tunnelPrivateKey, tunnelPublicKey, expiresAt,
  agentsAuthorizedKey?, permissionSetupScript?, recoveryCleanup?, publicOrigin?, lanHost?,
  onReport?}, os)` returns a clipboard command. Register the tunnel public key
  with `setupBridge` first. `bridgeHostKey` is `type base64`, without a
  known_hosts prefix. The clipboard contains **only the one-time URL and token**.
  The script downloads the dedicated tunnel private key in the `/key` response
  over bridge HTTPS or trusted LAN HTTP, then writes it 0600 (Windows uses a
  protected SYSTEM/Administrators ACL). No private key enters shell history,
  environment assignments or sudo argv. Neither agents nor management private
  keys are distributed.
- `RecoveryCleanup` is `{id, agentsPublicKeys, managementPublicKey}`. Persist the
  complete old public-key snapshot and generation ID before issuing recovery.
  The local installer verifies the dedicated account marker, retires only the
  old Drover service/task and its exact root/SYSTEM tunnel, then removes the
  listed key blobs (including restricted/untagged lines) before installing new
  credentials. This runs even when recovering from a retired bridge to LAN.
  Successful final `InstallerReport.cleanupId` must equal this capability's
  recovery ID; missing/mismatched/unrequested IDs are rejected and never forwarded.
  An error before completion leaves no recovery acknowledgment. Receipt success
  does not confirm the host key. The backend owns clearing only the bound durable
  removal record and must skip automatic SSH credential removal while it waits.
  A local exclusive lock is acquired before key download, preventing interleaved
  installers. Reissuing recovery must revoke old unconsumed capabilities first.
  Revocation cannot cancel an already consumed installer; UUID binding protects
  backend acknowledgment but cannot order delayed local executions of that copy.
- `removeTargets(bridge, machines, agentsPublicKey)` revokes tunnel keys and
  terminates only removed target tunnel accounts. `revokeJumpKey(bridge, oldKey)`
  independently revokes the agents jump key and terminates its existing sessions.
  `revokeInstallers(bridge)` clears pending capability downloads. Call those on
  revocation and keep failed remote cleanup pending in the backend store.
- `switchBridge(previous, next, targets, agentsPublicKey, {caddy, bridgeHostKey})`
  returns `{updated, needsReinstall, pendingOldCleanup}`. Offline/unsupported
  targets need a new installer. Successful target repoints survive failure to
  clean the old bridge; retry `removeTargets` and `revokeInstallers` for its ID.
  An updated ID confirms that a deferred tunnel restart was scheduled, not that
  the new bridge has already passed an SSH check. Confirm through the backend.
- `dispose()` stops LAN serving/report polling. The desktop service must call it
  when closing, and must preserve pending key revocations outside this module.

`src/main/machines/cleanup.ts` exports `BridgeCleanupQueue` and re-exports the
shared `BridgeCleanupState`. The queue only retires obsolete tunnel grants and
installer capabilities; it never completes target agents/management credential
removal. Its injected transport is the same confirmed management-key runner.

- Construct with `{userData, activeBridgeId, bridge, removeTargets,
  revokeInstallers, now?}`. The bridge resolver returns an existing row or null;
  `removeTargets(bridge, targetIds, agentsPublicKey)` receives IDs, while
  `revokeInstallers(bridge)` receives the resolved bridge.
- `await load()` after loading Machines; `await runOnce()` after rendering the
  managed SSH config at startup and on checks/periodic polling in the service's
  serial lane. No separate timer or agent is created.
- `await enqueue(oldBridgeId, targetIds, agentsPublicKey)` for each
  `switchBridge.pendingOldCleanup` entry, before publishing the switch result.
  The private `bridge-cleanup.json` stores only IDs/public keys and phase progress.
  Failed operations retry after 30 seconds, doubling to a two-hour maximum.
  Enqueue only for a fresh switch: it merges targets and resets phase progress
  because reselecting/reconfiguring that bridge may have recreated its grants.
- `cleanupState(id)` returns `{state, attempts, nextAttemptAt, error?}` or
  undefined. Project it into `machine.bridgeSetup.cleanup` for visible pending,
  running, or blocked state. Every remote mutation checks the active bridge ID;
  reselecting an old bridge blocks its queued cleanup, including after awaits.
- Missing bridge rows stay blocked; they are never assumed to be retired.
  After successful remote `retireBridge`, call `await cancel(id)` before deleting
  the row. Keep the row and job if retirement fails. Offline full target credential
  removals, including their original bridge ID, remain in the backend's separate
  `credentialRemovals` records even after tunnel retirement succeeds.

Capabilities have 256-bit random tokens, expire after two hours (or a shorter
explicit `expiresAt`), and are durably consumed before the first key/config
response is sent. A separate random receipt authorizes a bounded install report
after consumption. GET script is non-consuming so a user can inspect it first.
After key download both GET endpoints return 410. The report contains a public
target host key; the backend must check the machine through its pinned runner
before claiming it is online. Do not put tokens/commands into logs or task boards.
LAN callbacks additionally include optional `lanHost`: Drover's listener derives
the normalized private/loopback IPv4 from the HTTP socket, ignoring JSON and
forwarded headers. Bridge callbacks omit it. This address identifies a candidate
target; the reported public host key still requires the backend's confirmation.

HTTPS delivery uses a loopback Python service on bridge port 8791 and Caddy's
`/machines/install/*` route. It supports an explicit hostname or derives an
sslip.io hostname from a public IPv4 address. Existing custom Caddy configurations
are rejected for manual integration. UFW changes are additive 80/443 rules only
when UFW is already active; no firewall reset, public reverse ports or provider
firewall changes. The loopback listeners require no inbound firewall opening.
With `bridge:null`, the temporary Drover server advertises a private IPv4 LAN
address; there is no internet/NAT traversal. The backend must expose this LAN
fallback if no public bridge is selected. LAN HTTP assumes a trusted local network;
use bridge HTTPS when sending a command across networks.

Linux uses systemd and a dedicated `agent` account. macOS uses a LaunchDaemon and
requires Python 3 and permission to enable Remote Login. Windows uses elevated
64-bit PowerShell, OpenSSH and a SYSTEM scheduled task, with a dedicated
ProgramData key file rather than a shared administrators key. All install the
management public key on the same account. Read-only Linux requires the backend's
forced-command bubblewrap script; the installer runs it as `agent` and fails if
the sandbox is unavailable. macOS/Windows read-only fail closed. Selected projects
are advisory scope with full key access, as approved by the lead.

## Explicit remaining phone limitation for the lead

`caddy=true` creates the phone reverse-proxy route **only**. No desktop website
reverse tunnel is created by this module. Therefore this option does not provide
working phone access by itself. `bridgePhoneForward(localRemotePort)` describes
the required forward; an independent desktop tunnel credential, restricted
bridge account, pinned host key and Drover lifecycle are still required. Keep the
existing `remote/install.sh bridge` flow until that integration is implemented.
Do not report the phone path as verified or ready from Caddy provisioning alone.

## Isolated verification

```sh
python3 remote/machines/tests.py
python3 remote/tests/setup_checks.py
docker build -t drover-machines-checks:local -f remote/machines/Dockerfile.checks remote
docker run --rm --network none --tmpfs /tmp drover-machines-checks:local
node --test tests/machines-provision.test.mjs
node --test tests/machines-cleanup.test.mjs
DROVER_MACHINE_KERNEL_TEST=1 node --test tests/machines-kernel.test.mjs
DROVER_MACHINE_RECOVERY_TEST=1 node --test tests/machines-recovery.test.mjs
docker run --rm --network none --tmpfs /tmp:exec -e DROVER_MACHINE_CONTAINER_TEST=1 drover-machines-checks:local python3 /fixture/remote/machines/container-install-check.py
docker run --rm --network none --security-opt seccomp=unconfined --tmpfs /tmp:exec --mount type=bind,source="$PWD/src/main/machines/permissions.ts",target=/fixture/permissions.ts,readonly drover-machines-checks:local python3 /fixture/remote/machines/kernel-guard-check.py
```

No real server, user SSH config, live Drover/herdr or agent process is used.
The container integration uses real OpenSSH on loopback with generated fixture
keys and a systemd lifecycle test double; it verifies target key login, reverse
forwarding, tunnel shell refusal, report, 0600 downloaded private key, retirement
and that delayed removal cannot revive a revoked jump key.
The recovery fixtures use a real root orphan SSH process, old restricted and
untagged public keys, and an unrelated key. They verify LAN and replacement bridge
recovery, failure on a foreign unit, old tunnel removal, preserved unrelated
credentials and the capability-bound completion report.
The separate kernel regression installs the exact `READ_ONLY_GUARD` BPF using a
test-only bwrap shim and prctl. Its positive control removes only the three
io_uring denials, then reaches a UNIX daemon via real io_uring while ordinary
socket syscalls stay denied. The production filter must deny setup/enter/register
with EPERM. Docker's default seccomp is disabled for this check so it cannot mask
an ineffective Drover filter. This test does not assert mounts or namespaces.
PowerShell parsing can run in an isolated PowerShell container. Full Windows and
macOS installation, systemd/launchd boot behavior, certificate issuance and phone
access still need platform VM tests before release.

The desktop adapter passes `onReport` to ingest installer receipt status/host
keys, issues links with two-hour validity and passes `bridge:null` for LAN
fallback. Reported host keys still require the user's independent confirmation
before its pinned SSH checks claim that the target is online.

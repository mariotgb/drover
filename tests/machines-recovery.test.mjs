import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

for (const mode of ['lan', 'bridge']) {
  test(`Linux installer recovery retires old keys/tunnel before ${mode} replacement and bound receipt`, { skip: process.env.DROVER_MACHINE_RECOVERY_TEST !== '1' }, () => {
    const output = execFileSync('docker', ['run', '--rm', '--network', 'none', '--tmpfs', '/tmp:exec', '-e', 'DROVER_MACHINE_CONTAINER_TEST=1',
      'drover-machines-checks:local', 'python3', '/fixture/remote/machines/container-recovery-check.py', mode], { encoding: 'utf8', timeout: 40_000 })
    assert.match(output, /real orphan tunnel removed/)
    assert.match(output, /bound receipt OK/)
  })
}

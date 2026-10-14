import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
test('Mac tunnel transactions stage, verify, recover, retry and reconfigure with fake launchctl', () => {
  execFileSync('python3', ['tests/mac-tunnel_checks.py'], { stdio: 'pipe', timeout: 30_000 })
})

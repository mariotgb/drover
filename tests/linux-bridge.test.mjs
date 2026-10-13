import { test } from 'node:test'
import { execFileSync } from 'node:child_process'

test('Linux user bridge validates rendering, pins, lifecycle status and install rollback with fake systemd', () => {
  execFileSync('python3', ['tests/linux-bridge_checks.py'], { stdio: 'pipe', timeout: 30000 })
})

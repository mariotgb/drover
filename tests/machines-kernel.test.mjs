import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

test('exact read-only guard BPF denies a proven io_uring UNIX socket escape', { skip: process.env.DROVER_MACHINE_KERNEL_TEST !== '1' }, () => {
  const output = execFileSync('docker', ['run', '--rm', '--network', 'none', '--security-opt', 'seccomp=unconfined', '--tmpfs', '/tmp:exec',
    '--mount', `type=bind,source=${resolve('remote/machines/kernel-guard-check.py')},target=/fixture/kernel-guard-check.py,readonly`,
    '--mount', `type=bind,source=${resolve('src/main/machines/permissions.ts')},target=/fixture/permissions.ts,readonly`,
    'drover-machines-checks:local', 'python3', '/fixture/kernel-guard-check.py'], { encoding: 'utf8', timeout: 30_000 })
  assert.match(output, /Positive control reached UNIX daemon through real io_uring/)
  assert.match(output, /All three io_uring syscalls denied by production BPF/)
})

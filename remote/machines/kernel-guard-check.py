#!/usr/bin/env python3
"""Real io_uring socket bypass regression in a disposable Linux container.

The test-only bwrap shim installs the exact production BPF with prctl. It does
not perform mounts/namespaces, so this test makes no mount-isolation claims.
Run with Docker seccomp=unconfined so Docker cannot mask a missing Drover deny.
"""
import ctypes
import errno
import hashlib
import json
import mmap
import os
from pathlib import Path
import shlex
import socket
import struct
import subprocess
import sys
import tempfile
import threading


def linux_container():
    if not sys.platform.startswith('linux') or not Path('/.dockerenv').exists():
        sys.exit('Run only inside the isolated Linux Machines check container.')


def install_filter(args):
    linux_container()
    fd = int(args[args.index('--seccomp') + 1])
    code = os.read(fd, 65536)
    assert code and len(code) % 8 == 0

    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                    ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]

    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]

    filters = (Filter * (len(code) // 8)).from_buffer_copy(code)
    program = Program(len(filters), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.prctl(38, 1, 0, 0, 0) == 0, ctypes.get_errno()  # NO_NEW_PRIVS
    assert libc.prctl(22, 2, ctypes.byref(program), 0, 0) == 0, ctypes.get_errno()
    print('BPF ' + hashlib.sha256(code).hexdigest(), flush=True)
    os.execv(args[-3], args[-3:])


class Ring:
    def __init__(self, libc):
        self.libc = libc
        params = ctypes.create_string_buffer(120)
        self.fd = libc.syscall(425, 4, ctypes.byref(params))
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), 'io_uring_setup must work in the positive control')
        u32 = lambda offset: struct.unpack_from('I', params, offset)[0]
        self.sq_head, self.sq_tail, self.sq_mask, self.sq_array = (u32(n) for n in (40, 44, 48, 64))
        self.cq_head, self.cq_tail, self.cq_mask, self.cqes = (u32(n) for n in (80, 84, 88, 100))
        sq_size = self.sq_array + u32(0) * 4
        cq_size = self.cqes + u32(4) * 16
        mapping = lambda size, offset: mmap.mmap(self.fd, size, flags=mmap.MAP_SHARED,
                                                prot=mmap.PROT_READ | mmap.PROT_WRITE, offset=offset)
        self.sq = mapping(max(sq_size, cq_size) if u32(20) & 1 else sq_size, 0)
        self.cq = self.sq if u32(20) & 1 else mapping(cq_size, 0x8000000)
        self.entries = mapping(u32(0) * 64, 0x10000000)

    def operation(self, opcode, fd=-1, offset=0, address=0, length=0):
        tail = struct.unpack_from('I', self.sq, self.sq_tail)[0]
        slot = tail & struct.unpack_from('I', self.sq, self.sq_mask)[0]
        entry = bytearray(64)
        struct.pack_into('B', entry, 0, opcode)
        # Pack separately: native alignment of iQQI differs from the SQE ABI.
        struct.pack_into('i', entry, 4, fd)
        struct.pack_into('Q', entry, 8, offset)
        struct.pack_into('Q', entry, 16, address)
        struct.pack_into('I', entry, 24, length)
        self.entries[slot * 64:(slot + 1) * 64] = entry
        struct.pack_into('I', self.sq, self.sq_array + slot * 4, slot)
        struct.pack_into('I', self.sq, self.sq_tail, tail + 1)
        result = self.libc.syscall(426, self.fd, 1, 1, 1, 0, 0)  # GETEVENTS
        assert result >= 0, ctypes.get_errno()
        head = struct.unpack_from('I', self.cq, self.cq_head)[0]
        assert head != struct.unpack_from('I', self.cq, self.cq_tail)[0]
        position = self.cqes + (head & struct.unpack_from('I', self.cq, self.cq_mask)[0]) * 16
        result = struct.unpack_from('i', self.cq, position + 8)[0]
        struct.pack_into('I', self.cq, self.cq_head, head + 1)
        if result < 0:
            raise OSError(-result, 'io_uring operation failed')
        return result


def probe(path, mode):
    linux_container()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # The positive control also denies conventional sockets. Thus success must
    # come from io_uring, not an absent/incorrectly installed seccomp filter.
    try:
        socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        raise AssertionError('conventional socket unexpectedly allowed')
    except OSError as error:
        assert error.errno == errno.EPERM, error
    if mode == 'blocked':
        params = ctypes.create_string_buffer(120)
        for number, args in [(425, (4, ctypes.byref(params))),
                             (426, (-1, 0, 0, 0, 0, 0)), (427, (-1, 0, 0, 0))]:
            ctypes.set_errno(0)
            assert libc.syscall(number, *args) == -1
            assert ctypes.get_errno() == errno.EPERM, (number, ctypes.get_errno())
        print('All three io_uring syscalls denied by production BPF.')
        return
    ring = Ring(libc)
    # IORING_OP_SOCKET=45, CONNECT=16, SEND=26. No socket/connect syscall.
    fd = ring.operation(45, fd=socket.AF_UNIX, offset=socket.SOCK_STREAM)
    sockaddr = ctypes.create_string_buffer(struct.pack('H', socket.AF_UNIX) + os.fsencode(path) + b'\0')
    ring.operation(16, fd=fd, offset=ctypes.sizeof(sockaddr), address=ctypes.addressof(sockaddr))
    payload = ctypes.create_string_buffer(b'DROVER-URING-ESCAPE')
    assert ring.operation(26, fd=fd, address=ctypes.addressof(payload), length=len(payload.value)) == len(payload.value)
    os.close(fd)
    print('Positive control reached UNIX daemon through real io_uring.')


def main(permissions_path):
    linux_container()
    # This literal is currently plain Python: reject interpolation/escapes so
    # future changes cannot silently turn this into an approximation of it.
    source = Path(permissions_path).read_text()
    guard = source.split('export const READ_ONLY_GUARD = `', 1)[1].split('\n`', 1)[0] + '\n'
    assert '${' not in guard and '\\' not in guard
    assert guard.count('denied += [425,426,427]') == 1
    with tempfile.TemporaryDirectory(prefix='drover-kernel-check-') as temp:
        root = Path(temp); fake = root / 'bin'; fake.mkdir()
        shim = fake / 'bwrap'
        shim.write_text('#!/bin/sh\nexec python3 ' + shlex.quote(str(Path(__file__).resolve())) + ' --bwrap "$@"\n')
        shim.chmod(0o700)
        sockpath = str(root / 'daemon.sock')
        messages = []
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as daemon:
            daemon.bind(sockpath); daemon.listen(4); daemon.settimeout(5)
            def receive():
                connection, _ = daemon.accept()
                with connection:
                    chunks = []
                    while True:
                        chunk = connection.recv(1024)
                        if not chunk:
                            break
                        chunks.append(chunk)
                    messages.append(b''.join(chunks))
            thread = threading.Thread(target=receive); thread.start()
            outputs = []
            for mode, text in [('escape', guard.replace('denied += [425,426,427]', 'denied += []')),
                               ('blocked', guard)]:
                file = root / (mode + '.py'); file.write_text(text)
                command = shlex.join(['python3', str(Path(__file__).resolve()), '--probe', sockpath, mode])
                result = subprocess.run(['python3', str(file)], env={**os.environ, 'PATH': str(fake) + ':' + os.environ['PATH'], 'SSH_ORIGINAL_COMMAND': command}, text=True, capture_output=True, timeout=15)
                assert result.returncode == 0, result.stdout + result.stderr
                outputs.append(result.stdout)
            thread.join(timeout=6)
            assert not thread.is_alive() and messages == [b'DROVER-URING-ESCAPE'], messages
            assert outputs[0].splitlines()[0] != outputs[1].splitlines()[0], 'control BPF must differ'
            print(json.dumps({'kernel': os.uname().release, 'architecture': os.uname().machine,
                              'daemon_messages': len(messages), 'production_io_uring_denied': [425, 426, 427]}))
            print(''.join(outputs), end='')


if __name__ == '__main__':
    if sys.argv[1:2] == ['--bwrap']:
        install_filter(sys.argv[2:])
    elif sys.argv[1:2] == ['--probe']:
        probe(*sys.argv[2:])
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else '/fixture/permissions.ts')

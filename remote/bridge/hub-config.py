#!/usr/bin/env python3
"""Stage a policy Include before the first Match, including nested Includes.
Only the insertion point and old managed Includes change on disk. Other Include
paths stay live; no flattened system config is installed. prepare/commit/restore
use a private transaction directory, so a failed reload can restore every file.
"""
import glob
import json
import os
import shlex
import shutil
import sys
from pathlib import Path

MARK = '# drover-hub-policy (managed)'


def tokens(line):
    return shlex.split(line, comments=True)


def prepare(root, old, policy, work):
    root, old, policy, work = map(Path, (root, old, policy, work))
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    originals, edited, candidates = {}, {}, {}
    anchor = None
    active = set()
    policy_line = f'Include {policy} {MARK}\n'

    def visit(path, depth=0):
        nonlocal anchor
        path = Path(os.path.abspath(path))
        if path == old or path == policy:
            return None  # Previous managed policy is replaced, never read twice.
        if depth > 16 or path in active:
            raise ValueError(f'cyclic/deep Include: {path}')
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'unsafe config file: {path}')
        if path in candidates:
            raise ValueError(f'repeated Include of {path}; simplify config before installing')
        active.add(path)
        text = path.read_text()
        originals[str(path)] = text
        source, staged = [], []
        dest = work / ('config-' + str(len(candidates)))
        candidates[path] = dest
        for line in text.splitlines(keepends=True):
            if MARK in line:
                continue
            t = tokens(line)
            if t and t[0].lower() == 'include':
                paths = []
                for pattern in t[1:]:
                    # OpenSSH resolves relative Includes against /etc/ssh.
                    pattern = pattern if os.path.isabs(pattern) else '/etc/ssh/' + pattern
                    paths.extend(sorted(glob.glob(pattern)))
                children = [visit(p, depth + 1) for p in paths]
                children = [p for p in children if p is not None]
                source.append(line)
                if children:
                    staged.append('Include ' + ' '.join(map(str, children)) + '\n')
                continue
            if t and t[0].lower() == 'match' and anchor is None:
                anchor = path
                source.append(policy_line)
                staged.append(f'Include {work / "policy"}\n')
            source.append(line)
            staged.append(line)
        active.remove(path)
        edited[str(path)] = ''.join(source)
        dest.write_text(''.join(staged))
        return dest

    candidate = visit(root)
    if anchor is None:
        edited[str(root)] = edited[str(root)].rstrip('\n') + '\n' + policy_line
        with candidate.open('a') as f:
            f.write(f'\nInclude {work / "policy"}\n')
    changes = {p: text for p, text in edited.items() if text != originals[p]}
    changes[str(old)] = None
    changes[str(policy)] = (work / 'policy').read_text()
    entries = []
    for i, (name, text) in enumerate(changes.items()):
        p = Path(name)
        if p.is_symlink():
            raise ValueError(f'refusing symlink: {p}')
        exists = p.exists()
        backup = work / f'backup-{i}'
        if exists:
            shutil.copy2(p, backup)
        st = p.stat() if exists else None
        entries.append(dict(path=name, content=text, backup=str(backup), exists=exists,
                            mode=st.st_mode & 0o777 if st else 0o644,
                            uid=st.st_uid if st else os.getuid(), gid=st.st_gid if st else os.getgid()))
    (work / 'plan.json').write_text(json.dumps(entries))
    print(candidate)


def apply(work, restore=False):
    for e in json.loads((Path(work) / 'plan.json').read_text()):
        p = Path(e['path'])
        if p.is_symlink():
            raise ValueError(f'refusing symlink: {p}')
        content = Path(e['backup']).read_bytes() if restore and e['exists'] else e['content']
        if (restore and not e['exists']) or (not restore and content is None):
            p.unlink(missing_ok=True)
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name('.' + p.name + '.drover-new')
        with tmp.open('xb') as f:
            f.write(content if isinstance(content, bytes) else content.encode())
            os.fchmod(f.fileno(), e['mode'])
            if os.geteuid() == 0:
                os.fchown(f.fileno(), e['uid'], e['gid'])
        os.replace(tmp, p)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'prepare':
            prepare(*sys.argv[2:])
        elif sys.argv[1] in ('commit', 'restore'):
            apply(sys.argv[2], sys.argv[1] == 'restore')
        else:
            raise ValueError('unknown operation')
    except (ValueError, OSError) as error:
        sys.exit(f'hub-config: {error}')

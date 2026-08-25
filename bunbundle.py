#!/usr/bin/env python3
"""Unpack and repack the JS modules embedded in a bun standalone binary.

  bunbundle.py unpack <binary> <out.js>   concatenate every JS module, one
                                          `//__CHUNK__ <name>` marker line each
  bunbundle.py repack <in.js> <binary>    write the concatenation back into an
                                          existing copy of that binary

Blob format
-----------
A bun standalone binary ends with a blob laid out as: string region, module
table, argv, a 32-byte header, then the trailer `\\n---- Bun! ----\\n`. The
header holds, little-endian: u64 blob byte count (also the header's own offset
inside the blob), u32 module table offset, u32 module table length, u32 entry
module id, u32 argv offset, u32 argv length, u32 flags. All offsets are
relative to the start of the blob.

Each module is a 52-byte struct: six (u32 offset, u32 length) pointers into the
string region — name, contents, sourcemap, bytecode, module info, bytecode
origin path — followed by four flag bytes. Flag byte 1 is the loader: 1 for a
JS module, 5 for a file asset (`.min.js` libraries, HTML payloads), 10 for a
native `.node` addon. Only loader 1 modules are JS the runtime executes; this
tool moves exactly those. Every string in the region is NUL-terminated.

Fixed-length rebuild
--------------------
The rebuild pins the module table at its original offset and lets the string
region absorb the size delta as slack, so the blob — and the whole binary —
keeps its original byte length and every other file offset in the Mach-O image
stays valid.

Bytecode
--------
JS modules carry precompiled JSC bytecode, which bun validates against the
source and rejects on mismatch. A modified module therefore has its bytecode
field cleared and is compiled from source at startup. Bytecode dwarfs source
(hundreds of MB against tens), so clearing a single module frees far more slack
than any patch consumes.
"""
import os
import re
import struct
import subprocess
import sys
import tempfile

TRAILER = b'\n---- Bun! ----\n'
STRUCT_SIZE = 52
JS_LOADER = 1
MARKER = b'//__CHUNK__ '
MARKER_RE = re.compile(b'(?:\\A|(?<=\n))' + re.escape(MARKER))
FIELDS = ('name', 'contents', 'sourcemap', 'bytecode', 'moduleInfo', 'bytecodeOriginPath')


class Blob:
    def __init__(self, path):
        self.path = path
        self.data = bytearray(open(path, 'rb').read())
        head = self.data.rfind(TRAILER) - 32
        if head < 0:
            raise SystemExit(f'{path}: no bun standalone trailer — not a bun binary')
        (byte_count,) = struct.unpack_from('<Q', self.data, head)
        self.base = head - byte_count
        self.blob_len = byte_count + 32 + len(TRAILER)
        blob = memoryview(self.data)[self.base:self.base + self.blob_len]
        self.table_off, self.table_len = struct.unpack_from('<II', self.data, head + 8)
        (self.entry_id,) = struct.unpack_from('<I', self.data, head + 16)
        argv_off, argv_len = struct.unpack_from('<II', self.data, head + 20)
        (self.flags,) = struct.unpack_from('<I', self.data, head + 28)
        self.argv = bytes(blob[argv_off:argv_off + argv_len])
        table = bytes(blob[self.table_off:self.table_off + self.table_len])
        self.mods = []
        for k in range(self.table_len // STRUCT_SIZE):
            o = k * STRUCT_SIZE
            m = {}
            for j, field in enumerate(FIELDS):
                off, ln = struct.unpack_from('<II', table, o + 8 * j)
                m[field] = bytes(blob[off:off + ln])
            m['efs'] = struct.unpack_from('<BBBB', table, o + 48)
            self.mods.append(m)
        self.js = [m for m in self.mods if m['efs'][1] == JS_LOADER]
        self.js_names = [os.path.basename(m['name'].decode()) for m in self.js]

    def rebuild(self):
        strings = [m[f] for m in self.mods for f in FIELDS]
        offsets = []
        u = 0
        for s in strings:
            offsets.append((u, len(s)))
            u += len(s) + 1
        if u > self.table_off:
            raise SystemExit(f'string region grew past the module table: {u} > {self.table_off}')
        argv_off = self.table_off + self.table_len
        head = argv_off + len(self.argv) + 1
        if head + 32 + len(TRAILER) != self.blob_len:
            raise SystemExit(f'blob length changed: {head + 32 + len(TRAILER)} != {self.blob_len}')
        blob = bytearray(self.blob_len)
        for s, (off, ln) in zip(strings, offsets):
            blob[off:off + ln] = s
        blob[argv_off:argv_off + len(self.argv)] = self.argv
        for k, m in enumerate(self.mods):
            o = self.table_off + k * STRUCT_SIZE
            for j in range(len(FIELDS)):
                struct.pack_into('<II', blob, o + 8 * j, *offsets[k * len(FIELDS) + j])
            struct.pack_into('<BBBB', blob, o + 48, *m['efs'])
        struct.pack_into('<Q', blob, head, head)
        struct.pack_into('<II', blob, head + 8, self.table_off, self.table_len)
        struct.pack_into('<I', blob, head + 16, self.entry_id)
        struct.pack_into('<II', blob, head + 20, argv_off, len(self.argv))
        struct.pack_into('<I', blob, head + 28, self.flags)
        blob[head + 32:head + 32 + len(TRAILER)] = TRAILER
        self.data[self.base:self.base + self.blob_len] = blob
        with open(self.path, 'wb') as f:
            f.write(self.data)
        os.chmod(self.path, 0o755)


def split(data):
    """Marker-delimited concatenation -> [(name, contents)], undoing the added newline."""
    starts = [m.start() for m in MARKER_RE.finditer(data)]
    if not starts or starts[0] != 0:
        raise SystemExit(f'concatenation does not start with a {MARKER.decode()}marker line')
    chunks = []
    for start, end in zip(starts, starts[1:] + [len(data)]):
        line_end = data.find(b'\n', start)
        if line_end < 0 or line_end >= end:
            raise SystemExit(f'marker line {data[start:end].decode()} has no body')
        name = data[start + len(MARKER):line_end].decode()
        body = data[line_end + 1:end]
        if not body.endswith(b'\n'):
            raise SystemExit(f'chunk {name} does not end with a newline')
        chunks.append((name, body[:-1]))
    return chunks


def unpack(binary, out):
    blob = Blob(binary)
    if len(set(blob.js_names)) != len(blob.js_names):
        raise SystemExit('JS module basenames are not unique')
    for name, m in zip(blob.js_names, blob.js):
        if MARKER_RE.search(m['contents']):
            raise SystemExit(f'{name} contains the chunk marker, so it cannot be concatenated')
    parts = []
    for name, m in zip(blob.js_names, blob.js):
        parts += [MARKER, name.encode(), b'\n', m['contents'], b'\n']
    data = b''.join(parts)
    chunks = split(data)
    if chunks != list(zip(blob.js_names, (m['contents'] for m in blob.js))):
        raise SystemExit('self-check failed: splitting the concatenation does not reproduce the modules')
    with open(out, 'wb') as f:
        f.write(data)
    print(f'unpacked {len(chunks)} JS modules ({len(data)} bytes) to {out}')


def repack(src, binary):
    blob = Blob(binary)
    chunks = split(open(src, 'rb').read())
    names = [name for name, _ in chunks]
    if names != blob.js_names:
        extra = [n for n in names if n not in set(blob.js_names)]
        missing = [n for n in blob.js_names if n not in set(names)]
        first = next(i for i, (a, b) in enumerate(zip(names + [None], blob.js_names + [None])) if a != b)
        raise SystemExit(
            f'chunk markers do not match {binary}: {len(names)} chunks vs {len(blob.js_names)} JS modules, '
            f'first difference at index {first} ({names[first:first + 1]} vs {blob.js_names[first:first + 1]}), '
            f'unexpected {extra[:5]}, missing {missing[:5]}')
    changed = 0
    for (name, contents), m in zip(chunks, blob.js):
        if contents == m['contents']:
            continue
        node_check(name, contents, m['contents'])
        m['contents'] = contents
        m['bytecode'] = b''
        changed += 1
        print(f'patched {name} ({len(contents)} bytes)')
    blob.rebuild()
    print(f'repacked {changed} modified module(s) into {binary}')


def node_check(name, contents, stock):
    """node is a stand-in parser for the bun runtime, so it must be new enough
    for the bundle's syntax — the `using` declarations in current bundles need
    node >= 24. A stock module the checker cannot parse means the checker is
    behind, not that a patch broke anything, so tell those two apart."""
    def check(text):
        with tempfile.NamedTemporaryFile(suffix='.mjs', delete=False) as f:
            f.write(text)
        try:
            return subprocess.run(['node', '--check', f.name], capture_output=True, text=True)
        finally:
            os.unlink(f.name)
    r = check(contents)
    if r.returncode:
        if check(stock).returncode:
            raise SystemExit(f'node cannot parse even the stock {name} — too old for this '
                             f'bundle\'s syntax, install node >= 24:\n{r.stderr}')
        raise SystemExit(f'{name} is not valid JavaScript after patching:\n{r.stderr}')


if __name__ == '__main__':
    cmd, args = (sys.argv + [''])[1], sys.argv[2:]
    if cmd == 'unpack' and len(args) == 2:
        unpack(*args)
    elif cmd == 'repack' and len(args) == 2:
        repack(*args)
    else:
        raise SystemExit(__doc__.split('\n\nBlob format')[0])

#!/usr/bin/env python3
"""Unpack and repack the JS modules embedded in a bun standalone binary.

  bunbundle.py unpack <binary> <out.js>   concatenate every JS module, one
                                          `//__CHUNK__ <name>` marker line each
  bunbundle.py repack <in.js> <binary>    write the concatenation back into an
                                          existing copy of that binary

Blob format
-----------
A bun standalone binary ends with a blob laid out as: string region, module
table, optional records, argv, a 32-byte header, then the trailer
`\\n---- Bun! ----\\n`. The header holds, little-endian: u64 blob byte count
(also the header's own offset inside the blob), u32 module table offset, u32
module table length, u32 entry module id, u32 argv offset, u32 argv length, u32
flags. All offsets are relative to the start of the blob.

Each module is a 52-byte struct: six (u32 offset, u32 length) pointers into the
string region — name, contents, sourcemap, bytecode, module info, bytecode
origin path — followed by four flag bytes. Flag byte 0 is the string encoding,
1 for Latin-1. Flag byte 1 is the loader: 1 for a JS module, 5 for a file asset
(`.min.js` libraries, HTML payloads), 10 for a native `.node` addon. Only
loader 1 modules are JS the runtime executes; this tool moves exactly those.
Every string in the region is NUL-terminated.

The records between the module table and argv are each present when their flag
bit is set, laid out in bit order: bit 5, a `[u32; modules]` array of Latin-1
hashes of the modules' contents (0 means unrecorded, and the runtime then
hashes the source itself); bit 6, a builtin bytecode table of a u32 count
followed by count × {u32 id, u32 offset, u32 length}; bit 7, a (u32 offset, u32
length) pointer to the shared bytecode string table every module's bytecode
refers into; bit 8, a u32 startup module count. Bit 4 promises that all module
contents lie in one contiguous run no other region overlaps, which the runtime
madvise(DONTNEED)s once startup is done. Bytecode starts at an offset ≡ 120
(mod 128).

In-place edit
-------------
The repack rewrites only the bytes it must, so every byte it does not touch
keeps its offset and the blob, the binary, and every other file offset in the
executable stay valid. Clearing a modified module's bytecode opens a hole in
the string region; each new source is written into the first hole that fits it,
the module's contents pointer is repointed there, its source hash is zeroed,
and flag bit 4 is cleared because the new source sits outside the contiguous
run.

Bytecode
--------
JS modules carry precompiled JSC bytecode, which bun validates against the
source and rejects on mismatch. A modified module therefore has its bytecode
field cleared and is compiled from source at startup. Bytecode dwarfs source
(hundreds of MB against tens), so the hole one cleared module opens swallows
far more than any patch needs.
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
LATIN1 = 1
HAS_SOURCE_HASHES = 1 << 5
SOURCE_TEXT_CONTIGUOUS = 1 << 4
MARKER = b'//__CHUNK__ '
MARKER_RE = re.compile(b'(?:\\A|(?<=\n))' + re.escape(MARKER))
FIELDS = ('name', 'contents', 'sourcemap', 'bytecode', 'moduleInfo', 'bytecodeOriginPath')


class Blob:
    def __init__(self, path):
        self.path = path
        self.data = bytearray(open(path, 'rb').read())
        self.head = self.data.rfind(TRAILER) - 32
        if self.head < 0:
            raise SystemExit(f'{path}: no bun standalone trailer — not a bun binary')
        (byte_count,) = struct.unpack_from('<Q', self.data, self.head)
        self.base = self.head - byte_count
        self.blob = memoryview(self.data)[self.base:self.head + 32 + len(TRAILER)]
        self.table_off, self.table_len = struct.unpack_from('<II', self.blob, byte_count + 8)
        (self.flags,) = struct.unpack_from('<I', self.blob, byte_count + 28)
        self.mods = []
        for k in range(self.table_len // STRUCT_SIZE):
            o = self.table_off + k * STRUCT_SIZE
            p = struct.unpack_from('<12I', self.blob, o)
            ptr = dict(zip(FIELDS, zip(p[::2], p[1::2])))
            m = {'index': k, 'ptr': ptr, 'efs': struct.unpack_from('<BBBB', self.blob, o + 48)}
            for field in ('name', 'contents'):
                off, ln = ptr[field]
                m[field] = bytes(self.blob[off:off + ln])
            self.mods.append(m)
        self.js = [m for m in self.mods if m['efs'][1] == JS_LOADER]
        self.js_names = [os.path.basename(m['name'].decode()) for m in self.js]

    def set_ptr(self, m, field, off, ln):
        o = self.table_off + m['index'] * STRUCT_SIZE + 8 * FIELDS.index(field)
        struct.pack_into('<II', self.blob, o, off, ln)

    def write(self, patched):
        """Splice each patched module's contents in, reusing the space its now-stale
        bytecode occupied. Nothing else in the blob moves or changes length."""
        holes = []
        for m in patched:
            if m['efs'][0] != LATIN1:
                raise SystemExit(f"{m['name'].decode()}: string encoding {m['efs'][0]} is not Latin-1")
            off, ln = m['ptr']['bytecode']
            if ln:
                holes.append([off, ln])
            self.set_ptr(m, 'bytecode', 0, 0)
            if self.flags & HAS_SOURCE_HASHES:
                struct.pack_into('<I', self.blob, self.table_off + self.table_len + 4 * m['index'], 0)
        for m in patched:
            need = len(m['contents']) + 1
            hole = next((h for h in holes if h[1] >= need), None)
            if hole is None:
                largest = max((h[1] for h in holes), default=0)
                raise SystemExit(f"no freed bytecode hole fits {m['name'].decode()}: needs {need} "
                                 f'bytes, largest free hole is {largest}')
            off = hole[0]
            hole[0] += need
            hole[1] -= need
            self.blob[off:off + need] = m['contents'] + b'\0'
            self.set_ptr(m, 'contents', off, len(m['contents']))
        self.flags &= ~SOURCE_TEXT_CONTIGUOUS
        struct.pack_into('<I', self.data, self.head + 28, self.flags)
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
    patched = []
    for (name, contents), m in zip(chunks, blob.js):
        if contents == m['contents']:
            continue
        node_check(name, contents, m['contents'])
        m['contents'] = contents
        patched.append(m)
        print(f'patched {name} ({len(contents)} bytes)')
    blob.write(patched)
    print(f'repacked {len(patched)} modified module(s) into {binary}')


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

// Usage: node make_pets_look_right.js <Sims3.xex image dumped from memory at 0x88000000> <output .toml block>
// make_smart_copies.js also appends this block to "Smart screen copies.toml".
//
// Builds the "Pets look right" patch block for The Sims 3 Pets (Sims3.xex, hash DF7B98E763E34184).
// Each frame the game poses most pets' fur on the graphics card with memory export into a "PetFur" buffer, and the
// fur is then drawn from that buffer. With Xenia's memexport readback off (the fast setting) the CPU's copy of that
// buffer is never filled in, which is fine as long as Xenia never reloads it. Three game quirks make Xenia reload it:
//  1. The buffer sits in the general heap with 4-byte alignment (0x88563FF8 -> 0x88430B40(size, 4)), so its first and
//     last memory pages are shared with other game data. When the game writes that data (every frame in a crowd),
//     Xenia reloads the whole page, pet vertices included, from the never-filled CPU copy: meshes stretched across the
//     map, holes and spikes. Fix: the PetFur call (0x88833190) uses a copy of the buffer-create function that asks
//     the allocator for 4096-byte alignment and a page-rounded size, so the fur owns every page it touches.
//     (Pointing the graphics card at a page boundary inside an ordinary block does not work: the game also poses some
//     pets on the CPU and writes those from the start of the block.)
//  2. Every frame the game's memory compactor (0x8842F298) walks all vertex buffers and moves each one lower in memory
//     when it can (0x88564100), asking for 4-byte alignment again. In a crowd that soon puts pet fur back on shared
//     pages. Fix: the create copy tags pet fur buffers by giving them their own copy of the resource vtable (same
//     entries; only the buffer's constructor and destructor refer to the original), and the compactor's allocation
//     (0x88564138) goes through a wrapper that asks for page alignment and a page-rounded size for tagged buffers.
//     Every other buffer is moved exactly as before.
//  3. The export stream constant's element count gets the buffer's size in BYTES (vertices x 48) instead of 16-byte
//     items, so Xenia treats 16 times the buffer as GPU-written on every export and can lose the game's own writes to
//     whatever lies after it. Fix: divide it by 16 (0x8842DA30, in the setup used only by the pet fur pass).
'use strict';
const fs = require('fs');
const A = require('./ppcasm');

function build(img) {
  const BASE = 0x88000000;
  const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const at = (a) => img.readUInt32BE(a - BASE);
  const expect = (a, w, what) => { if (at(a) !== w) throw new Error(`${hex(a)} is not ${what}`); };
  const CAVE = 0x89480D00, CAVE_END = 0x89480E00;      // spare code space after the Smart screen copies stubs
  for (let a = CAVE; a < CAVE_END; a += 4) if (at(a) !== 0) throw new Error('spare code space not free at ' + hex(a));
  const words = [];
  const put = (start, list) => list.forEach((w, i) => words.push([start + i * 4, w >>> 0]));

  // 1. Count fix: element count = bytes / 16.
  const SITE1 = 0x8842DA30, STUB1 = CAVE;
  expect(SITE1, 0x7D5EE1D6, '"mullw r10,r30,r28"');
  put(STUB1, [A.mullw(10, 30, 28), A.rlwinm(10, 10, 28, 4, 31), A.b(STUB1 + 8, SITE1 + 4)]);
  words.push([SITE1, A.b(SITE1, STUB1)]);

  // The tag: a copy of the vertex buffer's resource vtable (the interface at object + 8, five methods).
  const VT_SRC = 0x8803801C, VT_LEN = 5, VT = CAVE + 0xD0;
  expect(VT_SRC + 16, 0x88564100, 'the resource vtable (slot 4 = 0x88564100, the compactor\'s move)');
  expect(0x88564740, A.addi(10, 10, -32740), '"addi r10,r10,-32740" (the constructor storing that vtable)');
  put(VT, Array.from({ length: VT_LEN }, (_, i) => at(VT_SRC + i * 4)));

  // 2. PetFur buffer create: a copy of 0x88563FF8 asking for 4096-byte alignment and a page-rounded size, which
  //    tags the buffer just before it is registered with the compactor.
  const SRC = 0x88563FF8, SRC_END = 0x88564070, SITE2 = 0x88833190, DEST = CAVE + 0x10;
  expect(SITE2, A.bl(SITE2, SRC), '"bl 0x88563FF8"');
  expect(0x88564020, 0x38800004, '"li r4,4" (alignment)');
  expect(0x88564024, 0x7FA3EB78, '"mr r3,r29" (allocation size)');
  expect(0x8856405C, A.addi(3, 31, 8), '"addi r3,r31,8" (register with the compactor)');
  const out = [];
  for (let a = SRC; a < SRC_END; a += 4) {
    const w = at(a), pc = DEST + out.length * 4;
    if (a === 0x88564020) { out.push(A.li(4, 4096)); continue; }
    if (a === 0x88564024) { out.push(A.addi(3, 29, 4095), A.rlwinm(3, 3, 0, 0, 19)); continue; }
    if (a === 0x8856405C) out.push(A.lis(11, A.ha(VT)), A.addi(11, 11, A.lo(VT)), A.stw(11, 8, 31));
    const npc = DEST + out.length * 4;
    if ((w >>> 26) === 18 && !(w & 2)) { let d = w & 0x03FFFFFC; if (d & 0x02000000) d -= 0x04000000; out.push((A.b(npc, (a + d) >>> 0) | (w & 1)) >>> 0); continue; }
    if ((w >>> 26) === 16) throw new Error('conditional branch at ' + hex(a) + ' would need retargeting');
    out.push(w);
  }
  if (DEST + out.length * 4 > CAVE + 0xA0) throw new Error('create copy too long');
  put(DEST, out);
  words.push([SITE2, A.bl(SITE2, DEST)]);

  // 3. The compactor's allocation: tagged buffers get page alignment and a page-rounded size. In 0x88564100,
  //    r31 = object + 8 and r3 = size, r4 = alignment (4) for 0x88430B40.
  const SITE3 = 0x88564138, WRAP = CAVE + 0xA0, ALLOC = 0x88430B40;
  expect(SITE3, A.bl(SITE3, ALLOC), '"bl 0x88430B40" (the compactor\'s allocation)');
  expect(0x88564110, A.mr(31, 3), '"mr r31,r3"');
  expect(0x88564134, 0x38800004, '"li r4,4"');
  const wrap = [
    A.lwz(11, 0, 31),                 // the object's resource vtable
    A.lis(12, A.ha(VT)),
    A.addi(12, 12, A.lo(VT)),
    A.cmpw(6, 11, 12),
    0,                                // bne cr6, -> the plain call (filled in below)
    A.addi(3, 3, 4095),               // tagged: round the size up to whole pages
    A.rlwinm(3, 3, 0, 0, 19),
    A.li(4, 4096),                    // and ask for page alignment
  ];
  const PLAIN = WRAP + wrap.length * 4;
  wrap[4] = A.bne(WRAP + 16, PLAIN, 6);
  wrap.push(A.b(PLAIN, ALLOC));       // tail call: returns straight to the compactor
  if (WRAP + wrap.length * 4 > VT) throw new Error('wrapper too long');
  put(WRAP, wrap);
  words.push([SITE3, A.bl(SITE3, WRAP)]);

  words.sort((x, y) => x[0] - y[0]);
  return '[[patch]]\n    name = "Pets look right"\n' +
    '    desc = "Keeps pets in shape with Xenia\'s memexport readback off (the fast setting): no holes, spikes or meshes stretched across the map. Gives each pet\'s fur buffer memory pages of its own and its true size, also when the game tidies its memory, so Xenia never reloads it from stale memory."\n' +
    '    author = "Atronode"\n    is_enabled = true\n' +
    words.map(([a, v]) => `    [[patch.be32]]\n        address = ${hex(a)}\n        value = ${hex(v >>> 0)}\n`).join('');
}
module.exports = { build };

if (require.main === module) {
  const block = build(fs.readFileSync(process.argv[2]));
  fs.writeFileSync(process.argv[3], block);
  console.log(`${(block.match(/patch\.be32/g) || []).length} words written to ${process.argv[3]}`);
}

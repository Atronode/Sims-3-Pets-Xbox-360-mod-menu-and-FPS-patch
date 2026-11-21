// Tiny PowerPC assembler for the few instructions the Sims 3 Pets hooks need. Each function returns one 32-bit word.
'use strict';
const ha = (a) => ((a + 0x8000) >>> 16) & 0xFFFF;   // high half, adjusted for a signed low half
const lo = (a) => a & 0xFFFF;
const D = (op, rt, ra, d) => (((op << 26) | (rt << 21) | (ra << 16) | (d & 0xFFFF)) >>> 0);
const X = (rt, ra, rb, xo, rc = 0) => (((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1) | rc) >>> 0);
const asm = {
  ha, lo,
  lis: (rt, imm) => D(15, rt, 0, imm),
  addis: (rt, ra, imm) => D(15, rt, ra, imm),
  li: (rt, imm) => D(14, rt, 0, imm),
  addi: (rt, ra, imm) => D(14, rt, ra, imm),
  ori: (ra, rs, imm) => D(24, rs, ra, imm),
  lwz: (rt, d, ra) => D(32, rt, ra, d),
  stw: (rs, d, ra) => D(36, rs, ra, d),
  lbz: (rt, d, ra) => D(34, rt, ra, d),
  stb: (rs, d, ra) => D(38, rs, ra, d),
  stwu: (rs, d, ra) => D(37, rs, ra, d),
  // 64-bit load/store (DS form: the offset must be a multiple of 4).
  std: (rs, d, ra) => { if (d & 3) throw new Error('std offset must be a multiple of 4'); return D(62, rs, ra, d); },
  ld: (rt, d, ra) => { if (d & 3) throw new Error('ld offset must be a multiple of 4'); return D(58, rt, ra, d); },
  stfd: (frs, d, ra) => D(54, frs, ra, d),
  lfd: (frt, d, ra) => D(50, frt, ra, d),
  bctr: () => 0x4E800420,
  bctrl: () => 0x4E800421,
  mullw: (rt, ra, rb) => X(rt, ra, rb, 235),
  rlwinm: (ra, rs, sh, mb, me) => (((21 << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1)) >>> 0),
  cmpwi: (cr, ra, imm) => D(11, cr << 2, ra, imm),
  cmplwi: (cr, ra, imm) => D(10, cr << 2, ra, imm),
  cmpw: (cr, ra, rb) => X(cr << 2, ra, rb, 0),
  mr: (ra, rs) => X(rs, ra, rs, 444),                  // or ra,rs,rs
  mflr: (rt) => (((31 << 26) | (rt << 21) | (0x100 << 11) | (339 << 1)) >>> 0),
  mtlr: (rs) => (((31 << 26) | (rs << 21) | (0x100 << 11) | (467 << 1)) >>> 0),
  subf: (rt, ra, rb) => X(rt, ra, rb, 40),             // rt = rb - ra
  mtctr: (rs) => (((31 << 26) | (rs << 21) | (0x120 << 11) | (467 << 1)) >>> 0),
  bdnz: (pc, target) => ((16 << 26) | (16 << 21) | ((target - pc) & 0xFFFC)) >>> 0,
  blr: () => 0x4E800020,
  nop: () => 0x60000000,
  sync: () => 0x7C0004AC,
  // Relative branches: pc is the address of this instruction.
  b: (pc, target) => ((18 << 26) | ((target - pc) & 0x03FFFFFC)) >>> 0,
  bl: (pc, target) => (((18 << 26) | ((target - pc) & 0x03FFFFFC)) | 1) >>> 0,
  // Conditional branches on cr field `cr`: bit 2 = eq, 0 = lt, 1 = gt.
  beq: (pc, target, cr = 0) => ((16 << 26) | (12 << 21) | ((cr * 4 + 2) << 16) | ((target - pc) & 0xFFFC)) >>> 0,
  bne: (pc, target, cr = 0) => ((16 << 26) | (4 << 21) | ((cr * 4 + 2) << 16) | ((target - pc) & 0xFFFC)) >>> 0,
  blt: (pc, target, cr = 0) => ((16 << 26) | (12 << 21) | ((cr * 4 + 0) << 16) | ((target - pc) & 0xFFFC)) >>> 0,
  bge: (pc, target, cr = 0) => ((16 << 26) | (4 << 21) | ((cr * 4 + 0) << 16) | ((target - pc) & 0xFFFC)) >>> 0,
  bgt: (pc, target, cr = 0) => ((16 << 26) | (12 << 21) | ((cr * 4 + 1) << 16) | ((target - pc) & 0xFFFC)) >>> 0,
};
// Signed 16-bit low half for d(ra) forms, paired with ha().
asm.lo = (a) => a & 0xFFFF;
module.exports = asm;

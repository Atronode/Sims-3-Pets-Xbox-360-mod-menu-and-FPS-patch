// Usage: node make_smart_copies.js <Sims3.xex image dumped from memory at 0x88000000> "../mod-menu/fps-patch/Smart screen copies.toml"
// Builds the "Smart screen copies" Xenia patch for The Sims 3 Pets (Sims3.xex, hash DF7B98E763E34184).
// The game's rare screen copies (portraits, thumbnails, loading pictures) pass through a stub that asks the
// helper (SmartReadback.ps1) to switch Xenia's readback on, and waits until it has. Every-frame copies are untouched.
// Without the helper (ALIVE = 0) the stubs do nothing, so Xenia's own settings apply as before.
// Every rare copy is then made twice (TWICE below), helper or not. Xenia's Vulkan renderer (canary_experimental
// cf206a3bd) copies a resolve back to game memory without first waiting for the GPU to finish writing it: in
// VulkanCommandProcessor::IssueCopy the barrier is queued (shared_memory_->Use(kRead)) but not flushed before the copy.
// The copy then races the resolve and can pick up stale 32-byte pieces, which is what spoiled Sims' baked outfits on
// Xenia's fbo render path. The second copy reads memory the first one has finished writing, so it is always whole.
// Neither copy function is ever asked to clear here, so the second copy produces exactly the same picture.
// The file also gets the "Pets look right" patch from make_pets_look_right.js.
'use strict';
const fs = require('fs');
const A = require('./ppcasm');
const img = fs.readFileSync(process.argv[2]); const BASE = 0x88000000;
const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const at = (a) => img.readUInt32BE(a - BASE);

const CAVE = 0x894807A0, CAVE_END = 0x89481000;          // zero-filled tail of .text
const MB = 0x89597760;                                   // mailbox in the zero-filled tail of .data (ends 0x89597800)
const M = { MAGIC: MB + 0x00, ALIVE: MB + 0x04, REQ: MB + 0x08, ACK: MB + 0x0C, TIMEOUTS: MB + 0x10, SITE: MB + 0x14, COUNTS: MB + 0x18 };
const MAGIC = 0x53334350;                                // "S3CP", written by the patch itself
// Spin limit = 0x40000000 loop turns, about 1.3 seconds in Xenia. The helper normally answers within a millisecond or
// two; the old limit (0x02000000, about 60 ms) ran out whenever Windows held the helper back for a moment, and the copy
// was then made with readback off, storing garbage in photos, portraits and Sims' baked outfits. The long wait only
// happens if the helper has stopped, and then once: after a timeout the game stops asking until the helper re-arms.
const TIMEOUT_HI = 0x4000;

// Rare copy call sites (never seen every frame in menus or live mode). Each still calls the function it called before:
// the game's copy function, or for two of them the resolve it wraps (COPY and RESOLVE below).
// Left out on purpose (every frame, checked identical with readback off): 0x8859467C, an indoor scratch-texture pass.
// Also left out: 0x8858B8C0, which redraws water and mirror reflections while the camera moves (checked identical, and it cost up to 2 s of low frame rate on a first zoom out).
const RARE = [0x8842F55C, 0x88442C88, 0x8857B254, 0x8857B39C, 0x8858B64C, 0x886CFD60,
              0x8886BB98, 0x8886D158, 0x8886D674, 0x8897DC94, 0x88E4BBC0, 0x88EA3EF4, 0x89137558];
// What the rare sites call. COPY is the game's copy function: arguments in r3-r10 only, and it never asks for a clear.
// RESOLVE is the graphics library's resolve that COPY wraps; two sites call it directly, with flags 0 (no clear), the
// depth clear value in f1 and two more arguments on the stack at entry SP+92 and SP+100.
// WRAP is a short entry at the end of COPY's code that fills in default arguments (r10 = r5, r5-r9 = 0) and branches to
// COPY; the household picture's own copies go through it (see PIC below).
const COPY = 0x8842E2C0, RESOLVE = 0x8912BC30, WRAP = 0x8842E408;
// "Copy twice" routine, after the "Pets look right" code (0x89480D00-0x89480E00), still in the zero tail of .text.
const TWICE = 0x89480E00, TWICE_END = 0x89480F00;
const TWICE_COPY = TWICE, TWICE_WRAP = TWICE + 12, TWICE_RESOLVE = TWICE + 24;
const twiceFor = (t) => (t === COPY ? TWICE_COPY : t === WRAP ? TWICE_WRAP : TWICE_RESOLVE);
// Household pictures (the family picture kept with a save, and the one made in household creation). The picture
// function (0x88E4AC88) makes one copy through the rare site 0x88E4BBC0 and four more through WRAP: one of its own and
// three in 0x8885EDC0, the step after it, which nothing else calls. Those four were made once, with readback as the last
// rare copy left it, so they were open to the same Xenia race as the outfits: saves stored pictures of blank silhouettes
// with speckled outlines, or with white bands (reproduced: 6 of 11 saves in a row, over two runs). Each fires only
// while a picture is made (once per picture; never in live mode or menus), so they become rare sites too. Space is
// short, so they share one body: each stub counts itself, notes its site number and jumps to it.
const PIC = [0x88E4B714, 0x8885F09C, 0x8885F0BC, 0x8885F294];
const PIC_CODE = 0x89480F00, PIC_END = 0x89481000;       // after the copy-twice routine, still in the zero tail of .text
const words = [[M.MAGIC, MAGIC]];
const sites = [];
const branchTarget = (site) => {
  const w = at(site);
  if ((w >>> 26) !== 18 || (w & 2)) throw new Error('not a relative branch at ' + hex(site));
  let d = w & 0x03FFFFFC; if (d & 0x02000000) d -= 0x04000000;
  return (site + d) >>> 0;
};
const redirect = (site, S) => { const w = at(site); words.push([site, ((w & 0xFC000003) | ((S - site) & 0x03FFFFFC)) >>> 0]); };
function stub(i, site, S) {
  const w = at(site), target = branchTarget(site);
  if (target !== COPY && target !== RESOLVE) throw new Error('site ' + hex(site) + ' calls ' + hex(target) + ', not a copy function');
  const cnt = M.COUNTS + i * 4; if (cnt + 4 > 0x89597800) throw new Error('mailbox full');
  const L = (a) => A.lo(a);
  const code = [];
  const emit = (fn) => { code.push(fn(S + code.length * 4)); };
  const B0 = S;
  emit(() => A.lis(11, A.ha(MB)));
  emit(() => A.lwz(12, L(cnt), 11));        // per-site count (for testing)
  emit(() => A.addi(12, 12, 1));
  emit(() => A.stw(12, L(cnt), 11));
  emit(() => A.lwz(12, L(M.ALIVE), 11));    // is the helper running?
  emit(() => A.cmpwi(0, 12, 0));
  const DONE = B0 + 24 * 4;
  emit((pc) => A.beq(pc, DONE));
  emit(() => A.li(0, i));
  emit(() => A.stw(0, L(M.SITE), 11));
  emit(() => A.lwz(12, L(M.REQ), 11));      // take a ticket
  emit(() => A.addi(12, 12, 1));
  emit(() => A.stw(12, L(M.REQ), 11));
  emit(() => A.lis(0, TIMEOUT_HI));
  emit(() => A.mtctr(0));
  const WAIT = S + code.length * 4;
  emit(() => A.lwz(0, L(M.ACK), 11));       // wait until the helper has switched readback on: ACK >= ticket
  emit(() => A.subf(0, 12, 0));
  emit(() => A.cmpwi(0, 0, 0));
  emit((pc) => A.bge(pc, DONE));
  emit((pc) => A.bdnz(pc, WAIT));
  emit(() => A.lwz(12, L(M.TIMEOUTS), 11)); // no answer: count it and stop waiting from now on
  emit(() => A.addi(12, 12, 1));
  emit(() => A.stw(12, L(M.TIMEOUTS), 11));
  emit(() => A.li(0, 0));
  emit(() => A.stw(0, L(M.ALIVE), 11));
  if (S + code.length * 4 !== DONE) throw new Error('layout ' + hex(S + code.length * 4) + ' vs ' + hex(DONE));
  emit((pc) => A.b(pc, twiceFor(target)));  // make the copy (twice; see TWICE)
  code.forEach((c, k) => words.push([S + 4 * k, c]));
  redirect(site, S);
  sites.push({ i, site: hex(site), target: hex(target), stub: hex(S), counter: hex(cnt), link: w & 1 });
}
RARE.forEach((site, i) => { const S = CAVE + i * 100; if (S + 100 > CAVE_END) throw new Error('cave full'); stub(i, site, S); });
{
  // WRAP must still be the short entry described above.
  const wrapCode = [0x7CAA2B78, 0x39200000, 0x39000000, 0x38E00000, 0x38C00000, 0x38A00000];
  wrapCode.forEach((v, k) => { if (at(WRAP + 4 * k) !== v) throw new Error('unexpected code at ' + hex(WRAP + 4 * k)); });
  if (branchTarget(WRAP + 24) !== COPY || (at(WRAP + 24) & 3) !== 0) throw new Error('WRAP does not end in a branch to COPY');
  for (let a = PIC_CODE; a < PIC_END; a += 4) if (at(a) !== 0) throw new Error('household-picture space not free at ' + hex(a));
  const SHARED = PIC_CODE + PIC.length * 28, L = (a) => A.lo(a);
  PIC.forEach((site, k) => {
    const i = RARE.length + k, S = PIC_CODE + k * 28, cnt = M.COUNTS + i * 4;
    if (cnt + 4 > 0x89597800) throw new Error('mailbox full');
    if (branchTarget(site) !== WRAP || (at(site) & 3) !== 1) throw new Error('site ' + hex(site) + ' is not a bl to WRAP');
    const code = [A.lis(11, A.ha(MB)), A.lwz(12, L(cnt), 11), A.addi(12, 12, 1), A.stw(12, L(cnt), 11),
      A.li(0, i), A.stw(0, L(M.SITE), 11), A.b(S + 24, SHARED)];
    code.forEach((c, j) => words.push([S + 4 * j, c]));
    redirect(site, S);
    sites.push({ i, site: hex(site), target: hex(WRAP), stub: hex(S), counter: hex(cnt), link: 1 });
  });
  // The shared body: the same request and wait as a rare stub, with r11 already pointing at the mailbox.
  const code = [];
  const emit = (fn) => { code.push(fn(SHARED + code.length * 4)); };
  const DONE = SHARED + 18 * 4;
  emit(() => A.lwz(12, L(M.ALIVE), 11));    // is the helper running?
  emit(() => A.cmpwi(0, 12, 0));
  emit((pc) => A.beq(pc, DONE));
  emit(() => A.lwz(12, L(M.REQ), 11));      // take a ticket
  emit(() => A.addi(12, 12, 1));
  emit(() => A.stw(12, L(M.REQ), 11));
  emit(() => A.lis(0, TIMEOUT_HI));
  emit(() => A.mtctr(0));
  const WAIT = SHARED + code.length * 4;
  emit(() => A.lwz(0, L(M.ACK), 11));       // wait until the helper has switched readback on: ACK >= ticket
  emit(() => A.subf(0, 12, 0));
  emit(() => A.cmpwi(0, 0, 0));
  emit((pc) => A.bge(pc, DONE));
  emit((pc) => A.bdnz(pc, WAIT));
  emit(() => A.lwz(12, L(M.TIMEOUTS), 11)); // no answer: count it and stop waiting from now on
  emit(() => A.addi(12, 12, 1));
  emit(() => A.stw(12, L(M.TIMEOUTS), 11));
  emit(() => A.li(0, 0));
  emit(() => A.stw(0, L(M.ALIVE), 11));
  if (SHARED + code.length * 4 !== DONE) throw new Error('shared layout');
  emit((pc) => A.b(pc, TWICE_WRAP));
  if (SHARED + code.length * 4 > PIC_END) throw new Error('household-picture code too long');
  code.forEach((c, j) => words.push([SHARED + 4 * j, c]));
}
// TWICE: entered by a branch from a stub, with the site's return address in LR and the copy's arguments where the
// site put them (r3-r10, f1, stack). Two entries pick the function (r12). In its own stack frame it saves r3-r10, f1,
// LR and the function (64-bit saves at 0x70 and up, clear of the callee's argument home area), copies the two stack
// arguments to the same place above the new frame, and makes the copy. Then it puts everything back, drops the frame
// and branches to the function again, which makes the second copy with the site's own stack and returns to the site.
{
  for (let a = TWICE; a < TWICE_END; a += 4) if (at(a) !== 0) throw new Error('copy-twice space not free at ' + hex(a));
  const FRAME = 0xD0, ARGS = 0x70, LR = 0xB0, F1 = 0xB8, FN = 0xC0, STACK_ARGS = [84, 88, 92, 96, 100, 104];
  const code = [];
  const emit = (fn) => { code.push(fn(TWICE + code.length * 4)); };
  const BODY = TWICE + 32;
  emit(() => A.lis(12, A.ha(COPY)));        // TWICE_COPY
  emit(() => A.addi(12, 12, A.lo(COPY)));
  emit((pc) => A.b(pc, BODY));
  emit(() => A.lis(12, A.ha(WRAP)));        // TWICE_WRAP
  emit(() => A.addi(12, 12, A.lo(WRAP)));
  emit((pc) => A.b(pc, BODY));
  emit(() => A.lis(12, A.ha(RESOLVE)));     // TWICE_RESOLVE
  emit(() => A.addi(12, 12, A.lo(RESOLVE)));
  if (TWICE + code.length * 4 !== BODY || TWICE_WRAP !== TWICE + 12 || TWICE_RESOLVE !== TWICE + 24) throw new Error('copy-twice entry layout');
  emit(() => A.mflr(0));
  emit(() => A.stwu(1, -FRAME, 1));
  emit(() => A.std(0, LR, 1));
  emit(() => A.stw(12, FN, 1));             // kept as a 32-bit word: reloaded with lwz it is zero-extended, like the
  emit(() => A.stfd(1, F1, 1));             // function pointers the game itself calls through CTR
  for (let r = 3; r <= 10; r++) emit(() => A.std(r, ARGS + (r - 3) * 8, 1));
  for (const o of STACK_ARGS) { emit(() => A.lwz(11, FRAME + o, 1)); emit(() => A.stw(11, o, 1)); }
  emit(() => A.lwz(12, FN, 1));
  emit(() => A.mtctr(12));
  emit(() => A.bctrl());                    // first copy (its readback may be incomplete)
  for (let r = 3; r <= 10; r++) emit(() => A.ld(r, ARGS + (r - 3) * 8, 1));
  emit(() => A.lfd(1, F1, 1));
  emit(() => A.lwz(12, FN, 1));
  emit(() => A.mtctr(12));
  emit(() => A.ld(0, LR, 1));
  emit(() => A.mtlr(0));
  emit(() => A.addi(1, 1, FRAME));
  emit(() => A.bctr());                     // second copy, returns to the site
  if (TWICE + code.length * 4 > TWICE_END) throw new Error('copy-twice routine too long');
  code.forEach((c, k) => words.push([TWICE + 4 * k, c]));
}
const head = [
  'title_name = "The Sims™ 3 Pets"',
  'title_id = "45410962" # EA-2402',
  'hash = "DF7B98E763E34184" # Sims3.xex',
  '',
  '[[patch]]',
  '    name = "Smart screen copies"',
  "    desc = \"Lets the mod menu launcher keep Xenia's readback off except while the game makes portraits, thumbnails and Sims' outfits, so the game runs fast without broken pictures. Those copies are made twice, so Xenia's Vulkan renderer always hands the game a whole picture. Without the launcher only the second copy is added.\"",
  '    author = "Atronode"',
  '    is_enabled = true',
].join('\n') + '\n';
const body = words.map(([a, v]) => `    [[patch.be32]]\n        address = ${hex(a)}\n        value = ${hex(v)}\n`).join('');
// The same file carries "Pets look right" (make_pets_look_right.js): Smart screen copies turns memexport readback
// off, and that patch is what keeps pet fur correct without it.
const pets = require('./make_pets_look_right').build(img);
fs.writeFileSync(process.argv[3], head + body + '\n' + pets);
console.log(`${RARE.length} sites + ${PIC.length} household-picture sites, ${words.length} words, stubs ${hex(CAVE)}..${hex(CAVE + RARE.length * 100)}, copy-twice routine at ${hex(TWICE)}, household-picture stubs at ${hex(PIC_CODE)}`);

'use strict';
// Builds the in-memory patch list for the Sims 3 Pets mod menu from the assembly saved out of guest memory.
const fs = require('fs');
const { load, disasm } = require('./clr.js');
const dll = process.argv[2], outFile = process.argv[3];
const m = load(dll), b = m.b;
const patched = Buffer.from(b), touched = new Uint8Array(b.length);
const mIdx = new Map(); m.methods.forEach((x, i) => mIdx.set(x, i));
const mtok = x => 0x06000001 + mIdx.get(x);
const byName = {}; for (const x of m.methods) { const k = m.fullT(x.owner) + '::' + x.name; (byName[k] = byName[k] || []).push(x); }
function M(name, i = 0) { const a = byName[name]; if (!a || !a[i]) throw new Error('no method ' + name); return a[i]; }
const nested = {}; for (let i = 0; i < m.rows[41]; i++) { const q = m.pos[41] + i * m.sz[41]; const n = m.R(q, m.idx(2)), e = m.R(q + m.idx(2), m.idx(2)); (nested[e] = nested[e] || []).push(n); }
const typeRid = new Map(); m.types.forEach((t, i) => { const k = m.fullT(t); if (!typeRid.has(k)) typeRid.set(k, i + 1); });
function ridOf(c) { const r = typeRid.get(c); if (!r) throw new Error('no type ' + c); return r; }
function defOf(c) { for (const r of nested[ridOf(c)] || []) if (m.types[r - 1].name === 'Definition') return m.types[r - 1]; throw new Error('no Definition in ' + c); }
const defMethod = (c, n) => m.methods.find(x => x.owner === defOf(c) && x.name === n && x.rva) || null;
function runOf(c) { const t = m.types[ridOf(c) - 1]; const r = m.methods.find(x => x.owner === t && x.name === 'Run'); if (!r) throw new Error('no Run in ' + c); return r; }
function extendsOf(c) { const q = m.pos[2] + (ridOf(c) - 1) * m.sz[2]; const tdr = Math.max(m.rows[2], m.rows[1], m.rows[27]) >= (1 << 14) ? 4 : 2; return m.R(q + 4 + 2 * m.sw, tdr); }
function body(me) { const o = m.rva(me.rva), h = b[o]; if ((h & 3) === 2) return { o, hdr: 1, size: h >> 2, code: o + 1, tiny: true }; const hs = (b.readUInt16LE(o) >> 12) * 4, size = b.readUInt32LE(o + 4); return { o, hdr: hs, size, code: o + hs, sig: b.readUInt32LE(o + 8), tiny: false }; }
function tokAt(me, il) { const i = body(me), c = b[i.code + il]; return b.readUInt32LE(i.code + il + (c === 0xFE ? 2 : 1)); }
function w(off, bytes) { for (let i = 0; i < bytes.length; i++) { patched[off + i] = bytes[i]; touched[off + i] = 1; } }
const hex = v => v.toString(16);
const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

// Member references by "Owner::name".
const mrefs = {}; for (let i = 1; i <= m.rows[10]; i++) { const k = m.tok(0x0A000000 | i); (mrefs[k] = mrefs[k] || []).push(0x0A000000 | i); }
function MR(k, i = 0) { if (!mrefs[k]) throw new Error('no member ref ' + k); return mrefs[k][i]; }
function F(k) { const f = m.fields.findIndex(x => m.fullT(x.owner) + '::' + x.name === k); if (f < 0) throw new Error('no field ' + k); return 0x04000001 + f; }
const chk = (t, re) => { const n = m.tok(t); if (!re.test(n)) throw new Error('token check failed: ' + n + ' vs ' + re); return t; };
// The one overload of a method whose IL body has the given size.
function sized(name, size) { const a = (byName[name] || []).filter(x => x.rva && body(x).size === size); if (a.length !== 1) throw new Error('overload of ' + name + ' with IL size ' + size + ': ' + a.length); return mtok(a[0]); }

// ---- IL assembler -----------------------------------------------------------
class IL {
  constructor() { this.c = []; this.l = {}; this.f = []; }
  u8(...v) { this.c.push(...v); return this; }
  t(op, tok) { this.c.push(op, ...u32(tok)); return this; }
  ldarg(n) { return n < 4 ? this.u8(2 + n) : this.u8(0x0E, n); }
  ldloc(n) { return n < 4 ? this.u8(6 + n) : this.u8(0x11, n); }
  stloc(n) { return n < 4 ? this.u8(0x0A + n) : this.u8(0x13, n); }
  ldci4(v) { if (v >= -1 && v <= 8) return this.u8(0x16 + v); if (v >= -128 && v <= 127) return this.u8(0x1F, v & 255); return this.u8(0x20, ...u32(v)); }
  ldcr4(f) { const x = Buffer.alloc(4); x.writeFloatLE(f, 0); return this.u8(0x22, ...x); }
  ldnull() { return this.u8(0x14); } dup() { return this.u8(0x25); } pop() { return this.u8(0x26); } ret() { return this.u8(0x2A); } add() { return this.u8(0x58); } nop() { return this.u8(0); }
  ldlen() { return this.u8(0x8E); } convI4() { return this.u8(0x69); } ldelemRef() { return this.u8(0x9A); } stelemRef() { return this.u8(0xA2); }
  call(x) { return this.t(0x28, x); } callvirt(x) { return this.t(0x6F, x); } newobj(x) { return this.t(0x73, x); } castclass(x) { return this.t(0x74, x); } isinst(x) { return this.t(0x75, x); }
  ldfld(x) { return this.t(0x7B, x); } ldflda(x) { return this.t(0x7C, x); } stfld(x) { return this.t(0x7D, x); } ldsfld(x) { return this.t(0x7E, x); } stsfld(x) { return this.t(0x80, x); }
  ldstr(x) { return this.t(0x72, x); } newarr(x) { return this.t(0x8D, x); }
  label(n) { this.l[n] = this.c.length; return this; }
  br_(op, n) { this.c.push(op, 0, 0, 0, 0); this.f.push({ at: this.c.length, n }); return this; }
  br(n) { return this.br_(0x38, n); } brfalse(n) { return this.br_(0x39, n); } brtrue(n) { return this.br_(0x3A, n); } blt(n) { return this.br_(0x3F, n); } beq(n) { return this.br_(0x3B, n); }
  // switch: jump to names[value]; a value past the end falls through. Offsets count from the end of the instruction.
  sw(names) { this.c.push(0x45, ...u32(names.length)); const start = this.c.length; names.forEach(() => this.c.push(0, 0, 0, 0)); const end = this.c.length; names.forEach((n, i) => this.f.push({ at: end, pos: start + i * 4, n })); return this; }
  bytes() { const c = this.c.slice(); for (const x of this.f) { if (this.l[x.n] === undefined) throw new Error('no label ' + x.n); const d = this.l[x.n] - x.at, p = x.pos !== undefined ? x.pos : x.at - 4; u32(d).forEach((v, i) => { c[p + i] = v; }); } return c; }
}

// ---- Spare space ------------------------------------------------------------
const delta = (() => { const me = M('Sims3.Gameplay.Core.Commands::OnPxUtil'); return me.rva - m.rva(me.rva); })();
// Keyboard-console commands (the Xbox has no console). The second row, added 2026-11-21, are not referenced anywhere in
// the game's code at all.
const caveSources = ['OnPxUtil', 'OnCountObjects', 'OnHauntingCheat', 'OnFindSimWithOutfit', 'OnRefreshSimThumbnails', 'OnEnsureWorldPopulation',
  'OnSpawn', 'OnOnlineFunc', 'OnRefreshLotThumbnails', 'OnCleanHouseholds', 'OnRefreshHouseholdThumbnails', 'OnExterminate', 'OnSpawnObjects', 'OnStressReset', 'OnTmp'].map(n => M('Sims3.Gameplay.Core.Commands::' + n));
const cave = caveSources.map(x => { const i = body(x); return { off: i.o, size: i.hdr + i.size }; });
let caveUsed = 0; const caveFill = cave.map(() => 0);
// Best fit: each allocation goes into the spare area that it fills most tightly, which keeps the big areas for big bodies.
function caveAlloc(n, align) { let best = -1, bestAt = 0, bestLeft = Infinity; for (let k = 0; k < cave.length; k++) { const c = cave[k]; const a = (c.off + caveFill[k] + align - 1) & ~(align - 1); const left = c.off + c.size - (a + n); if (left >= 0 && left < bestLeft) { best = k; bestAt = a; bestLeft = left; } } if (best < 0) throw new Error('code cave exhausted'); caveFill[best] = bestAt + n - cave[best].off; caveUsed += n; return bestAt; }
function emit(il, opts = {}) {
  const code = il.bytes();
  if (!opts.locals && code.length < 64 && (opts.maxstack || 0) <= 8) { const off = caveAlloc(1 + code.length, 1); w(off, [(code.length << 2) | 2, ...code]); return off + delta; }
  const off = caveAlloc(12 + code.length, 4);
  const h = Buffer.alloc(12); h.writeUInt16LE(0x3013, 0); h.writeUInt16LE(opts.maxstack || 8, 2); h.writeUInt32LE(code.length, 4); h.writeUInt32LE(opts.locals || 0, 8);
  w(off, h); w(off + 12, code); return off + delta;
}
function setRva(me, rva) { w(m.pos[6] + mIdx.get(me) * m.sz[6], u32(rva)); }

// Text pool: long help strings that only the keyboard-console command list registers.
const usBase = m.S['#US'].off;
function usEntry(off) { let p = usBase + off, l = b[p], h = 1; if ((l & 0xC0) === 0x80) { l = ((l & 0x3F) << 8) + b[p + 1]; h = 2; } else if ((l & 0xC0) === 0xC0) { l = ((l & 0x1F) * 0x1000000) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; h = 4; } return { h, l }; }
const useCount = new Map();
for (const me of m.methods) { if (!me.rva) continue; const i = body(me); for (let k = 0; k + 5 <= i.size; k++) if (b[i.code + k] === 0x72 && b[i.code + k + 4] === 0x70) { const off = b.readUInt32LE(i.code + k + 1) & 0xFFFFFF; useCount.set(off, (useCount.get(off) || 0) + 1); } }
const reg = body(M('Sims3.Gameplay.Core.Commands::RegisterWorldCommands')); const regions = [];
for (let k = 0; k + 5 <= reg.size; k++) if (b[reg.code + k] === 0x72 && b[reg.code + k + 4] === 0x70) { const off = b.readUInt32LE(reg.code + k + 1) & 0xFFFFFF; const e = usEntry(off); if (e.l >= 8 && useCount.get(off) === 1) regions.push({ off, total: e.h + e.l }); }
// Also the literals that only the console commands used as code space (above) refer to: those bodies are overwritten.
{ const fromCaves = new Map(); for (const me of caveSources) { const i = body(me); for (let k = 0; k + 5 <= i.size; k++) if (b[i.code + k] === 0x72 && b[i.code + k + 4] === 0x70) { const off = b.readUInt32LE(i.code + k + 1) & 0xFFFFFF; fromCaves.set(off, (fromCaves.get(off) || 0) + 1); } }
  for (const [off, n] of fromCaves) { const e = usEntry(off); if (useCount.get(off) === n && e.l >= 8 && !regions.some(r => r.off === off)) regions.push({ off, total: e.h + e.l }); } }
regions.sort((x, y) => y.total - x.total);
let ri = 0, rp = 0; const strCache = new Map();
// Text the game already has (outside the pool) is used as it is, so it costs no pool space.
const usExisting = new Map();
{ const end = m.S['#US'].sz; let p = 1; while (p < end) { const e = usEntry(p); if (e.l === 0) { p++; continue; } if ((e.l & 1) === 1) { const s = b.toString('utf16le', usBase + p + e.h, usBase + p + e.h + e.l - 1); if (!usExisting.has(s)) usExisting.set(s, p); } p += e.h + e.l; } }
const reusedText = new Set();
function S(text) {
  if (strCache.has(text)) return strCache.get(text);
  const have = usExisting.get(text);
  if (have !== undefined && !regions.some(r => have >= r.off && have < r.off + r.total)) { reusedText.add(have); const tok = 0x70000000 | have; strCache.set(text, tok); return tok; }
  const data = Buffer.from(text, 'utf16le'), blen = data.length + 1, hdr = blen < 0x80 ? [blen] : [0x80 | (blen >> 8), blen & 255], need = hdr.length + blen;
  while (ri < regions.length && rp + need > regions[ri].total) { ri++; rp = 0; }
  if (ri >= regions.length) throw new Error('string pool exhausted');
  const at = regions[ri].off + rp; w(usBase + at, [...hdr, ...data, 0]); rp += need;
  const tok = 0x70000000 | at; strCache.set(text, tok); return tok;
}
function renameLiteral(oldText, newText) {
  const enc = Buffer.from(oldText, 'utf16le'); let found = 0;
  for (const off of useCount.keys()) { const e = usEntry(off); if (e.l - 1 === enc.length && b.compare(enc, 0, enc.length, usBase + off + e.h, usBase + off + e.h + enc.length) === 0) { found++; if (reusedText.has(off)) throw new Error('renaming text that a new entry reuses: ' + oldText); const data = Buffer.from(newText, 'utf16le'), blen = data.length + 1; if (blen + (blen < 0x80 ? 1 : 2) > e.h + e.l) throw new Error('too long: ' + newText); const hdr = blen < 0x80 ? [blen] : [0x80 | (blen >> 8), blen & 255]; w(usBase + off, [...hdr, ...data, 0]); } }
  if (!found) throw new Error('literal not found: ' + oldText);
}

// ---- Tokens ------------------------------------------------------------------
const P = n => M(n);
const pause = P('DEBUG_Pause::Run'), other = P('DEBUG_PauseOther::Run'), every = P('DEBUG_PauseEveryone::Run'), guest = P('GuestLeftAlone::AddInteractionToTeleportOutside'), proxy = P('ProxyDefinition::AddInteractions'), fire = P('AddFire::Run');
const T = {
  getActor: tokAt(pause, 0x01), Sim: tokAt(pause, 0x06), getTarget: tokAt(other, 0x01), getQueue: tokAt(other, 0x0d),
  prioCtor: tokAt(every, 0x1d), createInstance: tokAt(every, 0x24), addNext: tokAt(every, 0x29), allSims: tokAt(every, 0x00),
  tp: tokAt(guest, 0xa1), terrain: tokAt(guest, 0xa6), TeleportMeHere: tokAt(guest, 0xc3), dest: tokAt(P('TeleportMeHere::SetDestination'), 0x0d),
  pos: mtok(P('Sims3.Gameplay.Abstracts.GameObject::get_Position')), fwd: tokAt(P('Sims3.Gameplay.WonderPowers.WonderPowerActivation::RouteToSafeArea'), 0x2c),
  v3add: MR('Sims3.SimIFace.Vector3::op_Addition'), hit: tokAt(fire, 0x01), hitPoint: tokAt(fire, 0x06),
  household: mtok(P('Sims3.Gameplay.Actors.Sim::get_Household')), activeHh: mtok(P('Sims3.Gameplay.CAS.Household::get_ActiveHousehold')), hhSims: mtok(P('Sims3.Gameplay.CAS.Household::get_Sims')),
  funds: mtok(P('Sims3.Gameplay.CAS.Household::get_FamilyFunds')), setFunds: mtok(P('Sims3.Gameplay.CAS.Household::set_FamilyFunds')), addSim: mtok(P('Sims3.Gameplay.CAS.Household::AddSim')),
  force: mtok(P('Sims3.Gameplay.Core.PlumbBob::ForceSelectActor')), lotHh: mtok(P('Sims3.Gameplay.Core.Lot::get_Household')), Lot: tokAt(P('Sims3.Gameplay.Core.AddToHousehold::Run'), 0x12),
  listSimItem: 0x0A000053, listSimCount: 0x0A000054, listTupleItem: 0x0A000660, listTupleCount: 0x0A0004D5, listTupleAdd: 0x0A000129,
  newarrStr: tokAt(P('Sims3.Gameplay.Interactions.NewInteractionDefinition::GetPath'), 1),
  tupleDef: tokAt(proxy, 0x73), tupleTarget: tokAt(proxy, 0x79), prepCtor: tokAt(proxy, 0x95),
  activeActor: mtok(P('Sims3.Gameplay.Actors.Sim::get_ActiveActor')), allCheat: mtok(P('Sims3.Gameplay.Abstracts.GameObject::GetAllCheatInteractionsForActor')), allDebug: mtok(P('Sims3.Gameplay.Abstracts.GameObject::GetAllDebugInteractionsForActor')),
  ticksGet: mtok(P('Sims3.Gameplay.Utilities.SimClock::get_TicksAdvanced')), ticksSet: mtok(P('Sims3.Gameplay.Utilities.SimClock::set_TicksAdvanced')), toTicks: tokAt(P('Sims3.Gameplay.Utilities.SimClock::AddOneHour'), 0x0b), hoursUntil: mtok(M('Sims3.Gameplay.Utilities.SimClock::HoursUntil', 0)),
  freeze: tokAt(P('FreezeTimeOfDay::Run'), 0x00),
  aging: mtok(P('Sims3.Gameplay.ActorSystems.AgingManager::get_Singleton')), ageUp: mtok(P('Sims3.Gameplay.ActorSystems.AgingManager::DEBUG_PushAgeUp')), desc: mtok(P('Sims3.Gameplay.Actors.Sim::get_SimDescription')),
  traits: tokAt(P('Sims3.Gameplay.WonderPowers.WonderPower::GetCost'), 0x3f), randomTrait: mtok(P('Sims3.Gameplay.ActorSystems.TraitManager::AddRandomTrait')),
  ltw: mtok(P('Sims3.Gameplay.CAS.SimDescription::set_HasCompletedLifetimeWish')), lthGet: mtok(P('Sims3.Gameplay.CAS.SimDescription::get_LifetimeHappiness')), lthSet: mtok(P('Sims3.Gameplay.CAS.SimDescription::set_LifetimeHappiness')),
  motives: tokAt(P('FixMood::Run'), 0x0d), maxAll: tokAt(P('FixMood::Run'), 0x12),
  repair: mtok(P('Sims3.Gameplay.Core.Lot::RepairAllObjects')),
};
const LOCALS = { RRRI: 0x11000137, RRIR: 0x11000230 };

// Wheel-entry registrations in the developer lists.
const listMethods = { obj: 'Sims3.Gameplay.Abstracts.GameObject::AddDebugInteractions', sim: 'Sims3.Gameplay.Actors.Sim::AddDebugInteractions', ter: 'Sims3.Gameplay.Core.Terrain::AddDebugInteractions', lot: 'Sims3.Gameplay.Core.Lot::AddDebugInteractions', mail: 'Sims3.Gameplay.Core.Mailbox::AddDebugInteractions' };
const singleton = {}, entries = []; let addDef = 0;
for (const k of Object.keys(listMethods)) { const i = body(M(listMethods[k])); for (let o = 0; o + 11 <= i.size; o++) { if (b[i.code + o] === 3 && b[i.code + o + 1] === 0x7E && b[i.code + o + 5] === 4 && b[i.code + o + 6] === 0x6F) { const f = b.readUInt32LE(i.code + o + 2); const cls = m.tok(f).replace(/::Singleton$/, ''); singleton[cls] = f; entries.push({ off: i.code + o, cls }); addDef = b.readUInt32LE(i.code + o + 7); o += 10; } } }
const NS_CORE = 'Sims3.Gameplay.Core.';

// ---- Wheel helpers ---------------------------------------------------------
const trueRva = emit(new IL().ldci4(1).ret());
const emptyPathRva = P('Sims3.Gameplay.Interactions.NewInteractionDefinition::GetPath').rva;
const pathBodies = new Map();
function pathRva(list) { if (!list.length) return emptyPathRva; const k = list.join('\u0001'); if (pathBodies.has(k)) return pathBodies.get(k); const il = new IL().ldci4(list.length).newarr(T.newarrStr); list.forEach((s, i) => il.dup().ldci4(i).ldstr(S(s)).stelemRef()); il.ret(); const r = emit(il, { maxstack: 4 }); pathBodies.set(k, r); return r; }
const reused = new Set();
function slot(cls, o) {
  if (o.name !== undefined) { const me = defMethod(cls, 'GetInteractionName'); if (!me) throw new Error('no name method: ' + cls); setRva(me, emit(new IL().ldstr(S(o.name)).ret())); }
  if (o.path !== undefined) { const me = defMethod(cls, 'GetPath'); if (!me) throw new Error('no GetPath override: ' + cls); setRva(me, pathRva(o.path)); }
  if (o.test === true) { const me = defMethod(cls, 'Test'); if (!me) throw new Error('no Test: ' + cls); setRva(me, trueRva); }
  if (o.cloneTest) { setRva(defMethod(cls, 'Test'), defMethod(o.cloneTest, 'Test').rva); }
  if (o.clone) { const src = runOf(o.clone); for (const l of disasm(m, src)) if (l.includes(' ' + o.clone + '::') || /\bDefinition::/.test(l)) throw new Error('clone uses own class: ' + o.clone + ' ' + l); if (extendsOf(o.clone) !== extendsOf(cls)) console.log('note: different base classes', cls, o.clone); setRva(runOf(cls), src.rva); reused.add(cls); }
  if (o.run) { setRva(runOf(cls), emit(o.run(new IL()), { locals: o.locals || 0, maxstack: o.maxstack || 10 })); reused.add(cls); }
  return singleton[cls] || F(cls + '::Singleton');
}
const target = il => il.ldarg(0).call(T.getTarget).castclass(T.Sim);
const actor = il => il.ldarg(0).call(T.getActor).castclass(T.Sim);
const hitPoint = il => il.ldarg(0).ldflda(T.hit).ldfld(T.hitPoint);
const inFront = who => il => { who(il).callvirt(T.pos); who(il).callvirt(T.fwd); return il.call(T.v3add); };
function warp(il, who, where) { who(il).callvirt(T.getQueue).ldsfld(T.tp).call(T.terrain); who(il).ldci4(10).newobj(T.prioCtor).ldci4(0).ldci4(1).callvirt(T.createInstance).isinst(T.TeleportMeHere).dup(); where(il); il.stfld(T.dest).callvirt(T.addNext).pop(); return il; }
const done = il => il.ldci4(1).ret();

// ---- Sim wheel ----------------------------------------------------------------
const sim = [];
sim.push(slot('DEBUG_ShowCASParts', { name: 'Warp To Me', path: [], run: il => done(warp(il, target, inFront(actor))) }));
sim.push(slot('DEBUG_ShowFacialBlends', { name: 'Warp Me To Them', path: [], run: il => done(warp(il, actor, inFront(target))) }));
sim.push(slot('DEBUG_ShowAgingStatus', { name: 'Play As This Sim', path: [], run: il => { target(il).call(T.force).pop(); return done(il); } }));
sim.push(slot('DEBUG_QueueAgeAssetBuild', { name: 'Add To My Household', path: [], test: true, run: il => { actor(il).callvirt(T.household); target(il).callvirt(T.addSim); return done(il); } }));
sim.push(slot('DEBUG_EditSimInCAS', { path: [] }));
// RELSTART: Relationships... with a Sim picker. The game's own Set Relationship only links the clicked Sim with the Sim you
// control. This reuses the TownieMaker's "Make Service NPC" (a developer object players never see): its Definition has one
// entry per relationship type and opens the pie menu's Sim picker, so any number of Sims from the whole town can be given
// that relationship with the clicked Sim. Each entry's MenuText is the game's own name for the type, text the game already
// has; its folder comes from the type's number (Relationship.GetLtrEnumValue). The three family entries are not
// relationship types (number 0) and set the family tree instead; the two Sims also get a relationship, so the relative
// shows in the relationships panel.
const REL_TYPES = [['Stranger', 'S'], ['Acquaintance', 'F'], ['Distant Friend', 'F'], ['Friend', 'F'], ['Good Friend', 'F'], ['Best Friend', 'F'], ['Best Friends Forever', 'F'], ['Old Friend', 'F'],
  ['Disliked', 'X'], ['Enemy', 'X'], ['Old Enemies', 'X'], ['Romantic Interest', 'R'], ['Partner', 'R'], ['Fiancee', 'R'], ['Spouse', 'R'], ['Ex', 'R'], ['Ex Spouse', 'R'],
  ['Parents', 'A'], ['Children', 'A'], ['Siblings', 'A']];
const REL_FOLDERS = { S: null, F: 'Friendship...', X: 'Rivalry...', R: 'Romance...', A: 'Family...' };
const REL = (() => {
  const msn = 'MakeServiceNPC', relRun = P('DEBUG_SetRelationship::Run'), casLtr = P('Sims3.Gameplay.CAS.CASLogic::LTRForceChangeState');
  const addI = defMethod(msn, 'AddInteractions'), pick = defMethod(msn, 'PopulatePieMenuPicker'), initM = P(msn + '::Init');
  const owner = defOf(msn), ctor2 = m.methods.find(x => x.owner === owner && x.name === '.ctor' && x.rva && body(x).size === 21);
  if (!ctor2) throw new Error('no 2-argument Definition constructor in ' + msn);
  // The game's name -> type number table, read from GetLtrEnumValue itself (names to dictionary slots, then a switch).
  const ltrM = P('Sims3.Gameplay.Socializing.Relationship::GetLtrEnumValue'), lb = body(ltrM), slots = new Map(), num = new Map();
  const ldcValue = (at) => { const op = b[at]; return op >= 0x16 && op <= 0x1E ? op - 0x16 : op === 0x1F ? b[at + 1] : -1; };
  for (let k = 0; k + 6 < lb.size; k++) if (b[lb.code + k] === 0x72 && b[lb.code + k + 4] === 0x70) { const v = ldcValue(lb.code + k + 5); if (v >= 0) slots.set(m.tok(b.readUInt32LE(lb.code + k + 1)).replace(/^"|"$/g, ''), v); }
  for (let k = 0; k < lb.size; k++) if (b[lb.code + k] === 0x45) { const n = b.readUInt32LE(lb.code + k + 1), end = k + 5 + n * 4; if (n !== slots.size) continue;
    for (const [s, i] of slots) num.set(s, ldcValue(lb.code + end + b.readInt32LE(lb.code + k + 5 + i * 4))); break; }
  if (!num.size) throw new Error('GetLtrEnumValue layout');
  const folderOf = [];
  for (const [name, f] of REL_TYPES) { const v = num.has(name) ? num.get(name) : 0; if (f === 'A' ? v !== 0 : v <= 0) throw new Error('relationship type number for ' + name + ': ' + v); if (folderOf[v] !== undefined && folderOf[v] !== f) throw new Error('two folders for type ' + v); folderOf[v] = f; }
  for (let v = 0; v < folderOf.length; v++) if (folderOf[v] === undefined) folderOf[v] = 'S';
  return {
    msn, addI, pick, pathM: defMethod(msn, 'GetPath'), testM: defMethod(msn, 'Test'), initM, runM: runOf(msn), folderOf, spouse: num.get('Spouse'), exSpouse: num.get('Ex Spouse'),
    menuText: chk(tokAt(defMethod(msn, 'GetInteractionName'), 0x01), /MenuText$/), defType: chk(tokAt(initM, 0x1a), /Definition$/), baseInit: chk(tokAt(initM, 0x02), /InteractionInstance::Init$/),
    defCtor: mtok(ctor2), tupleCtor: chk(tokAt(addI, 0x60), /InteractionTuningObjectTuple::\.ctor/),
    pickSims: chk(tokAt(pick, 0x20), /PopulateSimPicker/), parTarget: chk(tokAt(pick, 0x05), /InteractionInstanceParameters::get_Target/), listSimOf: tokAt(pick, 0x14),
    getDef: chk(tokAt(relRun, 0x19), /get_InteractionDefinition/), getRel: chk(tokAt(relRun, 0x31), /GetRelationship/), ltr: chk(tokAt(relRun, 0x3e), /GetLtrEnumValue/), force: chk(tokAt(relRun, 0x43), /ForceChangeState/),
    sel: mtok(P('Sims3.Gameplay.Interactions.InteractionInstance::get_SelectedObjects')), isPet: mtok(P('Sims3.Gameplay.CAS.SimDescription::get_IsPet')),
    gen: mtok(P('Sims3.Gameplay.Actors.Sim::get_Genealogy')), marry: mtok(P('Sims3.Gameplay.Socializing.Genealogy::Marry')), divorce: mtok(P('Sims3.Gameplay.Socializing.Genealogy::Divorce')),
    spouseOf: mtok(P('Sims3.Gameplay.Socializing.Genealogy::get_Spouse')), addChild: mtok(P('Sims3.Gameplay.Socializing.Genealogy::AddChild')), addSib: mtok(P('Sims3.Gameplay.Socializing.Genealogy::AddSibling')),
    streq: chk(0x0A00011E, /String::op_Equality$/), canRomance: mtok(P('Sims3.Gameplay.CAS.SimDescription::CanHaveRomanceWith')),
    relCur: mtok(P('Sims3.Gameplay.Socializing.Relationship::get_CurrentLTR')), ex: num.get('Ex'), partner: num.get('Partner'), fiancee: num.get('Fiancee'),
    relsOf: sized('Sims3.Gameplay.Socializing.Relationship::GetRelationships', 59), otherOf: sized('Sims3.Gameplay.Socializing.Relationship::GetOtherSimDescription', 23),
    ltrData: chk(tokAt(casLtr, 0x2d), /LTRDatabase::Get$/), setsPartner: chk(tokAt(casLtr, 0x34), /LTRData::get_SetsPartner$/),
    simRemove: chk(0x0A000157, /::Remove$/), simRemoveAt: chk(0x0A000258, /::RemoveAt$/), objCount: chk(0x0A0000B2, /::get_Count$/), objItem: chk(0x0A0000B3, /::get_Item$/),
  };
})();
const LOCALS2 = { RRII: 0x11000233, R5I3R: 0x11001284, R7IRI: 0x11000DFE };
{ const R = REL;
  // One menu entry per relationship type (romance and family only when the clicked Sim is not a pet).
  const add = new IL(); const entry = ([n]) => add.ldarg(4).ldnull().ldstr(S(n)).newobj(R.defCtor).ldarg(3).newobj(R.tupleCtor).callvirt(T.listTupleAdd);
  REL_TYPES.filter(([, f]) => f !== 'R' && f !== 'A').forEach(entry);
  add.ldarg(3).isinst(T.Sim).dup().brfalse('np').callvirt(T.desc).callvirt(R.isPet).brtrue('end');
  REL_TYPES.filter(([, f]) => f === 'R' || f === 'A').forEach(entry);
  add.br('end').label('np').pop().label('end').ret();
  setRva(R.addI, emit(add, { maxstack: 6 }));
  // Folder from the type number (the entry's name is its MenuText, which the game's own GetInteractionName returns).
  const path = new IL(); const arr = (il, parts) => { il.ldci4(parts.length).newarr(T.newarrStr); parts.forEach((s, i) => il.dup().ldci4(i).ldstr(S(s)).stelemRef()); return il.ret(); };
  path.ldarg(0).ldfld(R.menuText).call(R.ltr).sw(R.folderOf.map(f => 'p' + f)); arr(path, ['Relationships...']);
  for (const [f, folder] of Object.entries(REL_FOLDERS)) { path.label('p' + f); arr(path, folder ? ['Relationships...', folder] : ['Relationships...']); }
  setRva(R.pathM, emit(path, { maxstack: 6 }));
  setRva(R.testM, trueRva);
  // The picker: every Sim in town but the clicked one, any number of them; no pets for romance and family.
  const pk = new IL();
  pk.ldarg(4).ldci4(-1).u8(0x54);                                                     // stind.i4: NumSelectableRows = -1
  pk.call(T.allSims).newobj(R.listSimOf).stloc(0);
  pk.ldloc(0).ldarg(1).call(R.parTarget).isinst(T.Sim).callvirt(R.simRemove).pop();
  pk.ldarg(0).ldfld(R.menuText).call(R.ltr).sw(R.folderOf.map(f => (f === 'R' || f === 'A') ? 'flt' : 'show')).br('show');
  pk.label('flt').ldloc(0).callvirt(T.listSimCount).ldci4(1).u8(0x59).stloc(2).br('fc');   // sub
  pk.label('fl').ldloc(0).ldloc(2).callvirt(T.listSimItem).callvirt(T.desc).callvirt(R.isPet).brfalse('fn').ldloc(0).ldloc(2).callvirt(R.simRemoveAt);
  pk.label('fn').ldloc(2).ldci4(1).u8(0x59).stloc(2).label('fc').ldloc(2).ldci4(0).br_(0x3C, 'fl');   // bge
  pk.label('show').ldarg(0).ldarg(1).ldarg(2).ldarg(3).ldloc(0).ldci4(1).call(R.pickSims).ret();
  setRva(R.pick, emit(pk, { locals: LOCALS2.RRII, maxstack: 8 }));
  // The interaction itself: no TownieMaker needed; apply the chosen type to every picked Sim.
  setRva(R.initM, emit(new IL().ldarg(0).ldarg(1).call(R.baseInit).ret()));
  const run = new IL();
  run.ldarg(0).call(T.getTarget).castclass(T.Sim).stloc(0);
  run.ldarg(0).call(R.getDef).castclass(R.defType).ldfld(R.menuText).stloc(1);
  run.ldarg(0).call(R.sel).stloc(3).ldloc(3).brfalse('done').ldci4(0).stloc(7).br('c');
  run.label('l').ldloc(3).ldloc(7).callvirt(R.objItem).isinst(T.Sim).stloc(4).ldloc(4).brfalse('n').ldloc(4).ldloc(0).beq('n');
  // Romance entries only for pairs the game itself allows romance between (SimDescription.CanHaveRomanceWith): never a
  // child or younger, teens only with teens, the same species, and no blood or step relatives.
  run.ldloc(1).call(R.ltr).sw(R.folderOf.map(f => f === 'R' ? 'rom' : 'ok')).br('ok');
  run.label('rom').ldloc(0).callvirt(T.desc).ldloc(4).callvirt(T.desc).callvirt(R.canRomance).brfalse('n');
  // The relationship is made first for every picked Sim, family entries included: a family-tree link alone does not put
  // the new relative in the relationships panel.
  run.label('ok').ldloc(0).callvirt(T.desc).ldloc(4).callvirt(T.desc).ldci4(1).callvirt(R.getRel).stloc(5);
  run.ldloc(1).call(R.ltr).brfalse('fam').ldloc(5).brfalse('n');
  // A new partner (a type that sets partners: Partner, Fiancee, Spouse): every other Partner, Fiancee or Spouse either Sim
  // has becomes an Ex (Ex Spouse for a spouse), and any other marriage in the family tree ends. Every relationship is
  // checked (Relationship.GetRelationships), because SimDescription.Partner is not always set: a household made married
  // in Create a Sim can have a Spouse with no partner. The game's own state change ends a partnership it knows of
  // (LongTermRelationship.ChangeState) and sets the new partners.
  // Locals (0x11000dfe): 0 clicked Sim, 1 type name, 3 picked list, 4 picked Sim, 5 relationship, 6 other relationship,
  // 7 index, 8 relationship list, 9 its index.
  if (R.fiancee !== R.partner + 1 || R.spouse !== R.partner + 2) throw new Error('partner types not consecutive');
  const exOld = (x, y, p) => {
    run.ldloc(x).callvirt(T.desc).call(R.relsOf).stloc(8).ldci4(0).stloc(9).br(p + 'c');
    run.label(p + 'l').ldloc(8).ldloc(9).ldelemRef().stloc(6).ldloc(6).callvirt(R.relCur).ldci4(R.partner).u8(0x59).ldci4(3).br_(0x44, p + 'h').br(p + 'n');   // sub; blt.un: Partner, Fiancee or Spouse
    run.label(p + 'h').ldloc(6).ldloc(x).callvirt(T.desc).callvirt(R.otherOf).ldloc(y).callvirt(T.desc).beq(p + 'n');
    run.ldloc(6).ldloc(6).callvirt(R.relCur).ldci4(R.spouse).beq(p + 's').ldci4(R.ex).br(p + 'f').label(p + 's').ldci4(R.exSpouse).label(p + 'f').callvirt(R.force);
    run.label(p + 'n').ldloc(9).ldci4(1).add().stloc(9).label(p + 'c').ldloc(9).ldloc(8).ldlen().convI4().blt(p + 'l');
    run.ldloc(x).callvirt(R.gen).callvirt(R.spouseOf).dup().brfalse(p + 'd0').ldloc(y).callvirt(R.gen).beq(p + 'd1').ldloc(x).callvirt(R.gen).dup().callvirt(R.divorce).br(p + 'd1');
    run.label(p + 'd0').pop().label(p + 'd1');
  };
  run.ldloc(1).call(R.ltr).call(R.ltrData).callvirt(R.setsPartner).brfalse('np');
  exOld(0, 4, 'xa'); exOld(4, 0, 'xb');
  run.label('np').ldloc(5).ldloc(1).call(R.ltr).callvirt(R.force);
  // Spouse: once the game has accepted it, the two are also married in the family tree.
  run.ldloc(1).call(R.ltr).ldci4(R.spouse).br_(0x40, 'ns').ldloc(5).callvirt(R.relCur).ldci4(R.spouse).br_(0x40, 'n');   // bne.un
  run.ldloc(0).callvirt(R.gen).ldloc(4).callvirt(R.gen).callvirt(R.marry).br('n');
  // Ex Spouse: divorced in the family tree if they were married to each other. (Genealogy.Divorce takes the other Sim's
  // record, which it does not use.)
  run.label('ns').ldloc(1).call(R.ltr).ldci4(R.exSpouse).br_(0x40, 'n');
  run.ldloc(0).callvirt(R.gen).callvirt(R.spouseOf).ldloc(4).callvirt(R.gen).br_(0x40, 'n').ldloc(0).callvirt(R.gen).ldloc(4).callvirt(R.gen).callvirt(R.divorce).br('n');
  run.label('fam').ldloc(1).ldstr(S('Parents')).call(R.streq).brfalse('nf1').ldloc(4).callvirt(R.gen).ldloc(0).callvirt(R.gen).callvirt(R.addChild).br('n');
  run.label('nf1').ldloc(1).ldstr(S('Children')).call(R.streq).brfalse('nf2').ldloc(0).callvirt(R.gen).ldloc(4).callvirt(R.gen).callvirt(R.addChild).br('n');
  run.label('nf2').ldloc(0).callvirt(R.gen).ldloc(4).callvirt(R.gen).callvirt(R.addSib);
  run.label('n').ldloc(7).ldci4(1).add().stloc(7).label('c').ldloc(7).ldloc(3).callvirt(R.objCount).blt('l');
  run.label('done'); done(run);
  setRva(R.runM, emit(run, { locals: LOCALS2.R7IRI, maxstack: 8 }));
  reused.add(R.msn);
  sim.push(F(R.msn + '::Singleton')); }
// RELEND
sim.push(slot('Sims3.Gameplay.Skills.DEBUG_AddSkillToSim', {}));
sim.push(slot('DEBUG_SetMotives', {}));
sim.push(slot('FixMood', { path: ['Needs...'] }));
sim.push(slot('DEBUG_TankMood', { path: ['Needs...'] }));
sim.push(slot('DEBUGMakeFat', { name: 'Max Household Needs', path: ['Needs...'], run: il => { il.ldarg(0).call(T.getActor).castclass(T.Sim).callvirt(T.household).callvirt(T.hhSims).stloc(1).ldci4(0).stloc(2).br('c').label('l'); il.ldloc(1).ldloc(2).callvirt(T.listSimItem).callvirt(T.motives).callvirt(T.maxAll); il.ldloc(2).ldci4(1).add().stloc(2).label('c').ldloc(2).ldloc(1).callvirt(T.listSimCount).blt('l'); return done(il); }, locals: LOCALS.RRIR }));
sim.push(slot('DEBUG_ShowAgeTransitionNotification', { name: 'Age Up', path: ['Age...'], test: true, run: il => { il.call(T.aging); target(il).callvirt(T.ageUp); return done(il); } }));
// ADSTART: one stage younger, using the game's own age-reversal interaction.
const adExec = P('Sims3.Gameplay.ActorSystems.AgeDown::Execute'), adRun = P('Sims3.Gameplay.ActorSystems.AgeDown::Run'), startTask = M('Sims3.Gameplay.ActorSystems.AgingState::StartSimBuilderTask', 1);
const AD = { preg: chk(tokAt(adExec, 0x08), /get_IsPregnant/), single: chk(tokAt(adExec, 0x1c), /AgeDown::Singleton/), type: chk(tokAt(adExec, 0x2b), /AgeDown$/), newAge: chk(tokAt(adExec, 0x40), /NewAge/), add: chk(tokAt(adExec, 0x53), /InteractionQueue::Add/), changed: chk(tokAt(adExec, 0x5a), /ObjectStateChanged/),
  state: chk(tokAt(adRun, 0x39), /::AgingState$/), task: chk(tokAt(startTask, 0x01), /AgingState::SimBuilderTask$/), ctor: chk(tokAt(startTask, 0x0b), /SimBuilderTask::\.ctor/), addObj: chk(tokAt(startTask, 0x1b), /Simulator::AddObject/),
  abort: mtok(P('Sims3.Gameplay.ActorSystems.AgingState::AbortSimBuilderTask')), age: mtok(P('Sims3.Gameplay.CAS.SimDescription::get_Age')), isPet: mtok(P('Sims3.Gameplay.CAS.SimDescription::get_IsPet')) };
sim.push(slot('DEBUG_LosePosture', { name: 'Age Down', path: ['Age...'], test: true, locals: LOCALS.RRRI, maxstack: 10, run: il => {
  target(il).stloc(0).ldloc(0).callvirt(T.desc).stloc(1);
  il.ldloc(1).callvirt(AD.preg).brtrue('done');
  il.ldloc(1).callvirt(AD.age).stloc(3).ldloc(1).callvirt(AD.isPet).brtrue('pet');
  il.ldloc(3).ldci4(1).u8(0x63).stloc(3).br('check');
  il.label('pet').ldloc(3).ldci4(64).br_(0x40, 'p2').ldci4(32).stloc(3).br('check');
  il.label('p2').ldloc(3).ldci4(32).br_(0x40, 'p3').ldci4(4).stloc(3).br('check');
  il.label('p3').ldci4(0).stloc(3);
  il.label('check').ldloc(3).ldci4(2).blt('done');
  il.ldloc(1).ldfld(AD.state).callvirt(AD.abort);
  il.ldloc(1).ldfld(AD.state).ldloc(1).ldfld(AD.state).ldloc(3).newobj(AD.ctor).stfld(AD.task);
  il.ldloc(1).ldfld(AD.state).ldfld(AD.task).call(AD.addObj).pop();
  il.ldsfld(AD.single).ldloc(0).ldloc(0).ldci4(9).newobj(T.prioCtor).ldci4(0).ldci4(0).callvirt(T.createInstance).isinst(AD.type).stloc(2);
  il.ldloc(2).ldloc(3).stfld(AD.newAge);
  il.ldloc(0).callvirt(T.getQueue).ldloc(2).callvirt(AD.add).pop();
  il.ldloc(0).callvirt(AD.changed);
  il.label('done');
  return done(il);
} }));
sim.push(slot('DEBUG_MakeOldEnoughToAge', { name: 'Age Up Tomorrow', path: ['Age...'], test: true }));
{ const pick = M('ModifyTraits::<Run>b__0');
  const boxInt = tokAt(pick, 0x01), objId = chk(tokAt(pick, 0x0b), /get_ObjectId/), show = chk(tokAt(pick, 0x10), /ShowTraitsPickerDialog/);
  sim.push(slot('DEBUG_CarryRandomInventoryItem', { name: 'Change Traits', path: ['Traits & Wishes...'], test: true, run: il => { il.ldci4(0).t(0x8C, boxInt); target(il).callvirt(objId).call(show); return done(il); } })); }
sim.push(slot('DEBUG_TestVisionCone', { name: 'Add Random Trait', path: ['Traits & Wishes...'], run: il => { target(il).callvirt(T.desc).callvirt(T.traits).ldci4(1).ldci4(0).callvirt(T.randomTrait); return done(il); } }));
sim.push(slot('Stand', { name: 'Complete Lifetime Wish', path: ['Traits & Wishes...'], test: true, run: il => { target(il).callvirt(T.desc).ldci4(1).callvirt(T.ltw); return done(il); } }));
// Lifetime Happiness is both the running total and the points spendable on lifetime rewards (the game caps both at 999,999).
{ const spGet = mtok(P('Sims3.Gameplay.CAS.SimDescription::get_SpendableHappiness')), spSet = mtok(P('Sims3.Gameplay.CAS.SimDescription::set_SpendableHappiness'));
  sim.push(slot('DEBUG_PushTurnInPlace180', { name: 'Add 10,000 Lifetime Happiness', path: ['Traits & Wishes...'], test: true, run: il => {
    target(il).callvirt(T.desc).dup().callvirt(spGet).ldcr4(10000).add().callvirt(spSet);
    target(il).callvirt(T.desc).dup().callvirt(T.lthGet).ldcr4(10000).add().callvirt(T.lthSet);
    return done(il); } })); }
sim.push(slot('DEBUG_CareerPromoteSim', {}));
sim.push(slot('DEBUG_CareerDemoteSim', {}));
sim.push(slot('DEBUG_CareerRandomJob', { name: 'Random Job' }));
sim.push(slot('DEBUG_PauseAndDisableSave', { name: 'Give Raise', path: ['Career...'], clone: 'GiveRaise', cloneTest: 'GiveRaise' }));
sim.push(slot('DEBUG_Pause', { name: 'Fire Sim', path: ['Career...'], clone: 'DEBUG_FireSim', cloneTest: 'DEBUG_FireSim' }));
sim.push(slot('DEBUG_PauseOther', { name: 'Get Pregnant', path: ['Family...'], clone: 'DEBUG_GetPregnant', cloneTest: 'DEBUG_GetPregnant' }));
sim.push(slot('DEBUG_PauseEveryone', { name: 'Have Baby', path: ['Family...'], clone: 'DEBUG_HaveBaby', cloneTest: 'DEBUG_HaveBaby' }));
sim.push(slot('DEBUG_KillSim', {}));
sim.push(slot('Ghostify_Test', { path: ['Family...'] }));
sim.push(slot('DEBUG_Reset', { path: [] }));

// ---- Everything else that any object can use ----------------------------------------
const money = n => il => { il.call(T.activeHh).dup().callvirt(T.funds).ldci4(n).add().callvirt(T.setFunds); return done(il); };
const timeJump = h => il => { il.call(T.ticksGet).ldcr4(h).call(T.hoursUntil).ldci4(2).call(T.toTicks).add().call(T.ticksSet); return done(il); };
const world = [];
world.push(slot('DEBUG_ShowThumbnail', { name: 'Add 10,000 Simoleons', path: ['Money...'], run: money(10000) }));
world.push(slot('DEBUG_ShowHeadline', { name: 'Add 100,000 Simoleons', path: ['Money...'], run: money(100000) }));
world.push(slot('DEBUG_TestLineOfSight', { name: 'Morning (8 AM)', path: ['Time...'], run: timeJump(8) }));
world.push(slot('DEBUG_PerfTestLineOfSight', { name: 'Noon (12 PM)', path: ['Time...'], run: timeJump(12) }));
world.push(slot('DEBUG_ToggleLOSVisibility', { name: 'Evening (6 PM)', path: ['Time...'], run: timeJump(18) }));
world.push(slot('DEBUG_ResetTextureAll', { name: 'Night (11 PM)', path: ['Time...'], run: timeJump(23) }));
world.push(slot('DEBUG_ResetTexture', { name: 'Freeze Or Unfreeze Time', path: ['Time...'], run: il => { il.call(T.freeze).pop(); return done(il); } }));

// ---- Ground wheel ---------------------------------------------------------------
const CORE = n => NS_CORE + n;
for (const c of ['AddFire', 'AddPuddle', 'AddTrashPile', 'RemovePuddle', 'CreateMaterialSetTestObject', 'CleanupState', 'LoadAllLayerData', 'FindPlacesOnRoad', 'TriggerServiceCar', 'DEBUG_RouteAppendTest', 'ToggleGroupConversationRouting', 'SetDebugPath', 'RunDebugPath', CORE('BuyOnThisLot'), CORE('MoveHouseholdOut'), CORE('BulldozeThisLot')]) console.log('base', c.replace(NS_CORE, '').padEnd(32), '0x' + hex(extendsOf(c)));
const ter = [];
const everyone = (il, listExpr, where) => { il.ldarg(0); listExpr(il); il.stloc(1).ldci4(0).stloc(2).br('c').label('l'); il.ldloc(1).ldloc(2); return il; };
ter.push(slot('LoadAllLayerData', { name: 'Warp Me Here', run: il => done(warp(il, actor, hitPoint)) }));
ter.push(slot('LoadLayerData', { name: 'Warp My Household Here', run: il => { actor(il).callvirt(T.household).callvirt(T.hhSims).stloc(1).ldci4(0).stloc(2).br('c').label('l'); il.ldloc(1).ldloc(2).callvirt(T.listSimItem).stloc(0); warp(il, x => x.ldloc(0), hitPoint); il.ldloc(2).ldci4(1).add().stloc(2).label('c').ldloc(2).ldloc(1).callvirt(T.listSimCount).blt('l'); return done(il); }, locals: LOCALS.RRIR }));
ter.push(slot('UnloadLayerData', { name: 'Summon The Town Here', run: il => { il.call(T.allSims).stloc(1).ldci4(0).stloc(2).br('c').label('l'); il.ldloc(1).ldloc(2).ldelemRef().stloc(0); warp(il, x => x.ldloc(0), hitPoint); il.ldloc(2).ldci4(1).add().stloc(2).label('c').ldloc(2).ldloc(1).ldlen().convI4().blt('l'); return done(il); }, locals: LOCALS.RRIR }));
ter.push(slot('MakeSim', {})); ter.push(slot('MakePet', {}));
ter.push(slot('AddFire', {})); ter.push(slot('AddPuddle', {})); ter.push(slot('AddTrashPile', {}));
ter.push(slot(CORE('BuyOnThisLot'), {})); ter.push(slot(CORE('MoveHouseholdOut'), {})); ter.push(slot(CORE('BulldozeThisLot'), {}));
ter.push(slot('DEBUG_SpawnRockGemMetals', {})); ter.push(slot('MaximizeZonePopulation', {}));
for (const [o, n] of [['DEBUG: Add Fire', 'Add Fire'], ['DEBUG: Add Puddle', 'Add Puddle'], ['DEBUG: Add Trash Pile', 'Add Trash Pile'], ['DEBUG: Build/Buy On This Lot', 'Build Or Buy On This Lot'], ['DEBUG: Move Household Out', 'Move Household Out'], ['DEBUG: Bulldoze This Lot', 'Bulldoze This Lot'], ['DEBUG_SpawnRockGemMetals', 'Spawn Rocks And Gems'], ['DEBUG: AddToFamilyInventory', 'Add To Family Inventory'], ['Delete Me', 'Delete It'], ['DEBUG: Move Household In', 'Move Household In'], ['DEBUG: Add to Household', 'Add To Household'], ['Upgrade Breakable Objects to Unbreakable', 'Make Everything Unbreakable'], ['DEBUG_UnlockAllRelics', 'Unlock All Relics']]) renameLiteral(o, n);

// ---- Objects, lots, mailboxes -------------------------------------------------------
const obj = [slot('DEBUG_Clone', { path: [] }), slot('DEBUG_DeleteIt', { path: [] }), slot('DEBUG_AddToFamilyInventory', {})];
const lotList = [
  slot(CORE('DisplayLevelDown'), { name: 'Play This Household', test: true, run: il => { il.ldarg(0).call(T.getTarget).castclass(T.Lot).callvirt(T.lotHh).callvirt(T.hhSims).ldci4(0).callvirt(T.listSimItem).call(T.force).pop(); return done(il); } }),
  slot(CORE('DisplayLevelUp'), { name: 'Repair All Objects', test: true, run: il => { il.ldarg(0).call(T.getTarget).castclass(T.Lot).callvirt(T.repair); return done(il); } }),
  slot(CORE('MoveHouseholdIn'), {}), slot(CORE('MoveHouseholdOut'), {}), slot(CORE('AddToHousehold'), {}), slot(CORE('BuyOnThisLot'), {}), slot(CORE('BulldozeThisLot'), {}),
];
const mail = ['DEBUG_AutoPayBills', 'DEBUG_MakeAllObjectsUnbreakable', 'DEBUG_TriggerWelcomeWagon', 'DEBUG_UnlockAllLots', 'DEBUG_UnlockAllRelics', 'DEBUG_UnlockMysteryRewards', 'DEBUG_UnlockAllChallenges'].map(c => slot(c, {}));

// HOUSESTART: empty houses. On the ground of a residential lot that has a house but no household (live mode), and on
// such a lot itself (clicking the house, or on the Town Map), four options move randomly made Sims in. They use the game's
// own Sim.MakeRandomSim, which creates a household, moves it into the lot and makes a Sim with random looks, traits and
// name. A couple is a man and a woman, married, sharing his surname; a family adds one to three toddlers, children or
// teens as their children. Everyone in a new couple or family knows each other. Each new household is named after its
// surname and starts with 20,000 Simoleons.
const H = (() => {
  const rock = P('Sims3.Gameplay.WonderPowers.WonderPower_EarthquakeActivation::CreateRock'), spec = P('HouseholdCreationSpec::Instantiate');
  const pick = (name, i, size) => { const me = M(name, i); if (body(me).size !== size) throw new Error('unexpected overload ' + name + ' #' + i); return mtok(me); };
  return {
    mk3: pick('Sims3.Gameplay.Actors.Sim::MakeRandomSim', 0, 266), mk2: pick('Sims3.Gameplay.Actors.Sim::MakeRandomSim', 1, 29),
    coin: mtok(P('Sims3.Gameplay.Core.RandomUtil::CoinFlip')), getInt: pick('Sims3.Gameplay.Core.RandomUtil::GetInt', 1, 16),
    lastGet: mtok(P('Sims3.Gameplay.CAS.SimDescriptionCore::get_LastName')), lastSet: mtok(P('Sims3.Gameplay.CAS.SimDescriptionCore::set_LastName')),
    setName: mtok(P('Sims3.Gameplay.CAS.Household::SetName')),
    worldLot: mtok(P('Sims3.Gameplay.Core.Lot::get_IsWorldLot')), resLot: mtok(P('Sims3.Gameplay.Core.Lot::get_IsResidentialLot')), noObjects: mtok(P('Sims3.Gameplay.Core.Lot::IsLotEmptyFromObjects')),
    randPos: pick('Sims3.Gameplay.Core.Lot::GetRandomPosition', 0, 11), lotPos: mtok(P('Sims3.Gameplay.Core.Lot::get_Position')),
    allLots: mtok(P('Sims3.Gameplay.Core.LotManager::get_AllLots')), getEnum: chk(0x0A00000A, /IEnumerable::GetEnumerator$/), moveNext: chk(0x0A000086, /IEnumerator::MoveNext$/), current: chk(0x0A000009, /IEnumerator::get_Current$/),
    baseEarly: mtok(P('Sims3.Gameplay.Interactions.NewInteractionDefinition::EarlyOutTest')), parHit: mtok(P('Sims3.Gameplay.Interactions.InteractionInstanceParameters::get_Hit')),
    lotAt: mtok(P('Sims3.Gameplay.Core.LotManager::GetLotAtPoint')),
    v3Invalid: chk(tokAt(rock, 0x0f), /Vector3::Invalid$/), v3ne: chk(tokAt(rock, 0x14), /op_Inequality$/),
    ltrOf: chk(tokAt(spec, 0x1a4), /Relationship::get_LTR$/), famRange: chk(tokAt(spec, 0x1e0), /SimUtils::kFamilyRelationshipRange$/),
    famSteps: chk(tokAt(spec, 0x1e7), /SimUtils::kNumFamilyRelationshipUpdates$/), getFloat: chk(tokAt(spec, 0x1fc), /RandomUtil::GetFloat$/),
    liking: chk(tokAt(spec, 0x207), /LongTermRelationship::UpdateLiking$/),
  };
})();
{ // stack: lot -> true when it is a residential lot with a house and no household
  const emptyHouse = (il, p) => il.dup().brfalse(p + 'n').dup().callvirt(H.worldLot).brtrue(p + 'n').dup().callvirt(H.resLot).brfalse(p + 'n').dup().callvirt(T.lotHh).brtrue(p + 'n')
    .callvirt(H.noObjects).ldci4(0).u8(0xFE, 0x01).br(p + 'e').label(p + 'n').pop().ldci4(0).label(p + 'e');
  const spot = (il, L, p) => il.ldloc(L).ldci4(0).ldci4(1).callvirt(H.randPos).dup().ldsfld(H.v3Invalid).call(H.v3ne).brtrue(p).pop().ldloc(L).callvirt(H.lotPos).label(p);
  const adultAge = (il, p) => il.call(H.coin).brtrue(p + 'y').ldci4(32).br(p + 'd').label(p + 'y').ldci4(16).label(p + 'd');   // adult or young adult
  const nameHome = (il, s, p) => il.ldloc(s).brfalse(p).ldloc(s).callvirt(T.household).dup().ldloc(s).callvirt(T.desc).callvirt(H.lastGet).callvirt(H.setName).ldci4(20000).callvirt(T.setFunds).label(p);
  // All four options share one routine, Fill(lot, kind), so its code is stored once: a keyboard-console command that
  // nothing calls, given a (lot, number) signature (copied from Household.RegisterGhostCapture) and made public.
  // Kinds: 0 one Sim, 1 couple, 2 family, 3 every empty house.
  // Locals (R5I3R): 0 lot, 1 first Sim, 2 second Sim, 3 child, 4 lot enumerator or relationship, 5 child count or
  // inner index, 6 children wanted or update count, 7 outer index, 8 the household's Sims.
  const fillHost = M('Sims3.Gameplay.Core.Commands::OnSpawn');
  const f = new IL();
  f.ldarg(1).ldci4(3).beq('all');
  f.ldarg(0).stloc(0).ldloc(0); emptyHouse(f, 'ch').brfalse('x');
  f.ldarg(1).brtrue('two');
  spot(f, 0, 'p0'); adultAge(f, 'a0').call(H.mk2).stloc(1).br('name');
  f.label('two');
  spot(f, 0, 'pa'); adultAge(f, 'aa').ldci4(0x1000).call(H.mk3).stloc(1);
  spot(f, 0, 'pb'); adultAge(f, 'ab').ldci4(0x2000).call(H.mk3).stloc(2);
  f.ldloc(1).brfalse('x').ldloc(2).brfalse('x');
  f.ldloc(2).callvirt(T.desc).ldloc(1).callvirt(T.desc).callvirt(H.lastGet).callvirt(H.lastSet);
  f.ldloc(1).callvirt(T.desc).ldloc(2).callvirt(T.desc).ldci4(1).callvirt(REL.getRel).ldstr(S('Spouse')).call(REL.ltr).callvirt(REL.force);
  f.ldloc(1).callvirt(REL.gen).ldloc(2).callvirt(REL.gen).callvirt(REL.marry);
  f.ldarg(1).ldci4(1).beq('know');
  f.ldci4(1).ldci4(3).call(H.getInt).stloc(6).ldci4(0).stloc(5).br('kc').label('kl');
  spot(f, 0, 'pc'); f.ldci4(2).ldci4(0).ldci4(2).call(H.getInt).u8(0x62).call(H.mk2).stloc(3).ldloc(3).brfalse('kn');   // shl: toddler, child or teen
  f.ldloc(3).callvirt(T.desc).ldloc(1).callvirt(T.desc).callvirt(H.lastGet).callvirt(H.lastSet);
  f.ldloc(1).callvirt(REL.gen).ldloc(3).callvirt(REL.gen).callvirt(REL.addChild).ldloc(2).callvirt(REL.gen).ldloc(3).callvirt(REL.gen).callvirt(REL.addChild);
  f.label('kn').ldloc(5).ldci4(1).add().stloc(5).label('kc').ldloc(5).ldloc(6).blt('kl');
  // Everyone in a new couple or family knows each other, the way the game's own new households start
  // (HouseholdCreationSpec.Instantiate): kNumFamilyRelationshipUpdates liking updates per pair, each a random share of
  // kFamilyRelationshipRange (30 to 95 in all).
  const share = i => f.ldsfld(H.famRange).ldci4(i).u8(0x98).ldsfld(H.famSteps).u8(0x6B).u8(0x5B);   // ldelem.r4, conv.r4, div
  f.label('know').ldloc(1).callvirt(T.household).callvirt(T.hhSims).stloc(8).ldci4(0).stloc(7).br('ic');
  f.label('il').ldloc(7).ldci4(1).add().stloc(5).br('jc');
  f.label('jl').ldloc(8).ldloc(7).callvirt(T.listSimItem).callvirt(T.desc).ldloc(8).ldloc(5).callvirt(T.listSimItem).callvirt(T.desc).ldci4(1).callvirt(REL.getRel).dup().brfalse('j0');
  f.callvirt(H.ltrOf).stloc(4).ldci4(0).stloc(6).br('uc');
  f.label('ul').ldloc(4); share(0); share(1); f.call(H.getFloat).callvirt(H.liking);
  f.ldloc(6).ldci4(1).add().stloc(6).label('uc').ldloc(6).ldsfld(H.famSteps).blt('ul').br('jn');
  f.label('j0').pop();
  f.label('jn').ldloc(5).ldci4(1).add().stloc(5).label('jc').ldloc(5).ldloc(8).callvirt(T.listSimCount).blt('jl');
  f.ldloc(7).ldci4(1).add().stloc(7).label('ic').ldloc(7).ldloc(8).callvirt(T.listSimCount).blt('il');
  f.label('name'); nameHome(f, 1, 'nh'); f.label('x').ret();
  f.label('all').call(H.allLots).callvirt(H.getEnum).stloc(4).label('al').ldloc(4).callvirt(H.moveNext).brfalse('ae');
  f.ldloc(4).callvirt(H.current).isinst(T.Lot).stloc(0).ldloc(0); emptyHouse(f, 'ah').brfalse('al');
  spot(f, 0, 'ap'); adultAge(f, 'a3').call(H.mk2).stloc(1); nameHome(f, 1, 'an').br('al').label('ae').ret();
  setRva(fillHost, emit(f, { locals: LOCALS2.R5I3R, maxstack: 8 })); hostLike(fillHost, M('Sims3.Gameplay.CAS.Household::RegisterGhostCapture'));
  const early = new IL(); early.ldarg(0).ldarg(1).ldarg(2).call(H.baseEarly).brfalse('no').ldarg(1).call(H.parHit).ldfld(T.hitPoint).call(H.lotAt);
  emptyHouse(early, 'h').ret().label('no').ldci4(0).ret();
  const earlyRva = emit(early, { maxstack: 6 });
  const lotTest = new IL(); lotTest.ldarg(2).isinst(T.Lot); const lotTestRva = emit(emptyHouse(lotTest, 'h').ret(), { maxstack: 6 });
  const KINDS = [['Move In A Random Sim', 'RemovePuddle', 'IsLotEmpty'], ['Move In A Random Couple', 'DisplayStreetParking', 'MoveLotToGameBin'],
    ['Move In A Random Family', 'DEBUG_Carpool', 'MoveHouseholdToGameBin'], ['Fill Every Empty House', 'DEBUG_Carpools', 'GenerateLotThumbnails']];
  KINDS.forEach(([name, ground, lot], kind) => {
    ter.push(slot(ground, { name, test: true, maxstack: 4, run: il => done(il.ldarg(0).ldflda(T.hit).ldfld(T.hitPoint).call(H.lotAt).ldci4(kind).call(mtok(fillHost))) }));
    setRva(defMethod(ground, 'EarlyOutTest'), earlyRva);
    lotList.push(slot(CORE(lot), { name, maxstack: 4, run: il => done(il.ldarg(0).call(T.getTarget).isinst(T.Lot).ldci4(kind).call(mtok(fillHost))) }));
    setRva(defMethod(CORE(lot), 'Test'), lotTestRva);
  });
  // Play This Household only where there is a household to play.
  const hasHh = new IL(); hasHh.ldarg(2).isinst(T.Lot).dup().brfalse('n').callvirt(T.lotHh).ldnull().u8(0xFE, 0x03).ret().label('n').pop().ldci4(0).ret();   // cgt.un
  setRva(defMethod(CORE('DisplayLevelDown'), 'Test'), emit(hasHh, { maxstack: 4 }));
}
// HOUSEEND

// Curated lists.
function listBody(items) { const il = new IL(); for (const f of items) il.ldarg(1).ldsfld(f).callvirt(addDef); return il.ret(); }
const curM = M('Sims3.Gameplay.ActorSystems.Children.ChildUtils::DebugNotify');
const terrainTok = 0x02000000 | ridOf('Sims3.Gameplay.Core.Terrain');
const mailboxTok = tokAt(P('Sims3.Gameplay.Abstracts.GameObject::OnPick'), 0x5d);
// The Sim and ground lists are too long to share one body with the rest, so each lives in a host of its own: a keyboard-
// console command that nothing calls, given the dispatcher's signature (GameObject target, list) and made public.
function hostLike(me, model) {
  const row = m.pos[6] + mIdx.get(me) * m.sz[6], fl = b.readUInt16LE(row + 6), modelRow = m.pos[6] + mIdx.get(model) * m.sz[6];
  if (!(fl & 0x10)) throw new Error('host is not static: ' + me.name);
  w(row + 6, [((fl & ~7) | 6) & 255, ((fl & ~7) | 6) >> 8]);
  for (let k = 0; k < m.bw; k++) w(row + 8 + m.sw + k, [b[modelRow + 8 + m.sw + k]]);
}
{ const il = new IL(); const go = (t, l) => il.ldarg(0).isinst(t).brtrue(l);
  const add = (x, items) => { for (const f of items) x.ldarg(1).ldsfld(f).callvirt(addDef); x.ret(); };
  const hostSim = M('Sims3.Gameplay.Core.Commands::OnTmp'), hostTer = M('Sims3.Gameplay.Core.Commands::OnStressReset');
  go(T.Sim, 'sim'); go(terrainTok, 'ter'); go(mailboxTok, 'mail'); go(T.Lot, 'lot');
  add(il, [...obj]); il.label('sim').ldarg(0).ldarg(1).call(mtok(hostSim)).ret(); il.label('ter').ldarg(0).ldarg(1).call(mtok(hostTer)).ret();
  il.label('mail'); add(il, [...mail, ...obj]); il.label('lot'); add(il, [...lotList, ...world]);
  setRva(curM, emit(il, { maxstack: 4 }));
  for (const [host, items] of [[hostSim, [...sim, ...world]], [hostTer, [...ter, ...world]]]) { const x = new IL(); add(x, items); setRva(host, emit(x, { maxstack: 4 })); hostLike(host, curM); } }
const allCheatBody = body(P('Sims3.Gameplay.Abstracts.GameObject::GetAllCheatInteractionsForActor'));
if (b[allCheatBody.code + 8] !== 0x6F) throw new Error('GetAllCheat layout');
w(allCheatBody.code + 8, [0x28, ...u32(mtok(curM))]);

// Combined wheel: curated entries, then every developer tool under one folder.
const hostM = M('Sims3.Gameplay.Core.Commands::FormatWPStatus');
{ const q = m.pos[6] + mIdx.get(hostM) * m.sz[6] + 6; const f = b.readUInt16LE(q); w(q, [((f & ~7) | 6) & 255, ((f & ~7) | 6) >> 8]); }
{ const il = new IL(); il.ldarg(0).call(T.activeActor).callvirt(T.allCheat).stloc(0).ldarg(0).call(T.activeActor).callvirt(T.allDebug).stloc(1).ldci4(0).stloc(3).br('c').label('l');
  il.ldloc(1).ldloc(3).callvirt(T.listTupleItem).stloc(2).ldloc(0).ldloc(2).callvirt(T.tupleDef).ldloc(2).callvirt(T.tupleTarget).ldstr(S('Developer Tools...')).newobj(T.prepCtor).callvirt(T.listTupleAdd);
  il.ldloc(3).ldci4(1).add().stloc(3).label('c').ldloc(3).ldloc(1).callvirt(T.listTupleCount).blt('l').ldloc(0).ret();
  setRva(hostM, emit(il, { locals: LOCALS.RRRI, maxstack: 8 })); }

// Remove the entries whose classes now do something else from the developer lists.
const remove = new Set([...reused, ...Object.keys({})]);
for (const e of entries) if (remove.has(e.cls)) w(e.off, new Array(11).fill(0));

// LT + A opens the wheel on its own, and calls the combined list.
const pick = body(P('Sims3.Gameplay.Abstracts.GameObject::OnPick'));
if (b[pick.code + 0x29] !== 0x7E || b[pick.code + 0x2E] !== 0x2D) throw new Error('OnPick layout');
w(pick.code + 0x29, [0, 0, 0, 0, 0, 0x2B, 0x07]);
if (b[pick.code + 0x37] !== 2 || b[pick.code + 0x3D] !== 0x6F) throw new Error('OnPick call layout');
w(pick.code + 0x38, [0, 0, 0, 0, 0]); w(pick.code + 0x3D, [0x28, ...u32(mtok(hostM))]);

// Every world load: all challenge rewards (karma powers) unlocked, with no profile data needed.
const post = body(P('Sims3.Gameplay.WonderPowers.WonderPowers::PostWorldLoadStartup'));
if (b[post.code + 0x1b] !== 0x20 || post.size !== 45) throw new Error('PostWorldLoadStartup layout');
w(post.code + 0x1b, [0x28, ...u32(mtok(P('Sims3.Gameplay.ChallengesAndRewards.ChallengesManager::DEBUG_UnlockAllRewards'))), ...new Array(12).fill(0)]);


{ const sb = P('Sims3.Gameplay.ActorSystems.SimBuilderTask::Simulate'), sbBody = body(sb);
  const sd = chk(tokAt(sb, 0x52), /SimBuilderTask::SimDescription/), down = chk(tokAt(sb, 0x5f), /mAgingDown/), isPet = chk(tokAt(sb, 0x57), /get_IsPet/), age = chk(tokAt(sb, 0x6c), /get_Age/), species = chk(tokAt(sb, 0x77), /get_Species/), older = chk(tokAt(sb, 0x7c), /GetNextOlderAge/);
  const il = new IL();
  il.ldarg(0).ldfld(down).dup().brtrue('v').pop();
  il.ldarg(0).ldfld(sd).callvirt(age).ldarg(0).ldfld(sd).callvirt(species).call(older).br('end');
  il.label('v').dup().ldci4(1).br_(0x40, 'end').pop();
  il.ldarg(0).ldfld(sd).callvirt(isPet).brtrue('p').ldci4(16).br('end').label('p').ldci4(32);
  il.label('end').stloc(2);
  const code = il.bytes(), region = 0xAF - 0x51 + 1; if (code.length > region) throw new Error('builder patch too long ' + code.length);
  w(sbBody.code + 0x51, [...code, ...new Array(region - code.length).fill(0)]);
  console.log('builder patch', code.length, 'of', region); }

// CHOOSERSTART: with LT held, skip the "which object?" list and pick the first candidate, so the wheel opens directly.
{ const gouc = P('Sims3.Gameplay.InWorldSubState::GetObjectUnderCursor'), gb = body(gouc);
  if (b[gb.code + 0xe1] !== 0x28) throw new Error('GetObjectUnderCursor layout');
  const chooser = chk(tokAt(gouc, 0xe1), /TestAndBringUpPieMenu/);
  const trig = mtok(P('Sims3.Gameplay.InWorldSubState::GetLeftTriggerDown'));
  const live = P('Sims3.Gameplay.LiveModeState::OnTriggerDown');
  const taskGet = chk(tokAt(live, 0x53), /PickObjectTask::get_Singleton/), request = chk(tokAt(live, 0x59), /RequestClickEvent/);
  const fId = chk(tokAt(gouc, 0xc4), /mObjectId/), fType = chk(tokAt(gouc, 0xce), /mObjectType/);
  const il = new IL();
  il.call(trig).brtrue('one').ldarg(0).ldarg(1).ldarg(2).call(chooser).ret().label('one');
  il.u8(0x0F, 0).ldarg(1).ldci4(0).u8(0x96).stfld(fId);
  il.u8(0x0F, 0).ldarg(2).ldci4(0).u8(0x95).stfld(fType);
  il.call(taskGet).ldarg(0).callvirt(request).pop().ret();
  const hostH = M('Sims3.Gameplay.Core.Commands::SetWPLocked');
  const hostRow = m.pos[6] + mIdx.get(hostH) * m.sz[6], fl = b.readUInt16LE(hostRow + 6);
  if (!(fl & 0x10)) throw new Error('host is not static');
  w(hostRow + 6, [((fl & ~7) | 6) & 255, ((fl & ~7) | 6) >> 8]);
  const chooserRow = m.pos[6] + ((chooser & 0xFFFFFF) - 1) * m.sz[6];
  for (let k = 0; k < m.bw; k++) w(hostRow + 8 + m.sw + k, [b[chooserRow + 8 + m.sw + k]]);
  setRva(hostH, emit(il, { maxstack: 8 }));
  w(gb.code + 0xe1, [0x28, ...u32(mtok(hostH))]);
  console.log('chooser host flags 0x' + fl.toString(16)); }

// ---- Output --------------------------------------------------------------------
const sha = x => require('crypto').createHash('sha256').update(x).digest('hex');
const patches = []; for (let i = 0; i < b.length; i++) { if (!touched[i]) continue; let j = i; while (j < b.length && touched[j]) j++; patches.push({ o: i, n: j - i, h: sha(b.slice(i, j)), d: patched.slice(i, j).toString('hex') }); i = j; }
const probeOff = 120000, probeLen = 32;
fs.writeFileSync(outFile, JSON.stringify({ game: 'The Sims 3 Pets', titleId: '45410962', imageSize: b.length, probeOff, probeLen, probeSha256: sha(b.slice(probeOff, probeOff + probeLen)), patches }));
console.log('patches', patches.length, 'bytes', patches.reduce((s, p) => s + p.d.length / 2, 0), 'cave used', caveUsed, 'of', cave.reduce((s, c) => s + c.size, 0), 'pool regions', regions.length, 'used through', ri, 'at', rp);

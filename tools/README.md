# Patch generators

You don't need these files to play. They show how the patch files in `mod-menu` are made.

## Mod menu

- `clr.js` reads .NET metadata and disassembles method code.
- `modbuild.js` assembles the mod menu's code and writes the patch file.

To run the generator you need `Sims3GameplaySystems` saved from your own game's memory while it runs. That file is EA's code, so it isn't included here.

```bash
node modbuild.js path/to/Sims3GameplaySystems.dll ../mod-menu/mod_patches.json
```

The patch file holds only the new code and text, plus SHA-256 hashes of the bytes they replace.

## Smart screen copies

- `ppcasm.js` is a tiny PowerPC assembler, covering just the instructions the stubs use.
- `make_smart_copies.js` writes `mod-menu/fps-patch/Smart screen copies.toml`. It routes the game's 13 rare screen-copy call sites through stubs that ask the launcher's helper to switch Xenia's readback on. Each stub then makes its copy twice, through a shared routine placed after the pet patch's code. This works around Xenia's Vulkan readback copying a picture before the graphics card has finished writing it ([Sims' outfits](../README.md#sims-outfits)). It checks that each call site is the branch it expects, that it calls one of the two copy functions it knows, and that the space it writes into is empty.
- `make_pets_look_right.js` writes the "Pets look right" patch, which `make_smart_copies.js` adds to the end of the same file. It gives the game's pet fur buffers memory pages of their own (a copy of the buffer-create function that asks for page alignment), keeps them there when the game's memory tidier moves them (a tag on the buffer plus a wrapper around the tidier's allocation), and corrects the size the game gives the graphics card for the fur export. It checks every instruction it replaces first. Run on its own, it writes just that section.

It needs the game's `Sims3.xex` image saved from memory while the game runs (loaded at `0x88000000`, module hash `DF7B98E763E34184`). That's EA's code, so it isn't included either.

```bash
node make_smart_copies.js path/to/sims3_image.bin "../mod-menu/fps-patch/Smart screen copies.toml"
```

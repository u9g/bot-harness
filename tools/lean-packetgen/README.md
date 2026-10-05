# lean-packetgen

A Minecraft packet generator written in Lean 4, with a machine-checked proof that it misses no packet. It reads a `minecraft-data` `protocol.json` and lists packets along with the bytes each one must serialize to. `harness/validate.js` then checks node-minecraft-protocol against those packets.

This follows the idea in [minecraft-data-generator#57](https://github.com/PrismarineJS/minecraft-data-generator/issues/57): generate all packet permutations and use them to validate the serializers.

## What is proved

Every packet with every possible content can't be listed, because a single `string` field already allows more than 10^100000 values. So there are two modes.

### Default: every packet over a few sample values per primitive

Each primitive field takes a few representative values, chosen in [`DefaultSamples.lean`](PacketGen/DefaultSamples.lean):

- **numbers:** `0, 1, -1` (floats `0.0, 1.0, -1.0`);
- **strings:** `""`, `"a"`, `"ab"` and a 10-character string;
- **buffers and arrays:** length 0, 1 or 2 (buffers also 10).

A field that a `switch` compares also takes every case label, so every branch is reachable. A field used as an array count also takes `2`. Booleans, mapper names and switch branches are always enumerated in full. With finitely many values per field, the set of packets is finite.

[`PacketGen/Finite.lean`](PacketGen/Finite.lean) proves, for every protodef type `t` and every choice of samples `S`:

| theorem | statement |
| --- | --- |
| `mem_enumerate` | `v ∈ enumerate S t ↔ Valid t v ∧ t.dom S v` |

In words, the enumerator lists exactly the valid packets whose primitive values all come from the samples: none is missed and nothing invalid is produced.

The enumeration is **fair**: each field's choices are interleaved round-robin (`LList.fairFlatMap`). So any `--limit` prefix already touches every branch, rather than exhausting the first one. The proof covers the reordering, which changes only the order and never which packets appear (`mem_fairFlatMap`).

### `--size N`: every packet, ordered by size

Here every value is allowed, and packets are ordered by a natural-number **size**. Every valid packet appears at a finite, known position: its size. [`PacketGen/Spec.lean`](PacketGen/Spec.lean) proves:

| theorem | statement |
| --- | --- |
| `mem_generate` | `v ∈ generate t n ↔ Valid t v ∧ v.size = n` |
| `generate_complete` | `Valid t v → v ∈ generate t v.size` (**no valid packet is missed**) |
| `generate_sound` | `v ∈ generate t n → Valid t v` (**nothing invalid is produced**) |
| `mem_generateUpTo` | `generateUpTo t N` is exactly the valid packets of size `≤ N` |
| `generateUpTo_mono` | raising the budget never loses packets |
| `generate_unique_size` | each packet is listed at exactly one size |

Some packet types have too many combinations to list completely; `packetgen` reports which ones were cut at `--limit`. For each of those it also emits every *single-field variant* of the first packet: the same packet with one primitive field set to each of its samples. This catches values deep in long packets that the fair prefix doesn't reach. The variants are a coverage aid, not part of the completeness claim. They are filtered through the same `Valid` and sample checks, so every one is still a valid packet (`variants_valid`).

In both modes, `LList.take_eq` shows that `--limit k` outputs exactly the first `k` packets of the complete list. Both modes use the same definition of `Valid`.

The proofs contain no `sorry` and use only Lean's standard axioms. Run `lake env lean Axioms.lean` to check.

### What "valid" and "size" mean

`Valid t v` holds when:

- every field has the right shape and its value is in range for its type (`i8`, `varint`, bitfield widths, Unicode scalars in strings, count-prefix ranges);
- every `switch` takes the branch selected by the field it compares to, using protodef's semantics (`../` paths, closure lookup, numeric, boolean and string case labels, mapper names, default);
- every array whose length comes from another field matches that field.

This is checked left to right with the fields decoded so far, the same way the decoder reads a packet.

Size works like this. An integer costs its zig-zag magnitude (`0, -1, 1, -2, …` cost `0, 1, 2, 3, …`). A sequence costs its length plus the sizes of its elements. An option that is present costs 1 more than its value. A choice among finitely many alternatives (booleans, switch branches, mapper names) costs nothing. So size 0 already contains every branch of every packet with all-zero payloads, and each higher size adds bigger numbers and longer arrays and strings.

Floats are enumerated as IEEE-754 bit patterns, so every float, including subnormals and NaNs, is covered.

### How it is built

- [`Gen.lean`](PacketGen/Gen.lean) defines generic enumerators (`unit`, `bool`, `ints`, `option`, `list`, `prod`, …). Each comes with a proof that it is *exact*: it is sound and complete for its own check.
- [`Spec.lean`](PacketGen/Spec.lean) adds dependent combinators (`select` for switches, `fields` for containers). `Ty.dgen` builds a generator for any type out of these combinators only, so `Ty.dgen_exact` follows by structural recursion.
- [`LList.lean`](PacketGen/LList.lean) makes enumeration lazy, so `--limit` stays cheap. A 256-byte signature alone has about 10^10 values of size 5. Every lazy operation is proved equal to its `List` counterpart, and the fair merge is proved to keep exactly the same elements.
- [`Finite.lean`](PacketGen/Finite.lean) enumerates over the sample values. For each type it builds the candidates from the samples and keeps the ones `Ty.dgen` accepts, so it uses the same validity check as the size mode.

### What is *not* proved

- The translation from `protocol.json` to `Ty` ([`Json.lean`](PacketGen/Json.lean)).
- The reference byte encoder ([`Encode.lean`](PacketGen/Encode.lean)).
- The JSON conversion of values.

These are ordinary code. The harness cross-checks them against node-minecraft-protocol: two independent implementations have to agree byte for byte. Neither side is checked against the vanilla game yet; see "Next steps".

## Usage

```sh
# Lean toolchain: https://github.com/leanprover/elan
cd tools/lean-packetgen
lake build                      # checks every proof, builds .lake/build/bin/packetgen

# every valid packet over the sample values (at most 5000 per packet type), with expected bytes
.lake/build/bin/packetgen path/to/protocol.json --limit 5000 > packets.jsonl
.lake/build/bin/packetgen path/to/protocol.json --size 3 --limit 500  # size-ordered mode instead
.lake/build/bin/packetgen path/to/protocol.json --report          # which packet types are covered

# differential test of node-minecraft-protocol (run `npm install` at the repo root first)
node harness/validate.js 1.21.4 --limit 5000
```

Each output line has the form `{"state","direction","name","id","params","hex"}` (plus `"size"` in `--size` mode). The `hex` field is the packet id varint followed by the params. For each packet, the harness:

1. serializes `params` with nmp and requires exactly `hex`;
2. parses `hex` with nmp and requires every byte to be consumed;
3. re-serializes the parsed value and requires `hex` again.

Corrupting the expected bytes makes almost every check fail (531 of 543 in a size-1 run). The 12 that still pass are packets with no fields, whose bytes are only the packet ID.

Other options: `--state`, `--direction`, `--packet`. `--limit 0` means no limit. At the end, `packetgen` prints how many packet types were enumerated completely and which ones were cut at `--limit`.

## Results so far (default samples, `--limit 5000`)

| version | packet types translated | enumerated completely | packets checked | failing packet types |
| --- | --- | --- | --- | --- |
| 1.8.8 | 101 | 91 | 64,753 | `world_border` |
| 1.12.2 | 114 | 104 | 70,964 | `world_border` |
| 1.16.5 | 138 | 121 | 107,980 | `multi_block_change`, `world_border`, `update_structure_block` |
| 1.18.2 | 151 | 134 | 114,981 | `initialize_world_border`, `multi_block_change`, `world_border_lerp_size`, `update_structure_block` |
| 1.20.4 | 165 | 148 | 106,809 | none |
| 1.21.4 | 185 | 166 | 119,401 | none |
| 1.21.8 | 190 | 168 | 134,881 | none |
| 1.21.11 | 195 | 170 | 151,725 | `debug_block_value`, `debug_chunk_value`, `debug_entity_value` |
| 26.1 | 199 | 173 | 156,717 | `debug_{block,chunk,entity}_value`, `update_time` |

Every failure comes from one of two bugs:

- **`varlong` is serialized as a 32-bit varint.** nmp's `writeVarLong` calls `writeVarInt`, so `-1` comes out as `ffffffff0f` instead of `ffffffffffffffffff01`. Values ≥ 2³¹ throw when written and are misread when parsed, and BigInt input throws. This causes the `world_border*`, `multi_block_change`, `update_structure_block` and `update_time` failures.
- **`option(void)` cannot round-trip** in the 1.21.9+ `debug_*_value` packets. `payload` is `option(switch → void)` (for example `type = VillageSections`), and the bytes `…01` ("present, no data") parse to `payload: undefined`, which nmp writes back as `…00`.

Coverage in 1.21.4: 185 of 237 packet types translate. The other 52 use natives that are not modelled yet: `anonymousNbt` (26), `registryEntryHolder` (11), `bitflags` (8), `anonOptionalNbt` (2), recursive types (2), `topBitSetTerminatedArray`, `registryEntryHolderSet` and `entityMetadataLoop`. Use `--report` to see them. These packets are skipped and reported; they are never silently approximated, so the theorem covers exactly the packets that are generated.

## Next steps

- Model the remaining natives listed above (NBT, registry holders, `bitflags`, entity metadata).
- Validate against the real game: feed the generated `hex` to a vanilla server or client (the approach of [mc-zuri/minecraft-packets-generator](https://github.com/mc-zuri/minecraft-packets-generator)) and keep the packets that decode and re-encode identically. That turns `protocol.json` itself into a tested artifact, not only the serializers.
- Prove the reference encoder's `decode ∘ encode = id` in Lean.

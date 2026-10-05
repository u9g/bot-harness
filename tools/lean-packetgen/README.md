# lean-packetgen

An exhaustive Minecraft packet generator written in Lean 4. It comes with a machine-checked proof that it misses no packet. It reads a `minecraft-data` `protocol.json` and lists every valid packet in size order, along with the bytes each packet must serialize to. `harness/validate.js` then checks node-minecraft-protocol against those packets.

This follows the idea in [minecraft-data-generator#57](https://github.com/PrismarineJS/minecraft-data-generator/issues/57): generate all packet permutations and use them to validate the serializers.

## What is proved

"Every packet with every possible content" cannot be produced in finite time. A single `string` field already allows more than 10^100000 values. So the generator orders packets by a natural-number **size**, and the proof says that every valid packet appears at a finite, known position: its size.

For **every** protodef type `t` (and so every packet of every protocol version the translator accepts), [`PacketGen/Spec.lean`](PacketGen/Spec.lean) proves:

| theorem | statement |
| --- | --- |
| `mem_generate` | `v ∈ generate t n ↔ Valid t v ∧ v.size = n` |
| `generate_complete` | `Valid t v → v ∈ generate t v.size` (**no valid packet is missed**) |
| `generate_sound` | `v ∈ generate t n → Valid t v` (**nothing invalid is produced**) |
| `mem_generateUpTo` | `generateUpTo t N` is exactly the valid packets of size `≤ N` |
| `generateUpTo_mono` | raising the budget never loses packets |
| `generate_unique_size` | each packet is listed at exactly one size |
| `LList.take_eq` | `--limit k` outputs exactly the first `k` packets of the complete list |

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
- [`LList.lean`](PacketGen/LList.lean) makes enumeration lazy, so `--limit` stays cheap. A 256-byte signature alone has about 10^10 values of size 5. Every lazy operation is proved equal to its `List` counterpart.

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

# every valid packet up to size 3 (at most 500 per packet type), with expected bytes
.lake/build/bin/packetgen path/to/protocol.json --size 3 --limit 500 > packets.jsonl
.lake/build/bin/packetgen path/to/protocol.json --report          # which packet types are covered

# differential test of node-minecraft-protocol (run `npm install` at the repo root first)
node harness/validate.js 1.21.4 --size 4 --limit 1000
```

Each output line has the form `{"state","direction","name","id","size","params","hex"}`. The `hex` field is the packet id varint followed by the params. For each packet, the harness:

1. serializes `params` with nmp and requires exactly `hex`;
2. parses `hex` with nmp and requires every byte to be consumed;
3. re-serializes the parsed value and requires `hex` again.

Corrupting the expected bytes makes almost every check fail (531 of 543 in a size-1 run). The 12 that still pass are packets with no fields, whose bytes are only the packet ID.

Other options: `--state`, `--direction`, `--packet`. `--limit 0` means no limit.

## Results so far (`--size 3 --limit 500`, every version in minecraft-data 3.117)

| versions | result |
| --- | --- |
| 1.7, 1.19 – 1.21.8 | all generated packets pass |
| 1.8 – 1.18.2, 26.1 | **`varlong` is serialized as a 32-bit varint.** nmp's `writeVarLong` calls `writeVarInt`, so `-1` comes out as `ffffffff0f` instead of `ffffffffffffffffff01`, values ≥ 2³¹ are truncated, and BigInt input throws. Affected packets include `world_border`, `initialize_world_border`, `world_border_lerp_size`, `multi_block_change`, `update_structure_block.seed` and `update_time.clockUpdates[].totalTicks` (26.1). |
| 1.21.9 – 26.1 | **`debug_{block,chunk,entity}_value` cannot round-trip.** `payload` is `option(switch → void)` (for example `type = VillageSections`). The bytes `…01` ("present, no data") parse to `payload: undefined`, which nmp writes back as `…00`. |

Coverage in 1.21.4: 185 of 237 packet types translate. The other 52 use natives that are not modelled yet: `anonymousNbt` (26), `registryEntryHolder` (11), `bitflags` (8), `anonOptionalNbt` (2), recursive types (2), `topBitSetTerminatedArray`, `registryEntryHolderSet` and `entityMetadataLoop`. Use `--report` to see them. These packets are skipped and reported; they are never silently approximated, so the theorem covers exactly the packets that are generated.

## Next steps

- Model the remaining natives listed above (NBT, registry holders, `bitflags`, entity metadata).
- Validate against the real game: feed the generated `hex` to a vanilla server or client (the approach of [mc-zuri/minecraft-packets-generator](https://github.com/mc-zuri/minecraft-packets-generator)) and keep the packets that decode and re-encode identically. That turns `protocol.json` itself into a tested artifact, not only the serializers.
- Prove the reference encoder's `decode ∘ encode = id` in Lean.

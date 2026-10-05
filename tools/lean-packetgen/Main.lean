import PacketGen

/-!
`packetgen <protocol.json> [options]`

Writes one JSON line per generated packet to stdout:
`{"state","direction","name","id","size","params","hex"}` where `hex` is the
expected wire encoding (packet id varint followed by the params).

Options:
* `--size N`        generate every valid packet of size 0..N (default 2)
* `--limit M`       stop a packet after M values (default 1000, 0 = no limit)
* `--state S`       only this state (handshaking, status, login, configuration, play)
* `--direction D`   only toClient / toServer
* `--packet P`      only this packet name
* `--report`        print the supported/unsupported table instead of packets
-/

open Lean (Json)
open PacketGen

structure Opts where
  file : String := ""
  size : Nat := 2
  limit : Nat := 1000
  state : Option String := none
  direction : Option String := none
  packet : Option String := none
  report : Bool := false

partial def parseArgs (o : Opts) : List String → Except String Opts
  | [] => pure o
  | "--size" :: n :: r => do parseArgs { o with size := ← (n.toNat?.elim (throw "--size") pure) } r
  | "--limit" :: n :: r => do parseArgs { o with limit := ← (n.toNat?.elim (throw "--limit") pure) } r
  | "--state" :: s :: r => parseArgs { o with state := some s } r
  | "--direction" :: s :: r => parseArgs { o with direction := some s } r
  | "--packet" :: s :: r => parseArgs { o with packet := some s } r
  | "--report" :: r => parseArgs { o with report := true } r
  | f :: r => if f.startsWith "--" then throw s!"unknown option {f}" else parseArgs { o with file := f } r

/-- `(id, name, params type)` for every packet of a state/direction -/
def packetsOf (types : Json) : Except String (List (Int × String × Json)) := do
  let pkt ← types.getObjVal? "packet"
  let fields ← (← pkt.getArrVal? 1).getArr?
  let mappings ← (← (← (← fields[0]!.getObjVal? "type").getArrVal? 1).getObjVal? "mappings").getObj?
  let sw ← (← (← (← fields[1]!.getObjVal? "type").getArrVal? 1).getObjVal? "fields").getObj?
  let mut out := []
  for (k, nameJ) in mappings.toList do
    let name ← nameJ.getStr?
    let some id := parseNumber k | throw s!"bad packet id {k}"
    let some t := sw.get? name | throw s!"no params type for {name}"
    out := out ++ [(id, name, t)]
  return out.mergeSort (fun a b => a.1 ≤ b.1)

def main (args : List String) : IO UInt32 := do
  let o ← IO.ofExcept (parseArgs {} args)
  if o.file == "" then
    IO.eprintln "usage: packetgen <protocol.json> [--size N] [--limit M] [--state S] [--direction D] [--packet P] [--report]"
    return 2
  let proto ← IO.ofExcept (Json.parse (← IO.FS.readFile o.file))
  let globalTypes := objPairs ((proto.getObjVal? "types").toOption.getD (.obj {}))
  let stdout ← IO.getStdout
  let mut supported := 0
  let mut unsupported := 0
  let mut emitted := 0
  for (state, sj) in objPairs proto do
    if state == "types" || o.state.any (· != state) then continue
    for dir in ["toClient", "toServer"] do
      if o.direction.any (· != dir) then continue
      let some dj := (sj.getObjVal? dir).toOption | continue
      let some tj := (dj.getObjVal? "types").toOption | continue
      let env := objPairs tj ++ globalTypes
      let pkts ← IO.ofExcept (packetsOf tj)
      for (id, name, tyJ) in pkts do
        if o.packet.any (· != name) then continue
        match toTy env 0 tyJ with
        | .error e =>
          unsupported := unsupported + 1
          if o.report then IO.println s!"SKIP {state} {dir} {name}: {e}"
        | .ok t =>
          supported := supported + 1
          if o.report then
            IO.println s!"OK   {state} {dir} {name}"
            continue
          let mut count := 0
          for n in List.range (o.size + 1) do
            if o.limit != 0 && count ≥ o.limit then break
            -- `LList.take k l = l.toList.take k` (`LList.take_eq`): a prefix of the
            -- complete enumeration, computed without forcing the rest
            let vs := if o.limit == 0 then (generate t n).toList else (generate t n).take (o.limit - count)
            for v in vs do
              count := count + 1
              let bytes := encodeInt .varint id ++ t.encode v
              let line := Json.mkObj [("state", .str state), ("direction", .str dir),
                ("name", .str name), ("id", Lean.toJson id), ("size", Lean.toJson n),
                ("params", t.toJson v), ("hex", .str (hexOf bytes))]
              stdout.putStrLn line.compress
          emitted := emitted + count
  IO.eprintln s!"packet types translated: {supported}, skipped (unsupported natives): {unsupported}, packets emitted: {emitted}"
  return 0

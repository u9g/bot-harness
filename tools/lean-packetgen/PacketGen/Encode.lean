import PacketGen.Spec

/-!
# Reference serializer

An independent implementation of protodef's wire format, used to attach the
expected bytes to every generated packet.  Integers are big-endian two's
complement, `varint`/`varlong` are LEB128 of the 32/64-bit two's complement,
strings are UTF-8 with a byte-length prefix, `option` is a bool byte followed by
the value, bitfields are packed most-significant field first.
-/

namespace PacketGen

/-- two's complement of `z` on `bits` bits, as a natural number -/
def twos (bits : Nat) (z : Int) : Nat := (z % (2 ^ bits : Nat)).toNat

def beBytes (w n : Nat) : List UInt8 :=
  (List.range w).reverse.map fun i => (n / 2 ^ (8 * i) % 256).toUInt8

def leb128 (n : Nat) : List UInt8 :=
  if n < 128 then [n.toUInt8] else (n % 128 + 128).toUInt8 :: leb128 (n / 128)
termination_by n
decreasing_by omega

def encodeInt : IntKind → Int → List UInt8
  | .varint, z => leb128 (twos 32 z)
  | .varlong, z => leb128 (twos 64 z)
  | .bits w _, z => beBytes ((w + 7) / 8) (twos w z)
  | k, z => beBytes k.width (twos (8 * k.width) z)

def utf8 (cp : Nat) : List UInt8 :=
  if cp < 0x80 then [cp.toUInt8]
  else if cp < 0x800 then [(0xC0 + cp / 64).toUInt8, (0x80 + cp % 64).toUInt8]
  else if cp < 0x10000 then
    [(0xE0 + cp / 4096).toUInt8, (0x80 + cp / 64 % 64).toUInt8, (0x80 + cp % 64).toUInt8]
  else
    [(0xF0 + cp / 262144).toUInt8, (0x80 + cp / 4096 % 64).toUInt8,
     (0x80 + cp / 64 % 64).toUInt8, (0x80 + cp % 64).toUInt8]

def Count.prefix : Count → Nat → List UInt8
  | .prefixed k, n => encodeInt k n
  | _, _ => []

def packBits : List (String × Nat × Bool) → List Val → Nat → Nat
  | (_, w, _) :: bs, v :: vs, acc => packBits bs vs (acc * 2 ^ w + twos w (valInt v))
  | _, _, acc => acc

mutual
def Ty.encode : Ty → Val → List UInt8
  | .bool, .bool b => [if b then 1 else 0]
  | .int k, .int z => encodeInt k z
  | .pstring c, .list vs =>
    c.prefix vs.utf8Len ++ vs.toList.flatMap fun v => utf8 (valInt v).toNat
  | .array c e, .list vs => c.prefix vs.length ++ vs.toList.flatMap fun v => e.encode v
  | .tuple _ e, .tuple vs => vs.toList.flatMap fun v => e.encode v
  | .bytes c, .list vs => c.prefix vs.length ++ vs.toList.map fun v => (twos 8 (valInt v)).toUInt8
  | .fixedBytes _, .tuple vs => vs.toList.map fun v => (twos 8 (valInt v)).toUInt8
  | .uuid, .tuple vs => vs.toList.map fun v => (twos 8 (valInt v)).toUInt8
  | .option _, .none => [0]
  | .option t, .some v => 1 :: t.encode v
  | .container fs, .tuple vs => fs.encode vs
  | .bitfield bs, .tuple vs =>
    let total := (bs.map fun b => b.2.1).sum
    beBytes (total / 8) (packBits bs vs.toList 0)
  | .switch _ cs d, .case i v => if i < cs.length then cs.encodeAt i v else d.encode v
  | .mapper k m, .case i _ => encodeInt k ((m[i]?.map (·.1)).getD 0)
  | _, _ => []
def Fields.encode : Fields → Vals → List UInt8
  | .cons _ _ t fs, .cons v vs => t.encode v ++ fs.encode vs
  | _, _ => []
def Cases.encodeAt : Cases → Nat → Val → List UInt8
  | .cons _ t _, 0, v => t.encode v
  | .cons _ _ r, i + 1, v => r.encodeAt i v
  | .nil, _, _ => []
end

def hexOf (bs : List UInt8) : String :=
  String.join (bs.map fun b =>
    let d := fun (n : Nat) => if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)
    String.ofList [d (b.toNat / 16), d (b.toNat % 16)])

end PacketGen

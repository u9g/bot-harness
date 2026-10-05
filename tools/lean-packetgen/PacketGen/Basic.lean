/-!
# The protodef type language, and packet values

This is a model of the subset of the [ProtoDef](https://github.com/ProtoDef-io/ProtoDef)
type language used by `minecraft-data`'s `protocol.json`.  A `Ty` describes the
shape of a packet (or any part of one) and a `Val` is a concrete packet value.

Every value has a natural-number `size`.  The size is what makes exhaustive
enumeration possible: for every type and every `n` there are only finitely many
values of size exactly `n`, so we can list them, and every value shows up when
`n` reaches its size.  Choices among finitely many alternatives (booleans,
switch branches, mapper names) cost nothing, so the smallest sizes already
contain every branch of every packet.
-/

namespace PacketGen

/-- Integer-like primitive encodings.  Floats are modelled by their IEEE-754 bit
pattern so that *every* bit pattern (including NaNs and subnormals) is a value. -/
inductive IntKind where
  | u8 | i8 | u16 | i16 | u32 | i32 | u64 | i64
  | varint | varlong
  | f32 | f64
  /-- a field of a `bitfield` -/
  | bits (width : Nat) (signed : Bool)
  deriving Repr, Inhabited, BEq

namespace IntKind

def lo : IntKind → Int
  | .i8 => -2 ^ 7
  | .i16 => -2 ^ 15
  | .i32 | .varint => -2 ^ 31
  | .i64 | .varlong => -2 ^ 63
  | .bits w true => -2 ^ (w - 1)
  | _ => 0

def hi : IntKind → Int
  | .u8 => 2 ^ 8 - 1
  | .i8 => 2 ^ 7 - 1
  | .u16 => 2 ^ 16 - 1
  | .i16 => 2 ^ 15 - 1
  | .u32 | .f32 => 2 ^ 32 - 1
  | .i32 | .varint => 2 ^ 31 - 1
  | .u64 | .f64 => 2 ^ 64 - 1
  | .i64 | .varlong => 2 ^ 63 - 1
  | .bits w false => 2 ^ w - 1
  | .bits w true => 2 ^ (w - 1) - 1

def inRange (k : IntKind) (z : Int) : Bool := decide (k.lo ≤ z) && decide (z ≤ k.hi)

/-- byte width of fixed-size kinds (`0` for variable-length ones) -/
def width : IntKind → Nat
  | .u8 | .i8 => 1
  | .u16 | .i16 => 2
  | .u32 | .i32 | .f32 => 4
  | .u64 | .i64 | .f64 => 8
  | _ => 0

end IntKind

/-- A Unicode scalar value: what a `pstring` is made of (UTF-8 cannot encode surrogates). -/
def isScalar (z : Int) : Bool :=
  decide (0 ≤ z) && (decide (z < 0xD800) || (decide (0xE000 ≤ z) && decide (z ≤ 0x10FFFF)))

/-- How the length of a variable-length sequence is known. -/
inductive Count where
  /-- length prefix of the given integer kind (`countType`) -/
  | prefixed (k : IntKind)
  /-- length stored in another field (`count: "fieldName"`) -/
  | field (path : String)
  /-- runs to the end of the packet (`restBuffer`) -/
  | rest
  deriving Repr, Inhabited

/-- Only the prefix range is a *local* constraint; field counts are checked by
`consistent` because they relate two different parts of a packet. -/
def Count.ok : Count → Nat → Bool
  | .prefixed k, n => k.inRange n
  | _, _ => true

/-- What a `switch` dispatches on. -/
inductive Selector where
  | path (p : String)
  | value (s : String)
  deriving Repr, Inhabited

mutual
inductive Ty where
  | void
  | bool
  | int (k : IntKind)
  /-- UTF-8 string; the count is the *byte* length -/
  | pstring (c : Count)
  | array (c : Count) (elem : Ty)
  /-- array with a constant element count -/
  | tuple (n : Nat) (elem : Ty)
  /-- byte buffer (`buffer`, `restBuffer`) -/
  | bytes (c : Count)
  /-- byte buffer of constant length -/
  | fixedBytes (n : Nat)
  | uuid
  | option (t : Ty)
  | container (fs : Fields)
  | bitfield (fs : List (String × Nat × Bool))
  | switch (on : Selector) (cs : Cases) (dflt : Ty)
  | mapper (k : IntKind) (m : List (Int × String))
inductive Fields where
  | nil
  | cons (name : String) (anon : Bool) (t : Ty) (rest : Fields)
inductive Cases where
  | nil
  | cons (key : String) (t : Ty) (rest : Cases)
end

instance : Inhabited Ty := ⟨.void⟩

def Cases.length : Cases → Nat
  | .nil => 0
  | .cons _ _ r => r.length + 1

mutual
inductive Val where
  | unit
  | bool (b : Bool)
  | int (z : Int)
  | none
  | some (v : Val)
  /-- variable-length sequence (arrays, strings as code points, buffers) -/
  | list (vs : Vals)
  /-- fixed-shape sequence (containers, bitfields, fixed arrays, UUIDs) -/
  | tuple (vs : Vals)
  /-- the `i`-th alternative of a switch / mapper -/
  | case (i : Nat) (v : Val)
inductive Vals where
  | nil
  | cons (v : Val) (rest : Vals)
end

instance : Inhabited Val := ⟨.unit⟩

def Vals.length : Vals → Nat
  | .nil => 0
  | .cons _ r => r.length + 1

def Vals.toList : Vals → List Val
  | .nil => []
  | .cons v r => v :: r.toList

/-- Zig-zag size of an integer: 0, -1, 1, -2, 2, ... get sizes 0, 1, 2, 3, 4, ... -/
def zig (z : Int) : Nat := if 0 ≤ z then 2 * z.toNat else 2 * (-z).toNat - 1

def unzig (n : Nat) : Int := if n % 2 = 0 then (n / 2 : Nat) else -(((n + 1) / 2 : Nat) : Int)

theorem unzig_zig (z : Int) : unzig (zig z) = z := by
  unfold zig unzig
  split <;> split <;> omega

mutual
/-- The size of a value: integers by magnitude, sequences by length plus element
sizes.  Finite choices (booleans, switch branches, mapper entries) are free. -/
def Val.size : Val → Nat
  | .unit => 0
  | .bool _ => 0
  | .int z => zig z
  | .none => 0
  | .some v => v.size + 1
  | .list vs => vs.lsize
  | .tuple vs => vs.tsize
  | .case _ v => v.size
/-- size of a variable-length sequence: each element costs one extra -/
def Vals.lsize : Vals → Nat
  | .nil => 0
  | .cons v r => v.size + r.lsize + 1
/-- size of a fixed-shape sequence -/
def Vals.tsize : Vals → Nat
  | .nil => 0
  | .cons v r => v.size + r.tsize
end

def valInt : Val → Int
  | .int z => z
  | _ => 0

/-- number of bytes needed to UTF-8 encode a code point -/
def utf8Len (cp : Int) : Nat :=
  if cp < 0x80 then 1 else if cp < 0x800 then 2 else if cp < 0x10000 then 3 else 4

def Vals.utf8Len : Vals → Nat
  | .nil => 0
  | .cons (.int cp) r => PacketGen.utf8Len cp + r.utf8Len
  | .cons _ r => r.utf8Len

end PacketGen

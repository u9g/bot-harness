import PacketGen.Finite

/-!
# Default samples

Numbers take `0, 1, -1` (floats: `0.0, 1.0, -1.0`), strings take `""`, `"a"`,
`"ab"` and 10 characters, buffers and arrays have length 0, 1, 2 (buffers
also 10).  A field compared by a `switch` also takes every case label, and a
field used as an array count also takes `2`, so every branch and every sampled
array length stays reachable.  Values out of a field's range are dropped by
the type check.
-/

namespace PacketGen

-- labels of every switch, keyed by the last segment of its `compareTo` path
mutual
def Ty.labels : Ty → List (String × Key)
  | .array _ e => e.labels
  | .tuple _ e => e.labels
  | .option t => t.labels
  | .container fs => fs.labels
  | .switch on cs d =>
    let mine := match on with
      | .path p => (cs.keys.map fun k => ((p.splitOn "/").getLast!, Key.ofCaseLabel k))
      | .value _ => []
    mine ++ cs.labels ++ d.labels
  | _ => []
def Fields.labels : Fields → List (String × Key)
  | .nil => []
  | .cons _ _ t r => t.labels ++ r.labels
def Cases.labels : Cases → List (String × Key)
  | .nil => []
  | .cons _ t r => t.labels ++ r.labels
def Cases.keys : Cases → List String
  | .nil => []
  | .cons k _ r => k :: r.keys
end

def Count.fieldName : Count → List String
  | .field p => [(p.splitOn "/").getLast!]
  | _ => []

-- names of fields used as array / string / buffer counts
mutual
def Ty.countFields : Ty → List String
  | .array c e => c.fieldName ++ e.countFields
  | .pstring c | .bytes c => c.fieldName
  | .tuple _ e => e.countFields
  | .option t => t.countFields
  | .container fs => fs.countFields
  | .switch _ cs d => cs.countFields ++ d.countFields
  | _ => []
def Fields.countFields : Fields → List String
  | .nil => []
  | .cons _ _ t r => t.countFields ++ r.countFields
def Cases.countFields : Cases → List String
  | .nil => []
  | .cons _ t r => t.countFields ++ r.countFields
end

def strCodes (s : String) : List Int := s.toList.map fun c => (c.toNat : Int)

def baseInts : IntKind → List Int
  | .f32 => [0, 0x3F800000, 0xBF800000]
  | .f64 => [0, 0x3FF0000000000000, 0xBFF0000000000000]
  | _ => [0, 1, -1]

def defaultSamples (t : Ty) (base : IntKind → List Int := baseInts) : Samples :=
  let labels := t.labels
  let counts := t.countFields
  { ints := fun name k =>
      let ls := labels.filterMap fun (n, key) => if n == name then (match key with
        | .num z => some z
        | _ => none) else none
      let cs : List Int := if counts.contains name then [2] else []
      (base k ++ cs ++ ls).eraseDups
    strs := fun name =>
      let ls := labels.filterMap fun (n, key) => if n == name then (match key with
        | .str s => some (strCodes s)
        | _ => none) else none
      ([strCodes "", strCodes "a", strCodes "ab", strCodes "abcdefghij"] ++ ls).eraseDups
    bytes := [[], [1], [1, 2], (List.range 10).map fun i => ((i : Nat) : Int)]
    fixedBytes := fun n => [List.replicate n 0, (List.range n).map fun i => ((i % 256 : Nat) : Int)]
    lens := [0, 1, 2] }

end PacketGen

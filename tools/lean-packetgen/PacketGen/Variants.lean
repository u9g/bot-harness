import PacketGen.DefaultSamples

/-!
# Single-field variants

When a packet type has too many combinations to enumerate completely, the fair
prefix printed under `--limit` covers every branch but not every value of every
field.  `variants S t v` adds, for one packet `v`, every packet that differs from
it in one primitive field, with that field set to each of its samples.
Candidates are kept only if they pass the same checks as `enumerate`
(`variants_valid`), so every emitted packet is still valid and in the sample
domain.  Unlike `enumerate`, this is a coverage aid, not a completeness claim.
-/

namespace PacketGen

/-- all ways to replace one element of `vs` using `f` -/
def replaceOne (f : Val → List Val) : Vals → List Vals
  | .nil => []
  | .cons v r => (f v).map (fun w => .cons w r) ++ (replaceOne f r).map (.cons v)

mutual
def Ty.vary (S : Samples) (name : String) : Ty → Val → List Val
  | .bool, _ => [.bool false, .bool true]
  | .int k, _ => (S.ints name k).map .int
  | .pstring _, _ => (S.strs name).map fun s => .list (mkInts s)
  | .bytes _, _ => S.bytes.map fun s => .list (mkInts s)
  | .fixedBytes n, _ => (S.fixedBytes n).map fun s => .tuple (mkInts s)
  | .uuid, _ => (S.fixedBytes 16).map fun s => .tuple (mkInts s)
  | .bitfield bs, _ => (cartesian (bitSamples S bs)).map fun s => .tuple (mkInts s)
  | .mapper _ m, _ => (List.range m.length).map fun i => .case i .unit
  | .option t, .some v => .none :: (t.vary S name v).map .some
  | .array _ e, .list vs => (replaceOne (fun v => e.vary S name v) vs).map .list
  | .tuple _ e, .tuple vs => (replaceOne (fun v => e.vary S name v) vs).map .tuple
  | .container fs, .tuple vs => (fs.vary S vs).map .tuple
  | .switch _ cs d, .case i v =>
    (if i < cs.length then cs.varyAt S name i v else d.vary S name v).map (.case i)
  | _, _ => []
def Fields.vary (S : Samples) : Fields → Vals → List Vals
  | .cons n _ t fs, .cons v vs =>
    (t.vary S n v).map (fun w => .cons w vs) ++ (fs.vary S vs).map (.cons v)
  | _, _ => []
def Cases.varyAt (S : Samples) (name : String) : Cases → Nat → Val → List Val
  | .cons _ t _, 0, v => t.vary S name v
  | .cons _ _ r, i + 1, v => r.varyAt S name i v
  | .nil, _, _ => []
end

def variants (S : Samples) (t : Ty) (v : Val) : List Val :=
  (t.vary S "" v).filter fun w => t.dgen.check [] w && t.dom S "" w

/-- every variant is a valid packet in the sample domain -/
theorem variants_valid (S : Samples) (t : Ty) (v w : Val) (h : w ∈ variants S t v) :
    Valid t w ∧ t.dom S "" w = true := by
  simp only [variants, List.mem_filter, Bool.and_eq_true] at h
  exact h.2

end PacketGen

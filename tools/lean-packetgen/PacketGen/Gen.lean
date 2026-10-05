import PacketGen.Basic
import PacketGen.LList

/-!
# Exact enumerators

A `Gen` pairs an enumerator (all candidate values of a given size, as a lazy
list) with a validity check.  `Gen.Exact g` says the enumerator is *exactly*
right:

    v ∈ (g.enum n).toList  ↔  g.check v ∧ v.size = n

i.e. it is **sound** (it only lists valid values of size `n`) and **complete**
(it lists every valid value of size `n`).  Every combinator below preserves
`Exact`, so a generator assembled from them is exact by construction.
-/

namespace PacketGen

structure Gen where
  enum : Nat → LList Val
  check : Val → Bool

namespace Gen

def Exact (g : Gen) : Prop := ∀ v n, v ∈ (g.enum n).toList ↔ (g.check v = true ∧ v.size = n)

/-! ## Atoms -/

def unit : Gen where
  enum n := .ofList (if n = 0 then [.unit] else [])
  check | .unit => true | _ => false

theorem unit_exact : unit.Exact := by
  intro v n
  cases v <;> simp [unit, Val.size] <;> omega

def bool : Gen where
  enum n := .ofList (if n = 0 then [.bool false, .bool true] else [])
  check | .bool _ => true | _ => false

theorem bool_exact : bool.Exact := by
  intro v n
  cases v with
  | bool b => cases b <;> simp [bool, Val.size] <;> omega
  | _ => simp [bool, Val.size]

theorem zig_unzig (n : Nat) : zig (unzig n) = n := by
  unfold zig unzig
  split <;> split <;> omega

/-- integers satisfying `ok`, enumerated in zig-zag order 0, -1, 1, -2, 2, … -/
def ints (ok : Int → Bool) : Gen where
  enum n := .ofList (if ok (unzig n) then [.int (unzig n)] else [])
  check | .int z => ok z | _ => false

theorem ints_exact (ok : Int → Bool) : (ints ok).Exact := by
  intro v n
  cases v with
  | int z =>
    simp only [ints, Val.size, LList.toList_ofList]
    constructor
    · intro h
      split at h
      · simp at h; subst h; exact ⟨by assumption, zig_unzig n⟩
      · simp at h
    · rintro ⟨hz, rfl⟩
      rw [unzig_zig]; simp [hz]
  | _ => simp only [ints, LList.toList_ofList]; constructor <;> intro h <;> (try split at h) <;> simp_all

def int (k : IntKind) : Gen := ints k.inRange
def char : Gen := ints isScalar

/-- the `i`-th of `len` named constants (a `mapper`) -/
def mapper (len : Nat) : Gen where
  enum n := .ofList (if n = 0 then (List.range len).map fun i => .case i .unit else [])
  check | .case i .unit => decide (i < len) | _ => false

theorem mapper_exact (len : Nat) : (mapper len).Exact := by
  intro v n
  cases v with
  | case i v =>
    cases v <;> simp [mapper, Val.size] <;> omega
  | _ => simp [mapper]

/-! ## Option -/

def option (g : Gen) : Gen where
  enum
    | 0 => .ofList [.none]
    | n + 1 => (g.enum n).map .some
  check
    | .none => true
    | .some v => g.check v
    | _ => false

theorem option_exact (g : Gen) (hg : g.Exact) : (option g).Exact := by
  intro v n
  cases n <;> cases v <;> simp [option, Val.size, hg _ _]

/-! ## Variable-length sequences -/

def allVals (p : Val → Bool) : Vals → Bool
  | .nil => true
  | .cons v r => p v && allVals p r

/-- all sequences of total `lsize` exactly `n` whose elements come from `f` -/
def enumList (f : Nat → LList Val) : Nat → LList Vals
  | 0 => .ofList [.nil]
  | n + 1 => (LList.ofList (List.range (n + 1))).flatMap fun i =>
      (f i).flatMap fun h => (enumList f (n - i)).map (Vals.cons h)
termination_by n => n
decreasing_by omega

theorem enumList_exact (f : Nat → LList Val) (p : Val → Bool)
    (hf : ∀ v n, v ∈ (f n).toList ↔ (p v = true ∧ v.size = n)) :
    ∀ vs n, vs ∈ (enumList f n).toList ↔ (allVals p vs = true ∧ vs.lsize = n)
  | .nil, 0 => by simp [enumList, allVals, Vals.lsize]
  | .nil, n + 1 => by simp [enumList, allVals, Vals.lsize]
  | .cons h t, 0 => by simp [enumList, Vals.lsize]
  | .cons h t, n + 1 => by
      have ih := enumList_exact f p hf t
      rw [enumList]
      simp only [LList.toList_flatMap, LList.toList_map, LList.toList_ofList, List.mem_flatMap,
        List.mem_range, List.mem_map, Vals.cons.injEq, allVals, Vals.lsize, Bool.and_eq_true]
      constructor
      · rintro ⟨i, hi, h', hh', t', ht', rfl, rfl⟩
        have h1 := (hf _ _).1 hh'
        have h2 := (ih _).1 ht'
        exact ⟨⟨h1.1, h2.1⟩, by omega⟩
      · rintro ⟨⟨hp, ha⟩, hs⟩
        exact ⟨h.size, by omega, h, (hf _ _).2 ⟨hp, rfl⟩, t, (ih _).2 ⟨ha, by omega⟩, rfl, rfl⟩

/-- variable-length sequences of `g`, restricted by a length/content condition `ok` -/
def list (ok : Vals → Bool) (g : Gen) : Gen where
  enum n := ((enumList g.enum n).filter ok).map .list
  check
    | .list vs => allVals g.check vs && ok vs
    | _ => false

theorem list_exact (ok : Vals → Bool) (g : Gen) (hg : g.Exact) : (list ok g).Exact := by
  intro v n
  cases v with
  | list vs =>
    have := enumList_exact g.enum g.check hg vs n
    simp only [list, LList.toList_map, LList.toList_filter, List.mem_map, List.mem_filter,
      Val.list.injEq, Val.size, Bool.and_eq_true]
    constructor
    · rintro ⟨vs', ⟨h1, h2⟩, rfl⟩
      have := (enumList_exact g.enum g.check hg vs' n).1 h1
      exact ⟨⟨this.1, h2⟩, this.2⟩
    · rintro ⟨⟨h1, h2⟩, h3⟩
      exact ⟨vs, ⟨this.2 ⟨h1, h3⟩, h2⟩, rfl⟩
  | _ => simp [list]

/-! ## Fixed-shape sequences (heterogeneous products) -/

def enumHet : List Gen → Nat → LList Vals
  | [], n => .ofList (if n = 0 then [.nil] else [])
  | g :: gs, n => (LList.ofList (List.range (n + 1))).flatMap fun i =>
      (g.enum i).flatMap fun h => (enumHet gs (n - i)).map (Vals.cons h)

def checkHet : List Gen → Vals → Bool
  | [], .nil => true
  | g :: gs, .cons v r => g.check v && checkHet gs r
  | _, _ => false

theorem enumHet_exact (gs : List Gen) (hgs : ∀ g ∈ gs, g.Exact) :
    ∀ vs n, vs ∈ (enumHet gs n).toList ↔ (checkHet gs vs = true ∧ vs.tsize = n) := by
  induction gs with
  | nil =>
    intro vs n
    cases vs <;> simp [enumHet, checkHet, Vals.tsize]
    omega
  | cons g gs ih =>
    have hg : g.Exact := hgs g (by simp)
    have ih := ih (fun g' h => hgs g' (by simp [h]))
    intro vs n
    cases vs with
    | nil => simp [enumHet, checkHet]
    | cons h t =>
      simp only [enumHet, LList.toList_flatMap, LList.toList_map, LList.toList_ofList,
        List.mem_flatMap, List.mem_range, List.mem_map, Vals.cons.injEq, checkHet, Vals.tsize,
        Bool.and_eq_true]
      constructor
      · rintro ⟨i, hi, h', hh', t', ht', rfl, rfl⟩
        have h1 := (hg _ _).1 hh'
        have h2 := (ih _ _).1 ht'
        exact ⟨⟨h1.1, h2.1⟩, by omega⟩
      · rintro ⟨⟨hp, ha⟩, hs⟩
        exact ⟨h.size, by omega, h, (hg _ _).2 ⟨hp, rfl⟩, t, (ih _ _).2 ⟨ha, by omega⟩, rfl, rfl⟩

/-- a fixed sequence of fields, one value from each generator -/
def prod (gs : List Gen) : Gen where
  enum n := (enumHet gs n).map .tuple
  check
    | .tuple vs => checkHet gs vs
    | _ => false

theorem prod_exact (gs : List Gen) (hgs : ∀ g ∈ gs, g.Exact) : (prod gs).Exact := by
  intro v n
  cases v with
  | tuple vs =>
    simp only [prod, LList.toList_map, List.mem_map, Val.tuple.injEq, Val.size]
    constructor
    · rintro ⟨vs', h, rfl⟩; exact (enumHet_exact gs hgs _ _).1 h
    · intro h; exact ⟨vs, (enumHet_exact gs hgs _ _).2 h, rfl⟩
  | _ => simp [prod]

end Gen
end PacketGen

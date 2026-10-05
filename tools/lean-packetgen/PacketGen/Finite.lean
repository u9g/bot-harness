import PacketGen.Spec

/-!
# Finite enumeration over sample values

Instead of every integer and every string, each primitive field takes a few
representative values (`Samples`): e.g. `0, 1, -1` for numbers, `""`, `"a"`,
`"ab"` and a 10-character string for strings, arrays of length 0, 1, 2.
Samples are chosen per field name, so a field that a `switch` compares gets the
switch's case labels too and every branch stays reachable.

With finitely many choices per primitive the set of packets is finite, and
`enumerate S t` lists it.  The main theorem `mem_enumerate` says it lists
exactly the packets that are valid (`Valid t v`, same definition as the
size-ordered generator) and whose primitives come from the samples
(`t.dom S v`).
-/

namespace PacketGen

/-- Representative values for primitive fields.  Integer-like fields (including
floats as bit patterns and bitfield members) and strings are sampled per field
name; strings and byte buffers are given as lists of code points / bytes. -/
structure Samples where
  ints : String → IntKind → List Int
  strs : String → List (List Int)
  bytes : List (List Int)
  fixedBytes : Nat → List (List Int)
  lens : List Nat

def codes (vs : Vals) : List Int := vs.toList.map valInt

def mkInts : List Int → Vals
  | [] => .nil
  | z :: zs => .cons (.int z) (mkInts zs)

theorem codes_mkInts (l : List Int) : codes (mkInts l) = l := by
  induction l with
  | nil => rfl
  | cons z zs ih => simp [codes, mkInts, Vals.toList, valInt] at *; exact ih

def isInt : Val → Bool
  | .int _ => true
  | _ => false

theorem mkInts_codes : ∀ vs : Vals, Gen.allVals isInt vs = true → mkInts (codes vs) = vs
  | .nil, _ => rfl
  | .cons v r, h => by
    simp only [Gen.allVals, Bool.and_eq_true] at h
    have ih := mkInts_codes r h.2
    cases v <;> simp [isInt] at h
    simp only [codes, Vals.toList, List.map, valInt, mkInts] at ih ⊢
    rw [ih]

theorem allVals_iff (p : Val → Bool) : ∀ vs : Vals, Gen.allVals p vs = true ↔ ∀ v ∈ vs.toList, p v = true
  | .nil => by simp [Gen.allVals, Vals.toList]
  | .cons v r => by simp [Gen.allVals, Vals.toList, allVals_iff p r]

theorem allVals_mono (p q : Val → Bool) (h : ∀ v, p v = true → q v = true) (vs : Vals) :
    Gen.allVals p vs = true → Gen.allVals q vs = true := by
  rw [allVals_iff, allVals_iff]; intro hp v hv; exact h v (hp v hv)

theorem checkHet_replicate (g : Gen) : ∀ (n : Nat) (vs : Vals),
    Gen.checkHet (List.replicate n g) vs = true ↔ (vs.length = n ∧ Gen.allVals g.check vs = true)
  | 0, .nil => by simp [Gen.checkHet, Vals.length, Gen.allVals]
  | 0, .cons _ _ => by simp [Gen.checkHet, Vals.length]
  | n + 1, .nil => by simp [Gen.checkHet, Vals.length]
  | n + 1, .cons v r => by
    simp [List.replicate, Gen.checkHet, Vals.length, Gen.allVals, checkHet_replicate g n r]
    constructor <;> intro h <;> exact ⟨h.2.1, h.1, h.2.2⟩ <;> rfl

theorem bits_isInt : ∀ (bs : List (String × Nat × Bool)) (vs : Vals),
    Gen.checkHet (bs.map fun b => Gen.int (.bits b.2.1 b.2.2)) vs = true → Gen.allVals isInt vs = true
  | [], .nil, _ => rfl
  | [], .cons _ _, h => by simp [Gen.checkHet] at h
  | _ :: _, .nil, _ => rfl
  | b :: bs, .cons w r, h => by
    simp only [List.map, Gen.checkHet, Bool.and_eq_true] at h
    simp only [Gen.allVals, Bool.and_eq_true]
    exact ⟨by cases w <;> simp_all [Gen.int, Gen.ints, isInt], bits_isInt bs r h.2⟩

/-! ## Sequences of a given length -/

def pow (xs : Unit → LList Val) : Nat → LList Vals
  | 0 => .ofList [.nil]
  | k + 1 => (xs ()).flatMap fun h => (pow xs k).map (Vals.cons h)

theorem mem_pow (xs : Unit → LList Val) : ∀ (k : Nat) (vs : Vals),
    vs ∈ (pow xs k).toList ↔ (vs.length = k ∧ ∀ v ∈ vs.toList, v ∈ (xs ()).toList)
  | 0, .nil => by simp [pow, Vals.length, Vals.toList]
  | 0, .cons _ _ => by simp [pow, Vals.length]
  | k + 1, .nil => by simp [pow, Vals.length]
  | k + 1, .cons v r => by
    simp only [pow, LList.toList_flatMap, LList.toList_map, List.mem_flatMap, List.mem_map,
      Vals.cons.injEq, Vals.length, Vals.toList, List.mem_cons, forall_eq_or_imp]
    constructor
    · rintro ⟨h, hh, r', hr', rfl, rfl⟩
      have := (mem_pow xs k r').1 hr'
      exact ⟨by omega, hh, this.2⟩
    · rintro ⟨hl, hv, hr⟩
      exact ⟨v, hv, r, (mem_pow xs k r).2 ⟨by omega, hr⟩, rfl, rfl⟩

/-! ## The domain and the enumerator -/

/-- bitfield members' samples, as one list per member -/
def bitSamples (S : Samples) (bs : List (String × Nat × Bool)) : List (List Int) :=
  bs.map fun (n, w, s) => S.ints n (.bits w s)

def cartesian : List (List Int) → List (List Int)
  | [] => [[]]
  | l :: ls => l.flatMap fun z => (cartesian ls).map (z :: ·)

mutual
/-- `t.dom S name v`: every primitive inside `v` is one of its samples
(`name` is the enclosing field's name). -/
def Ty.dom (S : Samples) (name : String) : Ty → Val → Bool
  | .int k, .int z => (S.ints name k).contains z
  | .pstring _, .list vs => (S.strs name).contains (codes vs)
  | .bytes _, .list vs => S.bytes.contains (codes vs)
  | .fixedBytes n, .tuple vs => (S.fixedBytes n).contains (codes vs)
  | .uuid, .tuple vs => (S.fixedBytes 16).contains (codes vs)
  | .bitfield bs, .tuple vs => (cartesian (bitSamples S bs)).contains (codes vs)
  | .array _ e, .list vs => S.lens.contains vs.length && Gen.allVals (fun v => e.dom S name v) vs
  | .tuple _ e, .tuple vs => Gen.allVals (fun v => e.dom S name v) vs
  | .option t, .some v => t.dom S name v
  | .container fs, .tuple vs => fs.dom S vs
  | .switch _ cs d, .case i v => if i < cs.length then cs.domAt S name i v else d.dom S name v
  | _, _ => true
def Fields.dom (S : Samples) : Fields → Vals → Bool
  | .cons n _ t fs, .cons v vs => t.dom S n v && fs.dom S vs
  | _, _ => true
def Cases.domAt (S : Samples) (name : String) : Cases → Nat → Val → Bool
  | .cons _ t _, 0, v => t.dom S name v
  | .cons _ _ r, i + 1, v => r.domAt S name i v
  | .nil, _, _ => true
end

/-- keep the candidates `t` accepts in `env` -/
def keep (t : Ty) (env : Env) (l : LList Val) : LList Val := l.filter (t.dgen.check env)

mutual
def Ty.fall (S : Samples) (name : String) : Ty → Env → LList Val
  | .void, env => keep .void env (.ofList [.unit])
  | .bool, env => keep .bool env (.ofList [.bool false, .bool true])
  | .int k, env => keep (.int k) env (.ofList ((S.ints name k).map .int))
  | .pstring c, env => keep (.pstring c) env (.ofList ((S.strs name).map fun s => .list (mkInts s)))
  | .bytes c, env => keep (.bytes c) env (.ofList (S.bytes.map fun s => .list (mkInts s)))
  | .fixedBytes n, env =>
    keep (.fixedBytes n) env (.ofList ((S.fixedBytes n).map fun s => .tuple (mkInts s)))
  | .uuid, env => keep .uuid env (.ofList ((S.fixedBytes 16).map fun s => .tuple (mkInts s)))
  | .bitfield bs, env =>
    keep (.bitfield bs) env (.ofList ((cartesian (bitSamples S bs)).map fun s => .tuple (mkInts s)))
  | .mapper k m, env => keep (.mapper k m) env (.ofList ((List.range m.length).map fun i => .case i .unit))
  | .array c e, env => keep (.array c e) env
      ((LList.ofList (S.lens.filter (c.okIn env))).fairFlatMap fun k => (pow (fun _ => e.fall S name env) k).map .list)
  | .tuple n e, env => keep (.tuple n e) env ((pow (fun _ => e.fall S name env) n).map .tuple)
  | .option t, env => keep (.option t) env (.cons .none fun _ => (t.fall S name env).map .some)
  | .container fs, env => keep (.container fs) env ((fs.fall S env []).map .tuple)
  | .switch on cs d, env =>
    let i := cs.select (on.key env)
    keep (.switch on cs d) env
      (if i < cs.length then (cs.fallAt S name i env).map (.case i) else (d.fall S name env).map (.case i))
def Fields.fall (S : Samples) : Fields → Env → Scope → LList Vals
  | .nil, _, _ => .ofList [.nil]
  | .cons n a t fs, env, sc => (t.fall S n (sc :: env)).fairFlatMap fun h =>
      (fs.fall S env (sc ++ [(n, a, t, h)])).map (Vals.cons h)
def Cases.fallAt (S : Samples) (name : String) : Cases → Nat → Env → LList Val
  | .cons _ t _, 0, env => t.fall S name env
  | .cons _ _ r, i + 1, env => r.fallAt S name i env
  | .nil, _, _ => .nil
end

/-! ## Proofs -/

theorem mem_keep (t : Ty) (env : Env) (l : LList Val) (v : Val) :
    v ∈ (keep t env l).toList ↔ (v ∈ l.toList ∧ t.dgen.check env v = true) := by
  simp [keep]

/-- the `i`-th case's check, as `DGen.select` sees it -/
def Cases.checkAt (cs : Cases) (i : Nat) (env : Env) (v : Val) : Bool :=
  match cs.dgens[i]? with
  | some g => g.check env v
  | none => false

theorem Cases.dgens_length : ∀ cs : Cases, cs.dgens.length = cs.length
  | .nil => rfl
  | .cons _ _ r => by simp [Cases.dgens, Cases.length, Cases.dgens_length r]

/-- How the switch check decomposes. -/
theorem switch_check (on : Selector) (cs : Cases) (d : Ty) (env : Env) (i : Nat) (v : Val) :
    (Ty.switch on cs d).dgen.check env (.case i v) = true ↔
      (i = cs.select (on.key env) ∧
        (if i < cs.length then cs.checkAt i env v = true
         else i = cs.length ∧ d.dgen.check env v = true)) := by
  rw [Ty.dgen]
  simp only [DGen.select, Bool.and_eq_true, beq_iff_eq]
  constructor
  · rintro ⟨rfl, h⟩
    refine ⟨rfl, ?_⟩
    split
    · rename_i hi
      unfold Cases.checkAt
      rw [List.getElem?_append_left (by rw [Cases.dgens_length]; exact hi)] at h
      exact h
    · rename_i hi
      have hlen := Cases.dgens_length cs
      cases hx : (cs.dgens ++ [d.dgen])[cs.select (on.key env)]? with
      | none => rw [hx] at h; simp at h
      | some g =>
        rw [hx] at h
        have hj : cs.select (on.key env) = cs.length := by
          have := (List.getElem?_eq_some_iff.1 hx).1
          simp at this; omega
        refine ⟨hj, ?_⟩
        rw [hj, List.getElem?_append_right (by omega)] at hx
        simp [hlen] at hx
        subst hx; simpa using h
  · rintro ⟨rfl, h⟩
    refine ⟨rfl, ?_⟩
    split at h
    · rename_i hi
      unfold Cases.checkAt at h
      rw [List.getElem?_append_left (by rw [Cases.dgens_length]; exact hi)]
      exact h
    · obtain ⟨hj, h⟩ := h
      rw [hj, List.getElem?_append_right (by rw [Cases.dgens_length]; exact Nat.le_refl _), Cases.dgens_length]
      simp [h]

mutual
/-- Every enumerated value is in the sample domain. -/
theorem Ty.fall_dom (S : Samples) (name : String) :
    ∀ (t : Ty) (env : Env) (v : Val), v ∈ (t.fall S name env).toList → t.dom S name v = true
  | .void, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h; rw [h.1]; rfl
  | .bool, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h; rcases h.1 with rfl | rfl <;> rfl
  | .int k, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h
      obtain ⟨⟨z, hz, rfl⟩, -⟩ := h
      simp [Ty.dom, hz]
  | .pstring c, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h
      obtain ⟨⟨s, hs, rfl⟩, -⟩ := h
      simp [Ty.dom, codes_mkInts, hs]
  | .bytes c, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h
      obtain ⟨⟨s, hs, rfl⟩, -⟩ := h
      simp [Ty.dom, codes_mkInts, hs]
  | .fixedBytes n, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h
      obtain ⟨⟨s, hs, rfl⟩, -⟩ := h
      simp [Ty.dom, codes_mkInts, hs]
  | .uuid, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h
      obtain ⟨⟨s, hs, rfl⟩, -⟩ := h
      simp [Ty.dom, codes_mkInts, hs]
  | .bitfield bs, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h
      obtain ⟨⟨s, hs, rfl⟩, -⟩ := h
      simp [Ty.dom, codes_mkInts, hs]
  | .mapper k m, env, v, h => by
      rw [Ty.fall, mem_keep] at h; simp at h
      obtain ⟨⟨i, -, rfl⟩, -⟩ := h
      rfl
  | .array c e, env, v, h => by
      rw [Ty.fall, mem_keep] at h
      simp only [LList.mem_fairFlatMap, LList.toList_map, LList.toList_ofList,
        List.mem_map] at h
      obtain ⟨⟨k, hk, vs, hvs, rfl⟩, -⟩ := h
      rw [List.mem_filter] at hk
      replace hk := hk.1
      rw [mem_pow] at hvs
      obtain ⟨rfl, hall⟩ := hvs
      simp only [Ty.dom, Bool.and_eq_true, List.contains_iff_mem]
      exact ⟨hk, (allVals_iff _ _).2 fun w hw => Ty.fall_dom S name e env w (hall w hw)⟩
  | .tuple n e, env, v, h => by
      rw [Ty.fall, mem_keep] at h
      simp only [LList.toList_map, List.mem_map] at h
      obtain ⟨⟨vs, hvs, rfl⟩, -⟩ := h
      rw [mem_pow] at hvs
      simp only [Ty.dom]
      exact (allVals_iff _ _).2 fun w hw => Ty.fall_dom S name e env w (hvs.2 w hw)
  | .option t, env, v, h => by
      rw [Ty.fall, mem_keep] at h
      simp only [LList.toList_cons, LList.toList_map, List.mem_cons, List.mem_map] at h
      rcases h.1 with rfl | ⟨w, hw, rfl⟩
      · rfl
      · simp only [Ty.dom]; exact Ty.fall_dom S name t env w hw
  | .container fs, env, v, h => by
      rw [Ty.fall, mem_keep] at h
      simp only [LList.toList_map, List.mem_map] at h
      obtain ⟨⟨vs, hvs, rfl⟩, -⟩ := h
      simp only [Ty.dom]
      exact Fields.fall_dom S fs env [] vs hvs
  | .switch on cs d, env, v, h => by
      rw [Ty.fall, mem_keep] at h
      obtain ⟨h, -⟩ := h
      split at h
      · rename_i hi
        simp only [LList.toList_map, List.mem_map] at h
        obtain ⟨w, hw, rfl⟩ := h
        simp only [Ty.dom, hi, ite_true]
        exact Cases.fallAt_dom S name cs _ env w hw
      · rename_i hi
        simp only [LList.toList_map, List.mem_map] at h
        obtain ⟨w, hw, rfl⟩ := h
        simp only [Ty.dom, hi, ite_false]
        exact Ty.fall_dom S name d env w hw
theorem Fields.fall_dom (S : Samples) :
    ∀ (fs : Fields) (env : Env) (sc : Scope) (vs : Vals), vs ∈ (fs.fall S env sc).toList → fs.dom S vs = true
  | .nil, env, sc, vs, h => by
      rw [Fields.fall] at h; simp at h; rw [h]; rfl
  | .cons n a t fs, env, sc, vs, h => by
      rw [Fields.fall] at h
      simp only [LList.mem_fairFlatMap, LList.toList_map, List.mem_map] at h
      obtain ⟨w, hw, ws, hws, rfl⟩ := h
      simp only [Fields.dom, Bool.and_eq_true]
      exact ⟨Ty.fall_dom S n t _ w hw, Fields.fall_dom S fs env _ ws hws⟩
theorem Cases.fallAt_dom (S : Samples) (name : String) :
    ∀ (cs : Cases) (i : Nat) (env : Env) (v : Val), v ∈ (cs.fallAt S name i env).toList → cs.domAt S name i v = true
  | .cons _ t _, 0, env, v, h => by
      rw [Cases.fallAt] at h; simp only [Cases.domAt]; exact Ty.fall_dom S name t env v h
  | .cons _ _ r, i + 1, env, v, h => by
      rw [Cases.fallAt] at h; simp only [Cases.domAt]; exact Cases.fallAt_dom S name r i env v h
  | .nil, _, env, v, h => by rw [Cases.fallAt] at h; simp at h
end

mutual
/-- Every valid value in the sample domain is enumerated. -/
theorem Ty.fall_complete (S : Samples) (name : String) :
    ∀ (t : Ty) (env : Env) (v : Val), t.dgen.check env v = true → t.dom S name v = true →
      v ∈ (t.fall S name env).toList
  | .void, env, v, hc, _ => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      rw [Ty.dgen] at hc; cases v <;> simp [DGen.lift, Gen.unit] at hc ⊢
  | .bool, env, v, hc, _ => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      rw [Ty.dgen] at hc
      cases v with
      | bool b => cases b <;> simp
      | _ => simp [DGen.lift, Gen.bool] at hc
  | .int k, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      rw [Ty.dgen] at hc
      cases v with
      | int z => simp [Ty.dom] at hd; simp [hd]
      | _ => simp [DGen.lift, Gen.int, Gen.ints] at hc
  | .pstring c, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | list vs =>
        simp only [DGen.list, DGen.lift, DGen.atEnv, Gen.list, Bool.and_eq_true] at hc'
        have hi : Gen.allVals isInt vs = true :=
          allVals_mono _ _ (fun w hw => by cases w <;> simp_all [Gen.char, Gen.ints, isInt]) vs hc'.1
        simp only [Ty.dom, List.contains_iff_mem] at hd
        simp only [LList.toList_ofList, List.mem_map]
        exact ⟨codes vs, hd, by rw [mkInts_codes vs hi]⟩
      | _ => simp [DGen.list, Gen.list] at hc'
  | .bytes c, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | list vs =>
        simp only [DGen.list, u8s, DGen.lift, DGen.atEnv, Gen.list, Bool.and_eq_true] at hc'
        have hi : Gen.allVals isInt vs = true :=
          allVals_mono _ _ (fun w hw => by cases w <;> simp_all [Gen.int, Gen.ints, isInt]) vs hc'.1
        simp only [Ty.dom, List.contains_iff_mem] at hd
        simp only [LList.toList_ofList, List.mem_map]
        exact ⟨codes vs, hd, by rw [mkInts_codes vs hi]⟩
      | _ => simp [DGen.list, Gen.list] at hc'
  | .fixedBytes n, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | tuple vs =>
        simp only [DGen.prod, Gen.prod, List.map_replicate, checkHet_replicate] at hc'
        have hi : Gen.allVals isInt vs = true :=
          allVals_mono _ _ (fun w hw => by
            cases w <;> simp_all [u8s, DGen.lift, DGen.atEnv, Gen.int, Gen.ints, isInt]) vs hc'.2
        simp only [Ty.dom, List.contains_iff_mem] at hd
        simp only [LList.toList_ofList, List.mem_map]
        exact ⟨codes vs, hd, by rw [mkInts_codes vs hi]⟩
      | _ => simp [DGen.prod, Gen.prod] at hc'
  | .uuid, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | tuple vs =>
        simp only [DGen.prod, Gen.prod, List.map_replicate, checkHet_replicate] at hc'
        have hi : Gen.allVals isInt vs = true :=
          allVals_mono _ _ (fun w hw => by
            cases w <;> simp_all [u8s, DGen.lift, DGen.atEnv, Gen.int, Gen.ints, isInt]) vs hc'.2
        simp only [Ty.dom, List.contains_iff_mem] at hd
        simp only [LList.toList_ofList, List.mem_map]
        exact ⟨codes vs, hd, by rw [mkInts_codes vs hi]⟩
      | _ => simp [DGen.prod, Gen.prod] at hc'
  | .bitfield bs, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | tuple vs =>
        simp only [DGen.lift, Gen.prod] at hc'
        have hi : Gen.allVals isInt vs = true := bits_isInt bs vs hc'
        simp only [Ty.dom, List.contains_iff_mem] at hd
        simp only [LList.toList_ofList, List.mem_map]
        exact ⟨codes vs, hd, by rw [mkInts_codes vs hi]⟩
      | _ => simp [DGen.lift, Gen.prod] at hc'
  | .mapper k m, env, v, hc, _ => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      rw [Ty.dgen] at hc
      cases v with
      | case i w =>
        cases w <;> simp_all [DGen.lift, Gen.mapper]
      | _ => simp [DGen.lift, Gen.mapper] at hc
  | .array c e, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | list vs =>
        simp only [DGen.list, DGen.atEnv, Gen.list, Bool.and_eq_true] at hc'
        simp only [Ty.dom, Bool.and_eq_true, List.contains_iff_mem] at hd
        simp only [LList.mem_fairFlatMap, LList.toList_map, LList.toList_ofList,
          List.mem_map, Val.list.injEq]
        refine ⟨vs.length, List.mem_filter.2 ⟨hd.1, hc'.2⟩, vs, (mem_pow _ _ _).2 ⟨rfl, fun w hw => ?_⟩, rfl⟩
        exact Ty.fall_complete S name e env w ((allVals_iff _ _).1 hc'.1 w hw)
          ((allVals_iff _ _).1 hd.2 w hw)
      | _ => simp [DGen.list, Gen.list] at hc'
  | .tuple n e, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | tuple vs =>
        simp only [DGen.prod, Gen.prod, List.map_replicate, checkHet_replicate] at hc'
        simp only [Ty.dom] at hd
        simp only [LList.toList_map, List.mem_map, Val.tuple.injEq]
        refine ⟨vs, (mem_pow _ _ _).2 ⟨hc'.1, fun w hw => ?_⟩, rfl⟩
        exact Ty.fall_complete S name e env w ((allVals_iff _ _).1 hc'.2 w hw)
          ((allVals_iff _ _).1 hd w hw)
      | _ => simp [DGen.prod, Gen.prod] at hc'
  | .option t, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | none => simp
      | some w =>
        simp only [DGen.option, DGen.atEnv, Gen.option] at hc'
        simp only [Ty.dom] at hd
        simp only [LList.toList_cons, LList.toList_map, List.mem_cons, List.mem_map, Val.some.injEq]
        exact Or.inr ⟨w, Ty.fall_complete S name t env w hc' hd, rfl⟩
      | _ => simp [DGen.option, Gen.option] at hc'
  | .container fs, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      have hc' := hc
      rw [Ty.dgen] at hc'
      cases v with
      | tuple vs =>
        simp only [DGen.fields] at hc'
        simp only [Ty.dom] at hd
        simp only [LList.toList_map, List.mem_map, Val.tuple.injEq]
        exact ⟨vs, Fields.fall_complete S fs env [] vs hc' hd, rfl⟩
      | _ => simp [DGen.fields] at hc'
  | .switch on cs d, env, v, hc, hd => by
      rw [Ty.fall, mem_keep]; refine ⟨?_, hc⟩
      cases v with
      | case i w =>
        obtain ⟨hi, h⟩ := (switch_check on cs d env i w).1 hc
        simp only [← hi]
        split
        · rename_i hlt
          simp only [hlt, ite_true] at h
          simp only [Ty.dom, hlt, ite_true] at hd
          simp only [LList.toList_map, List.mem_map, Val.case.injEq]
          exact ⟨w, Cases.fallAt_complete S name cs i env w hlt h hd, by simp⟩
        · rename_i hlt
          simp only [hlt, ite_false] at h
          simp only [Ty.dom, hlt, ite_false] at hd
          simp only [LList.toList_map, List.mem_map, Val.case.injEq]
          exact ⟨w, Ty.fall_complete S name d env w h.2 hd, by simp⟩
      | _ => rw [Ty.dgen] at hc; simp [DGen.select] at hc
theorem Fields.fall_complete (S : Samples) :
    ∀ (fs : Fields) (env : Env) (sc : Scope) (vs : Vals),
      DGen.checkFields fs.specs env sc vs = true → fs.dom S vs = true → vs ∈ (fs.fall S env sc).toList
  | .nil, env, sc, vs, hc, _ => by
      rw [Fields.fall]; cases vs <;> simp_all [Fields.specs, DGen.checkFields]
  | .cons n a t fs, env, sc, vs, hc, hd => by
      rw [Fields.fall]
      cases vs with
      | nil => simp [Fields.specs, DGen.checkFields] at hc
      | cons w ws =>
        simp only [Fields.specs, DGen.checkFields, Bool.and_eq_true] at hc
        simp only [Fields.dom, Bool.and_eq_true] at hd
        simp only [LList.mem_fairFlatMap, LList.toList_map, List.mem_map,
          Vals.cons.injEq]
        exact ⟨w, Ty.fall_complete S n t _ w hc.1 hd.1, ws,
          Fields.fall_complete S fs env _ ws hc.2 hd.2, rfl, rfl⟩
theorem Cases.fallAt_complete (S : Samples) (name : String) :
    ∀ (cs : Cases) (i : Nat) (env : Env) (v : Val), i < cs.length →
      cs.checkAt i env v = true → cs.domAt S name i v = true → v ∈ (cs.fallAt S name i env).toList
  | .cons _ t _, 0, env, v, _, hc, hd => by
      rw [Cases.fallAt]
      simp only [Cases.checkAt, Cases.dgens, List.getElem?_cons_zero] at hc
      exact Ty.fall_complete S name t env v hc hd
  | .cons _ _ r, i + 1, env, v, hi, hc, hd => by
      rw [Cases.fallAt]
      simp only [Cases.checkAt, Cases.dgens, List.getElem?_cons_succ] at hc
      simp only [Cases.length] at hi
      exact Cases.fallAt_complete S name r i env v (by omega) hc hd
  | .nil, _, env, v, hi, _, _ => by simp [Cases.length] at hi
end

/-! ## Main theorem -/

/-- every valid packet of type `t` whose primitives are drawn from `S` -/
def enumerate (S : Samples) (t : Ty) : LList Val := t.fall S "" []

/-- **Exactness over the sample domain**: `enumerate S t` lists exactly the
valid packets whose primitive values all come from the samples. -/
theorem mem_enumerate (S : Samples) (t : Ty) (v : Val) :
    v ∈ (enumerate S t).toList ↔ (Valid t v ∧ t.dom S "" v = true) := by
  constructor
  · intro h
    have h' := h
    unfold enumerate at h
    cases t <;> (rw [Ty.fall, mem_keep] at h) <;> exact ⟨h.2, Ty.fall_dom S "" _ [] v h'⟩
  · rintro ⟨hv, hd⟩
    exact Ty.fall_complete S "" t [] v hv hd

end PacketGen

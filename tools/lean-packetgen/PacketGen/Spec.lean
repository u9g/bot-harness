import PacketGen.Gen

/-!
# The packet generator and its completeness proof

A packet is decoded left to right, and a field can depend on fields decoded
before it: a `switch` takes the branch selected by the value of an earlier
field, and an array may take its length from an earlier field.  So validity,
and the generator, are defined *relative to an environment* `env` holding the
fields seen so far (one scope per enclosing container).

* `Ty.dgen t` is a dependent generator for every protodef type `t`, built only
  from combinators that preserve exactness.
* `Valid t v`  : `v` is a valid packet of type `t` (well-typed, in range, every
  switch on its selected branch, every count field matching its array).
* `generate t n` : the list of packets of size `n`.

Main results, for an arbitrary `t : Ty` (so for every packet of every protocol
version the translator can express):

* `mem_generate`         : `v ∈ (generate t n).toList ↔ Valid t v ∧ v.size = n`
* `generate_complete`    : every valid packet `v` is listed, at index `v.size`
* `generate_sound`       : everything listed is a valid packet
* `mem_generateUpTo`     : `generateUpTo t N` is exactly the valid packets of size `≤ N`
* `generateUpTo_mono`    : raising the budget never loses packets
-/

namespace PacketGen

/-! ## Switch keys and field lookup -/

/-- A switch key, as the compiled JS `switch` statement compares it. -/
inductive Key where
  | num (z : Int)
  | bool (b : Bool)
  | str (s : String)
  | none
  deriving BEq, Inhabited

def parseNumber (s : String) : Option Int :=
  if s.startsWith "0x" then
    (s.drop 2).foldl (fun acc c => acc.bind fun a =>
      if c.isDigit then some (a * 16 + (c.toNat - '0'.toNat))
      else if 'a' ≤ c && c ≤ 'f' then some (a * 16 + (c.toNat - 'a'.toNat + 10))
      else if 'A' ≤ c && c ≤ 'F' then some (a * 16 + (c.toNat - 'A'.toNat + 10))
      else Option.none) (some 0)
  else if s.startsWith "-" then (s.drop 1).toString.toNat?.map fun n => -(n : Int)
  else s.toNat?.map fun n => (n : Int)

/-- How protodef's compiler turns a `fields` key into a JS `case` label. -/
def Key.ofCaseLabel (s : String) : Key :=
  if s == "true" then .bool true
  else if s == "false" then .bool false
  else match parseNumber s with
    | some z => .num z
    | Option.none => .str s

def codepointsToString (vs : Vals) : String :=
  String.ofList (vs.toList.map fun | .int z => Char.ofNat z.toNat | _ => ' ')

/-- The JS value a field holds, as far as `switch` comparisons are concerned. -/
def Ty.key : Ty → Val → Key
  | .bool, .bool b => .bool b
  | .int _, .int z => .num z
  | .mapper _ m, .case i _ => match m[i]? with
    | some (_, name) => .str name
    | Option.none => .none
  | .pstring _, .list vs => .str (codepointsToString vs)
  | _, _ => .none

/-- The fields of a container decoded so far: name, anonymous?, type, value. -/
abbrev Scope := List (String × Bool × Ty × Val)
/-- Enclosing container scopes, innermost first. -/
abbrev Env := List Scope

/-- what a path segment can point at -/
inductive Target where
  | field (t : Ty) (v : Val)
  | none

def lookupBits (name : String) : List (String × Nat × Bool) → Vals → Target
  | (n, w, s) :: bs, .cons v vs => if n == name then .field (.int (.bits w s)) v else lookupBits name bs vs
  | _, _ => .none

/-- a field of an already decoded container value -/
def lookupField (name : String) : Fields → Vals → Target
  | .cons n anon t fs, .cons v vs =>
    if !anon && n == name then .field t v
    else match anon, t, v with
      | true, .bitfield bs, .tuple bvs => match lookupBits name bs bvs with
        | .none => lookupField name fs vs
        | r => r
      | _, _, _ => lookupField name fs vs
  | _, _ => .none

/-- a field of the scope being decoded (anonymous bitfields are inlined by protodef) -/
def lookupScope (name : String) : Scope → Target
  | [] => .none
  | (n, anon, t, v) :: sc =>
    if !anon && n == name then .field t v
    else match anon, t, v with
      | true, .bitfield bs, .tuple bvs => match lookupBits name bs bvs with
        | .none => lookupScope name sc
        | r => r
      | _, _, _ => lookupScope name sc

def descend (name : String) : Target → Target
  | .field (.container fs) (.tuple vs) => lookupField name fs vs
  | .field (.bitfield bs) (.tuple vs) => lookupBits name bs vs
  | _ => .none

/-- Resolve a protodef field path (`a`, `a/b`, `../a`).  Like the compiled JS,
a bare name missing from the innermost scope is looked up in the enclosing
ones (JS closures). -/
def resolve (env : Env) (path : String) : Target :=
  go env (path.splitOn "/")
where
  go : Env → List String → Target
    | _ :: env, ".." :: rest => go env rest
    | env, name :: rest => rest.foldl (fun t n => descend n t) (first env name)
    | _, _ => .none
  first : Env → String → Target
    | [], _ => .none
    | sc :: env, name => match lookupScope name sc.reverse with
      | .none => first env name
      | r => r

def Target.key : Target → Key
  | .field t v => t.key v
  | .none => .none

def Target.count : Target → Option Nat
  | .field _ (.int z) => if 0 ≤ z then some z.toNat else Option.none
  | _ => Option.none

/-- the branch protodef takes; `cs.length` is `default` -/
def Cases.select : Cases → Key → Nat
  | .nil, _ => 0
  | .cons k _ r, key => if Key.ofCaseLabel k == key then 0 else r.select key + 1

def Selector.key (env : Env) : Selector → Key
  | .path p => (resolve env p).key
  | .value s => Key.ofCaseLabel s

/-- the length constraint of a sequence in a given environment -/
def Count.okIn (env : Env) : Count → Nat → Bool
  | .prefixed k, n => k.inRange n
  | .field p, n => (resolve env p).count == some n
  | .rest, _ => true

/-! ## Dependent generators -/

structure DGen where
  enum : Env → Nat → LList Val
  check : Env → Val → Bool

namespace DGen

def Exact (g : DGen) : Prop := ∀ env v n, v ∈ (g.enum env n).toList ↔ (g.check env v = true ∧ v.size = n)

/-- the generator at a fixed environment -/
def atEnv (g : DGen) (env : Env) : Gen := ⟨g.enum env, g.check env⟩

theorem at_exact (g : DGen) (hg : g.Exact) (env : Env) : (g.atEnv env).Exact := hg env

def lift (g : Gen) : DGen := ⟨fun _ => g.enum, fun _ => g.check⟩

theorem lift_exact (g : Gen) (hg : g.Exact) : (lift g).Exact := fun _ => hg

def option (g : DGen) : DGen :=
  ⟨fun env => (Gen.option (g.atEnv env)).enum, fun env => (Gen.option (g.atEnv env)).check⟩

theorem option_exact (g : DGen) (hg : g.Exact) : (option g).Exact :=
  fun env => Gen.option_exact _ (hg env)

def list (ok : Env → Vals → Bool) (g : DGen) : DGen :=
  ⟨fun env => (Gen.list (ok env) (g.atEnv env)).enum, fun env => (Gen.list (ok env) (g.atEnv env)).check⟩

theorem list_exact (ok : Env → Vals → Bool) (g : DGen) (hg : g.Exact) : (list ok g).Exact :=
  fun env => Gen.list_exact _ _ (hg env)

/-- independent fields sharing one environment (fixed arrays) -/
def prod (gs : List DGen) : DGen :=
  ⟨fun env => (Gen.prod (gs.map (·.atEnv env))).enum, fun env => (Gen.prod (gs.map (·.atEnv env))).check⟩

theorem prod_exact (gs : List DGen) (hgs : ∀ g ∈ gs, g.Exact) : (prod gs).Exact := by
  intro env
  refine Gen.prod_exact _ ?_
  intro g hg
  simp only [List.mem_map] at hg
  obtain ⟨g', hg', rfl⟩ := hg
  exact hgs g' hg' env

/-- the alternative chosen by the environment (a `switch`) -/
def select (sel : Env → Nat) (gs : List DGen) : DGen where
  enum env n := match gs[sel env]? with
    | some g => (g.enum env n).map (.case (sel env))
    | none => .nil
  check env
    | .case i v => i == sel env && (match gs[i]? with
      | some g => g.check env v
      | none => false)
    | _ => false

theorem select_exact (sel : Env → Nat) (gs : List DGen) (hgs : ∀ g ∈ gs, g.Exact) :
    (select sel gs).Exact := by
  intro env v n
  simp only [select]
  cases h : gs[sel env]? with
  | none =>
    cases v <;> simp
    rename_i i _
    intro hi; subst hi; simp [h]
  | some g =>
    have hg := hgs g (List.mem_of_getElem? h)
    cases v with
    | case i w =>
      simp only [LList.toList_map, List.mem_map, Val.case.injEq, Val.size, Bool.and_eq_true,
        beq_iff_eq]
      constructor
      · rintro ⟨w', hw', rfl, rfl⟩
        rw [h]; exact ⟨⟨rfl, ((hg _ _ _).1 hw').1⟩, ((hg _ _ _).1 hw').2⟩
      · rintro ⟨⟨rfl, hc⟩, hs⟩
        rw [h] at hc
        exact ⟨w, (hg _ _ _).2 ⟨hc, hs⟩, rfl, rfl⟩
    | _ => simp

/-- a container field: the generator sees the earlier fields of its container -/
structure FSpec where
  name : String
  anon : Bool
  ty : Ty
  g : DGen

def enumFields : List FSpec → Env → Scope → Nat → LList Vals
  | [], _, _, n => .ofList (if n = 0 then [.nil] else [])
  | f :: fs, env, sc, n => (LList.ofList (List.range (n + 1))).flatMap fun i =>
      (f.g.enum (sc :: env) i).flatMap fun h =>
        (enumFields fs env (sc ++ [(f.name, f.anon, f.ty, h)]) (n - i)).map (Vals.cons h)

def checkFields : List FSpec → Env → Scope → Vals → Bool
  | [], _, _, .nil => true
  | f :: fs, env, sc, .cons v vs =>
    f.g.check (sc :: env) v && checkFields fs env (sc ++ [(f.name, f.anon, f.ty, v)]) vs
  | _, _, _, _ => false

theorem enumFields_exact (fs : List FSpec) (hfs : ∀ f ∈ fs, f.g.Exact) :
    ∀ env sc vs n, vs ∈ (enumFields fs env sc n).toList ↔ (checkFields fs env sc vs = true ∧ vs.tsize = n) := by
  induction fs with
  | nil =>
    intro env sc vs n
    cases vs <;> simp [enumFields, checkFields, Vals.tsize]
    omega
  | cons f fs ih =>
    have hf : f.g.Exact := hfs f (by simp)
    have ih := ih (fun f' h => hfs f' (by simp [h]))
    intro env sc vs n
    cases vs with
    | nil => simp [enumFields, checkFields]
    | cons h t =>
      simp only [enumFields, LList.toList_flatMap, LList.toList_map, LList.toList_ofList,
        List.mem_flatMap, List.mem_range, List.mem_map, Vals.cons.injEq, checkFields, Vals.tsize,
        Bool.and_eq_true]
      constructor
      · rintro ⟨i, hi, h', hh', t', ht', rfl, rfl⟩
        have h1 := (hf _ _ _).1 hh'
        have h2 := (ih _ _ _ _).1 ht'
        exact ⟨⟨h1.1, h2.1⟩, by omega⟩
      · rintro ⟨⟨hp, ha⟩, hs⟩
        exact ⟨h.size, by omega, h, (hf _ _ _).2 ⟨hp, rfl⟩, t, (ih _ _ _ _).2 ⟨ha, by omega⟩, rfl, rfl⟩

/-- a container: opens a new scope -/
def fields (fs : List FSpec) : DGen where
  enum env n := (enumFields fs env [] n).map .tuple
  check env
    | .tuple vs => checkFields fs env [] vs
    | _ => false

theorem fields_exact (fs : List FSpec) (hfs : ∀ f ∈ fs, f.g.Exact) : (fields fs).Exact := by
  intro env v n
  cases v with
  | tuple vs =>
    simp only [fields, LList.toList_map, List.mem_map, Val.tuple.injEq, Val.size]
    constructor
    · rintro ⟨vs', h, rfl⟩; exact (enumFields_exact fs hfs _ _ _ _).1 h
    · intro h; exact ⟨vs, (enumFields_exact fs hfs _ _ _ _).2 h, rfl⟩
  | _ => simp [fields]

end DGen

/-! ## Every protodef type gets an exact generator -/

def u8s : DGen := DGen.lift (Gen.int .u8)

mutual
def Ty.dgen : Ty → DGen
  | .void => DGen.lift Gen.unit
  | .bool => DGen.lift Gen.bool
  | .int k => DGen.lift (Gen.int k)
  | .pstring c => DGen.list (fun env vs => c.okIn env vs.utf8Len) (DGen.lift Gen.char)
  | .array c e => DGen.list (fun env vs => c.okIn env vs.length) e.dgen
  | .tuple n e => DGen.prod (List.replicate n e.dgen)
  | .bytes c => DGen.list (fun env vs => c.okIn env vs.length) u8s
  | .fixedBytes n => DGen.prod (List.replicate n u8s)
  | .uuid => DGen.prod (List.replicate 16 u8s)
  | .option t => DGen.option t.dgen
  | .container fs => DGen.fields fs.specs
  | .bitfield bs => DGen.lift (Gen.prod (bs.map fun b => Gen.int (.bits b.2.1 b.2.2)))
  | .switch on cs d => DGen.select (fun env => cs.select (on.key env)) (cs.dgens ++ [d.dgen])
  | .mapper _ m => DGen.lift (Gen.mapper m.length)
def Fields.specs : Fields → List DGen.FSpec
  | .nil => []
  | .cons n a t r => ⟨n, a, t, t.dgen⟩ :: r.specs
def Cases.dgens : Cases → List DGen
  | .nil => []
  | .cons _ t r => t.dgen :: r.dgens
end

theorem u8s_exact : u8s.Exact := DGen.lift_exact _ (Gen.ints_exact _)

mutual
theorem Ty.dgen_exact : ∀ t : Ty, t.dgen.Exact
  | .void => by rw [Ty.dgen]; exact DGen.lift_exact _ Gen.unit_exact
  | .bool => by rw [Ty.dgen]; exact DGen.lift_exact _ Gen.bool_exact
  | .int k => by rw [Ty.dgen]; exact DGen.lift_exact _ (Gen.ints_exact _)
  | .pstring c => by rw [Ty.dgen]; exact DGen.list_exact _ _ (DGen.lift_exact _ (Gen.ints_exact _))
  | .array c e => by rw [Ty.dgen]; exact DGen.list_exact _ _ (Ty.dgen_exact e)
  | .tuple n e => by
      rw [Ty.dgen]
      exact DGen.prod_exact _ (fun g h => by rw [List.eq_of_mem_replicate h]; exact Ty.dgen_exact e)
  | .bytes c => by rw [Ty.dgen]; exact DGen.list_exact _ _ u8s_exact
  | .fixedBytes n => by
      rw [Ty.dgen]
      exact DGen.prod_exact _ (fun g h => by rw [List.eq_of_mem_replicate h]; exact u8s_exact)
  | .uuid => by
      rw [Ty.dgen]
      exact DGen.prod_exact _ (fun g h => by rw [List.eq_of_mem_replicate h]; exact u8s_exact)
  | .option t => by rw [Ty.dgen]; exact DGen.option_exact _ (Ty.dgen_exact t)
  | .container fs => by rw [Ty.dgen]; exact DGen.fields_exact _ (Fields.specs_exact fs)
  | .bitfield bs => by
      rw [Ty.dgen]
      refine DGen.lift_exact _ (Gen.prod_exact _ ?_)
      intro g hg
      simp only [List.mem_map] at hg
      obtain ⟨b, -, rfl⟩ := hg
      exact Gen.ints_exact _
  | .switch _ cs d => by
      rw [Ty.dgen]
      refine DGen.select_exact _ _ ?_
      intro g hg
      simp only [List.mem_append, List.mem_singleton] at hg
      rcases hg with hg | rfl
      · exact Cases.dgens_exact cs g hg
      · exact Ty.dgen_exact d
  | .mapper _ m => by rw [Ty.dgen]; exact DGen.lift_exact _ (Gen.mapper_exact _)
theorem Fields.specs_exact : ∀ fs : Fields, ∀ f ∈ fs.specs, f.g.Exact
  | .nil => by simp [Fields.specs]
  | .cons _ _ t r => by
      intro f hf
      simp only [Fields.specs, List.mem_cons] at hf
      rcases hf with rfl | hf
      · exact Ty.dgen_exact t
      · exact Fields.specs_exact r f hf
theorem Cases.dgens_exact : ∀ cs : Cases, ∀ g ∈ cs.dgens, g.Exact
  | .nil => by simp [Cases.dgens]
  | .cons _ t r => by
      intro g hg
      simp only [Cases.dgens, List.mem_cons] at hg
      rcases hg with rfl | hg
      · exact Ty.dgen_exact t
      · exact Cases.dgens_exact r g hg
end

/-! ## The generator -/

/-- A valid packet of type `t`: every field well-typed and in range, every
switch on the branch its key selects, every count field equal to its array's
length. -/
def Valid (t : Ty) (v : Val) : Prop := t.dgen.check [] v = true

/-- every valid packet of type `t` of size exactly `n` -/
def generate (t : Ty) (n : Nat) : LList Val := t.dgen.enum [] n

/-- every valid packet of type `t` of size at most `n`, smallest first -/
def generateUpTo (t : Ty) (n : Nat) : LList Val :=
  (LList.ofList (List.range (n + 1))).flatMap (generate t)

theorem mem_generate (t : Ty) (v : Val) (n : Nat) :
    v ∈ (generate t n).toList ↔ (Valid t v ∧ v.size = n) :=
  Ty.dgen_exact t [] v n

/-- **Completeness**: every valid packet is generated, at the position given by its size. -/
theorem generate_complete (t : Ty) (v : Val) (h : Valid t v) : v ∈ (generate t v.size).toList :=
  (mem_generate t v v.size).2 ⟨h, rfl⟩

/-- **Soundness**: everything generated is a valid packet. -/
theorem generate_sound (t : Ty) (v : Val) (n : Nat) (h : v ∈ (generate t n).toList) : Valid t v :=
  ((mem_generate t v n).1 h).1

theorem mem_generateUpTo (t : Ty) (v : Val) (n : Nat) :
    v ∈ (generateUpTo t n).toList ↔ (Valid t v ∧ v.size ≤ n) := by
  simp only [generateUpTo, LList.toList_flatMap, LList.toList_ofList, List.mem_flatMap,
    List.mem_range, mem_generate]
  constructor
  · rintro ⟨i, hi, hv, rfl⟩; exact ⟨hv, by omega⟩
  · rintro ⟨hv, hs⟩; exact ⟨v.size, by omega, hv, rfl⟩

theorem generateUpTo_mono (t : Ty) {m n : Nat} (h : m ≤ n) (v : Val) :
    v ∈ (generateUpTo t m).toList → v ∈ (generateUpTo t n).toList := by
  simp only [mem_generateUpTo]
  rintro ⟨hv, hs⟩
  exact ⟨hv, by omega⟩

/-- No valid packet is missed by the stream `generate t 0, generate t 1, …`. -/
theorem exists_index (t : Ty) (v : Val) (h : Valid t v) : ∃ n, v ∈ (generate t n).toList :=
  ⟨v.size, generate_complete t v h⟩

/-- Each valid packet is listed at exactly one size. -/
theorem generate_unique_size (t : Ty) (v : Val) (m n : Nat)
    (hm : v ∈ (generate t m).toList) (hn : v ∈ (generate t n).toList) : m = n := by
  rw [mem_generate] at hm hn
  omega

end PacketGen

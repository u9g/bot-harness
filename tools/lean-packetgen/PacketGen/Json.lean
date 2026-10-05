import Lean.Data.Json
import PacketGen.Encode

/-!
# protocol.json → `Ty`, and `Val` → node-minecraft-protocol JSON

The translator covers the protodef combinators and the natives listed in
`intKinds` / `toTy`.  Anything else (NBT, entity metadata, `bitflags`,
registry holders, ...) is reported as unsupported and the packet is skipped,
so the completeness theorem only ever speaks about packets whose type was
translated faithfully.
-/

namespace PacketGen
open Lean (Json)

def objPairs : Json → List (String × Json)
  | .obj kvs => kvs.toList
  | _ => []

def intKinds : List (String × IntKind) :=
  [("u8", .u8), ("i8", .i8), ("u16", .u16), ("i16", .i16), ("u32", .u32), ("i32", .i32),
   ("u64", .u64), ("i64", .i64), ("varint", .varint), ("varlong", .varlong),
   ("f32", .f32), ("f64", .f64)]

def Fields.toList : Fields → List (String × Bool × Ty)
  | .nil => []
  | .cons n a t r => (n, a, t) :: r.toList

abbrev TypeEnv := List (String × Json)

def maxDepth : Nat := 64

mutual
partial def toTy (env : TypeEnv) (depth : Nat) (j : Json) : Except String Ty := do
  if depth > maxDepth then throw "type nesting too deep (recursive type?)"
  match j with
  | .str name =>
    match intKinds.lookup name with
    | some k => return .int k
    | none =>
    match name with
    | "void" => return .void
    | "bool" => return .bool
    | "UUID" => return .uuid
    | "restBuffer" => return .bytes .rest
    | _ =>
      match env.lookup name with
      | some (.str "native") => throw s!"unsupported native type '{name}'"
      | some d => toTy env (depth + 1) d
      | none => throw s!"unknown type '{name}'"
  | .arr #[.str kind, args] => toParam env depth kind args
  | _ => throw s!"unsupported type expression {j.compress}"

partial def toCount (env : TypeEnv) (depth : Nat) (args : Json) : Except String (Sum Count Nat) := do
  match args.getObjVal? "countType" with
  | .ok ct =>
    match ← toTy env (depth + 1) ct with
    | .int k => return .inl (.prefixed k)
    | _ => throw "countType must be an integer type"
  | .error _ =>
  match args.getObjVal? "count" with
  | .ok (.str p) => return .inl (.field p)
  | .ok c => match c.getNat? with
    | .ok n => return .inr n
    | .error _ => throw s!"bad count {c.compress}"
  | .error _ =>
    if (args.getObjVal? "rest").toOption == some (.bool true) then return .inl .rest
    throw s!"no count in {args.compress}"

partial def toParam (env : TypeEnv) (depth : Nat) (kind : String) (args : Json) : Except String Ty := do
  match kind with
  | "container" =>
    let some fs := (args.getArr?).toOption | throw "container: expected array"
    let mut out : List (String × Bool × Ty) := []
    for f in fs do
      let anon := (f.getObjVal? "anon").toOption == some (.bool true)
      let name := ((f.getObjVal? "name").toOption.bind (·.getStr?.toOption)).getD ""
      let t ← toTy env (depth + 1) (← f.getObjVal? "type")
      -- protodef inlines anonymous containers into their parent
      match anon, t with
      | true, .container fs' => out := out ++ fs'.toList
      | _, _ => out := out ++ [(name, anon, t)]
    return .container (out.foldr (fun (n, a, t) r => .cons n a t r) .nil)
  | "array" =>
    let e ← toTy env (depth + 1) (← args.getObjVal? "type")
    match ← toCount env depth args with
    | .inl c => return .array c e
    | .inr n => return .tuple n e
  | "pstring" =>
    match ← toCount env depth args with
    | .inl c => return .pstring c
    | .inr _ => throw "fixed-length pstring"
  | "buffer" =>
    match ← toCount env depth args with
    | .inl c => return .bytes c
    | .inr n => return .fixedBytes n
  | "option" => return .option (← toTy env (depth + 1) args)
  | "switch" =>
    let on ← match args.getObjVal? "compareTo" with
      | .ok (.str p) =>
        if p.startsWith "$" then throw "switch on a type parameter" else pure (Selector.path p)
      | _ => match args.getObjVal? "compareToValue" with
        | .ok (.str v) => pure (Selector.value v)
        | _ => throw "switch: no compareTo"
    let fields := objPairs ((args.getObjVal? "fields").toOption.getD (.obj {}))
    let mut cs : List (String × Ty) := []
    for (k, t) in fields do
      if k.startsWith "/" then throw "switch on root context variable"
      cs := cs ++ [(k, ← toTy env (depth + 1) t)]
    let d ← match args.getObjVal? "default" with
      | .ok t => toTy env (depth + 1) t
      | .error _ => pure .void
    return .switch on (cs.foldr (fun (k, t) r => .cons k t r) .nil) d
  | "mapper" =>
    let k ← match ← toTy env (depth + 1) (← args.getObjVal? "type") with
      | .int k => pure k
      | _ => throw "mapper over a non-integer type"
    let mut m : List (Int × String) := []
    for (key, v) in objPairs (← args.getObjVal? "mappings") do
      let some z := parseNumber key | throw s!"mapper key '{key}'"
      m := m ++ [(z, ← v.getStr?)]
    return .mapper k m
  | "bitfield" =>
    let some fs := (args.getArr?).toOption | throw "bitfield: expected array"
    let mut bs : List (String × Nat × Bool) := []
    for f in fs do
      bs := bs ++ [(← (← f.getObjVal? "name").getStr?, ← (← f.getObjVal? "size").getNat?,
        ← (← f.getObjVal? "signed").getBool?)]
    if (bs.map fun b => b.2.1).sum % 8 != 0 then throw "bitfield not byte aligned"
    return .bitfield bs
  | _ =>
    match env.lookup kind with
    | some (.str "native") => throw s!"unsupported native type '{kind}'"
    | some _ => throw s!"unsupported parametrized type '{kind}'"
    | none => throw s!"unknown type '{kind}'"
end

/-! ## Values as node-minecraft-protocol params

Values JSON cannot carry are tagged and revived by `harness/validate.js`:
`{"$bigint": "…"}`, `{"$varlong": "…"}`, `{"$f32": bits}`, `{"$f64": "bits"}`, `{"$buffer": "hex"}`. -/

def intJson (k : IntKind) (z : Int) : Json :=
  match k with
  | .i64 | .u64 => Json.mkObj [("$bigint", .str (toString z))]
  | .varlong => Json.mkObj [("$varlong", .str (toString z))]
  | .f32 => Json.mkObj [("$f32", Lean.toJson z)]
  | .f64 => Json.mkObj [("$f64", .str (toString z))]
  | _ => Lean.toJson z

def bytesOf (vs : Vals) : List UInt8 := vs.toList.map fun v => (twos 8 (valInt v)).toUInt8

def uuidString (bs : List UInt8) : String :=
  let h := hexOf bs
  let p (a b : Nat) := (h.drop a).take (b - a) |>.toString
  s!"{p 0 8}-{p 8 12}-{p 12 16}-{p 16 20}-{p 20 32}"

mutual
def Ty.toJson : Ty → Val → Json
  | .bool, .bool b => .bool b
  | .int k, .int z => intJson k z
  | .pstring _, .list vs => .str (codepointsToString vs)
  | .array _ e, .list vs => .arr (vs.toList.map fun v => e.toJson v).toArray
  | .tuple _ e, .tuple vs => .arr (vs.toList.map fun v => e.toJson v).toArray
  | .bytes _, .list vs => Json.mkObj [("$buffer", .str (hexOf (bytesOf vs)))]
  | .fixedBytes _, .tuple vs => Json.mkObj [("$buffer", .str (hexOf (bytesOf vs)))]
  | .uuid, .tuple vs => .str (uuidString (bytesOf vs))
  | .option t, .some v => t.toJson v
  | .container fs, .tuple vs => Json.mkObj (fs.toJson vs)
  | .bitfield bs, .tuple vs =>
    Json.mkObj ((bs.zip vs.toList).map fun ((n, _), v) => (n, Lean.toJson (valInt v)))
  | .switch _ cs d, .case i v => if i < cs.length then cs.toJsonAt i v else d.toJson v
  | .mapper _ m, .case i _ => .str ((m[i]?.map (·.2)).getD "")
  | _, _ => .null
def Fields.toJson : Fields → Vals → List (String × Json)
  | .cons n anon t fs, .cons v vs =>
    (if anon then objPairs (t.toJson v) else [(n, t.toJson v)]) ++ fs.toJson vs
  | _, _ => []
def Cases.toJsonAt : Cases → Nat → Val → Json
  | .cons _ t _, 0, v => t.toJson v
  | .cons _ _ r, i + 1, v => r.toJsonAt i v
  | .nil, _, _ => .null
end

end PacketGen

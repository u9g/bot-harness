/-!
# Lazy lists

Enumerations are produced lazily so that `--limit` can stop after the first
values without computing a whole size level (a 256-byte signature alone has
about 10¹⁰ values of size 5).  Every operation comes with a lemma relating it
to the corresponding `List` operation, so all proofs are stated about
`toList` and the lazy evaluation order changes nothing.
-/

namespace PacketGen

inductive LList (α : Type) where
  | nil
  | cons (h : α) (t : Unit → LList α)

namespace LList

variable {α β : Type}

def toList : LList α → List α
  | nil => []
  | cons h t => h :: toList (t ())

@[simp] theorem toList_nil : (nil : LList α).toList = [] := rfl
@[simp] theorem toList_cons (h : α) (t : Unit → LList α) : (cons h t).toList = h :: (t ()).toList := rfl

def ofList : List α → LList α
  | [] => nil
  | h :: t => cons h fun _ => ofList t

@[simp] theorem toList_ofList (l : List α) : (ofList l).toList = l := by
  induction l with
  | nil => rfl
  | cons h t ih => simp [ofList, ih]

def append : LList α → (Unit → LList α) → LList α
  | nil, b => b ()
  | cons h t, b => cons h fun _ => append (t ()) b

@[simp] theorem toList_append (a : LList α) (b : Unit → LList α) :
    (append a b).toList = a.toList ++ (b ()).toList := by
  induction a with
  | nil => simp [append, toList]
  | cons h t ih => simp [append, toList, ih]

def map (f : α → β) : LList α → LList β
  | nil => nil
  | cons h t => cons (f h) fun _ => map f (t ())

@[simp] theorem toList_map (f : α → β) (l : LList α) : (l.map f).toList = l.toList.map f := by
  induction l with
  | nil => rfl
  | cons h t ih => simp [map, toList, ih]

def filter (p : α → Bool) : LList α → LList α
  | nil => nil
  | cons h t => if p h then cons h fun _ => filter p (t ()) else filter p (t ())

@[simp] theorem toList_filter (p : α → Bool) (l : LList α) :
    (l.filter p).toList = l.toList.filter p := by
  induction l with
  | nil => rfl
  | cons h t ih =>
    simp only [filter, toList]
    cases hp : p h <;> simp [List.filter, hp, ih]

def flatMap (l : LList α) (f : α → LList β) : LList β :=
  match l with
  | nil => nil
  | cons h t => append (f h) fun _ => flatMap (t ()) f

@[simp] theorem toList_flatMap (l : LList α) (f : α → LList β) :
    (l.flatMap f).toList = l.toList.flatMap fun a => (f a).toList := by
  induction l with
  | nil => rfl
  | cons h t ih => simp [flatMap, toList, ih]

/-- the first `n` elements; forces nothing beyond them -/
def take : Nat → LList α → List α
  | 0, _ => []
  | _, nil => []
  | n + 1, cons h t => h :: take n (t ())

theorem take_eq (n : Nat) (l : LList α) : l.take n = l.toList.take n := by
  induction l generalizing n with
  | nil => cases n <;> simp [take, toList]
  | cons h t ih => cases n <;> simp [take, toList, ih]

end LList
end PacketGen

namespace PacketGen.LList

variable {α β : Type}

/-- weighted number of elements still to come (for termination) -/
def lenSum (w : Nat) (ls : List (LList β)) : Nat := (ls.map fun s => 2 * s.toList.length + w).sum

/-- Fair merge: active streams are served round-robin from a queue
(`front ++ back.reverse`), and after every element one more stream `f a` (for
the next `a` of `rest`) joins.  Each stream starts early and gets a fair share,
so a prefix of the result touches every stream. -/
def fairGo (f : α → LList β) (front back : List (LList β)) (rest : LList α) : LList β :=
  match front, back, rest with
  | [], [], nil => nil
  | [], [], cons a more => fairGo f [f a] [] (more ())
  | [], b :: bs, rest => fairGo f (b :: bs).reverse [] rest
  | nil :: front', back, rest => fairGo f front' back rest
  | cons h t :: front', back, nil => cons h fun _ => fairGo f front' (t () :: back) nil
  | cons h t :: front', back, cons a more =>
    cons h fun _ => fairGo f front' (f a :: t () :: back) (more ())
termination_by lenSum 1 front + lenSum 2 back + (rest.toList.map fun a => 2 * (f a).toList.length + 4).sum
decreasing_by
  all_goals simp [lenSum, toList_cons, List.sum_append, List.map_reverse, List.sum_reverse]
  all_goals try omega
  all_goals
    have : ∀ l : List (LList β), (l.map fun s => 2 * s.toList.length + 1).sum <
        (l.map fun s => 2 * s.toList.length + 2).sum + 1 := by
      intro l; induction l with
      | nil => simp
      | cons x l ih => simp; omega
    have := this bs
    omega

theorem mem_fairGo (f : α → LList β) (front back : List (LList β)) (rest : LList α) (x : β) :
    x ∈ (fairGo f front back rest).toList ↔
      ((∃ s ∈ front ++ back, x ∈ s.toList) ∨ ∃ a ∈ rest.toList, x ∈ (f a).toList) := by
  induction front, back, rest using fairGo.induct f with
  | case1 => simp [fairGo]
  | case2 a more ih =>
    rw [fairGo, ih]; simp [toList_cons]
  | case3 b bs rest ih =>
    rw [fairGo, ih]; simp; grind
  | case4 front' back rest ih =>
    rw [fairGo, ih]; simp
  | case5 h t front' back ih =>
    rw [fairGo, toList_cons, List.mem_cons, ih]
    simp only [List.mem_append, List.mem_cons, toList_nil, List.not_mem_nil]
    grind [toList_cons]
  | case6 h t front' back a more ih =>
    rw [fairGo, toList_cons, List.mem_cons, ih]
    simp only [List.mem_append, List.mem_cons]
    grind [toList_cons]

/-- `flatMap` in fair order: same elements, but every `f a` starts early -/
def fairFlatMap (l : LList α) (f : α → LList β) : LList β := fairGo f [] [] l

theorem mem_fairFlatMap (l : LList α) (f : α → LList β) (x : β) :
    x ∈ (fairFlatMap l f).toList ↔ ∃ a ∈ l.toList, x ∈ (f a).toList := by
  simp [fairFlatMap, mem_fairGo]

end PacketGen.LList

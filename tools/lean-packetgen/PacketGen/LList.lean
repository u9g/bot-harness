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

; PR-FORMALMETHOD-013/014: finite abstraction, not actual hash/time acquisition.
; V0/V1 are distinguishable identity generations; Missing and Invalid are not evidence of equality.
(set-logic ALL)
(declare-datatypes () ((Value Missing Invalid V0 V1)))
(declare-datatypes () ((Field Target Model ToolKind ToolVersion ToolConfig Evidence Acquisition Property Assumptions Scope Criteria Time)))
(define-sort Identity () (Array Field Value))

(define-fun known ((v Value)) Bool (or (= v V0) (= v V1)))
(define-fun pair-equal ((a Value) (b Value)) Bool
  (and (known a) (known b) (= a b)))
(define-fun all-known ((a Identity) (b Identity)) Bool
  (and (known (select a Target)) (known (select b Target))
       (known (select a Model)) (known (select b Model))
       (known (select a ToolKind)) (known (select b ToolKind))
       (known (select a ToolVersion)) (known (select b ToolVersion))
       (known (select a ToolConfig)) (known (select b ToolConfig))
       (known (select a Evidence)) (known (select b Evidence))
       (known (select a Acquisition)) (known (select b Acquisition))
       (known (select a Property)) (known (select b Property))
       (known (select a Assumptions)) (known (select b Assumptions))
       (known (select a Scope)) (known (select b Scope))
       (known (select a Criteria)) (known (select b Criteria))
       (known (select a Time)) (known (select b Time))))
(define-fun all-equal ((a Identity) (b Identity)) Bool
  (and (pair-equal (select a Target) (select b Target))
       (pair-equal (select a Model) (select b Model))
       (pair-equal (select a ToolKind) (select b ToolKind))
       (pair-equal (select a ToolVersion) (select b ToolVersion))
       (pair-equal (select a ToolConfig) (select b ToolConfig))
       (pair-equal (select a Evidence) (select b Evidence))
       (pair-equal (select a Acquisition) (select b Acquisition))
       (pair-equal (select a Property) (select b Property))
       (pair-equal (select a Assumptions) (select b Assumptions))
       (pair-equal (select a Scope) (select b Scope))
       (pair-equal (select a Criteria) (select b Criteria))
       (pair-equal (select a Time) (select b Time))))
(define-fun any-invalid ((a Identity) (b Identity)) Bool
  (or (= (select a Target) Invalid) (= (select b Target) Invalid)
      (= (select a Model) Invalid) (= (select b Model) Invalid)
      (= (select a ToolKind) Invalid) (= (select b ToolKind) Invalid)
      (= (select a ToolVersion) Invalid) (= (select b ToolVersion) Invalid)
      (= (select a ToolConfig) Invalid) (= (select b ToolConfig) Invalid)
      (= (select a Evidence) Invalid) (= (select b Evidence) Invalid)
      (= (select a Acquisition) Invalid) (= (select b Acquisition) Invalid)
      (= (select a Property) Invalid) (= (select b Property) Invalid)
      (= (select a Assumptions) Invalid) (= (select b Assumptions) Invalid)
      (= (select a Scope) Invalid) (= (select b Scope) Invalid)
      (= (select a Criteria) Invalid) (= (select b Criteria) Invalid)
      (= (select a Time) Invalid) (= (select b Time) Invalid)))
; 0 current, 1 stale, 2 missing, 3 invalid; invalid takes precedence over missing.
(define-fun classification ((a Identity) (b Identity)) Int
  (ite (any-invalid a b) 3 (ite (not (all-known a b)) 2 (ite (all-equal a b) 0 1))))
(define-fun reuse-permitted ((a Identity) (b Identity)) Bool
  (= (classification a b) 0))

; Comparison is about same target/property/scope/assumptions; tool and model may differ.
(define-fun comparable ((a Identity) (b Identity)) Bool
  (and (pair-equal (select a Target) (select b Target))
       (pair-equal (select a Property) (select b Property))
       (pair-equal (select a Assumptions) (select b Assumptions))
       (pair-equal (select a Scope) (select b Scope))))
; -1 means unavailable; no performance verdict without both nonnegative measurements.
(define-fun can-report-faster ((a Identity) (b Identity) (time-a Int) (time-b Int)) Bool
  (and (comparable a b) (>= time-a 0) (>= time-b 0) (< time-a time-b)))

; Independent oracle enumerates admitted value pairs, rather than using pair-equal.
(define-fun exact-pair ((a Value) (b Value)) Bool
  (or (and (= a V0) (= b V0)) (and (= a V1) (= b V1))))
(define-fun oracle-reuse ((a Identity) (b Identity)) Bool
  (and (exact-pair (select a Target) (select b Target))
       (exact-pair (select a Model) (select b Model))
       (exact-pair (select a ToolKind) (select b ToolKind))
       (exact-pair (select a ToolVersion) (select b ToolVersion))
       (exact-pair (select a ToolConfig) (select b ToolConfig))
       (exact-pair (select a Evidence) (select b Evidence))
       (exact-pair (select a Acquisition) (select b Acquisition))
       (exact-pair (select a Property) (select b Property))
       (exact-pair (select a Assumptions) (select b Assumptions))
       (exact-pair (select a Scope) (select b Scope))
       (exact-pair (select a Criteria) (select b Criteria))
       (exact-pair (select a Time) (select b Time))))
(define-fun oracle-comparison ((a Identity) (b Identity) (time-a Int) (time-b Int)) Bool
  (and (exact-pair (select a Target) (select b Target))
       (exact-pair (select a Property) (select b Property))
       (exact-pair (select a Assumptions) (select b Assumptions))
       (exact-pair (select a Scope) (select b Scope))
       (>= time-a 0) (>= time-b 0) (< time-a time-b)))

; Mutants intentionally omit a comparison or accept unknown values.
(define-fun mutant-ignore-version ((a Identity) (b Identity)) Bool
  (reuse-permitted a (store b ToolVersion (select a ToolVersion))))
(define-fun mutant-allow-missing ((a Identity) (b Identity)) Bool
  (or (reuse-permitted a b)
      (and (= (select a ToolVersion) Missing) (= (select b ToolVersion) Missing)
           (reuse-permitted (store a ToolVersion V0) (store b ToolVersion V0)))))
(define-fun mutant-ignore-scope ((a Identity) (b Identity) (ta Int) (tb Int)) Bool
  (can-report-faster a (store b Scope (select a Scope)) ta tb))

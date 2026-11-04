------------------------------ MODULE PrdSpec ------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxQuestions,
    MaxPasses

VARIABLES
    phase,
    questions,
    answers,
    blockingIssues,
    passes,
    auditPassed

vars == <<phase, questions, answers, blockingIssues, passes, auditPassed>>

Phases == {"draft", "reviewing", "needs_input", "blocked", "approved", "done"}

TypeOK ==
    /\ phase \in Phases
    /\ questions \subseteq (1..MaxQuestions)
    /\ answers \subseteq (1..MaxQuestions)
    /\ blockingIssues \in 0..MaxQuestions
    /\ passes \in 0..MaxPasses
    /\ auditPassed \in BOOLEAN

Init ==
    /\ phase = "draft"
    /\ questions = {}
    /\ answers = {}
    /\ blockingIssues = 0
    /\ passes = 0
    /\ auditPassed = FALSE

SubmitForReview ==
    /\ phase = "draft"
    /\ phase' = "reviewing"
    /\ passes' = passes + 1
    /\ UNCHANGED <<questions, answers, blockingIssues, auditPassed>>

AskQuestions ==
    /\ phase = "reviewing"
    /\ passes <= MaxPasses
    /\ questions' \in SUBSET (1..MaxQuestions)
    /\ questions' /= {}
    /\ phase' = "needs_input"
    /\ UNCHANGED <<answers, blockingIssues, passes, auditPassed>>

ProvideAnswers ==
    /\ phase = "needs_input"
    /\ \E ans \in SUBSET questions:
        /\ ans /= {}
        /\ answers' = answers \cup ans
        /\ phase' = "reviewing"
    /\ UNCHANGED <<questions, blockingIssues, passes, auditPassed>>

BlockOnDefect ==
    /\ phase \in {"reviewing", "needs_input"}
    /\ phase' = "blocked"
    /\ UNCHANGED <<questions, answers, blockingIssues, passes, auditPassed>>

ResolveBlock ==
    /\ phase = "blocked"
    /\ passes < MaxPasses
    /\ phase' = "reviewing"
    /\ UNCHANGED <<questions, answers, blockingIssues, passes, auditPassed>>

PassAudit ==
    /\ phase = "reviewing"
    /\ questions \subseteq answers
    /\ blockingIssues = 0
    /\ auditPassed' = TRUE
    /\ phase' = "approved"
    /\ UNCHANGED <<questions, answers, blockingIssues, passes>>

Complete ==
    /\ phase = "approved"
    /\ auditPassed = TRUE
    /\ phase' = "done"
    /\ UNCHANGED <<questions, answers, blockingIssues, passes, auditPassed>>

Next ==
    \/ SubmitForReview
    \/ AskQuestions
    \/ ProvideAnswers
    \/ BlockOnDefect
    \/ ResolveBlock
    \/ PassAudit
    \/ Complete

Spec == Init /\ [][Next]_vars

NoUnresolvedQuestionsOnApproval ==
    (phase \in {"approved", "done"}) => (questions \subseteq answers)

NoBlockingOnCompletion ==
    (phase = "done") => (blockingIssues = 0 /\ auditPassed = TRUE)

ValidTerminal ==
    (phase = "done") => (questions \subseteq answers /\ auditPassed = TRUE)

=============================================================================

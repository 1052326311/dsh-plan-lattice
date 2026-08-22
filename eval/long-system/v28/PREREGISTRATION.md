# V28 Preregistration

Status before paid execution: **fixed Candidate `e79413f` unseen on the paid
protocol and result claims prohibited**. The older `5c1df23` Candidate was
observed in the disclosed, incomplete V27 trial; V28 records that negative
observation rather than treating the fixed Candidate as historically unseen.

## Question

Under identical DeepSeek Harness rc.7, `deepseek-v4-flash`, nine-round EvoCode
Jobforge task, hidden grader, and per-attempt hard budget, does Plan Lattice
rc.9 preserve intent across compaction, cold process recovery, and foreground
subagent work often enough to materially improve completed product behavior?

## Invariants

- Harness commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Candidate commit: `e79413ff2770b2b67217ce2010cd1df4c1b2aa87`
- Candidate tree: `d88d47d8b74a93c739bda3359a69aa735fb72c71`
- Candidate tarball SHA256:
  `7a7a17b12927890e11fe537d796d43897d5f4dbaba379dc5cb9f9242d6d8c7f1`
- Candidate lockfile SHA256:
  `1fbfd191c614e98ac9062d67eb239d45ae383d0109f9ec4a2d0b6daef574c521`
- Candidate source reproduction: exact `git archive`, offline frozen-lockfile
  install from the content-addressed pnpm store, `tsc`, and `npm pack` using
  Node `v22.23.0`, pnpm `11.19.0`, and npm `10.9.8`; all 67 normalized payload
  entries must match by path, executable mode, bytes, and SHA256, with payload
  digest `ba78f7a3b03144186e118992d2a4e4ebe6a517249355169b0dfc8eae71f960e4`
- Dataset commit: `9fcae3e5539d1c0e85e2481fe06bd6af42cc4bc6`
- Dataset authority: the clean official Hugging Face Git checkout, its frozen
  Git LFS archive pointer, the matching 67 MB object, and a byte/mode-identical
  extracted task tree
- Model: `deepseek-v4-flash`, temperature 0, 32,768 max agent output tokens
- Upstream endpoint: exactly `https://api.deepseek.com`; the canonical URL and
  SHA256 are frozen into the manifest, run envelope, and attempt signature chain
- Budget per attempt: 240 agent requests, 6,000,000 input tokens, 750,000
  output tokens
- Twelve AB/BA pairs with six runs in each within-pair order, one fresh
  workspace per slot, no replacement run
- The public manifest commit is the single direct child of the frozen driver
  commit, changes only the manifest, and must be the exact target of the
  dedicated public preregistration tag before any paid request; Git replacement
  refs and host configuration are disabled while resolving that identity
- Before the trial claim, driver bytes are materialized from the frozen commit
  and the Harness archive, Candidate archive, and full task are copied into one
  private snapshot and reverified. Both execution and final disk verification
  consume that retained snapshot rather than reopening the original paths
- One frozen absolute output root and run ID; one exclusive manifest-level
  trial claim prevents accidental duplicate execution while its local evidence
  remains present, and each slot has a durable pre-side-effect start record
- Hidden official verifier after every delivered product round
- Identical tool-level filesystem boundary in both arms: native filesystem
  readers are absent, Bash cannot request escalation, every command enters one
  rc.7 `SandboxProvider` without changing model-visible arguments, and its
  Seatbelt profile denies private host roots while explicitly reallowing the
  workspace/runtime roots and only their traversal metadata; Bash cannot read
  other user data, prior attempts, the repository, oracle, or grader, outbound
  network is denied, and protected runtime/package trees must remain
  byte-identical across execution; Apple Git uses the read-only Command Line
  Tools binary with system and isolated-user config disabled; model Bash cannot
  inspect ancestor process metadata
- Every actual Candidate Harness process must durably prove successful plugin
  activation with its own receipt bound to attempt, epoch digest, evaluator
  nonce, process PID, wrapper, Candidate, configuration, and Bash adapter;
  Native must produce zero activation receipts
- Every full completion must contain exactly the two frozen process epochs,
  each with a unique PID/start identity, status 0, no signal, and confirmed
  process-group cleanup
- The final verifier rebuilds the trace contract from the retained task and
  locates the foreground audit from its durable message digest; runner-authored
  lifecycle expectations or event ranges cannot weaken the contract
- The rebuilt contract freezes every stage message digest and source, the
  complete stage order and epoch membership, both post-stage compaction
  windows, and the round-5 cold-restart boundary. The two process ledgers must
  form a gapless, non-overlapping partition from root Session seq 0 through the
  final durable event, with the second epoch beginning at its sole end-seed
- The reported attempt directories, model-proxy request/response stream, and
  budget activation/snapshot stream must form one closed protocol prefix with
  no unknown IDs, extra attempts, duplicate activations, or unpaired requests;
  every agent request must use the exact origin-form `/chat/completions` target
  and have exactly one corresponding budget-accounted terminal event
- Unreached rounds receive zero under the fixed nine-round denominator
- `completed`, `max-tokens`, and host-authenticated
  `attempt-budget-exhausted` are scoreable terminal kinds

The final frozen manifest adds exact runtime, task, image, driver, signing-key,
and source-object digests after the driver commit is frozen.

Attempt signatures use Ed25519 schema v3 over the canonical complete envelope,
including the public manifest commit, manifest and execution digests, run ID,
slot ordinal, ledger ID, previous record digest, and result digest. Complete
Candidate traces are not trusted from the report: the final verifier re-reads the frozen Session tree
with a decoder extracted from the separately verified rc.7 tarball and
recomputes the continuity verdict. It also derives the expected Candidate
payload from the separately verified rc.9 tarball; no executable module under
the evidence root is imported. It also rebuilds that payload from the frozen
public Candidate source commit and rejects the trial if the source-derived and
supplied package entries differ.

## Outcomes

Primary effect endpoints are median score delta, fraction of the remaining
score gap closed, and paired continuity-depth improvement. Product-reliability endpoints are
full nine-round Candidate completions, clean terminals, hidden case score,
historical regressions, and continuity-trace validity.

`continuityDepth` is the number of product rounds with a durable `completed`
acknowledgement before the attempt terminal, from 0 through 9. Release requires
all of the following, without multiplicity-driven endpoint substitution:

Continuity depth is the primary mechanism endpoint; full completion is the key
confirmatory endpoint. Their one-sided tests each use `alpha=0.025`, a fixed
Bonferroni allocation that bounds the two-test family-wise error at 0.05.
Within each contemporaneous pair, stochastic arm outcomes are assumed
independent across pairs and exchangeable under the null. The continuity test
is therefore an exact paired sign-flip test under a symmetric paired-difference
null, not an allocation randomization test. McNemar uses the corresponding
paired binary null for discordant full-completion outcomes.

- Candidate median score gain at least 15 points and at least 30% of the
  remaining score gap;
- Candidate median strict reward score 100;
- at least 10 of 12 Candidate full completions and clean terminals;
- full-completion-rate gain at least 0.50 with one-sided exact paired McNemar
  `p <= 0.025`;
- paired mean continuity-depth gain at least four rounds, at least 10 of 12
  pair wins, one-sided exact sign-flip `p <= 0.025`, and the fixed-seed
  100,000-sample paired bootstrap 95% lower bound above two rounds;
- paired mean strict reward gain at least 30 points;
- paired mean hidden case-score gain at least 20 points with paired bootstrap
  95% lower bound above zero;
- zero Candidate historical regressions; and
- valid frozen continuity traces for every fully completed Candidate attempt.

Thresholds are compiled into `analysis.mjs` and repeated in the frozen
manifest. They cannot be changed after execution without creating a new
protocol version and disclosing V28 as a prior observation.

## Stopping and publication

An infrastructure-invalid attempt stops the sequence and remains
inconclusive; it is never rewritten as a low-scoring model outcome. A scoreable
model or product terminal remains in the intended analysis. The runner never
retries a slot or replaces the claimed output root or run ID. Setup, copy,
activation, sealing, checkpoint, and finalization faults produce an exclusive
inconclusive terminal record. No intermediate score may alter order, budgets,
thresholds, or whether a later arm is exposed.

The public precommit fixes the disclosed run identity before execution, and
exclusive local records prevent accidental reuse. This protocol does not claim
to cryptographically detect a malicious operator deleting an undisclosed local
run or an owner deliberately deleting the public preregistration tag after the
final verification. The publication claim is therefore one preregistered,
operator-attested disclosed trial rather than proof that no private execution
ever occurred.

Only `report-verifier.mjs` reading the final report, all disk evidence, the
trusted frozen runtime/Candidate archives, and one report-bound Ed25519 trial
terminal may return `releaseAllowed: true`. Finalization first verifies the
evidence, writes the exclusive signed terminal, and verifies again. A process
death after report creation but before terminal persistence therefore remains
inconclusive. Otherwise V28 is a retained negative result and must not be
presented as evidence of uplift.

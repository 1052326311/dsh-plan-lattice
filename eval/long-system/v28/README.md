# V28: Paired Long-Task Continuity Evaluation

V28 is a prospective comparison of Native DeepSeek Harness rc.7 and the
previously frozen Plan Lattice rc.9 candidate on one nine-round EvoCode
Jobforge task. The model, task bytes, hidden grader, Harness runtime, candidate
package, output limits, per-attempt budget, host adapter, and evidence signer
are identical across arms.

The upstream model endpoint is also an invariant: only
`https://api.deepseek.com` is accepted, and its canonical URL digest is bound
into the manifest, run envelope, and signed attempt chain. A compatible proxy
or arm-aware replacement service cannot satisfy final verification.

## Prior observation

V27 publicly preregistered twelve balanced pairs and retained 13 signed
attempts before ending during pair 7 Native, so it has no final report and no
scoreable comparative claim. Its six retained Native scores were
`[0, 0, 0, 0, 33.33, 11.11]`; its seven retained Candidate scores were all
zero. Every retained Candidate stopped in round 1.

The retained V27 Session exposed a concrete Candidate control loop: local
Bash, test, and guard failures incorrectly created authority-refresh debt, so
unchanged authority reads could consume the budget without advancing the
active Todo. Commit `e79413ff2770b2b67217ce2010cd1df4c1b2aa87` keeps local
workflow failures local, permits a failed Todo write to retry directly, and
adds bounded full/compact/circuit-breaker refresh behavior. V28 is a new
prospective trial of that fixed Candidate; V27 remains an incomplete negative
prior observation and is never rewritten as uplift evidence.

## Frozen comparison

V28 runs twelve contemporaneous pairs in a frozen balanced order: six pairs
run Native first and six run Candidate first. The exact 24-slot order is
compiled into the driver and repeated in the signed manifest.

Both arms receive the same hard budget for every fresh workspace. Native
variance is measured, not used to hide Candidate. An infrastructure-invalid
slot stops the trial and cannot be replaced. Every attempt is chained through
the pre-anchored Ed25519 signer. Signature schema v3 authenticates the complete
canonical envelope: public manifest commit, manifest and execution digests,
run and slot identity, ordinal, ledger identity, previous record, and attempt
result. The final
verifier reconstructs each result from raw Session state, a Session-tree
digest, host budget audit, hidden grader receipts, and terminal
acknowledgements. It extracts the decoder from a separately supplied rc.7
runtime tarball after checking the frozen archive and metadata digests; it
never imports executable code from an evidence directory. It similarly
recomputes the installed Candidate payload from the frozen rc.9 tarball.
The Candidate archive is not trusted as an opaque binary. Freeze, preflight,
snapshot construction, and final verification independently materialize exact
public commit `e79413ff2770b2b67217ce2010cd1df4c1b2aa87` with `git archive`, require
tree `d88d47d8b74a93c739bda3359a69aa735fb72c71` and the frozen lockfile,
install from the local content-addressed pnpm store with networking disabled,
run the commit's exact TypeScript build, and repack it with the frozen
Node/pnpm/npm toolchain. All 67 publishable entries must match the supplied
archive by path, executable mode, bytes, and SHA256 after only npm's documented
removal of `scripts.prepack` is normalized. The normalized payload digest is
`ba78f7a3b03144186e118992d2a4e4ebe6a517249355169b0dfc8eae71f960e4`.
Before recomputing a release gate, the final verifier also proves that its
current analyzer and verifier bytes match the driver commit and source-object
table frozen in the manifest. Changing analysis code after observing outcomes
invalidates verification.

Task provenance is executable evidence rather than a label. Freeze and
preflight require the clean official Hugging Face dataset commit, verify its
Git LFS pointer for the 67 MB archive, verify the downloaded object's SHA256
and size, unpack it with a frozen zstd binary, and compare the selected task
checkout to the archive by path, bytes, mode, and full tree digest.

Before any paid slot, the driver commit and immutable manifest are published as
two consecutive commits and anchored by the disclosed dedicated preregistration
tag. The manifest commit
must be the single direct child of the driver commit, change only
`frozen-manifest.json`, match the local bytes, and remain the exact remote
tag target. Host Git runs with system/global configuration, replacement refs,
alternate object stores, and interactive credentials disabled. It freezes one
absolute output root and one run ID. An exclusive
manifest-level claim then prevents accidental reuse while its local evidence
remains present. Every slot writes and fsyncs a start record before workspace
copying or model use. Setup,
activation, signing, checkpoint, and finalization failures create an exclusive
`inconclusive` terminal record; infrastructure faults are never converted into
scoreable product failures, and neither a failed slot nor the whole trial may
be replaced under another root or ID. The report alone has no release
authority. Finalization writes one
report-bound Ed25519 `release-allowed` or `release-prohibited` terminal, then
runs the disk verifier again. Missing, forged, mismatched, or fatal terminal
state always fails closed.

Preflight does not leave a check/use gap. Before the exclusive trial claim and
before any model request, the runner materializes driver bytes directly from
the frozen commit, copies the Harness archive, Candidate archive, and complete
task tree into one private staging directory, and rechecks every frozen
identity on the copied bytes. It then atomically moves that directory under the
run root. Wrappers, support plugin, Harness extraction, workspace seed, prompts,
and every hidden grader round consume only this retained snapshot. Its complete
identity is bound into the signed run envelope; the disk verifier rehashes the
retained assets and independently rematerializes the driver commit before
accepting any score.

Model-authored filesystem effects use one tool-level boundary. The Harness
process remains able to persist Sessions and load the frozen plugins, while
the identical Native/Candidate rc.7 `SandboxProvider` confines subprocess argv
to one Darwin Seatbelt invocation. Model-visible Bash arguments remain
byte-for-byte unchanged. Native `read`, `grep`, and `glob` are removed, so Bash
is the only model filesystem channel. It can write only the workspace plus
isolated HOME/TMP roots and cannot read the repository, task oracle, hidden
grader, current runtime state, prior attempts, other user data, or sibling
attempts. Outbound network is denied. Private host roots are denied, then the
current workspace, isolated HOME/TMP, and Node/Go toolchain roots are explicitly
reallowed. Only literal ancestor-directory metadata required to resolve an
authorized path is reallowed; parent listings and sibling file metadata remain
denied.
Bash fixes Apple Git to the read-only Command Line Tools path and disables the
system Git config, so ordinary repository inspection works without reopening
the denied system or user configuration trees.
Bash escalation metadata is rejected.
Each Candidate Harness process writes a separate exclusive, fsync-backed
activation receipt only after Plan Lattice `apply()` succeeds. The receipt
binds the attempt, exact epoch payload, evaluator nonce, actual process PID,
wrapper, Candidate package, configuration, and Bash adapter. The runner checks
each receipt immediately after its process exits, while the final verifier
rebuilds both epochs from the frozen task and requires the on-disk receipt set
to match the process ledger exactly. Native must produce no such receipt.
For every full product completion, the final verifier also requires exactly two
unique process identities, successful zero-status exits, no signal, and a
confirmed clean process group. A killed process or failed cleanup invalidates
the evidence instead of being reduced to an `ended` flag.
Protected Harness, decoder, profile-module, and package
trees are hashed before model execution, checked afterward, signed in the raw
attempt, and recomputed by the final verifier. A real rc.7 zero-cost smoke test
proves that workspace writes and the task toolchain work while sibling writes,
sibling reads, and outbound network access are denied.
The same smoke also proves that model Bash cannot inspect an ancestor process
environment while workspace writes and the fixed toolchain remain available.

Continuity expectations are evaluator-owned. The final verifier rebuilds the
trace contract from the retained nine-round task and frozen hidden-asset
digest, then requires the runner's recorded contract to match it exactly. That
contract freezes the digest, source, order, and epoch of all ten stages, the
two exact post-stage compaction windows, and the round-5 cold-restart boundary.
The foreground audit boundary is located from the exact persisted audit-message
digest and source in the durable root Session, not from runner-authored event
ranges. The two process ranges must form a gapless partition of every root
Session event, and the resumed range must begin at its sole durable end-seed.
The verifier also inventories the complete reported attempt-directory prefix
and closes every model-proxy request/response pair and budget activation
stream. Model requests are restricted to the exact origin-form
`/chat/completions` path and reconciled per attempt against one budget terminal
event each. Unknown attempt IDs, extra directories, duplicate activations,
unpaired requests, missing budget accounting, and missing completed-attempt
audit evidence all prohibit release.

Realized token use is reported but is not a release gate. Prematurely stopping
after round 1 naturally uses fewer tokens than completing all nine rounds, so
equal realized usage would measure early termination rather than execution
efficiency. Fairness is enforced by the identical hard budget and model limits.

## Release gates

The disk-backed verifier is the only publication authority. Release requires:

- all 24 exact AB/BA slots with valid evidence;
- the exact official DeepSeek endpoint, frozen runtime and Candidate payload,
  protected runtime trees, and one valid report-bound Ed25519 terminal;
- Native median score at most 85 and at most four full Native completions;
- Candidate median score at least 15 points above Native and at least 30% of
  the remaining gap closed;
- at least 10 of 12 Candidate runs completing all nine hidden rounds with
  no hard requirement miss;
- a full-completion-rate gain of at least 50 percentage points with one-sided
  exact paired McNemar `p <= 0.025`;
- a mean continuity-depth gain of at least four rounds, wins in at least 10 of
  12 pairs, exact paired sign-flip `p <= 0.025`, and fixed-seed 100,000-run
  bootstrap lower bound above two rounds;
- Candidate median strict reward 100, paired mean reward gain at least 30
  points, and paired mean hidden case-score gain at least 20 points with a
  positive bootstrap lower bound;
- at least 10 clean Candidate task terminals;
- Candidate median case score no lower than Native;
- zero historical requirement regressions in every Candidate run; and
- valid continuity traces for every fully completed Candidate run, including both real
  compactions, a cold same-Session process restart, foreground child audit,
  revision continuity, durable receipts, and terminal echoes.

If any gate fails, the evidence is retained and no release or effect claim is
allowed. A passing result supports only this exact model, task, budget, Harness,
candidate package, and adapter. It does not establish a global ranking.

The public precommit and exclusive files prove the identity and integrity of
the disclosed run and prevent accidental duplicate execution. They do not
cryptographically prove that a malicious operator never deleted an earlier
local run. V28 therefore claims one publicly preregistered, operator-attested
disclosed trial, not a tamper-proof census of every private execution.

## Execution sequence

Set the non-secret artifact variables named by `long-system:v28:freeze`, plus
one unused absolute `PLAN_LATTICE_LONG_SYSTEM_V28_OUTPUT_ROOT` and one unused
`PLAN_LATTICE_LONG_SYSTEM_V28_RUN_ID`. Keep `DEEPSEEK_API_KEY` process-only.
Then:

1. Commit and publish all driver sources.
2. Run `pnpm long-system:v28:freeze` from that exact commit.
3. Commit only `eval/long-system/v28/frozen-manifest.json` as its direct child,
   create `v28-native-continuity-prereg-20260823` at that exact commit, and
   publish the commit and tag without moving the tag afterward.
4. Set `PLAN_LATTICE_LONG_SYSTEM_V28_MANIFEST_COMMIT` to the manifest commit
   and run `pnpm long-system:v28:preflight`.
5. Run `pnpm long-system:v28:run` exactly once.
6. Point `PLAN_LATTICE_LONG_SYSTEM_V28_OUTPUT` at `final-report.json` and run
   `pnpm long-system:v28:analyze`; publish only when it returns
   `releaseAllowed: true`.

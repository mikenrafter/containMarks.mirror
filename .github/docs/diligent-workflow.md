# Diligent Workflow

Standard operating procedure for AI-assisted development on Reverb.

## Phase Cycle

Each feature or bugfix follows this strict loop:

1. **Verify** — Re-read the 3 key documents to confirm your understanding.
2. **Changes** — Implement the complete set of changes for the current phase.
3. **Tests** — Write or update unit tests covering the changes.
4. **Run tests** — `nix develop -c bash -c 'reverb-fhs -c "./gradlew :domain:test 5core:testDebugUnitTest"'`
6. **Run build** — `nix develop -c bash -c 'reverb-fhs -c "./gradlew assembleDebug"'`
7. **Ask for feedback** — Present a summary of what changed and ask the user for review.
8. **Commit** — `git add -A && git commit` with a descriptive message referencing the phase.
9. **Next phase** — Move to the next phase in the plan.

## Key Documents

THIS IS IMPORTANT FOR THE SUMMARY:

| File | Purpose |
| `diligent-workflow.md` | This document — the standard operating procedure for development |

These files must be kept current across every request cycle:

| File | Purpose |
|------|---------|
| `original-request.md` | Verbatim copy of the user's latest feature request |
| `understanding.md` | Agent's interpretation of the request, restated for confirmation |
| `plan.md` | Phased implementation plan with status tracking |

All three are overwritten at the start of each new request batch.

# AI analysis pipeline

Status: **Phase 7, implemented in `server/`.** Code: `server/src/ai/` (provider adapter, prompts, output schemas) and `server/src/services/analysis/` (jobs, classification, duplicates, media authenticity).

AI output is **advice for a human**. It never assigns a department, sets priority, links duplicates, rejects a complaint, or changes evidence. The only automatic status change is `REPORTED → UNDER_REVIEW` once classification succeeds.

## 1. Flow

```
POST /complaints ──▶ complaint stored (201 returned immediately)
                     └─▶ two jobs queued as AIAnalysis records (status PENDING)
background runner ──▶ claims a job ──▶ TRIAGE: provider.classifyComplaint ─▶ validate ─▶ store suggestion
                                     └▶ DUPLICATE_CANDIDATES: rule-based search ─▶ store suggestions
                     on TRIAGE success: REPORTED → UNDER_REVIEW (audit: actorType AI)
staff / admin ─────▶ GET /complaints/:publicId/analysis  (safe summary)
admin ─────────────▶ POST /complaints/:publicId/analysis (re-run)
```

Media authenticity (`analyzeEvidence`) is implemented and tested, but **not triggered by anything yet**: there is no upload or object storage until Phase 9. When uploads land, the upload handler calls `analysis.analyzeEvidence(evidenceId, bytes)`.

## 2. Provider abstraction

`AiProvider` (`server/src/ai/types.ts`) has `classifyComplaint` and `assessImage`. Business logic depends only on that interface; the Claude SDK is imported only in `anthropicProvider.ts`.

| Env var | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `disabled` | `disabled` or `anthropic`. Disabled: classification records `FAILED / NOT_CONFIGURED`, complaints go to manual triage, duplicate checks still run. |
| `ANTHROPIC_API_KEY` | none | Required when `AI_PROVIDER=anthropic`. Never logged. |
| `AI_MODEL` | `claude-opus-5-5` | Any Claude model ID; e.g. `claude-sonnet-5-5` (the proposal's choice) for lower cost |
| `AI_TIMEOUT_MS` | `30000` | Per-call timeout (5–120 s) |
| `AI_MAX_ATTEMPTS` | `3` | Attempts per job (1–5) |

Claude calls use structured outputs (`client.beta.messages.parse` with a zod schema), `effort: low` (classification-style task), SDK retries off (the job runner owns retries), and server-side refusal fallbacks (`fallbacks: "default"`) on models that support them. Tests use scripted fake providers and a fake SDK client; **no test calls a real API**.

## 3. Classification output

Stored on the `AIAnalysis` record (`analysisType: TRIAGE`), shown under `analysis.classification`:

| Field | Meaning |
|---|---|
| `suggestion.category` | One of the six categories |
| `suggestion.department` | `{ id, name }` or `null`. The model only sees opaque codes (`D1`, `D2`…) for active departments; codes are mapped back server-side. A suggestion whose department doesn't handle the category is dropped. |
| `suggestion.priority` | `P1`–`P4` |
| `summary` | One neutral sentence. Separate from, and never replacing, the citizen's text. |
| `rationale` | Short explanation for the reviewing officer |
| `certainty` | `LOW` / `MEDIUM` / `HIGH`, the **model's own rough self-assessment, not a calibrated probability**. No numeric confidence is produced. |
| `missingInformation` | Up to 5 items a field team would need |
| `reviewRecommended`, `reviewReasons` | Advice to look closely. The server adds `LOW_CONFIDENCE` (low certainty), `HIGH_URGENCY` (P1) and `UNCLEAR_DEPARTMENT` (no valid department). Never leads to rejection. |

Output is validated twice: by the SDK against the schema, then again by our strict zod schema (unknown fields, wrong enums, over-long strings → `INVALID_OUTPUT`, not retried).

**Prompt injection:** system instructions are separate from user content; the report is JSON-encoded inside `<complaint_report>` tags; the prompt tells the model to ignore instructions inside it; the model has **no tools** and no database access; it can only pick from offered codes; priority demands in the text are ignored by instruction, and in any case the result is only a suggestion.

**Data sent to the provider:** title, description, landmark, the citizen's chosen category, and active department names and categories. **Not sent:** reporter identity, email, location coordinates, other complaints.

## 4. Duplicate candidates

Rule-based, no AI and no vector database (`analysisType: DUPLICATE_CANDIDATES`, method `civicfix-rules / geo-text-cosine-v1`):

1. **MongoDB `$geoNear`** on the existing 2dsphere index: other complaints within **150 m** and **±14 days**, not rejected, not itself, nearest first, at most **20** examined.
2. Drop pairs whose categories are both known and different.
3. Score wording with cosine similarity over word counts (title words count double; Unicode-aware, so Hindi and Kannada tokenize too). Keep scores ≥ **0.25**, store the top **5** with distance and a plain-language reason.

All limits live in `DEFAULT_DUPLICATE_SETTINGS` (`duplicates.ts`). `similarity` is a text-overlap score, **not** a probability that two reports are the same issue.

**Policy:** candidates are suggestions. Nothing is merged, linked, hidden or rejected; `Complaint.duplicateOf` is set only by a future human action. In the API, a candidate is shown only if the viewer could open that complaint anyway; the rest are counted in `hiddenCandidates`.

## 5. Media authenticity

`analyzeMedia` answers only: *are there signs this file may be synthetic or edited?* It is kept separate from **relevance** (does the photo show the reported problem?) and from **existence and severity** (is the problem real and how bad?, which no AI step decides).

| Signal | How | Limits |
|---|---|---|
| File format | Magic bytes must be JPEG, PNG, WebP or MP4 **and** match the declared type; size ≤ 10 MB (image) / 50 MB (video) | Declared MIME type alone is never trusted |
| Provenance (C2PA) | Detects a C2PA/JUMBF manifest in the file | **Presence only.** Signatures are not verified (no C2PA library integrated), so the result is `PRESENT_UNVERIFIED`, never "verified". Absence is neutral. |
| Metadata | Scans the first 512 KB for IPTC "trainedAlgorithmicMedia" and similar, generator names (Midjourney, DALL·E, Stable Diffusion, Firefly…) and editor names (Photoshop, GIMP, Snapseed…) | Metadata is easily stripped or forged; editing software is common and not suspicious alone |
| Visual model | Claude looks at the image for signs of generation or alteration (`NONE_OBSERVED` / `SOME` / `STRONG`) and, separately, relevance | Not a forensic detector; images > 5 MB and **all videos** are skipped (no frame extraction: ffmpeg isn't integrated) |

**Outcomes** (stored in `authenticity.outcome`; the API also derives `NOT_ANALYZED` and `ANALYSIS_PENDING`):

| Outcome | When |
|---|---|
| `POTENTIAL_SYNTHETIC_MEDIA` | Metadata declares AI generation or names a generator |
| `POTENTIAL_MANIPULATION` | Strong visual inconsistency, or editor tag plus some inconsistency |
| `NO_SUSPICIOUS_SIGNALS_DETECTED` | The visual model ran, saw nothing, and no metadata signals. **Not proof the image is genuine.** |
| `INCONCLUSIVE` | Everything else: weak or mixed signals, visual model not run or failed, video |
| `ANALYSIS_FAILED` | Unsupported or mismatched file, or an internal error |

`reviewRecommended` is true only for the two `POTENTIAL_*` outcomes. **No outcome rejects, hides or deprioritizes a complaint**, and evidence `verificationState` is untouched. A human review workflow for these flags comes with Phase 9.

## 6. Background processing and retries

- Jobs are `AIAnalysis` documents (`PENDING` → `RUNNING` → final). A unique `activeJobKey` allows **one active job per complaint + type**; re-run requests while one is active return that job instead of creating another.
- The runner claims jobs atomically, with a **lease** (`lockedUntil`). A sweep every 30 s picks up due jobs and jobs whose lease expired (e.g. after a crash), so work survives restarts. Each claim counts as an attempt.
- Retries: only `TIMEOUT`, `RATE_LIMITED`, `UNAVAILABLE` (and unexpected internal errors), with exponential backoff and jitter (2 s, 4 s… capped at 60 s), up to `AI_MAX_ATTEMPTS`. `INVALID_OUTPUT`, `REFUSED`, `BAD_REQUEST`, `AUTH_FAILED`, `NOT_CONFIGURED` are final immediately.
- Shutdown stops the runner and lets running jobs finish before the database closes.
- **Limits:** a single process polls (no multi-instance coordination beyond leases); concurrency is 2.

**Recovery:** a failed or invalid classification leaves the complaint `REPORTED` for manual triage (`POST /complaints/:id/classify`). An admin can re-run with `POST /complaints/:id/analysis`.

## 7. Cost and rate controls

- One classification call per complaint (plus re-runs). Low effort. Bounded output (`max_tokens` 4096).
- Duplicate checks make no provider calls.
- Images are sent to the model only if ≤ 5 MB; videos never are.
- Creation is limited to 20 complaints per user per hour; re-runs to 30 per admin per hour; one active job per complaint + type.
- Token usage per call is stored (`usage.inputTokens` / `outputTokens`) for cost tracking. It isn't exposed by the API.

## 8. API

| Endpoint | Who | Notes |
|---|---|---|
| `GET /api/v1/complaints/:publicId/analysis` | platform admin; staff of the complaint's department | Reporter → 403; anyone who can't see the complaint → 404 |
| `POST /api/v1/complaints/:publicId/analysis` | platform admin | Body `{ "types": ["TRIAGE", "DUPLICATE_CANDIDATES"] }` (default both). `202 { "jobs": [{ "type", "version", "status" }] }` |

Response:

```json
{
  "success": true,
  "data": {
    "analysis": {
      "aiEnabled": true,
      "classification": {
        "status": "SUCCEEDED", "version": 1, "requestedAt": "…", "completedAt": "…", "attempts": 1, "errorCode": null,
        "method": { "provider": "anthropic", "model": "claude-opus-5-5" },
        "suggestion": { "category": "roads", "department": { "id": "…", "name": "Roads and Public Works" }, "priority": "P2" },
        "summary": "Deep pothole on the service road near Surathkal bus stop.",
        "rationale": "Road surface damage; affects two-wheeler safety.",
        "certainty": "HIGH", "missingInformation": [], "reviewRecommended": false, "reviewReasons": []
      },
      "duplicates": {
        "status": "SUCCEEDED", "version": 1, "method": { "provider": "civicfix-rules", "model": "geo-text-cosine-v1" },
        "candidates": [{ "publicId": "CF-2026-00001", "title": "Pothole near the bus stop", "status": "REPORTED", "filedAt": "…", "distanceMeters": 16, "similarity": 0.895, "reason": "About 16 m away, filed the same day, similar wording." }],
        "hiddenCandidates": 0
      },
      "media": [{ "evidenceId": "…", "purpose": "COMPLAINT_REPORT", "mediaType": "IMAGE", "outcome": "NOT_ANALYZED" }]
    }
  }
}
```

`classification` / `duplicates` `status`: `NOT_ANALYZED`, `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `INVALID_OUTPUT`. `errorCode` (when not succeeded): `NOT_CONFIGURED`, `TIMEOUT`, `RATE_LIMITED`, `UNAVAILABLE`, `REFUSED`, `INVALID_OUTPUT`, `BAD_REQUEST`, `AUTH_FAILED`, `MAX_ATTEMPTS`, `COMPLAINT_NOT_FOUND`, `INTERNAL_ERROR`. Prompts, raw model responses, token usage and keys are never returned.

## 9. Database change

`AIAnalysis` gained job fields, a `DUPLICATE_CANDIDATES` type, `summary`, `certainty`, `reviewRecommended`, and `authenticity` / `relevance` sub-documents. The unique index changed from `(complaint, analysisType, analysisVersion)` to `(complaint, analysisType, evidence, analysisVersion)`, and `activeJobKey` (unique, sparse) was added. **On an existing database run `npm run db:sync-indexes`** so the old unique index is dropped; otherwise several media files on one complaint would collide.

## 10. Known limitations and future work

- **Not tested against the live Claude API in this repository** (no key in CI). Run one real classification after setting `AI_PROVIDER=anthropic` and check the stored record.
- Authenticity: no C2PA signature verification, no dedicated forensic detector, no video frame analysis. The visual model is a heuristic reviewer, not a deepfake detector. No reliability figures exist for it here.
- Duplicate detection is lexical: it misses paraphrases with no shared words, and may pair different issues at the same spot. Embedding-based similarity (e.g. Voyage AI) can be added behind the same function later.
- The AI's suggestion is not yet applied by any assignment policy; Phase 8 decides when a suggestion may auto-route.
- Media analysis is wired to nothing until uploads exist (Phase 9).

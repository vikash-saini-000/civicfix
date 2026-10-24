# AI analysis pipeline

Status: **Phase 7, implemented in `server/`; photo checks wired to uploads in Phase 9; AI suggestions feed the Phase 8 routing rules. Triage agent (§3a) and before/after verifier (§5a) added after Phase 12.** Code: `server/src/ai/` (provider adapter, prompts, output schemas) and `server/src/services/analysis/` (jobs, classification, triage agent, duplicates, media authenticity, photo metadata).

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

Media authenticity runs **at upload, before the file is stored** (the upload gate, `MEDIA_UPLOAD_GATE`): files flagged as AI-generated or edited are refused with `422 MEDIA_REJECTED`, and the result of an accepted file is stored as its `MEDIA_AUTHENTICITY` record (no second call). The background `MEDIA_AUTHENTICITY` job is only used when a file arrives without an upload-time result. Resolution verification treats flagged, unfinished or inconclusive checks as `UNCERTAIN`. When both TRIAGE and DUPLICATE_CANDIDATES finish, the Phase 8 rules decide whether to assign automatically ([ASSIGNMENTS_WORK_ORDERS.md](../api/ASSIGNMENTS_WORK_ORDERS.md)).

## 2. Provider abstraction

`AiProvider` (`server/src/ai/types.ts`) has `classifyComplaint` and `assessImage`, plus optional `runAgent` (bounded tool loop) and `compareResolution` (before/after photos). Business logic depends only on that interface; the Claude SDK is imported only in `anthropicProvider.ts`.

| Env var | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `disabled` | `disabled` or `anthropic`. Disabled: classification records `FAILED / NOT_CONFIGURED`, complaints go to manual triage, duplicate checks still run. |
| `ANTHROPIC_API_KEY` | none | Direct Anthropic API key. Set this **or** `AICREDITS_API_KEY` when `AI_PROVIDER=anthropic`, never both. Never logged. |
| `AICREDITS_API_KEY` | none | Prepaid AiCredits.in gateway key. Calls go to the fixed host `https://api.aicredits.in`. Requires an explicit `AI_MODEL` from the AiCredits catalog (e.g. `anthropic/claude-sonnet-4.6`). |
| `AI_MODEL` | `claude-opus-5-5` | Model ID; optional `vendor/` prefix for gateway IDs |
| `AI_TIMEOUT_MS` | `30000` | Per-call timeout (5–120 s) |
| `AI_MAX_ATTEMPTS` | `3` | Attempts per job (1–5) |
| `AI_TRIAGE_MODE` | `single` | `single`: one classification call. `agent`: the tool-using triage agent (§3a), several calls per complaint. |
| `AI_AGENT_MAX_TURNS` | `6` | Max model calls per agent run (2–10) |

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

## 3a. Triage agent (`AI_TRIAGE_MODE=agent`)

Instead of one classification call, Claude runs a **bounded tool-calling loop** (`runTriageAgent` in `services/analysis/triageAgent.ts`, loop in `anthropicProvider.ts → runAgent`). It plans with read-only backend tools, then submits one recommendation:

| Tool | Returns | Notes |
|---|---|---|
| `find_similar_complaints` | Nearby, similarly worded complaints as refs `C1…` (title, category, status, distance, similarity) | Same search as §4 |
| `get_department_workload` | Open / overdue work orders and staff with capacity for one department `D#` | Read-only |
| `list_available_staff` | Staff refs `S1…` with open work counts, least busy first | Same eligibility as automatic assignment (`staffCapacity.ts`): active members, active accounts, under the workload cap. No names. |
| `submit_triage` (final) | — | Classification fields (§3) plus `assigneeRef` (`S#` or null) and `likelyDuplicateRef` (`C#` or null) |

**Guardrails**
- Tools are read-only and scoped to the one complaint. The model only sees short refs (`D1`, `S1`, `C1`) issued during the run; database IDs, staff names and emails never reach it.
- Every tool input and the final answer are validated with zod. Invalid calls return a tool error (rejected values are not echoed back), so the model can correct them; unknown tools are refused; internal errors are reported only as "the tool failed".
- Limits: `AI_AGENT_MAX_TURNS` model calls, 5 tool calls per turn, 8 KB per tool result, an overall deadline inside the job lease, no SDK retries. Running out of turns or stopping without `submit_triage` (after one reminder) is `INVALID_OUTPUT`.
- Refs that weren't issued, or a staff ref from another department, are dropped. A likely duplicate adds `AMBIGUOUS_DUPLICATE`, so the case goes to review.
- **The agent decides nothing.** Its proposed assignee is used only if the Phase 8 rules would auto-assign anyway (high certainty, one department, no duplicates, not P1…) **and** that person still passes the capacity rules at commit time. Otherwise the rules pick or a human decides.
- Stored per run: `agentTrace` (turn count; tool name, success and duration per call; no arguments or results), `suggestedAssignee`, `likelyDuplicate`. Staff see them under `analysis.classification.agent`.
- Failures follow §6: the complaint stays `REPORTED` for manual triage. If the provider has no `runAgent`, or no department is active, triage falls back to the single call.

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
| File format | Magic bytes must be JPEG, PNG, WebP, MP4 or MOV **and** match the declared type (WebM recordings are converted to MP4 first); size ≤ 10 MB (image) / 50 MB (video), videos ≤ `MAX_VIDEO_SECONDS` | Declared MIME type alone is never trusted |
| Provenance (C2PA) | Detects a C2PA/JUMBF manifest in the file | **Presence only.** Signatures are not verified (no C2PA library integrated), so the result is `PRESENT_UNVERIFIED`, never "verified". Absence is neutral. |
| Metadata | Scans the first and last 512 KB (plus ffprobe tags for videos) for IPTC "trainedAlgorithmicMedia" and similar, generator names (Midjourney, DALL·E, Stable Diffusion, Firefly, Sora, Runway, Pika, Kling, Veo…) and editor names (Photoshop, GIMP, Snapseed, CapCut, InShot, Premiere…) | Metadata is easily stripped or forged; editing software is common and not suspicious alone (except in `strict` mode) |
| Visual model | Claude looks at the image for signs of generation or alteration (`NONE_OBSERVED` / `SOME` / `STRONG`) and, separately, relevance. **Videos:** 4 frames from across the clip go in one call (`assessVideo`, prompt `video-v2`), which also looks for morphing between frames and still images being zoomed/panned | Not a forensic detector; images > 5 MB are skipped; videos need ffmpeg |

**Outcomes** (stored in `authenticity.outcome`; the API also derives `NOT_ANALYZED` and `ANALYSIS_PENDING`):

| Outcome | When |
|---|---|
| `POTENTIAL_SYNTHETIC_MEDIA` | Metadata declares AI generation or names a generator |
| `POTENTIAL_MANIPULATION` | Strong visual inconsistency, or editor tag plus some inconsistency |
| `NO_SUSPICIOUS_SIGNALS_DETECTED` | The visual model ran, saw nothing, and no metadata signals. **Not proof the image is genuine.** |
| `INCONCLUSIVE` | Everything else: weak or mixed signals, visual model not run or failed, video without ffmpeg |
| `ANALYSIS_FAILED` | Unsupported or mismatched file, or an internal error |

`reviewRecommended` is true only for the two `POTENTIAL_*` outcomes.

**Upload gate** (`MEDIA_UPLOAD_GATE`):

| Gate | Refused at upload |
|---|---|
| `strict` | Both `POTENTIAL_*` outcomes, **and** files with any "some signs" visual finding or an editing-app tag |
| `block` (default) | Both `POTENTIAL_*` outcomes |
| `flag` | Nothing; flagged files are stored and marked for review |

A refused upload stores nothing and is audited as `evidence.rejected`. If the AI is unavailable the check is `INCONCLUSIVE` and the file is allowed (marked for review). No outcome rejects or hides the *complaint* itself.

## 5a. Before/after comparison (resolution evidence)

Every `RESOLUTION` photo also gets a `RESOLUTION_COMPARISON` job. Claude sees up to two of the citizen's own photos (`COMPLAINT_REPORT` / `ADDITIONAL`) as BEFORE and the submitted photo as AFTER, plus the complaint text and category, and answers `sameLocation`, `issueAppearsFixed` and `matchesCategory` (`YES` / `NO` / `UNCLEAR`) with a short note. Videos are compared through their middle frame (needs ffmpeg); images over 5 MB are recorded as `NOT_COMPARABLE`. One request carries at most 6 MB of image bytes (gateways such as AiCredits cap bodies at 10 MB). The result only feeds the verification rules ([EVIDENCE_VERIFICATION_DISPUTES.md](../api/EVIDENCE_VERIFICATION_DISPUTES.md) §2), where it can make the outcome more cautious but never approve. Staff see it per file under `analysis.media[].comparison`.

Uploads also read **capture time and GPS from JPEG EXIF** (`services/analysis/exif.ts`, no dependency, bounds-checked, first 512 KB only) into `Evidence.capturedAt` / `captureLocation`. These are uploader-controlled hints; they are never returned by evidence APIs.

## 6. Background processing and retries

- Jobs are `AIAnalysis` documents (`PENDING` → `RUNNING` → final). A unique `activeJobKey` allows **one active job per complaint + type**; re-run requests while one is active return that job instead of creating another.
- The runner claims jobs atomically, with a **lease** (`lockedUntil`). A sweep every 30 s picks up due jobs and jobs whose lease expired (e.g. after a crash), so work survives restarts. Each claim counts as an attempt.
- Retries: only `TIMEOUT`, `RATE_LIMITED`, `UNAVAILABLE` (and unexpected internal errors), with exponential backoff and jitter (2 s, 4 s… capped at 60 s), up to `AI_MAX_ATTEMPTS`. `INVALID_OUTPUT`, `REFUSED`, `BAD_REQUEST`, `AUTH_FAILED`, `NOT_CONFIGURED` are final immediately.
- Shutdown stops the runner and lets running jobs finish before the database closes.
- **Limits:** a single process polls (no multi-instance coordination beyond leases); concurrency is 2.

**Recovery:** a failed or invalid classification leaves the complaint `REPORTED` for manual triage (`POST /complaints/:id/classify`). An admin can re-run with `POST /complaints/:id/analysis`.

## 7. Cost and rate controls

- One classification call per complaint (plus re-runs) in `single` mode; up to `AI_AGENT_MAX_TURNS` calls in `agent` mode (typically 3–4). Low effort. Bounded output (`max_tokens` 4096).
- One comparison call per resolution photo, in addition to its authenticity call.
- Duplicate checks make no provider calls.
- Images are sent to the model only if ≤ 5 MB. A video costs one authenticity call (4 frames), up to 12 privacy-detection calls (one per sampled frame) and, for resolution videos, one comparison call.
- The upload-time check is cached by file hash for 30 minutes, so the report form's pre-check and the real upload cost one call.
- Out-of-credit or over-budget gateway responses (HTTP 402 / `billing_error`) are recorded as `CREDITS_EXHAUSTED` and not retried; admins can use **Re-run AI** once credits are topped up.
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
        "certainty": "HIGH", "missingInformation": [], "reviewRecommended": false, "reviewReasons": [],
        "mode": "agent",
        "agent": {
          "turns": 4,
          "toolCalls": [{ "tool": "find_similar_complaints", "ok": true, "ms": 12 }, { "tool": "get_department_workload", "ok": true, "ms": 9 }, { "tool": "list_available_staff", "ok": true, "ms": 8 }, { "tool": "submit_triage", "ok": true, "ms": 0 }],
          "proposedAssignee": { "id": "…", "name": "Ravi K" },
          "likelyDuplicate": null
        }
      },
      "duplicates": {
        "status": "SUCCEEDED", "version": 1, "method": { "provider": "civicfix-rules", "model": "geo-text-cosine-v1" },
        "candidates": [{ "publicId": "CF-2026-00001", "title": "Pothole near the bus stop", "status": "REPORTED", "filedAt": "…", "distanceMeters": 16, "similarity": 0.895, "reason": "About 16 m away, filed the same day, similar wording." }],
        "hiddenCandidates": 0
      },
      "media": [
        { "evidenceId": "…", "purpose": "COMPLAINT_REPORT", "mediaType": "IMAGE", "outcome": "NOT_ANALYZED" },
        { "evidenceId": "…", "purpose": "RESOLUTION", "mediaType": "IMAGE", "outcome": "NO_SUSPICIOUS_SIGNALS_DETECTED",
          "comparison": { "status": "DONE", "sameLocation": "YES", "issueAppearsFixed": "YES", "matchesCategory": "YES", "notes": "Pothole filled; same kerb and pole.", "beforePhotos": 1 } }
      ]
    }
  }
}
```

`mode` is `single` or `agent`; `agent` is null in single mode. `likelyDuplicate.publicId` is null when the viewer can't open that complaint. `comparison.status` is `PENDING`, `DONE` or `NOT_COMPARED` (with `errorCode`).

`classification` / `duplicates` `status`: `NOT_ANALYZED`, `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `INVALID_OUTPUT`. `errorCode` (when not succeeded): `NOT_CONFIGURED`, `TIMEOUT`, `RATE_LIMITED`, `UNAVAILABLE`, `REFUSED`, `INVALID_OUTPUT`, `BAD_REQUEST`, `AUTH_FAILED`, `MAX_ATTEMPTS`, `COMPLAINT_NOT_FOUND`, `INTERNAL_ERROR`. Prompts, raw model responses, token usage and keys are never returned.

## 9. Database change

`AIAnalysis` gained job fields, a `DUPLICATE_CANDIDATES` type, `summary`, `certainty`, `reviewRecommended`, and `authenticity` / `relevance` sub-documents. The unique index changed from `(complaint, analysisType, analysisVersion)` to `(complaint, analysisType, evidence, analysisVersion)`, and `activeJobKey` (unique, sparse) was added. **On an existing database run `npm run db:sync-indexes`** so the old unique index is dropped; otherwise several media files on one complaint would collide.

## 10. Known limitations and future work

- **Not tested against the live Claude API in this repository** (no key in CI). Run one real classification after setting `AI_PROVIDER=anthropic` and check the stored record. Through AiCredits.in, structured outputs, tool use and image input are not documented by the gateway and must be confirmed with `npm run ai:live`.
- The agent doesn't ask the citizen follow-up questions; missing details are stored in `missingInformation` for staff.
- Photo GPS is often stripped by phones and browsers; without it the verifier can't confirm the location and a human must check (`requireCaptureLocation`). EXIF is read from JPEG only, and EXIF times usually lack a time zone (14 h slack).
- The before/after comparison describes what is visible; it can't judge whether a repair is safe or durable.
- Authenticity: no C2PA signature verification, no dedicated forensic detector; videos are judged from 4 sampled frames. The visual model is a heuristic reviewer, not a deepfake detector. No reliability figures exist for it here.
- Duplicate detection is lexical: it misses paraphrases with no shared words, and may pair different issues at the same spot. Embedding-based similarity (e.g. Voyage AI) can be added behind the same function later.
- The AI's suggestion is not yet applied by any assignment policy; Phase 8 decides when a suggestion may auto-route.
- Media analysis is wired to nothing until uploads exist (Phase 9).

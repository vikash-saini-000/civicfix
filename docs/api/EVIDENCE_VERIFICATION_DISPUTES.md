# Evidence, resolution verification, disputes

Status: **Phase 9, implemented in `server/`.** Builds on [ASSIGNMENTS_WORK_ORDERS.md](ASSIGNMENTS_WORK_ORDERS.md). Conventions: [API_CONVENTIONS.md](API_CONVENTIONS.md).

## 1. Evidence files

### Storage

| `STORAGE_PROVIDER` | Behaviour |
|---|---|
| `disabled` (default) | Uploads return **503 SERVICE_UNAVAILABLE**. Nothing is faked. |
| `local` | Files are written under `STORAGE_LOCAL_DIR` (default `./uploads`, gitignored). For development and single-server demos. |

Cloud storage (S3, GCS, Azure Blob) can implement the same small interface (`server/src/storage/index.ts`); it isn't integrated. The database stores only metadata and an internal key. **Keys, paths and URLs to storage are never returned by the API**; downloads go through an access-checked endpoint.

### POST /api/v1/complaints/:publicId/evidence

The **raw file is the request body**; it's not JSON or multipart.

```http
POST /api/v1/complaints/CF-2026-00012/evidence?purpose=RESOLUTION&caption=After%20repair
Authorization: Bearer …
Content-Type: image/jpeg

<bytes>
```

```ts
await fetch(`${API}/complaints/${id}/evidence?purpose=ADDITIONAL`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
  body: file,
});
```

| Query | Rules |
|---|---|
| `purpose` | `COMPLAINT_REPORT`, `ADDITIONAL`, `WORK_PROGRESS`, `RESOLUTION`, `DISPUTE` |
| `caption` | Optional, up to 300 characters |
| `disputeId` | Required for `DISPUTE` |

| Purpose | Who | When |
|---|---|---|
| `COMPLAINT_REPORT` | reporter | complaint `REPORTED` / `UNDER_REVIEW` |
| `ADDITIONAL` | reporter | until closed or rejected |
| `WORK_PROGRESS` | assignee | work order `ACCEPTED`, `IN_PROGRESS`, `BLOCKED` |
| `RESOLUTION` | assignee | work order `IN_PROGRESS`, `VERIFICATION_REQUIRED` |
| `DISPUTE` | reporter | for their own open dispute |

**File rules:** JPEG, PNG, WebP up to 10 MB; MP4 and MOV up to 50 MB and `MAX_VIDEO_SECONDS` (default 60). WebM (browser recordings) is accepted and converted to MP4 with ffmpeg before anything else.
- The type is checked from the file's **actual bytes** and must match `Content-Type` (MP4 and MOV labels are interchangeable). Client file names and declared types are never trusted.
- At most 30 files per complaint, and 60 uploads per user per hour.

**In-app camera stamp** (required when `EVIDENCE_CAPTURE=camera`, the default):

| Header | Value |
|---|---|
| `X-Capture-Token` | Token from `POST /api/v1/evidence/capture-sessions` (same user, not expired) |
| `X-Captured-At` | ISO time on the device when the photo was taken / recording started; must fall inside the session |
| `X-Capture-Lat`, `X-Capture-Lng` | Optional GPS at capture time |
| `X-Capture-Accuracy` | Optional GPS accuracy in metres; fixes worse than 500 m are ignored |

The stamp's time and GPS become the evidence's `capturedAt` / capture location (used by the 50 m and timing checks), and the evidence gets `captureMethod: "IN_APP_CAMERA"`. Without a stamp (only allowed with `EVIDENCE_CAPTURE=any`) it is `FILE_UPLOAD` and time/GPS come from the file's EXIF or video tags.

**Authenticity check before storing:** see [AI_ANALYSIS_PIPELINE.md](../ai/AI_ANALYSIS_PIPELINE.md). With `MEDIA_UPLOAD_GATE=block` (default) files flagged as AI-generated or edited are refused; `strict` also refuses files with only some signs of editing; `flag` stores everything and marks it for review. Refusals are audited as `evidence.rejected`; the message to the uploader is deliberately general.

Errors: `415` (wrong or mismatched type, unreadable video, empty body), `413` (too large or too long), `422 CAPTURE_REQUIRED` (no or invalid camera stamp), `422 MEDIA_REJECTED` (looks AI-generated or edited; nothing stored), `403` / `404` / `409` (rules above), `503` (storage off, or video tools temporarily failing).

`201` and `Location: /api/v1/evidence/<id>/content`:

```json
{ "success": true, "data": { "evidence": {
  "id": "6adc…", "purpose": "RESOLUTION", "mediaType": "IMAGE", "contentType": "image/jpeg", "sizeBytes": 482113,
  "sha256": "9f2c…", "caption": "After repair", "uploadedBy": { "id": "…", "isReporter": false },
  "workOrderId": "…", "disputeId": null, "createdAt": "…", "contentUrl": "/api/v1/evidence/6adc…/content",
  "durationSec": null, "captureMethod": "IN_APP_CAMERA",
  "authenticity": "NO_SUSPICIOUS_SIGNALS_DETECTED"
} } }
```

`authenticity` is the result of the upload-time check, shown to staff and admins only, never to citizens. Each upload also queues the shareable privacy copy and, for `RESOLUTION` files, the before/after comparison.

### POST /api/v1/evidence/check

Same body and headers as an upload, without a complaint: used by the report form to refuse a file **before** the complaint is created. Stores nothing. `200 { "allowed": true, "message": null }` or `200 { "allowed": false, "message": "…" }`. The result is cached by file hash, so the real upload doesn't repeat the AI call.

### GET /api/v1/evidence/capture-policy

`{ "captureMode": "camera" | "any", "maxVideoSeconds": 60, "cameraSessions": true }`. Any signed-in user.

### POST /api/v1/evidence/capture-sessions

No body. `201 { "token": "…", "expiresAt": "…", "captureMode": "camera", "maxVideoSeconds": 60 }`. Call it when the camera opens; every capture in that session is uploaded with the token. Rate-limited like uploads.

### GET /api/v1/complaints/:publicId/evidence

Metadata list for the reporter, staff of the complaint's department, and admins. Others get 404.

### GET /api/v1/evidence/:id/content

The file bytes, with `Cache-Control: private, no-store` and `Content-Disposition: attachment`. Same access rule as the complaint; anything else is 404. Every download is audited (`evidence.downloaded`). The frontend must fetch it with the bearer header (e.g. into a blob URL); it isn't a public link.

## 2. Resolution and verification

### POST /api/v1/work-orders/:id/resolution (assignee)

```json
{ "completionNotes": "Filled and compacted the pothole with asphalt.", "evidenceIds": ["6adc…"] }
```

- **Rules:** `completionNotes` is 10–2000 characters. `evidenceIds` takes 1–10 IDs, each a `RESOLUTION` file uploaded for this work order.
- **Allowed** when the work order is `IN_PROGRESS`, or `VERIFICATION_REQUIRED` (resubmitting with more evidence).
- **Result:** the work order and complaint go to `RESOLUTION_SUBMITTED`. **This is not resolved.**

Then rule-based checks run (policy `verify-v2`). The result is stored as an `AIAnalysis` record of type `RESOLUTION_VERIFICATION`, and returned:

```json
{ "success": true, "data": { "workOrder": { … }, "assessment": { "outcome": "UNCERTAIN", "reasons": ["Authenticity checks have not finished for every file."], "missingEvidence": [] } } }
```

| Check | Outcome if it fails |
|---|---|
| At least 1 resolution file | `INSUFFICIENT` |
| Every file uploaded after the work was assigned | `INSUFFICIENT` |
| Every file's authenticity check finished with `NO_SUSPICIOUS_SIGNALS_DETECTED` | `UNCERTAIN` (flagged, pending, or inconclusive) |
| Every file has GPS within **50 m** of the reported location (`maxCaptureDistanceMeters`) | `UNCERTAIN` (too far, with the distance; or no GPS when `requireCaptureLocation`) |
| No file's capture time is more than 14 h before the assignment (EXIF times often lack a time zone) | `UNCERTAIN` |
| Every file's before/after comparison finished and shows the issue fixed, at the same place, matching the category (`requireVisualComparison`) | `UNCERTAIN` (pending, not comparable, failed, `NO`, or fix `UNCLEAR`) |

- **`SUFFICIENT`**: stays `RESOLUTION_SUBMITTED` for a human verifier. Auto-approval only happens if `AUTO_APPROVE_RESOLUTIONS=true` (off by default; product-owner decision).
- **`UNCERTAIN` / `INSUFFICIENT`**: moves to `VERIFICATION_REQUIRED` (flagged for the verifier).

AI results and photo metadata can only make the outcome more cautious; nothing approves a fix because a photo "looks fixed". A photo never proves a repair is safe, complete or durable. GPS and capture time come from the uploaded JPEG's EXIF (stored on the evidence record, never returned by these APIs); they are uploader-controlled hints, so a match is not proof either. The new policy values (50 m, GPS required, comparison required) need product-owner sign-off.

### POST /api/v1/work-orders/:id/verification (verifier)

```json
{ "decision": "APPROVE", "reason": "Photos match the location; surface level." }
```

The **verifier** is a manager of the department or an admin, and **not the assignee**.

| Decision | Work order | Complaint |
|---|---|---|
| `APPROVE` | COMPLETED | RESOLVED (`resolvedAt` set) |
| `REJECT` | IN_PROGRESS (rework) | IN_PROGRESS |
| `REQUEST_EVIDENCE` | VERIFICATION_REQUIRED | VERIFICATION_REQUIRED; the assignee adds files and resubmits |

- `409` if there is nothing to verify, or more evidence was already requested.
- The decision is stored on `workOrder.verificationDecision` (with `source: VERIFIER` or `SYSTEM_POLICY`) and audited.

## 3. Disputes (citizen challenges a resolution)

| Endpoint | Who |
|---|---|
| `POST /api/v1/complaints/:publicId/disputes` | reporter. Complaint must be `RESOLVED`, within **14 days** (`DISPUTE_WINDOW_DAYS`) |
| `GET /api/v1/disputes?scope=mine\|department\|all&status=OPEN,UNDER_REVIEW` | `mine` = mine; `department` = staff of the work order's department; `all` = admins |
| `GET /api/v1/disputes/:id` | reporter, the complaint's department staff, admins (else 404) |
| `POST /api/v1/disputes/:id/review` | department manager or admin: `OPEN` → `UNDER_REVIEW` |
| `POST /api/v1/disputes/:id/decision` | department manager or admin |
| `POST /api/v1/disputes/:id/withdraw` | the reporter |

Create:

```json
{ "reason": "The pothole opened up again after the rain.", "category": "NOT_FIXED" }
```

`category`: `NOT_FIXED` (default), `POOR_QUALITY`, `WRONG_LOCATION`, `OTHER`. **One open dispute per complaint** (a unique index; concurrent attempts get 409). The dispute stores an unchangeable snapshot of the disputed resolution: completion notes, times, verification record, evidence IDs.

Decision:

```json
{ "decision": "UPHOLD", "reason": "Site check shows it reopened." }
```

- **`UPHOLD`** → dispute `UPHELD`, the work order reopens (`COMPLETED` → `IN_PROGRESS`, `reopenedCount` + 1), complaint → `IN_PROGRESS`.
- **`DISMISS`** → `DISMISSED`; the complaint stays `RESOLVED`.
- **Final:** a second decision gets 409. History and the original evidence are never deleted.

While a dispute is `OPEN` or `UNDER_REVIEW`, the complaint **cannot be closed**.

## 4. Closing and feedback

`POST /api/v1/complaints/:publicId/close` (empty body):
- **Reporter:** any time after `RESOLVED` (confirms the fix).
- **Department manager or admin:** only once the dispute window has passed.
- Never while a dispute is open. The complaint goes to `CLOSED` (`closedAt` set).

`POST /api/v1/complaints/:publicId/feedback` (reporter, after `RESOLVED`): `{ "rating": 1-5, "comment": "optional" }`, once per complaint (second time is 409).

## 5. Audit

`evidence.uploaded`, `evidence.rejected`, `evidence.downloaded`, `work_order.submit_resolution`, `work_order.require_verification`, `work_order.approve`, `work_order.reject_resolution`, `work_order.reopen`, `dispute.created`, `dispute.review_started`, `dispute.decided`, `dispute.withdrawn`, `complaint.closed`, `feedback.created`.

## 6. Limitations and decisions needed

- **Storage:** only local disk. Production needs a cloud provider implementation and backups. There's no virus scanning; files are never executed or transformed. If storing the database record fails after the file was written, the file is deleted.
- **Needs product-owner approval:** auto-approval (off by default), the 14-day dispute window, and the minimum evidence count.
- **Video:** needs ffmpeg. The authenticity check looks at 4 frames; the privacy blur samples frames about every 2 s (up to 12), so a face that appears only between samples can be missed. Without ffmpeg, videos get metadata checks only.
- **Camera stamp:** raises the bar (old or downloaded files can't be passed off as taken now in the app) but it is not proof; a determined person can script the API. The AI check runs regardless.
- **Same-person review:** the reviewer of a dispute may be the same manager who approved the resolution. There's no separation-of-duties rule yet.

# Cloud Cost Review Portal — Phase 1 Design Spec

## Overview

A new, standalone multi-tenant web application where Cloud Assist One's client companies upload AWS and Azure billing exports and get live cost/usage reports (graphs, breakdowns, day/week/month views), and Cloud Assist One staff review that spend, leaving notes, voice notes, and follow-up todos that are visible to the client. A time-tracking log shows the client how much staff time has gone into reviewing their account.

This is Phase 1 of a larger product. Later phases (specced separately when it's time to build them):
1. Cost ingestion, reporting, and review workflow *(this spec)*
2. Subscription billing / paid access gating
3. AI-driven automation (anomaly detection, auto-generated notes/todos, etc.)

## Goals

- Let a client company upload an AWS Cost Explorer export or an Azure Cost Management export and see it turned into a live report within the portal.
- Separate AWS and Azure reporting into their own tabs, plus a side-by-side comparison view.
- Let the client filter any report by day, week, or month.
- Let Cloud Assist One staff attach notes, voice notes, and todos to specific expenses or date ranges, visible to the client.
- Let the client see a log of staff time spent reviewing their account.
- Support multiple client companies from day one, each seeing only their own data, with Cloud Assist One staff able to see across all companies.

## Non-goals (Phase 1)

- No subscription billing or payment gating — every logged-in user has full access to their company's data for now (see Phase 2).
- No AI-driven automation — notes, todos, and time entries are all staff-entered by hand (see Phase 3).
- No support for billing file formats beyond AWS Cost Explorer exports and Azure Cost Management exports. Other formats (e.g. detailed AWS CUR) are out of scope until a real need arises.
- No automated/scheduled ingestion (e.g. pulling directly from an AWS/Azure API) — upload is manual, by either the client or Cloud Assist One staff.
- No client-side editing of cost data — uploaded numbers are read-only once parsed; a bad upload is fixed by re-uploading, not by editing rows in place.

## Technical constraints

- **Stack**: Next.js (App Router) + Supabase (Postgres + Auth + Storage) + Vercel, matching the pattern already proven on the Cloud Assist One AI training portal.
- **New project**: this lives in its own repository (`Cloud Assist One Cloud Costs`), not inside the existing marketing-site or training-portal codebases.
- Voice notes are recorded in-browser (MediaRecorder API) and stored as audio files in Supabase Storage — no third-party transcription service in this phase.

## Architecture

- **Multi-tenancy**: a `companies` table; every user belongs to a company via `profiles.company_id`, except Cloud Assist One staff, whose `profiles.company_id` is `null` and whose `role = 'staff'` lets them read/write across every company. Row Level Security enforces this at the database level — a client user can only ever see rows where `company_id` matches their own.
- **Ingestion**: upload picks a cloud provider (AWS or Azure) and a file. The file is stored in Supabase Storage, then a server-side Route Handler parses it (`xlsx` library) into normalized rows written to `cost_records`. Reports are computed with SQL aggregations over `cost_records`, not by re-parsing Excel on every view.
- **Auth**: Supabase email/password auth, same session-handling pattern (`@supabase/ssr`) as the training portal. No public self-signup — Cloud Assist One staff create accounts for both new client users and new staff members.

## Data model

### `companies`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `name` | text | |
| `created_at` | timestamptz | default `now()` |

### `profiles`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | FK → `auth.users.id` |
| `company_id` | uuid, nullable | FK → `companies.id`; `null` for Cloud Assist One staff |
| `email` | text | |
| `role` | text | `'client'` \| `'staff'` |
| `created_at` | timestamptz | default `now()` |

Populated by the same auth-trigger pattern as the training portal (a row is created automatically when an account is created via the admin tool; `company_id`/`role` are set by whichever staff member creates the account).

### `uploaded_files`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `company_id` | uuid | FK → `companies.id` |
| `cloud_provider` | text | `'aws'` \| `'azure'` |
| `filename` | text | original filename, for display |
| `storage_path` | text | path within the `billing-files` bucket |
| `status` | text | `'processing'` \| `'processed'` \| `'error'` |
| `error_message` | text, nullable | set when `status = 'error'` |
| `row_count` | integer, nullable | set once processing completes |
| `uploaded_by` | uuid | FK → `profiles.id` |
| `created_at` | timestamptz | default `now()` |

### `cost_records`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `company_id` | uuid | FK → `companies.id` |
| `cloud_provider` | text | `'aws'` \| `'azure'` |
| `service_name` | text | e.g. "Amazon EC2", "Azure App Service" |
| `usage_date` | date | |
| `cost` | numeric | |
| `account_id` | text, nullable | AWS account ID or Azure subscription ID, if present in the export |
| `source_file_id` | uuid | FK → `uploaded_files.id` |
| `created_at` | timestamptz | default `now()` |

### `review_notes`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `company_id` | uuid | FK → `companies.id` |
| `cost_record_id` | uuid, nullable | FK → `cost_records.id`; `null` = a general note, not tied to one line item |
| `author_id` | uuid | FK → `profiles.id`, always a staff member |
| `note_text` | text, nullable | |
| `voice_note_path` | text, nullable | path within the `voice-notes` bucket |
| `created_at` | timestamptz | default `now()` |

A note has `note_text`, `voice_note_path`, or both.

### `review_todos`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `company_id` | uuid | FK → `companies.id` |
| `cost_record_id` | uuid, nullable | FK → `cost_records.id` |
| `title` | text | |
| `status` | text | `'open'` \| `'done'` |
| `created_by` | uuid | FK → `profiles.id`, always staff |
| `created_at` | timestamptz | default `now()` |
| `completed_at` | timestamptz, nullable | |

### `time_entries`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `company_id` | uuid | FK → `companies.id` |
| `staff_id` | uuid | FK → `profiles.id` |
| `entry_date` | date | |
| `minutes_spent` | integer | |
| `description` | text | shown to the client, e.g. "Reviewed EC2 cost spike in July" |
| `created_at` | timestamptz | default `now()` |

## Row Level Security

- All six tables (excluding `companies`, `profiles` which have their own narrower rules) follow the same shape: `role = 'staff'` can read/write every row; `role = 'client'` can only read/write rows where `company_id` matches their own `profiles.company_id`.
- Clients can read `review_notes`, `review_todos`, and `time_entries` for their company but cannot create or edit them — those are staff-authored.
- Clients can create `uploaded_files` (their own uploads) and read `cost_records` for their company, but cannot directly insert/edit `cost_records` — those are only ever written by the server-side parsing route.
- `profiles`: a user can read their own row; staff can read all profiles. Only staff can create new profiles (via an admin-style account-creation flow, same service-role pattern as the training portal).

## Ingestion flow

1. User (client or staff, viewing a specific company) goes to the Upload area, picks a cloud provider, and selects a file.
2. File uploads to Supabase Storage (`billing-files/{company_id}/...`); an `uploaded_files` row is created with `status = 'processing'`.
3. A server Route Handler parses the file (`xlsx`) into rows, validating that required columns are present. Valid rows are inserted into `cost_records` tagged with `company_id`, `cloud_provider`, and `source_file_id`.
4. On success, `uploaded_files.status` flips to `'processed'` and `row_count` is set. On failure (missing columns, unreadable file), it flips to `'error'` with a human-readable `error_message` — the upload is not silently dropped.

## Portal UI

- **Login**: same pattern as the training portal (email/password, forgot-password flow).
- **Tabs**: **AWS**, **Azure**, **Compare**, **Uploaded Files**, **Notes & Follow-ups**.
  - **AWS** / **Azure**: a day/week/month date-range picker (defaulting to the current month), a total-cost summary, a cost-over-time chart, a cost-by-service breakdown (chart + table).
  - **Compare**: AWS vs. Azure totals over the same date range, plus category-level comparison where service names overlap meaningfully.
  - **Uploaded Files**: every upload for the company, with status, row count, and upload date. Staff (or the client) can re-upload to correct an error.
  - **Notes & Follow-ups**: a chronological feed of notes (text/voice) and todos (open/done), each optionally linked to a specific cost record. A time-tracking summary ("X hours reviewed this month") sits alongside it.
- **Staff view**: staff select which company they're viewing (a company switcher), then see the same tabs as that company's clients, plus the ability to create notes/voice notes/todos/time entries and upload files on the client's behalf.
- **Admin (staff-only)**: create/manage company records and user accounts (client and staff), mirroring the training portal's Admin tab pattern.

## Environment & deployment

- New Supabase project (separate from the training portal's — this is an unrelated product with its own data).
- New Vercel project, deployed from this repo's own GitHub repository.
- Env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only), following the exact same handling conventions established on the training portal (trimmed on read, never logged, `.env.local` gitignored).

## Testing

- Unit/component tests (Jest + Testing Library) for the Excel-parsing logic (valid file, missing-column file, empty file), report aggregation logic, and each interactive component (upload flow, note/todo creation, date-range picker).
- RLS policies verified via Supabase's security advisor after migration, plus a manual pass confirming a client from Company A cannot see Company B's data.
- Manual end-to-end pass before considering a milestone done: upload an AWS file and an Azure file as a client, confirm both report tabs populate correctly, confirm the Compare tab; switch to a staff account, leave a note/voice note/todo, log time, and confirm all of it appears in the client's Notes & Follow-ups tab.

## Future work (explicitly out of scope now)

- Subscription billing / payment gating (Phase 2).
- AI-driven automation — anomaly detection, auto-generated notes or todos, natural-language summaries (Phase 3).
- Support for additional billing file formats (e.g. detailed AWS CUR, GCP).
- Scheduled/automatic ingestion directly from cloud provider APIs, instead of manual file upload.
- Voice note transcription.

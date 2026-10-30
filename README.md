# Turnaround Daily Report

A lightweight daily shift reporting tool for refinery turnaround teams, with plant selection for OL1, CTU, and TFJ, and work package selection for MS03 Drum and MS04 Tower. The online version uses Supabase authentication and a shared database for invited team members.

## Run

The online version requires an internet connection and a valid Supabase team account.

Dates displayed in reports and schedules use the English `dd/Mon/yyyy` format (for example, `01/Jan/2026`). Browser date inputs and stored values retain their native ISO date format.

## Configure shared Supabase access

1. In Supabase **SQL Editor**, run the contents of `supabase-setup.sql`.
2. Before running it, add each team member's lowercase email in the commented `insert into public.turnaround_team_members...` statement near the end. Only allowlisted emails can read or change the shared tables, even if another user manages to authenticate.
3. In Supabase **Authentication → Users**, invite those same team email addresses. Users sign in to the app through a one-time email link.
4. In Supabase **Authentication → URL Configuration**, set the Site URL to the published website URL and add that URL to the allowed Redirect URLs. For GitHub Pages, the URL is usually `https://<account>.github.io/<repository>/`.
5. `supabase-config.js` contains the Supabase Project URL and publishable key. Publishable keys are intended for browser use; never put a `service_role` or secret key in this project.

## Publish online with GitHub Pages

This project includes the GitHub Actions workflow `.github/workflows/deploy-pages.yml`.

1. Create a GitHub repository and upload `index.html`, `app.js`, `styles.css`, `master-schedule.js`, `supabase-config.js`, and `.github/workflows/deploy-pages.yml` to its `main` or `master` branch.
2. In the repository, open **Settings → Pages** and set the source to **GitHub Actions**.
3. Wait for **Deploy static site to GitHub Pages** in the **Actions** tab. Share the published URL with invited team members.

Reports, actual progress, equipment overrides, and Tower activity statuses are stored in the shared Supabase project. Local browser data is merged into the cloud on first sign-in in that website origin; data stored while opening the old `file://` page is isolated and does not automatically transfer. Check Supabase RLS policies and team allowlist before inviting users or entering operational data.

## Workflow

1. Fill in the report date, shift, Plant, Work Package, preparer, and overall status.
2. Record equipment milestones, completed work, and the next shift plan. In the Activity field, enter one task per line to capture multiple activities for a shift in a single row. Equipment choices follow the selected Work Package (Tower or Drum); Planned Start and Plan Finish auto-fill from the imported schedule, while actual dates remain manual.
3. Use **Open issues & actions** for blockers or follow-ups, with a countermeasure, owner, and due date. Use **Handover notes** only for important information not already captured in the tables.
4. The **Activity-level progress** table is optional and collapsed by default; use it only when a concise critical-activity percentage breakdown is needed.
5. Save the report to the local browser archive. Use **Export for Excel (.csv)** or **Print / save as PDF** for a shareable copy; the PDF includes the S-curve for the report's selected Work Package.
6. Use **Progress S-curve** to compare the MNT-day-weighted plan and actual for a Work Package. Planned progress is interpolated between maintenance start and finish dates; actual progress is weighted by MNT use days. A vertical **Today** marker shows the current date on the timeline.
7. Expand **Actual progress by equipment** to enter equipment completion by date. Use **Edit** on an equipment row to change that equipment's Area, Unit, MNT start/finish plan, Actual Start/Finish, or MNT use days, then select **Save** on the same row. Each equipment record is saved independently in this browser, and Actual Start/Finish are also shown in the equipment schedule. Actual Finish cannot be earlier than Actual Start. **Save actuals** separately saves completion by date. Unreported equipment counts as 0% until its first update, then the latest value carries forward. Actuals and equipment edits are saved per Work Package, independent of Plant; the entry table is not included in daily-report exports.
8. Expand **Equipment & activity plan** to browse the imported Master Schedule Plan and the MS03 Drum / MS04 Tower equipment schedules. In the MS04 Tower schedule's Daily activities list, set each activity to **Not started** (white), **Ongoing** (yellow), or **Done** (green); each status saves automatically in this browser. Choose a date in the archive to view saved report details.

Reports are stored in the browser's local storage on the current device. Clearing browser data or switching browsers/devices will remove or hide that archive. Use the export actions to keep a separate copy.

The bundled schedule data was read from `Master Schedule Plan`, `Drum Package CR3`, and `Tower Package CR3` in `Master Schedule of all Tower Drum_22Oct26.xlsx`. The original Area/Unit values are retained as schedule metadata and are not automatically mapped to the daily-report Plant field. The planned S-curve is calculated from maintenance plan start/finish dates with MNT use days as equipment weights. Actual equipment readings are stored separately from daily report summaries in this browser.

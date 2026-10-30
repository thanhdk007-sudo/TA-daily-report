# Turnaround Daily Report

A lightweight daily shift reporting tool for refinery turnaround teams, with plant selection for OL1, CTU, and TFJ, and work package selection for MS03 Drum and MS04 Tower. The online version uses Supabase as a shared database that anyone can access without signing in.

## Run

The online version requires an internet connection. No account is needed to open the shared workspace.

Dates displayed in reports and schedules use the English `dd/Mon/yyyy` format (for example, `01/Jan/2026`). Browser date inputs and stored values retain their native ISO date format.

## Configure public link access

1. In Supabase **SQL Editor**, run the contents of `supabase-setup.sql`.
2. The script grants anonymous users read/write access to the shared report tables. Anyone who can reach the website can view, add, change, or delete shared data; the URL is not a private password.
3. `supabase-config.js` contains the Supabase Project URL and publishable key. Publishable keys are intended for browser use; never put a `service_role` or secret key in this project.

## Publish online with GitHub Pages

This project includes the GitHub Actions workflow `.github/workflows/deploy-pages.yml`.

1. Create a GitHub repository and upload `index.html`, `app.js`, `styles.css`, `master-schedule.js`, `supabase-config.js`, and `.github/workflows/deploy-pages.yml` to its `main` or `master` branch.
2. In the repository, open **Settings → Pages** and set the source to **GitHub Actions**.
3. Wait for **Deploy static site to GitHub Pages** in the **Actions** tab. Share the published URL with anyone who needs access.

Reports, actual progress, equipment overrides, and Tower activity statuses are stored in the shared Supabase project. Data saved while opening the old `file://` page is isolated and does not automatically transfer. GitHub Pages sites are public; do not use this setup for confidential or sensitive operational data.

## Workflow

1. Fill in the report date, shift, Plant, Work Package, preparer, and overall status.
2. Record equipment milestones, completed work, and the next shift plan. In the Activity field, enter one task per line to capture multiple activities for a shift in a single row. Equipment choices follow the selected Work Package (Tower or Drum); Planned Start and Plan Finish auto-fill from the imported schedule, while actual dates remain manual.
3. Use **Open issues & actions** for blockers or follow-ups, with a countermeasure, owner, and due date. Use **Handover notes** only for important information not already captured in the tables.
4. The **Activity-level progress** table is optional and collapsed by default; use it only when a concise critical-activity percentage breakdown is needed.
5. Save the report to the shared archive. Use **Export for Excel (.csv)** or **Print / save as PDF** for a shareable copy; the PDF includes the S-curve for the report's selected Work Package.
6. Use **Progress S-curve** to compare the MNT-day-weighted plan and actual for a Work Package. Planned progress is interpolated between maintenance start and finish dates; actual progress is weighted by MNT use days. A vertical **Today** marker shows the current date on the timeline.
7. Expand **Actual progress by equipment** to enter equipment completion by date. Use **Edit** on an equipment row to change that equipment's Area, Unit, MNT start/finish plan, Actual Start/Finish, or MNT use days, then select **Save** on the same row. Each equipment record is saved in the shared workspace, and Actual Start/Finish are also shown in the equipment schedule. Actual Finish cannot be earlier than Actual Start. **Save actuals** separately saves completion by date. Unreported equipment counts as 0% until its first update, then the latest value carries forward. Actuals and equipment edits are saved per Work Package, independent of Plant; the entry table is not included in daily-report exports.
8. Expand **Equipment & activity plan** to browse the imported Master Schedule Plan and the MS03 Drum / MS04 Tower equipment schedules. In the MS04 Tower schedule's Daily activities list, set each activity to **Not started** (white), **Ongoing** (yellow), or **Done** (green); each status saves automatically to the shared workspace. Choose a date in the archive to view saved report details.

The browser keeps a local copy of shared data to support the app's display; changes are synchronized to Supabase. Data saved before deployment or while opening the old `file://` page does not automatically transfer. Use the export actions to keep a separate copy.

The bundled schedule data was read from `Master Schedule Plan`, `Drum Package CR3`, and `Tower Package CR3` in `Master Schedule of all Tower Drum_22Oct26.xlsx`. The original Area/Unit values are retained as schedule metadata and are not automatically mapped to the daily-report Plant field. The planned S-curve is calculated from maintenance plan start/finish dates with MNT use days as equipment weights. Actual equipment readings are stored separately from daily report summaries in the shared Supabase project.

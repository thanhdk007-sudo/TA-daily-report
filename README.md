# Turnaround Daily Report

A lightweight daily shift reporting tool for refinery turnaround teams, with plant selection for OL1, CTU, and TFJ, and work package selection for MS03 Drum and MS04 Tower. Use it locally in a browser or publish an online workspace with shared Supabase data.

## Run

Open `TA26 daily report.html` directly in a browser to use local-only mode. No server or internet connection is required; reports stay in that browser on that device.

## Publish an online shared workspace

1. In the Supabase SQL Editor, run `supabase-setup.sql` on the project configured in `supabase-config.js`. It replaces existing row-level security policies on the four shared tables, then enables anonymous read, create, update, and delete access.
2. Create a GitHub repository and upload the project files, including `.github/workflows/deploy-pages.yml`.
3. In the repository settings, enable GitHub Pages with **GitHub Actions** as the source. The workflow publishes `TA26 daily report.html` as the site's `index.html`; the Pages URL is the shared app link.
4. Open the Pages URL while online. The app syncs reports, actual progress, equipment overrides, and activity statuses through the configured Supabase project.

The anonymous Supabase policies mean anyone with access to the site or the Supabase API can read, add, change, or delete shared data; the site link is not access control. The setup script replaces all existing row-level security policies on the four shared tables. Do not store confidential or sensitive operational information in this public setup. Data saved in local-file mode is separate from the online workspace.

Dates displayed in reports and schedules use the English `dd/Mon/yyyy` format (for example, `01/Jan/2026`). Browser date inputs and stored values retain their native ISO date format.

## Workflow

1. Fill in the report date, shift, Plant, Work Package, preparer, and overall status. Open a saved report to edit it; saving updates that report instead of creating another version. Choose **New report** to start a separate report.
2. Record equipment milestones, completed work, and the next shift plan. In the Activity field, enter one task per line to capture multiple activities for a shift in a single row. Equipment choices follow the selected Work Package (Tower or Drum); Planned Start and Plan Finish auto-fill from the imported schedule, while actual dates remain manual.
3. Use **Open issues & actions** for blockers or follow-ups, with a countermeasure, owner, and due date. Use **Handover notes** only for important information not already captured in the tables.
4. The **Activity-level progress** table is optional and collapsed by default; use it only when a concise critical-activity percentage breakdown is needed.
5. Save the report to the archive. Use **Print / save as PDF** to create a shareable copy; the PDF includes the S-curve for the report's selected Work Package.
6. Use **Progress S-curve** to compare the MNT-day-weighted plan and actual for a Work Package. Planned progress is interpolated between maintenance start and finish dates; actual progress is weighted by MNT use days. A solid red vertical line labeled with the current date (for example, `06-Nov`) marks that date on the timeline.
7. Expand **Actual progress by equipment** to enter equipment completion by date. Use **Edit** on an equipment row to change that equipment's Area, Unit, MNT start/finish plan, Actual Start/Finish, or MNT use days, then select **Save** on the same row. Each equipment record and progress update is saved in the selected workspace. Actual Finish cannot be earlier than Actual Start. **Save actuals** separately saves completion by date. Unreported equipment counts as 0% until its first update, then the latest value carries forward. Actuals and equipment edits are saved per Work Package, independent of Plant; the entry table is not included in daily-report exports.
8. Expand **Equipment & activity plan** to browse the imported Master Schedule Plan and the MS03 Drum / MS04 Tower equipment schedules. Enter **Actual Start** and **Actual Finish** directly in the equipment schedule; valid dates save automatically in the selected workspace, and Actual Finish cannot be earlier than Actual Start. In either package's Daily activities list, enter progress from 0% to 100%; status updates automatically to **Not started** (0%, white), **Ongoing** (1-99%, yellow), or **Done** (100%, green). The equipment schedule shows each equipment item's overall progress as the average of its scheduled activity progress values; unentered activities count as 0%. The **Actual** value in the equipment delay comparison uses this same Overall progress for equipment with scheduled activities, so both views stay in sync. Progress saves automatically in the selected workspace. Choose a date in the archive to see the number of saved reports, who prepared them, and their Work Packages.

In local-file mode, data remains in the current browser on this device. In online mode, data is shared through Supabase.

The bundled schedule data was read from `Master Schedule Plan`, `Drum Package CR3`, and `Tower Package CR3` in `Master Schedule of all Tower Drum_22Oct26.xlsx`. The original Area/Unit values are retained as schedule metadata and are not automatically mapped to the daily-report Plant field. The planned S-curve is calculated from maintenance plan start/finish dates with MNT use days as equipment weights.

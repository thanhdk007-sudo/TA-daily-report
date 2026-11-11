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
2. Record equipment milestones and use **Daily Activity Description** to enter work done today and work planned for tomorrow on the same equipment/section row, with an optional shared remark. Enter one task per line. Existing reports with separate today/tomorrow rows retain them as separate rows; their previously saved dates, statuses, and day-specific remarks remain stored but are not shown in the table or exports. Equipment choices follow the selected Work Package (Tower or Drum); Planned Start and Plan Finish auto-fill from the imported schedule, while actual dates remain manual.
3. Use **Open issues & actions** for blockers or follow-ups, with a countermeasure, owner, due date, **Pending** or **Done** status, and an optional remark. Older issues without a status remain unspecified until updated. Use **Handover notes** only for important information not already captured in the tables.
4. The **Activity-level progress** table is optional and collapsed by default; use it only when a concise critical-activity percentage breakdown is needed.
5. Save the report to the archive. Use **Download report image (JPG)** to create an image for sharing in a Zalo group, or use **Print / save as PDF** to create a PDF. Both exports include the Drum and Tower package comparison, indicators and S-curve for the report's Work Package. Package progress is calculated from the current schedule and progress at export time, not preserved as a historical report-date snapshot.
6. Use **Progress S-curve** to compare the MNT-day-weighted plan and actual for a Work Package. The **TA Package progress summary** above Equipment behind schedule shows equipment quantity and today's planned and actual percentages for both packages. Planned progress is interpolated between maintenance start and finish dates; actual progress uses each equipment item's **Overall progress** from Daily activities and is weighted by MNT use days. The actual value updates when activity progress is saved. Dated snapshots build the solid green actual curve over time; the first snapshot appears as a point until another date is recorded. The planned curve is dashed amber, and a solid red vertical line labeled with the current date (for example, `06-Nov`) marks that date on the timeline.
7. Expand **Equipment & activity plan** to browse the imported Master Schedule Plan and the MS03 Drum / MS04 Tower equipment schedules. Select a Work Package in **Package progress**, then use **Add equipment** or **Edit** in the equipment schedule to manage its equipment tags, area/unit, package/section, plan dates, actual dates, and MNT use days. Changes save in the selected workspace and appear in Daily activities equipment choices. Enter **Actual Start** and **Actual Finish** directly in the equipment schedule; valid dates save automatically, and Actual Finish cannot be earlier than Actual Start. Expand an equipment item's **Daily activities** and use **Add activity** to enter a date, optional start and finish times, and activity description, including for newly added equipment; use **Edit** to update existing activities. In either package's Daily activities list, enter progress from 0% to 100%; status updates automatically to **Not started** (0%, white), **Ongoing** (1-99%, yellow), or **Done** (100%, green). The equipment schedule shows each equipment item's overall progress as the average of its scheduled activity progress values; unentered activities count as 0%. Progress and S-curve snapshots save automatically in the selected workspace. Choose a date in the archive to see the number of saved reports, who prepared them, and their Work Packages.

In local-file mode, data remains in the current browser on this device. In online mode, data is shared through Supabase.

Use **Delete** beside equipment to remove it from the selected package's active schedule and calculations. Its details, activities, and progress remain stored; open **Removed equipment** and choose **Restore** to bring it back. Existing saved reports are unchanged. A removed equipment tag cannot be added again until it is restored.

The bundled schedule data was read from `Master Schedule Plan`, `Drum Package CR3`, and `Tower Package CR3` in `Master Schedule of all Tower Drum_22Oct26.xlsx`. The original Area/Unit values are retained as schedule metadata and are not automatically mapped to the daily-report Plant field. The planned S-curve is calculated from maintenance plan start/finish dates with MNT use days as equipment weights.

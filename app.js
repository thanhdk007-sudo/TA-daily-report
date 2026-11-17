const STORAGE_KEY = "turnaround-daily-reports-v1";
const ACTUALS_STORAGE_KEY = "turnaround-equipment-actuals-v1";
const EQUIPMENT_OVERRIDES_STORAGE_KEY = "turnaround-equipment-overrides-v1";
const ACTIVITY_STATUSES_STORAGE_KEY = "turnaround-equipment-activity-statuses-v1";
const form = document.getElementById("report-form");
const rows = document.getElementById("package-rows");
const toast = document.getElementById("toast");
const masterSchedule = window.MASTER_SCHEDULE;
const preparerNames = ["ThanhDK", "ThienHV", "TruongTX", "AnhTT", "DongBM", "MinhQN"];
const activitySections = ["2A", "2B", "2C", "3A", "2D", "2E", "5T", "0P", "CTU", "TFJ"];
let toastTimer;
const editingEquipmentTags = new Set();
let editingReportId = null;
const supabaseClient = window.location.protocol !== "file:" && window.supabase?.createClient(
  window.SUPABASE_CONFIG?.url || "",
  window.SUPABASE_CONFIG?.publishableKey || ""
);
let cloudReady = false;
let cloudWriteQueue = Promise.resolve();
let realtimeChannel = null;

const fieldIds = [
  "report-date", "shift", "plant", "work-package", "prepared-by",
  "overall-status", "weather", "handover-summary"
];
const legacyHandoverFields = [
  ["Work completed this shift", "completedWork"],
  ["HSE / quality observations", "hseQuality"],
  ["Constraints / decisions required", "constraints"],
  ["Materials / equipment status", "materials"],
  ["Priorities for next shift", "nextShift"]
];

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return String(value ?? "");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(match[2]) - 1];
  return month ? `${match[3]}/${month}/${match[1]}` : String(value ?? "");
}

function setSyncStatus(message) {
  document.getElementById("sync-status").textContent = message;
}

function assertCloudResult(result) {
  if (result.error) throw result.error;
  return result.data || [];
}

function mergeByKey(remote, local, getKey) {
  const merged = new Map();
  local.forEach(item => merged.set(getKey(item), item));
  remote.forEach(item => merged.set(getKey(item), item));
  return [...merged.values()];
}

function queueCloudWrite(operation) {
  if (!cloudReady) return;
  setSyncStatus("Saving shared data…");
  cloudWriteQueue = cloudWriteQueue.then(async () => {
    if (!cloudReady) return;
    const error = await operation();
    if (error) throw error;
    setSyncStatus("Shared data saved");
  }).catch(error => {
    console.error("Could not sync turnaround data.", error);
    setSyncStatus("Sync error · saved locally");
    showToast("Could not sync to shared data. Check your connection and permissions.");
  });
}

async function loadSharedWorkspace() {
  const results = await Promise.all([
    supabaseClient.from("turnaround_reports").select("id,data"),
    supabaseClient.from("turnaround_equipment_actuals").select("id,data"),
    supabaseClient.from("turnaround_equipment_overrides").select("work_package,equipment_tag,data"),
    supabaseClient.from("turnaround_activity_statuses").select("activity_key,status,progress")
  ]);
  const [reportRows, actualRows, overrideRows, statusRows] = results.map(assertCloudResult);
  const localReports = readLocalArray(STORAGE_KEY);
  const localActuals = readLocalArray(ACTUALS_STORAGE_KEY);
  const localOverrides = readLocalArray(EQUIPMENT_OVERRIDES_STORAGE_KEY);
  const localStatuses = readLocalObject(ACTIVITY_STATUSES_STORAGE_KEY);
  const reports = mergeByKey(reportRows.map(row => row.data), localReports, item => String(item.id));
  const actuals = mergeByKey(actualRows.map(row => row.data), localActuals, item => String(item.id));
  const getOverrideKey = item => `${normalizeWorkPackage(item.workPackage)}::${item.equipmentTag}`;
  const overrides = mergeByKey(overrideRows.map(row => row.data), localOverrides, getOverrideKey);
  const normalizeStatus = value => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const progress = Number(value.progress);
      if (Number.isInteger(progress) && progress >= 0 && progress <= 100) {
        return { progress, status: statusForProgress(progress) };
      }
    } else if (["not-started", "ongoing", "done"].includes(value)) {
      const progress = value === "done" ? 100 : value === "ongoing" ? 1 : 0;
      return { progress, status: statusForProgress(progress) };
    }
    return { progress: 0, status: "not-started" };
  };
  const remoteStatuses = Object.fromEntries(statusRows.map(row => [
    row.activity_key,
    normalizeStatus(row)
  ]));
  const statuses = Object.fromEntries(
    Object.entries({ ...localStatuses, ...remoteStatuses })
      .map(([key, value]) => [key, normalizeStatus(value)])
  );

  localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
  localStorage.setItem(ACTUALS_STORAGE_KEY, JSON.stringify(actuals));
  localStorage.setItem(EQUIPMENT_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  localStorage.setItem(ACTIVITY_STATUSES_STORAGE_KEY, JSON.stringify(statuses));

  const reportIds = new Set(reportRows.map(row => String(row.id)));
  const actualIds = new Set(actualRows.map(row => String(row.id)));
  const overrideIds = new Set(overrideRows.map(row =>
    `${normalizeWorkPackage(row.work_package)}::${row.equipment_tag}`));
  const statusKeys = new Set(statusRows.map(row => row.activity_key));
  const uploads = [];
  const missingReports = localReports.filter(item => !reportIds.has(String(item.id)));
  const missingActuals = localActuals.filter(item => !actualIds.has(String(item.id)));
  const missingOverrides = localOverrides.filter(item =>
    !overrideIds.has(getOverrideKey(item)));
  const missingStatuses = Object.entries(localStatuses)
    .filter(([key]) => !statusKeys.has(key))
    .map(([activity_key, value]) => ({ activity_key, ...normalizeStatus(value) }));

  if (missingReports.length) uploads.push(supabaseClient.from("turnaround_reports").upsert(
    missingReports.map(data => ({ id: String(data.id), data }))
  ));
  if (missingActuals.length) uploads.push(supabaseClient.from("turnaround_equipment_actuals").upsert(
    missingActuals.map(data => ({ id: String(data.id), data }))
  ));
  if (missingOverrides.length) uploads.push(supabaseClient.from("turnaround_equipment_overrides").upsert(
    missingOverrides.map(data => ({
      work_package: normalizeWorkPackage(data.workPackage),
      equipment_tag: String(data.equipmentTag),
      data
    })),
    { onConflict: "work_package,equipment_tag" }
  ));
  if (missingStatuses.length) uploads.push(supabaseClient.from("turnaround_activity_statuses").upsert(missingStatuses));
  const uploadResults = await Promise.all(uploads);
  uploadResults.forEach(result => {
    if (result.error) throw result.error;
  });
}

async function refreshSharedWorkspace(payload, tableName) {
  if (!cloudReady) return;
  try {
    if (payload?.eventType === "DELETE") {
      if (tableName === "turnaround_reports" || tableName === "turnaround_equipment_actuals") {
        const key = tableName === "turnaround_reports" ? STORAGE_KEY : ACTUALS_STORAGE_KEY;
        const items = readLocalArray(key).filter(item => String(item.id) !== String(payload.old.id));
        localStorage.setItem(key, JSON.stringify(items));
      } else if (tableName === "turnaround_equipment_overrides") {
        const items = readLocalArray(EQUIPMENT_OVERRIDES_STORAGE_KEY).filter(item =>
          normalizeWorkPackage(item.workPackage) !== normalizeWorkPackage(payload.old.work_package)
          || String(item.equipmentTag) !== String(payload.old.equipment_tag));
        localStorage.setItem(EQUIPMENT_OVERRIDES_STORAGE_KEY, JSON.stringify(items));
      } else if (tableName === "turnaround_activity_statuses") {
        const statuses = readLocalObject(ACTIVITY_STATUSES_STORAGE_KEY);
        delete statuses[payload.old.activity_key];
        localStorage.setItem(ACTIVITY_STATUSES_STORAGE_KEY, JSON.stringify(statuses));
      }
    }
    await loadSharedWorkspace();
    renderHistory();
    renderOverview();
    updateActivityEquipmentOptions();
    setSyncStatus("Shared data synced");
  } catch (error) {
    console.error("Could not refresh shared turnaround data.", error);
    setSyncStatus("Sync error · saved locally");
    showToast("Could not refresh shared data. Check your connection.");
  }
}

function subscribeToSharedWorkspace() {
  realtimeChannel = supabaseClient.channel("turnaround-shared-workspace")
    .on("postgres_changes", { event: "*", schema: "public", table: "turnaround_reports" },
      payload => refreshSharedWorkspace(payload, "turnaround_reports"))
    .on("postgres_changes", { event: "*", schema: "public", table: "turnaround_equipment_actuals" },
      payload => refreshSharedWorkspace(payload, "turnaround_equipment_actuals"))
    .on("postgres_changes", { event: "*", schema: "public", table: "turnaround_equipment_overrides" },
      payload => refreshSharedWorkspace(payload, "turnaround_equipment_overrides"))
    .on("postgres_changes", { event: "*", schema: "public", table: "turnaround_activity_statuses" },
      payload => refreshSharedWorkspace(payload, "turnaround_activity_statuses"))
    .subscribe(status => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("Supabase Realtime subscription failed.", status);
        setSyncStatus("Live updates unavailable");
      }
    });
}

async function startSharedWorkspace() {
  if (window.location.protocol === "file:") {
    setSyncStatus("Saved in this browser");
    return;
  }
  if (!supabaseClient) {
    setSyncStatus("Shared data unavailable · check online config");
    showToast("Shared database configuration or connection is unavailable.");
    return;
  }
  setSyncStatus("Connecting to shared data…");
  try {
    await loadSharedWorkspace();
    cloudReady = true;
    renderHistory();
    renderOverview();
    updateActivityEquipmentOptions();
    setSyncStatus("Shared data synced");
    subscribeToSharedWorkspace();
  } catch (error) {
    cloudReady = false;
    console.error("Could not connect to shared turnaround data.", error);
    setSyncStatus("Sync error · saved locally");
    showToast("Could not connect to shared data. Run supabase-setup.sql and check the online configuration.");
  }
}

function readLocalArray(key) {
  const value = JSON.parse(localStorage.getItem(key) || "[]");
  if (!Array.isArray(value)) throw new Error(`Local data for ${key} is not a list.`);
  return value;
}

function readLocalObject(key) {
  const value = JSON.parse(localStorage.getItem(key) || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local data for ${key} is not an object.`);
  }
  return value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function normalizeWorkPackage(value) {
  return value === "M03 Drum" ? "MS03 Drum" : value;
}

function getHandoverSummary(report) {
  if (report.handoverSummary) return report.handoverSummary;
  return legacyHandoverFields
    .map(([label, key]) => report[key] ? `${label}: ${report[key]}` : "")
    .filter(Boolean)
    .join("\n");
}

function getReportReporter(report = {}) {
  return report.preparedBy || report.reportedBy || report.reporter || report.createdBy || report.owner || "Reporter not specified";
}

function getReports() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) throw new Error("Stored reports are not a list.");
    saved.forEach(report => {
      report.workPackage = normalizeWorkPackage(report.workPackage || report.unit);
      report.preparedBy = report.preparedBy || report.reportedBy || report.reporter || report.createdBy || report.owner || "Reporter not specified";
      report.shift = report.shift || "Day shift";
      report.overallStatus = report.overallStatus || "On track";
    });
    return saved;
  } catch (error) {
    console.error("Could not read saved turnaround reports.", error);
    showToast("Saved reports could not be read. Check browser storage.");
    return [];
  }
}

function storeReports(reports) {
  try {
    const previous = readLocalArray(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
    if (cloudReady) queueCloudWrite(async () => {
      const previousById = new Map(previous.map(item => [String(item.id), item]));
      const nextById = new Map(reports.map(item => [String(item.id), item]));
      const changed = reports.filter(item =>
        JSON.stringify(previousById.get(String(item.id))) !== JSON.stringify(item));
      const deleted = [...previousById.keys()].filter(id => !nextById.has(id));
      if (changed.length) {
        const { error } = await supabaseClient.from("turnaround_reports").upsert(
          changed.map(data => ({ id: String(data.id), data })));
        if (error) return error;
      }
      if (deleted.length) {
        const { error } = await supabaseClient.from("turnaround_reports").delete().in("id", deleted);
        if (error) return error;
      }
      return null;
    });
    return true;
  } catch (error) {
    console.error("Could not save turnaround reports.", error);
    showToast("Could not save. Browser storage may be full or disabled.");
    return false;
  }
}

function getEquipmentActuals() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTUALS_STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) throw new Error("Stored equipment actuals are not a list.");
    return saved;
  } catch (error) {
    console.error("Could not read saved equipment actuals.", error);
    showToast("Equipment actuals could not be read. Check browser storage.");
    return [];
  }
}

function storeEquipmentActuals(actuals) {
  try {
    const previous = readLocalArray(ACTUALS_STORAGE_KEY);
    localStorage.setItem(ACTUALS_STORAGE_KEY, JSON.stringify(actuals));
    if (cloudReady) queueCloudWrite(async () => {
      const previousById = new Map(previous.map(item => [String(item.id), item]));
      const changed = actuals.filter(item =>
        JSON.stringify(previousById.get(String(item.id))) !== JSON.stringify(item));
      if (!changed.length) return null;
      const { error } = await supabaseClient.from("turnaround_equipment_actuals").upsert(
        changed.map(data => ({ id: String(data.id), data })));
      return error;
    });
    return true;
  } catch (error) {
    console.error("Could not save equipment actuals.", error);
    showToast("Could not save equipment actuals. Browser storage may be full or disabled.");
    return false;
  }
}

function getEquipmentOverrides() {
  try {
    const saved = JSON.parse(localStorage.getItem(EQUIPMENT_OVERRIDES_STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) throw new Error("Stored equipment overrides are not a list.");
    return saved;
  } catch (error) {
    console.error("Could not read saved equipment details.", error);
    showToast("Saved equipment details could not be read. Check browser storage.");
    return [];
  }
}

function storeEquipmentOverrides(overrides) {
  try {
    const previous = readLocalArray(EQUIPMENT_OVERRIDES_STORAGE_KEY);
    localStorage.setItem(EQUIPMENT_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
    if (cloudReady) queueCloudWrite(async () => {
      const getKey = item => `${normalizeWorkPackage(item.workPackage)}::${item.equipmentTag}`;
      const previousByKey = new Map(previous.map(item => [getKey(item), item]));
      const nextByKey = new Map(overrides.map(item => [getKey(item), item]));
      const changed = overrides.filter(item =>
        JSON.stringify(previousByKey.get(getKey(item))) !== JSON.stringify(item));
      const deleted = [...previousByKey.keys()].filter(key => !nextByKey.has(key));
      if (changed.length) {
        const { error } = await supabaseClient.from("turnaround_equipment_overrides").upsert(
          changed.map(data => ({
            work_package: normalizeWorkPackage(data.workPackage),
            equipment_tag: String(data.equipmentTag),
            data
          })),
          { onConflict: "work_package,equipment_tag" }
        );
        if (error) return error;
      }
      for (const key of deleted) {
        const [workPackage, equipmentTag] = key.split("::");
        const { error } = await supabaseClient.from("turnaround_equipment_overrides")
          .delete().eq("work_package", workPackage).eq("equipment_tag", equipmentTag);
        if (error) return error;
      }
      return null;
    });
    return true;
  } catch (error) {
    console.error("Could not save equipment details.", error);
    showToast("Could not save equipment details. Browser storage may be full or disabled.");
    return false;
  }
}

function statusForProgress(progress) {
  if (progress === 0) return "not-started";
  if (progress === 100) return "done";
  return "ongoing";
}

function getActivityStatuses() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVITY_STATUSES_STORAGE_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      throw new Error("Stored equipment activity statuses are not an object.");
    }
    return Object.fromEntries(Object.entries(saved).map(([key, value]) => {
      let progress = 0;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const storedProgress = Number(value.progress);
        if (Number.isInteger(storedProgress) && storedProgress >= 0 && storedProgress <= 100) {
          progress = storedProgress;
        }
      } else if (value === "done") {
        progress = 100;
      } else if (value === "ongoing") {
        progress = 1;
      }
      return [key, { progress, status: statusForProgress(progress) }];
    }));
  } catch (error) {
    console.error("Could not read equipment activity statuses.", error);
    showToast("Equipment activity statuses could not be read. Check browser storage.");
    return {};
  }
}

function storeActivityStatuses(statuses) {
  try {
    const previous = readLocalObject(ACTIVITY_STATUSES_STORAGE_KEY);
    localStorage.setItem(ACTIVITY_STATUSES_STORAGE_KEY, JSON.stringify(statuses));
    if (cloudReady) queueCloudWrite(async () => {
      const changed = Object.entries(statuses)
        .filter(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value))
        .map(([activity_key, value]) => ({ activity_key, ...value }));
      if (!changed.length) return null;
      const { error } = await supabaseClient.from("turnaround_activity_statuses")
        .upsert(changed, { onConflict: "activity_key" });
      return error;
    });
    return true;
  } catch (error) {
    console.error("Could not save equipment activity statuses.", error);
    showToast("Could not save activity status. Browser storage may be full or disabled.");
    return false;
  }
}

function getEquipmentRecords(workPackage, includeHidden = false) {
  const overrides = new Map(
    getEquipmentOverrides()
      .filter(item => normalizeWorkPackage(item.workPackage) === workPackage)
      .map(item => [String(item.equipmentTag), item])
  );
  const records = (masterSchedule.equipment[workPackage] || []).map(record => {
    const override = overrides.get(String(record.equipmentTag));
    return override ? { ...record, ...override } : record;
  });
  const existingTags = new Set(records.map(record => String(record.equipmentTag)));
  overrides.forEach((override, tag) => {
    if (override.custom && !existingTags.has(tag)) {
      records.push({ timeline: [], ...override });
    }
  });
  return includeHidden ? records : records.filter(record => !record.hidden);
}

function getPackageSectionLabel(record) {
  const packageSectionOverrides = {
    "T-3000": "PB-101-A3",
    "T-3060": "PB-105-A3"
  };
  return packageSectionOverrides[String(record.equipmentTag)]
    || [record.packageNo || record.operationPackage, record.packageCode || record.section].filter(Boolean).join(" · ")
    || "—";
}

function getEquipmentActivityLabel(activity) {
  const descriptions = {
    B: "Blind equipment",
    DB: "De-blind equipment",
    M: "Open / close M/H",
    V: "Preparation work / remove ventilation sys",
    S: "Install / remove internal scaffolding",
    C: "Take equipment out / install back to tower",
    MW: "Open / close manway of tray",
    T: "Torque all nozzle around the tower",
    MG: "Margin 25%",
    I: "Inspection OPE / ME",
    P: "NDT inspection by PDM",
    R: "Repair as-found inspection",
    D: "Remove / install demister",
    RI: "Remove / install insulation M/H",
    RC: "Remove / install cartridges",
    L: "Load catalyst / packing",
    U: "Un-load catalyst / packing",
    CM: "Cleaning shell by manual",
    CS: "Cleaning shell by water jet",
    CN: "Cleaning for NDT inspection by PDM",
    CD: "Cleaning demister by air blowing",
    CO: "Cleaning demister by soaking in wash oil",
    CH: "Cleaning by HPWJ",
    CV: "Cleaning by air vacuum"
  };
  const code = String(activity ?? "").trim();
  return descriptions[code] ? `${code} — ${descriptions[code]}` : String(activity ?? "");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function addPackage(data = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input aria-label="Work package or activity" data-key="name" type="text" placeholder="e.g. exchanger bundle pull" value="${escapeHtml(data.name || "")}"></td>
    <td><input aria-label="Work package area" data-key="area" type="text" placeholder="Area" value="${escapeHtml(data.area || "")}"></td>
    <td><input aria-label="Planned completion percentage" data-key="planned" type="number" min="0" max="100" step="0.1" value="${escapeHtml(data.planned ?? 0)}"></td>
    <td><input aria-label="Actual completion percentage" data-key="actual" type="number" min="0" max="100" step="0.1" value="${escapeHtml(data.actual ?? 0)}"></td>
    <td><select aria-label="Work package status" data-key="status">
      ${["Not started", "In progress", "On hold", "Completed"].map(status => `<option${data.status === status ? " selected" : ""}>${status}</option>`).join("")}
    </select></td>
    <td><button class="remove-row" type="button" aria-label="Remove work package">×</button></td>`;
  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();
    if (!rows.children.length) addPackage();
    updateDashboard();
  });
  row.addEventListener("input", updateDashboard);
  row.addEventListener("change", updateDashboard);
  rows.appendChild(row);
  updateDashboard();
}

function collectReport() {
  const report = {};
  for (const id of fieldIds) {
    const element = document.getElementById(id);
    report[element.name] = element.type === "number" ? Number(element.value || 0) : element.value.trim();
  }
  report.packages = [...rows.querySelectorAll("tr")].map(row => {
    const value = key => row.querySelector(`[data-key="${key}"]`).value.trim();
    return {
      name: value("name"),
      area: value("area"),
      planned: Number(value("planned") || 0),
      actual: Number(value("actual") || 0),
      status: value("status")
    };
  }).filter(item => item.name || item.area);
  report.overallActivities = collectRows("overall-activity-rows", ["equipment", "plannedOpen", "actualOpen", "planClose", "actualClose"]);
  report.workActivities = collectRows("work-activity-rows", [
    "equipment", "section", "todayActivity", "tomorrowActivity", "remark",
    "todayDueDate", "todayStatus", "todayRemarks", "tomorrowDueDate", "tomorrowStatus", "tomorrowRemarks"
  ]);
  const legacyActivities = prefix => report.workActivities.flatMap(item => {
    const activity = {
      equipment: item.equipment, section: item.section, activity: item[`${prefix}Activity`],
      dueDate: item[`${prefix}DueDate`], status: item[`${prefix}Status`], remarks: item[`${prefix}Remarks`]
    };
    return activity.activity || activity.dueDate || activity.status || activity.remarks ? [activity] : [];
  });
  report.todayActivities = legacyActivities("today");
  report.tomorrowActivities = legacyActivities("tomorrow");
  report.issues = collectRows("issue-rows", ["issue", "countermeasure", "actionBy", "dueDate", "status", "remark"]);
  return report;
}

function collectRows(tbodyId, keys) {
  return [...document.getElementById(tbodyId).querySelectorAll("tr")].map(row => {
    const item = {};
    for (const key of keys) {
      const field = row.querySelector(`[data-key="${key}"]`);
      item[key] = field ? field.value.trim() : "";
    }
    return item;
  }).filter(item => Object.values(item).some(Boolean));
}

function equipmentOptions(selected = "") {
  const workPackage = normalizeWorkPackage(document.getElementById("work-package").value);
  const equipment = getEquipmentRecords(workPackage);
  const prompt = workPackage ? "Select equipment" : "Select Work Package first";
  const unavailable = selected && !equipment.some(record => String(record.equipmentTag) === selected)
    ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (not in selected Work Package)</option>`
    : "";
  return `<option value="">${prompt}</option>${unavailable}${equipment.map(record => {
    const tag = String(record.equipmentTag);
    const selectedAttribute = tag === selected ? " selected" : "";
    const section = record.unit || record.section || record.area;
    return `<option value="${escapeHtml(tag)}"${selectedAttribute}>${escapeHtml(tag)}${section ? ` — ${escapeHtml(section)}` : ""}</option>`;
  }).join("")}`;
}

function equipmentSelectMarkup(selected = "") {
  const workPackage = normalizeWorkPackage(document.getElementById("work-package").value);
  return `<select data-key="equipment" aria-label="Equipment"${workPackage ? "" : " disabled"}>${equipmentOptions(selected)}</select>`;
}

function findScheduledEquipment(tag) {
  const workPackage = normalizeWorkPackage(document.getElementById("work-package").value);
  return getEquipmentRecords(workPackage)
    .find(record => String(record.equipmentTag) === tag);
}

function applyEquipmentPlanDates(row, record) {
  row.querySelector("[data-key=plannedOpen]").value = record.maintenanceStart || "";
  row.querySelector("[data-key=planClose]").value = record.maintenanceFinish || "";
}

function clearEquipmentMilestoneDates(row) {
  ["plannedOpen", "actualOpen", "planClose", "actualClose"].forEach(key => {
    row.querySelector(`[data-key=${key}]`).value = "";
  });
}

function activitySectionOptions(selected = "") {
  const legacyOption = selected && !activitySections.includes(selected)
    ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`
    : "";
  return `<option value="">Select section</option>${legacyOption}${activitySections.map(section =>
    `<option value="${section}"${section === selected ? " selected" : ""}>${section}</option>`
  ).join("")}`;
}

function activityRow(tbodyId, data = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `<td>${equipmentSelectMarkup(data.equipment || "")}</td>
    <td><input data-key="plannedOpen" aria-label="Planned Start date" type="date" value="${escapeHtml(data.plannedOpen || "")}"></td>
    <td><input data-key="actualOpen" aria-label="Actual Start date" type="date" value="${escapeHtml(data.actualOpen || "")}"></td>
    <td><input data-key="planClose" aria-label="Plan Finish date" type="date" value="${escapeHtml(data.planClose || "")}"></td>
    <td><input data-key="actualClose" aria-label="Actual Finish date" type="date" value="${escapeHtml(data.actualClose || "")}"></td>
    <td><button class="remove-row" type="button" aria-label="Remove overall activity">×</button></td>`;
  row.querySelector("[data-key=equipment]").value = data.equipment || "";
  row.querySelector("[data-key=equipment]").addEventListener("change", event => {
    const record = findScheduledEquipment(event.currentTarget.value);
    clearEquipmentMilestoneDates(row);
    if (record) applyEquipmentPlanDates(row, record);
    updateDashboard();
  });
  if (data.equipment && (!data.plannedOpen || !data.planClose)) {
    const record = findScheduledEquipment(data.equipment);
    if (record) {
      if (!data.plannedOpen) row.querySelector("[data-key=plannedOpen]").value = record.maintenanceStart || "";
      if (!data.planClose) row.querySelector("[data-key=planClose]").value = record.maintenanceFinish || "";
    }
  }
  bindEditableRow(row);
  document.getElementById(tbodyId).appendChild(row);
  syncDailyTableEmptyState(tbodyId);
}

function workActivityRow(data = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `<td>${equipmentSelectMarkup(data.equipment || "")}</td>
    <td><select data-key="section" aria-label="Section">${activitySectionOptions(data.section || "")}</select></td>
    <td><textarea data-key="todayActivity" aria-label="Work Done Today" rows="2" placeholder="One activity per line">${escapeHtml(data.todayActivity || "")}</textarea></td>
    <td><textarea data-key="tomorrowActivity" aria-label="Work to be Tomorrow" rows="2" placeholder="One activity per line">${escapeHtml(data.tomorrowActivity || "")}</textarea></td>
    <td><textarea data-key="remark" aria-label="Remark" rows="2" placeholder="Optional remark">${escapeHtml(data.remark || "")}</textarea></td>
    <td>${["todayDueDate", "todayStatus", "todayRemarks", "tomorrowDueDate", "tomorrowStatus", "tomorrowRemarks"]
      .map(key => `<input type="hidden" data-key="${key}" value="${escapeHtml(data[key] || "")}">`).join("")}
      <button class="remove-row" type="button" aria-label="Remove activity">×</button></td>`;
  row.querySelector("[data-key=equipment]").value = data.equipment || "";
  bindEditableRow(row);
  document.getElementById("work-activity-rows").appendChild(row);
  syncDailyTableEmptyState("work-activity-rows");
}

function getReportWorkActivities(report) {
  if (Array.isArray(report.workActivities)) return report.workActivities;
  const convert = (item, prefix) => ({
    equipment: item.equipment || "", section: item.section || "",
    [`${prefix}Activity`]: item.activity || "", [`${prefix}DueDate`]: item.dueDate || "",
    [`${prefix}Status`]: item.status || "", [`${prefix}Remarks`]: item.remarks || ""
  });
  return [
    ...(report.todayActivities || []).map(item => convert(item, "today")),
    ...(report.tomorrowActivities || []).map(item => convert(item, "tomorrow"))
  ];
}

function getWorkActivityExportRows(report) {
  return getReportWorkActivities(report).map(item => ({
    equipment: item.equipment || "",
    section: item.section || "",
    today: item.todayActivity || "",
    tomorrow: item.tomorrowActivity || "",
    remark: item.remark || ""
  }));
}

function issueRow(data = {}) {
  const row = document.createElement("tr");
  const status = data.status || "";
  const previousStatus = status && !["Pending", "Done"].includes(status)
    ? `<option value="${escapeHtml(status)}" selected>${escapeHtml(status)}</option>`
    : "";
  row.innerHTML = `<td class="issue-number"></td>
    <td><textarea data-key="issue" aria-label="Issue" rows="2" placeholder="Describe issue">${escapeHtml(data.issue || "")}</textarea></td>
    <td><textarea data-key="countermeasure" aria-label="Countermeasure" rows="2" placeholder="Action / countermeasure">${escapeHtml(data.countermeasure || "")}</textarea></td>
    <td><select data-key="actionBy" aria-label="Action by"><option value="">Select owner</option>${preparerNames.map(name => `<option${data.actionBy === name ? " selected" : ""}>${name}</option>`).join("")}</select></td>
    <td><input data-key="dueDate" aria-label="Issue due date" type="date" value="${escapeHtml(data.dueDate || "")}"></td>
    <td><select data-key="status" aria-label="Issue status"><option value="">Select status</option>${previousStatus}<option value="Pending"${status === "Pending" ? " selected" : ""}>Pending</option><option value="Done"${status === "Done" ? " selected" : ""}>Done</option></select></td>
    <td><textarea data-key="remark" aria-label="Issue remark" rows="2" placeholder="Optional remark">${escapeHtml(data.remark || "")}</textarea></td>
    <td><button class="remove-row" type="button" aria-label="Remove issue">×</button></td>`;
  bindEditableRow(row);
  document.getElementById("issue-rows").appendChild(row);
  updateIssueNumbers();
  syncDailyTableEmptyState("issue-rows");
}

function syncDailyTableEmptyState(tbodyId) {
  const tbody = document.getElementById(tbodyId);
  const table = tbody.closest("table");
  const emptyNote = document.querySelector(`[data-empty-for="${tbodyId}"]`);
  const hasRows = tbody.rows.length > 0;
  table.hidden = !hasRows;
  emptyNote.hidden = hasRows;
}

function bindEditableRow(row) {
  row.querySelector(".remove-row").addEventListener("click", () => {
    const tbodyId = row.closest("tbody").id;
    row.remove();
    if (tbodyId === "issue-rows") updateIssueNumbers();
    syncDailyTableEmptyState(tbodyId);
    updateDashboard();
  });
  row.addEventListener("input", updateDashboard);
  row.addEventListener("change", updateDashboard);
}

function updateIssueNumbers() {
  document.querySelectorAll("#issue-rows .issue-number").forEach((cell, index) => {
    cell.textContent = index + 1;
  });
}

function renderDailyRows(report = {}) {
  for (const [tbodyId, values, factory] of [
    ["overall-activity-rows", report.overallActivities || [], activityRow]
  ]) {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = "";
    values.forEach(item => factory(tbodyId, item));
  }
  document.getElementById("work-activity-rows").innerHTML = "";
  getReportWorkActivities(report).forEach(workActivityRow);
  const issueBody = document.getElementById("issue-rows");
  issueBody.innerHTML = "";
  (report.issues || []).forEach(issueRow);
  updateIssueNumbers();
  ["overall-activity-rows", "work-activity-rows", "issue-rows"]
    .forEach(syncDailyTableEmptyState);
}

function updateActivityEquipmentOptions() {
  document.querySelectorAll("#overall-activity-rows [data-key=equipment], #work-activity-rows [data-key=equipment]").forEach(select => {
    const selected = select.value;
    const row = select.closest("tr");
    select.innerHTML = equipmentOptions(selected);
    select.disabled = !normalizeWorkPackage(document.getElementById("work-package").value);
    const record = findScheduledEquipment(selected);
    if (record) {
      select.value = selected;
      if (row.closest("tbody").id === "overall-activity-rows") applyEquipmentPlanDates(row, record);
    } else if (selected && getEquipmentRecords(
      normalizeWorkPackage(document.getElementById("work-package").value), true
    ).some(item => item.hidden && String(item.equipmentTag) === selected)) {
      select.value = selected;
    } else {
      select.value = row.closest("tbody").id === "work-activity-rows" ? selected : "";
      if (row.closest("tbody").id === "overall-activity-rows") {
        clearEquipmentMilestoneDates(row);
      }
    }
  });
}

function validateForm() {
  return form.reportValidity();
}

function updateDashboard() {
  const report = collectReport();

  const status = document.getElementById("preview-status");
  status.textContent = report.overallStatus;
  status.className = `status-pill ${report.overallStatus.toLowerCase().replace(/\s+/g, "-")}`;
  document.getElementById("preview-date").textContent = report.date ? formatDate(report.date) : "—";
  document.getElementById("preview-location").textContent = [report.plant || report.site, report.workPackage || report.unit].filter(Boolean).join(" · ") || "—";
  const packages = report.packages;
  document.getElementById("package-count").textContent = `${packages.length} ${packages.length === 1 ? "activity" : "activities"}`;
  document.getElementById("preview-packages").innerHTML = packages.length
    ? packages.map(item => `<div class="preview-package"><div class="preview-package-name"><strong>${escapeHtml(item.name || item.area || "Untitled activity")}</strong><span>${escapeHtml(item.area || item.status)}</span></div><span class="package-percent">${item.actual}%</span></div>`).join("")
    : '<p class="empty-note">Add work packages to see the shift breakdown.</p>';
}

function updateSaveButtonLabels() {
  const label = editingReportId ? "Update daily report" : "Save daily report";
  document.getElementById("save-report-button").innerHTML = `${label} <span aria-hidden="true">→</span>`;
  document.querySelector(".form-footer button[type=submit]").innerHTML = `${label} <span aria-hidden="true">→</span>`;
}

function loadReport(report) {
  editingReportId = String(report.id);
  updateSaveButtonLabels();
  const workPackageSelect = document.getElementById("work-package");
  const savedWorkPackage = normalizeWorkPackage(report.workPackage || report.unit);
  if (savedWorkPackage) workPackageSelect.value = savedWorkPackage;
  const overviewWorkPackageSelect = document.getElementById("overview-work-package");
  if ([...overviewWorkPackageSelect.options].some(option => option.value === savedWorkPackage)) {
    overviewWorkPackageSelect.value = savedWorkPackage;
  }
  updateActivityEquipmentOptions();
  for (const id of fieldIds) {
    const element = document.getElementById(id);
    const value = element.name === "workPackage"
      ? savedWorkPackage
      : element.name === "plant"
        ? report.plant || report.site
        : element.name === "handoverSummary"
          ? getHandoverSummary(report)
        : report[element.name];
    if (value !== undefined && value !== null) element.value = value;
  }
  rows.innerHTML = "";
  (report.packages?.length ? report.packages : [{}]).forEach(addPackage);
  renderDailyRows(report);
  document.getElementById("save-feedback").textContent = "Loaded saved report";
  updateDashboard();
  renderOverview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderHistory() {
  const reports = getReports().sort((a, b) => `${b.date}-${b.savedAt}`.localeCompare(`${a.date}-${a.savedAt}`));
  document.getElementById("history-count").textContent = reports.length;
  const history = document.getElementById("report-history");
  if (!reports.length) {
    history.innerHTML = '<p class="empty-note">Saved reports will appear here.</p>';
    renderSavedDateSummary();
    renderOverview();
    return;
  }
  history.innerHTML = reports.slice(0, 8).map(report => {
    const day = formatDate(report.date) || "—";
    const reporter = getReportReporter(report);
    const workPackage = report.workPackage || report.unit || "Work package not specified";
    const location = [report.plant || report.site, workPackage].filter(Boolean).join(" · ") || "Location not specified";
    const shift = report.shift || "Day shift";
    const status = report.overallStatus || "On track";
    return `<div class="history-item">
      <span class="history-date-mark">${escapeHtml(day)}</span>
      <div class="history-item-main">
        <div class="history-item-line"><strong>${escapeHtml(location)}</strong></div>
        <div class="history-item-meta">
          <span>${escapeHtml(shift)} • ${escapeHtml(status)}</span>
          <span class="history-item-reporter">Reported by ${escapeHtml(reporter)}</span>
        </div>
      </div>
      <button class="history-open" type="button" data-action="open" data-id="${escapeHtml(report.id)}" aria-label="Open report">↗</button>
      <button class="history-delete" type="button" data-action="delete" data-id="${escapeHtml(report.id)}" aria-label="Delete report">×</button>
    </div>`;
  }).join("");
  history.querySelectorAll("button[data-action]").forEach(button => button.addEventListener("click", () => {
    const reportsNow = getReports();
    const report = reportsNow.find(item => item.id === button.dataset.id);
    if (button.dataset.action === "open" && report) loadReport(report);
    if (button.dataset.action === "delete" && report) {
      const location = cloudReady ? "the shared workspace" : "this browser";
      if (!window.confirm(`Delete this saved daily report from ${location}?`)) return;
      if (storeReports(reportsNow.filter(item => item.id !== report.id))) {
        renderHistory();
        renderSavedDateSummary();
        renderOverview();
        showToast("Report deleted.");
      }
    }
  }));
  renderSavedDateSummary();
  renderOverview();
}

function toggleHistory() {
  const content = document.getElementById("history-content");
  const button = document.getElementById("toggle-history");
  const isExpanded = button.getAttribute("aria-expanded") === "true";
  content.hidden = isExpanded;
  button.setAttribute("aria-expanded", String(!isExpanded));
  button.textContent = isExpanded ? "Expand" : "Collapse";
}

function renderOverview() {
  const allReports = getReports();
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const reports = allReports
    .filter(report => !workPackage || normalizeWorkPackage(report.workPackage || report.unit) === workPackage)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.savedAt).localeCompare(String(b.savedAt)));
  document.getElementById("overview-report-count").textContent = reports.length.toLocaleString();
  document.getElementById("overview-latest-actual").textContent = "—";
  const latest = reports[reports.length - 1];
  document.getElementById("overview-latest-date").textContent = latest?.date ? formatDate(latest.date) : "—";

  renderMasterSchedule();
  renderActualEntryTable();
  const chart = document.getElementById("curve-chart-wrap");
  renderPackageComparisonCards(workPackage);
  const schedule = workPackage ? getEquipmentRecords(workPackage) : [];
  const plannedPoints = buildPlannedProgress(schedule);
  const actualPoints = workPackage ? buildActualProgress(workPackage, schedule) : [];
  renderDashboardMetrics(workPackage, schedule, plannedPoints, actualPoints);
  if (!workPackage) {
    chart.innerHTML = '<p class="empty-note">Select a Work Package to view progress.</p>';
    return;
  }
  document.getElementById("overview-latest-actual").textContent = actualPoints.length
    ? `${actualPoints[actualPoints.length - 1].actualProgress.toFixed(1)}%`
    : "—";
  if (!plannedPoints.length) {
    chart.innerHTML = '<p class="empty-note">No maintenance plan data is available for this Work Package.</p>';
    return;
  }
  chart.innerHTML = buildCurveSvg(plannedPoints, actualPoints);
  document.getElementById("actual-entry-feedback").textContent = actualPoints.length
    ? `${actualPoints.length} Overall progress snapshot date${actualPoints.length === 1 ? "" : "s"} · latest ${formatDate(actualPoints[actualPoints.length - 1].date)}`
    : "No Overall progress recorded yet. Enter Daily activities progress to start the actual curve.";
}

function renderDashboardMetrics(workPackage, schedule, plannedPoints, actualPoints) {
  const today = localDateString();
  const dateLabel = formatDate(today);
  document.getElementById("dashboard-status-date").textContent = `AS OF ${dateLabel}`;
  document.getElementById("dashboard-selected-title").textContent =
    workPackage ? `${workPackage} · package indicators` : "Select a package to view its schedule";
  document.getElementById("dashboard-selected-date").textContent = workPackage ? dateLabel : "";
  document.getElementById("dashboard-chart-date").textContent = workPackage
    ? `${workPackage} · ${dateLabel}`
    : "Select MS03 Drum or MS04 Tower";
  const { completedEquipment, durationDays, delayedEquipment } = getPackageIndicators(workPackage, schedule, today);
  const values = {
    "dashboard-equipment-total": workPackage ? schedule.length.toLocaleString() : "—",
    "dashboard-use-days": workPackage && durationDays !== null ? durationDays.toLocaleString() : "—",
    "dashboard-done-total": workPackage ? `${completedEquipment.toLocaleString()} / ${schedule.length.toLocaleString()}` : "—",
    "dashboard-delayed-total": workPackage ? delayedEquipment.toLocaleString() : "—"
  };
  Object.entries(values).forEach(([id, value]) => {
    document.getElementById(id).textContent = value;
  });
  document.getElementById("dashboard-done-caption").textContent =
    workPackage ? "Equipment with actual finish date" : "Choose a package to view completion";
}

function getPackageIndicators(workPackage, schedule, today = localDateString()) {
  const activityStatuses = getActivityStatuses();
  const todayTime = new Date(`${today}T00:00:00Z`).getTime();
  const delayedEquipment = schedule.filter(record => {
    if (!workPackage || !record.maintenanceStart || !record.maintenanceFinish
      || new Date(`${record.maintenanceStart}T00:00:00Z`).getTime() > todayTime
      || !record.timeline.length) return false;
    const actual = getEquipmentOverallProgress(workPackage, record, activityStatuses);
    if (actual === null) return false;
    const start = new Date(`${record.maintenanceStart}T00:00:00Z`).getTime();
    const finish = new Date(`${record.maintenanceFinish}T00:00:00Z`).getTime();
    const planned = todayTime >= finish
      ? 100
      : Math.max(0, Math.min(100, (todayTime - start) / Math.max(1, finish - start) * 100));
    return planned - actual > 0.1;
  }).length;
  return {
    completedEquipment: schedule.filter(record => record.actualFinish).length,
    durationDays: getPackageScheduleDuration(schedule),
    delayedEquipment
  };
}

function getPackageComparison(workPackage, today = localDateString()) {
  const schedule = getEquipmentRecords(workPackage);
  const plannedPoints = buildPlannedProgress(schedule);
  const actualPoints = buildActualProgress(workPackage, schedule);
  const plannedAsOfToday = plannedPoints.filter(point => point.date <= today);
  return {
    workPackage,
    equipmentCount: schedule.length,
    planned: plannedAsOfToday.length ? plannedAsOfToday[plannedAsOfToday.length - 1].plannedProgress : plannedPoints.length ? 0 : null,
    actual: actualPoints.length ? actualPoints[actualPoints.length - 1].actualProgress : null,
    durationDays: getPackageScheduleDuration(schedule),
    finish: schedule.reduce((latest, record) =>
      record.maintenanceFinish && record.maintenanceFinish > latest ? record.maintenanceFinish : latest, "")
  };
}

function renderPackageComparisonCards(selectedWorkPackage) {
  const today = localDateString();
  document.getElementById("dashboard-status-date").textContent = `AS OF ${formatDate(today)}`;
  [
    { workPackage: "MS03 Drum", prefix: "dashboard-ms03" },
    { workPackage: "MS04 Tower", prefix: "dashboard-ms04" }
  ].forEach(({ workPackage, prefix }) => {
    const { equipmentCount, planned, actual, durationDays, finish } = getPackageComparison(workPackage, today);
    const setText = (suffix, value) => {
      document.getElementById(`${prefix}-${suffix}`).textContent = value;
    };
    const setBar = (suffix, value) => {
      document.getElementById(`${prefix}-${suffix}-bar`).style.width =
        `${Math.max(0, Math.min(100, value ?? 0))}%`;
    };
    setText("equipment", equipmentCount.toLocaleString());
    setText("plan", planned === null ? "—" : `${planned.toFixed(1)}%`);
    setText("actual", actual === null ? "—" : `${actual.toFixed(1)}%`);
    setText("days", durationDays === null ? "—" : durationDays.toLocaleString());
    setText("finish", finish ? formatDate(finish) : "—");
    setBar("plan", planned);
    setBar("actual", actual);
  });
  document.querySelectorAll("[data-dashboard-package]").forEach(button => {
    const selected = button.dataset.dashboardPackage === selectedWorkPackage;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function getPackageScheduleDuration(schedule) {
  const datedRecords = schedule.filter(record =>
    /^\d{4}-\d{2}-\d{2}$/.test(record.maintenanceStart || "")
    && /^\d{4}-\d{2}-\d{2}$/.test(record.maintenanceFinish || "")
    && record.maintenanceFinish >= record.maintenanceStart);
  if (!datedRecords.length) return null;
  const start = datedRecords.reduce((earliest, record) =>
    record.maintenanceStart < earliest ? record.maintenanceStart : earliest,
  datedRecords[0].maintenanceStart);
  const finish = datedRecords.reduce((latest, record) =>
    record.maintenanceFinish > latest ? record.maintenanceFinish : latest,
  datedRecords[0].maintenanceFinish);
  const duration = (Date.parse(`${finish}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  return Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) + 1 : null;
}

function equipmentWeight(record) {
  const days = Number(record.maintenanceUseDays);
  return Number.isFinite(days) && days > 0 ? days : 1;
}

function buildPlannedProgress(schedule) {
  const equipment = schedule.filter(record => record.maintenanceStart && record.maintenanceFinish);
  if (!equipment.length) return [];
  const start = equipment.reduce((earliest, record) => record.maintenanceStart < earliest ? record.maintenanceStart : earliest, equipment[0].maintenanceStart);
  const finish = equipment.reduce((latestDate, record) => record.maintenanceFinish > latestDate ? record.maintenanceFinish : latestDate, equipment[0].maintenanceFinish);
  const startDate = new Date(`${start}T00:00:00Z`);
  const finishDate = new Date(`${finish}T00:00:00Z`);
  const totalDays = Math.round((finishDate - startDate) / 86400000);
  const totalWeight = equipment.reduce((sum, record) => sum + equipmentWeight(record), 0);
  const points = [];
  for (let day = 0; day <= totalDays; day++) {
    const date = new Date(startDate.getTime() + day * 86400000).toISOString().slice(0, 10);
    const completedWeight = equipment.reduce((sum, record) => {
      if (date <= record.maintenanceStart) return sum;
      if (date >= record.maintenanceFinish) return sum + equipmentWeight(record);
      const taskStart = new Date(`${record.maintenanceStart}T00:00:00Z`);
      const taskFinish = new Date(`${record.maintenanceFinish}T00:00:00Z`);
      const taskDuration = Math.max(1, (taskFinish - taskStart) / 86400000);
      const taskElapsed = (new Date(`${date}T00:00:00Z`) - taskStart) / 86400000;
      return sum + equipmentWeight(record) * taskElapsed / taskDuration;
    }, 0);
    points.push({ date, plannedProgress: completedWeight / totalWeight * 100 });
  }
  return points;
}

function buildActualProgress(workPackage, schedule) {
  const equipment = schedule.map(record => ({ record, tag: String(record.equipmentTag), weight: equipmentWeight(record) }));
  const totalWeight = equipment.reduce((sum, record) => sum + record.weight, 0);
  const pointsByDate = new Map();
  const savedSnapshots = getEquipmentActuals()
    .filter(item => item.source === "overall-progress"
      && normalizeWorkPackage(item.workPackage) === workPackage
      && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.savedAt).localeCompare(String(b.savedAt)));
  const progressFor = progress => {
    const completedWeight = equipment.reduce((sum, item) => {
      const value = Number(progress?.[item.tag]);
      return sum + item.weight * (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0) / 100;
    }, 0);
    return totalWeight ? completedWeight / totalWeight * 100 : 0;
  };
  savedSnapshots.forEach(item => pointsByDate.set(item.date, {
    date: item.date,
    actualProgress: progressFor(item.progress)
  }));

  const activityStatuses = getActivityStatuses();
  const currentProgress = Object.fromEntries(equipment.flatMap(({ record, tag }) => {
    const hasRecordedActivity = record.timeline.some((item, index) =>
      Object.prototype.hasOwnProperty.call(
        activityStatuses,
        getActivityStatusKey(workPackage, tag, index, item)
      ));
    if (!hasRecordedActivity) return [];
    const progress = getEquipmentOverallProgress(workPackage, record, activityStatuses);
    return progress === null ? [] : [[tag, progress]];
  }));
  if (Object.keys(currentProgress).length) {
    const date = localDateString();
    pointsByDate.set(date, { date, actualProgress: progressFor(currentProgress) });
  }
  return [...pointsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function saveOverallProgressSnapshot(workPackage, schedule) {
  const activityStatuses = getActivityStatuses();
  const progress = Object.fromEntries(schedule.flatMap(record => {
    const value = getEquipmentOverallProgress(workPackage, record, activityStatuses);
    return value === null ? [] : [[String(record.equipmentTag), value]];
  }));
  if (!Object.keys(progress).length) return true;

  const date = localDateString();
  const id = `overall-progress:${encodeURIComponent(workPackage)}:${date}`;
  const actuals = getEquipmentActuals();
  const snapshot = { id, workPackage, date, progress, source: "overall-progress", savedAt: new Date().toISOString() };
  const existingIndex = actuals.findIndex(item => item.id === id);
  if (existingIndex >= 0) actuals[existingIndex] = snapshot;
  else actuals.push(snapshot);
  return storeEquipmentActuals(actuals);
}

function getActivityStatusKey(workPackage, equipmentTag, index, item) {
  return encodeURIComponent(JSON.stringify([
    workPackage, equipmentTag, index, item.date, item.start || "",
    item.finish || "", item.activity
  ]));
}

function getEquipmentOverallProgress(workPackage, record, activityStatuses = getActivityStatuses()) {
  if (!record.timeline.length) return null;
  const total = record.timeline.reduce((sum, item, sourceIndex) => {
    const activityKey = getActivityStatusKey(workPackage, record.equipmentTag, sourceIndex, item);
    return sum + (activityStatuses[activityKey]?.progress ?? 0);
  }, 0);
  return total / record.timeline.length;
}

function getEquipmentProgressClass(progress) {
  if (progress === null) return "progress-unavailable";
  if (progress === 0) return "progress-not-started";
  if (progress === 100) return "progress-done";
  return "progress-ongoing";
}

function renderMasterSchedule() {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const search = document.getElementById("master-schedule-search").value.trim().toLowerCase();
  const equipmentTable = document.getElementById("equipment-schedule-table");
  const addEquipmentButton = document.getElementById("add-equipment-button");
  const title = document.getElementById("equipment-schedule-title");
  const caption = document.getElementById("equipment-schedule-caption");
  const records = getEquipmentRecords(workPackage);
  const hiddenRecords = workPackage
    ? getEquipmentRecords(workPackage, true).filter(record => record.hidden)
    : [];
  const hiddenPanel = document.getElementById("hidden-equipment-panel");
  hiddenPanel.hidden = !hiddenRecords.length;
  document.getElementById("hidden-equipment-count").textContent = hiddenRecords.length;
  document.getElementById("hidden-equipment-list").innerHTML = hiddenRecords.map(record =>
    `<li><strong>${escapeHtml(record.equipmentTag)}</strong>
      <button class="button button-outline button-small" type="button" data-restore-equipment="${escapeHtml(record.equipmentTag)}">Restore</button></li>`
  ).join("");
  const activityStatuses = getActivityStatuses();
  addEquipmentButton.disabled = !workPackage;
  const expandedActivityTags = equipmentTable.dataset.workPackage === workPackage
    ? new Set([...equipmentTable.querySelectorAll(".equipment-activities[open]")]
      .map(details => details.dataset.equipmentTag))
    : new Set();
  if (!workPackage) {
    title.textContent = "Equipment schedule";
    caption.textContent = "Select a Work Package to browse its equipment and planned dates.";
    equipmentTable.innerHTML = '<p class="empty-note">Select a Work Package to view its schedule.</p>';
  } else {
    title.textContent = `${workPackage} equipment schedule`;
    const filtered = records.filter(record => [
      record.equipmentTag, record.area, record.packageCode, record.unit, record.section,
      getPackageSectionLabel(record),
      record.packageNo, record.operationPackage,
      ...record.timeline.flatMap(item => [item.activity, getEquipmentActivityLabel(item.activity)])
    ].some(value => String(value ?? "").toLowerCase().includes(search)));
    caption.textContent = `${filtered.length} of ${records.length} equipment records · ${records.reduce((count, item) => count + item.timeline.length, 0).toLocaleString()} scheduled time slots`;
    if (!filtered.length) {
      equipmentTable.innerHTML = '<p class="empty-note">No equipment or activity matches that search.</p>';
    } else {
      equipmentTable.innerHTML = `<table class="master-equipment-table">
        <thead><tr><th>No.</th><th>Equipment tag</th><th>Area / unit</th><th>Package / section</th><th>MNT start plan</th><th>MNT finish plan</th><th>Actual start</th><th>Actual finish</th><th>Overall progress</th><th>Daily activities</th><th>Actions</th></tr></thead>
        <tbody>${filtered.map(record => {
          const sequence = records.indexOf(record) + 1;
          const areaUnit = [record.area, record.unit || record.section].filter(Boolean).join(" · ");
          const packageSection = getPackageSectionLabel(record);
          const overallProgress = getEquipmentOverallProgress(workPackage, record, activityStatuses);
          const activityRows = record.timeline
            .map((item, sourceIndex) => ({ item, sourceIndex }))
            .sort((a, b) => a.item.date.localeCompare(b.item.date)
              || String(a.item.start || "").localeCompare(String(b.item.start || ""))
              || a.sourceIndex - b.sourceIndex)
            .map(({ item, sourceIndex }) => {
              const activityKey = getActivityStatusKey(workPackage, record.equipmentTag, sourceIndex, item);
              const activityProgress = activityStatuses[activityKey] || { progress: 0, status: "not-started" };
              const { progress, status } = activityProgress;
              const rowStatus = record.timeline.length ? status : "";
              const activityLabel = getEquipmentActivityLabel(item.activity);
              const statusControl = record.timeline.length
                ? `<td><span class="activity-status-label activity-status-${escapeHtml(status)}" data-activity-status-label>${escapeHtml(status === "not-started" ? "Not started" : status === "done" ? "Done" : "Ongoing")}</span></td>
                   <td><input class="activity-progress-input" type="number" min="0" max="100" step="1" value="${progress}" data-activity-progress="${escapeHtml(activityKey)}" data-saved-progress="${progress}" aria-label="Progress percentage for ${escapeHtml(activityLabel)} on ${escapeHtml(item.date)}"><span class="activity-progress-unit">%</span></td>
                   <td><button class="button button-outline button-small activity-edit-button" type="button" data-edit-scheduled-activity="${sourceIndex}">Edit</button></td>`
                : "";
              return `<tr class="${rowStatus ? `activity-status-row-${escapeHtml(rowStatus)}` : ""}">
                <td>${escapeHtml(formatDate(item.date))}</td>
                <td>${escapeHtml(item.start || "—")}–${escapeHtml(item.finish || "—")}</td>
                <td>${escapeHtml(activityLabel)}</td>${statusControl}</tr>`;
            }).join("");
          const activityHeaders = "<th>Date</th><th>Time</th><th>Scheduled activity</th><th>Status</th><th>Progress (%)</th><th>Actions</th>";
          const emptyActivity = '<tr data-empty-activity><td colspan="6">No daily activities listed.</td></tr>';
          return `<tr>
            <td>${sequence}</td><td><strong class="equipment-tag ${getEquipmentProgressClass(overallProgress)}">${escapeHtml(record.equipmentTag)}</strong></td>
            <td>${escapeHtml(areaUnit || "—")}</td><td>${escapeHtml(packageSection)}</td>
            <td>${escapeHtml(record.maintenanceStart ? formatDate(record.maintenanceStart) : "—")}</td>
            <td>${escapeHtml(record.maintenanceFinish ? formatDate(record.maintenanceFinish) : "—")}</td>
            <td><input type="date" data-equipment-actual-date="actualStart" data-equipment-tag="${escapeHtml(record.equipmentTag)}" data-saved-value="${escapeHtml(record.actualStart || "")}" aria-label="Actual start for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.actualStart || "")}"></td>
            <td><input type="date" data-equipment-actual-date="actualFinish" data-equipment-tag="${escapeHtml(record.equipmentTag)}" data-saved-value="${escapeHtml(record.actualFinish || "")}" aria-label="Actual finish for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.actualFinish || "")}"></td>
            <td><strong class="equipment-overall-progress ${getEquipmentProgressClass(overallProgress)}" data-equipment-overall-progress>${overallProgress === null ? "—" : `${overallProgress.toFixed(1)}%`}</strong></td>
            <td><details class="equipment-activities" data-equipment-tag="${escapeHtml(record.equipmentTag)}"${expandedActivityTags.has(String(record.equipmentTag)) ? " open" : ""}><summary>${record.timeline.length} ${record.timeline.length === 1 ? "activity" : "activities"}</summary>
                            <div class="equipment-activities-list"><table><thead><tr>${activityHeaders}</tr></thead><tbody>${activityRows || emptyActivity}</tbody></table></div>
                            <button class="button button-outline button-small add-scheduled-activity" type="button" data-add-scheduled-activity>Add activity</button>
            </details></td>
            <td class="scheduled-equipment-actions"><button class="button button-outline button-small" type="button" data-edit-scheduled-equipment="${escapeHtml(record.equipmentTag)}">Edit</button>
              <button class="button button-outline button-small" type="button" data-hide-scheduled-equipment="${escapeHtml(record.equipmentTag)}">Delete</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;
    }
  }
  equipmentTable.dataset.workPackage = workPackage;
  document.getElementById("equipment-editor").hidden = true;

  const planTable = document.getElementById("master-plan-table");
  const planRows = masterSchedule.masterPlan.map(item => {
    const assignments = item.entries.map(entry => `${entry.month || ""} ${entry.week || ""}: ${entry.activity}`).join(" · ");
    const quantities = [
      item.executionDays ? `${item.executionDays} days` : "",
      item.equipmentQty ? `${item.equipmentQty} equipment` : "",
      item.mechanicalNorm ? `Mechanical ${item.mechanicalNorm}` : "",
      item.hpwjNorm ? `HPWJ ${item.hpwjNorm}` : ""
    ].filter(Boolean).join(" · ") || "—";
    return `<tr><td>${escapeHtml(item.option)}</td><td>${escapeHtml(item.activity)}</td>
      <td>${escapeHtml(item.contractor || "—")}</td><td>${escapeHtml(quantities)}</td>
      <td>${escapeHtml(assignments || "—")}</td></tr>`;
  }).join("");
  planTable.innerHTML = `<table class="master-plan-table"><thead><tr><th>Option</th><th>Master activity</th><th>Contractor</th><th>Quantities / execution</th><th>Weekly plan</th></tr></thead><tbody>${planRows}</tbody></table>`;
}

function openEquipmentEditor(tag = "") {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  if (!workPackage) {
    showToast("Select a Work Package before adding or editing equipment.");
    return;
  }
  const form = document.getElementById("equipment-editor");
  const record = tag
    ? getEquipmentRecords(workPackage).find(item => String(item.equipmentTag) === tag)
    : null;
  if (tag && !record) {
    showToast(`Equipment ${tag} is not available in the selected Work Package.`);
    return;
  }
  form.reset();
  form.elements.equipmentTag.value = record?.equipmentTag || "";
  form.elements.equipmentTag.readOnly = Boolean(record);
  form.elements.area.value = record?.area || "";
  form.elements.unit.value = record?.unit || record?.section || "";
  form.elements.packageNo.value = record?.packageNo || record?.operationPackage || "";
  form.elements.section.value = record?.packageCode || record?.section || "";
  form.elements.maintenanceStart.value = record?.maintenanceStart || "";
  form.elements.maintenanceFinish.value = record?.maintenanceFinish || "";
  form.elements.actualStart.value = record?.actualStart || "";
  form.elements.actualFinish.value = record?.actualFinish || "";
  form.elements.maintenanceUseDays.value = record?.maintenanceUseDays ?? "";
  form.dataset.originalTag = tag;
  document.getElementById("equipment-editor-title").textContent = record ? `Edit ${tag}` : "Add equipment";
  form.hidden = false;
  form.elements.equipmentTag.focus();
}

function saveScheduledEquipment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const originalTag = form.dataset.originalTag || "";
  const tag = form.elements.equipmentTag.value.trim();
  const records = getEquipmentRecords(workPackage, true);
  const duplicate = records.some(record =>
    String(record.equipmentTag).toLowerCase() === tag.toLowerCase()
    && String(record.equipmentTag) !== originalTag);
  if (duplicate) {
    form.elements.equipmentTag.setCustomValidity("This equipment tag already exists in this Work Package, including hidden equipment. Restore it if needed.");
    form.elements.equipmentTag.reportValidity();
    form.elements.equipmentTag.setCustomValidity("");
    return;
  }
  const maintenanceStart = form.elements.maintenanceStart.value;
  const maintenanceFinish = form.elements.maintenanceFinish.value;
  const actualStart = form.elements.actualStart.value;
  const actualFinish = form.elements.actualFinish.value;
  if (maintenanceStart && maintenanceFinish && maintenanceStart > maintenanceFinish) {
    showToast("MNT finish plan cannot be before MNT start plan.");
    form.elements.maintenanceFinish.focus();
    return;
  }
  if (actualStart && actualFinish && actualStart > actualFinish) {
    showToast("Actual finish cannot be before Actual Start.");
    form.elements.actualFinish.focus();
    return;
  }
  const useDaysInput = form.elements.maintenanceUseDays;
  const maintenanceUseDays = useDaysInput.value === "" ? null : Number(useDaysInput.value);
  if (maintenanceUseDays !== null && (!Number.isFinite(maintenanceUseDays) || maintenanceUseDays < 0)) {
    useDaysInput.focus();
    useDaysInput.reportValidity();
    return;
  }
  const savedOverrides = getEquipmentOverrides();
  const existingOverride = savedOverrides.find(item =>
    normalizeWorkPackage(item.workPackage) === workPackage
    && String(item.equipmentTag) === originalTag);
  const equipment = {
    ...(existingOverride || {}),
    workPackage,
    equipmentTag: tag,
    area: form.elements.area.value.trim(),
    unit: form.elements.unit.value.trim(),
    packageNo: form.elements.packageNo.value.trim(),
    packageCode: form.elements.section.value.trim(),
    maintenanceStart,
    maintenanceFinish,
    actualStart,
    actualFinish,
    maintenanceUseDays
  };
  if (!originalTag) {
    equipment.custom = true;
    equipment.timeline = [];
  }
  const overrides = savedOverrides.filter(item =>
    normalizeWorkPackage(item.workPackage) !== workPackage
    || String(item.equipmentTag) !== originalTag);
  overrides.push(equipment);
  if (!storeEquipmentOverrides(overrides)) return;
  form.hidden = true;
  renderOverview();
  updateActivityEquipmentOptions();
  showToast(`Equipment ${tag} saved.`);
}

function setEquipmentHidden(tag, hidden) {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const record = getEquipmentRecords(workPackage, true)
    .find(item => String(item.equipmentTag) === tag);
  if (!record || Boolean(record.hidden) === hidden) {
    showToast("This equipment is no longer available. Refresh the schedule and try again.");
    return;
  }
  if (hidden && !window.confirm(`Remove ${tag} from ${workPackage}? Its activities and progress will be kept and can be restored.`)) return;
  const overrides = getEquipmentOverrides();
  const existing = overrides.find(item =>
    normalizeWorkPackage(item.workPackage) === workPackage && String(item.equipmentTag) === tag);
  const updated = overrides.filter(item =>
    normalizeWorkPackage(item.workPackage) !== workPackage || String(item.equipmentTag) !== tag);
  updated.push({ ...existing, workPackage, equipmentTag: tag, hidden });
  if (!storeEquipmentOverrides(updated)) return;
  renderOverview();
  updateActivityEquipmentOptions();
  showToast(`Equipment ${tag} ${hidden ? "removed" : "restored"}.`);
}

function addScheduledActivity(button) {
  const details = button.closest(".equipment-activities");
  const tbody = details.querySelector(".equipment-activities-list tbody");
  const existingEditor = tbody.querySelector("[data-new-activity]");
  if (existingEditor) {
    existingEditor.querySelector('[data-activity-field="date"]').focus();
    return;
  }
  const row = document.createElement("tr");
  row.dataset.newActivity = "true";
  row.innerHTML = `<td><input type="date" data-activity-field="date" aria-label="Activity date" required></td>
    <td><div class="activity-time-fields">
      <input type="text" data-activity-field="start" aria-label="Activity start time" placeholder="7AM">
      <span>–</span>
      <input type="text" data-activity-field="finish" aria-label="Activity finish time" placeholder="12PM">
    </div></td>
    <td><input type="text" data-activity-field="activity" aria-label="Scheduled activity" placeholder="Activity" required></td>
    <td>Not started</td><td>0%</td>
    <td class="activity-row-actions">
      <button class="button button-primary button-small" type="button" data-activity-action="save">Save</button>
      <button class="button button-outline button-small" type="button" data-activity-action="cancel-add">Cancel</button>
    </td>`;
  const emptyRow = tbody.querySelector("[data-empty-activity]");
  if (emptyRow) emptyRow.hidden = true;
  tbody.prepend(row);
  row.querySelector('[data-activity-field="date"]').focus();
}

function editScheduledActivity(button) {
  const row = button.closest("tr");
  const activityIndex = button.dataset.editScheduledActivity;
  const details = button.closest(".equipment-activities");
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const record = getEquipmentRecords(workPackage)
    .find(item => String(item.equipmentTag) === details.dataset.equipmentTag);
  const item = record?.timeline[Number(activityIndex)];
  if (!item) {
    showToast("This scheduled activity is no longer available. Refresh the schedule and try again.");
    return;
  }
  const statusMarkup = row.querySelector("[data-activity-status-label]").outerHTML;
  const progressMarkup = row.querySelector("[data-activity-progress]").closest("td").innerHTML;
  row.dataset.activityIndex = activityIndex;
  row.innerHTML = `<td><input type="date" data-activity-field="date" aria-label="Activity date" required value="${escapeHtml(item.date)}"></td>
    <td><div class="activity-time-fields">
      <input type="text" data-activity-field="start" aria-label="Activity start time" value="${escapeHtml(item.start || "")}">
      <span>–</span>
      <input type="text" data-activity-field="finish" aria-label="Activity finish time" value="${escapeHtml(item.finish || "")}">
    </div></td>
    <td><input type="text" data-activity-field="activity" aria-label="Scheduled activity" required value="${escapeHtml(getEquipmentActivityLabel(item.activity))}"></td>
    <td>${statusMarkup}</td><td>${progressMarkup}</td>
    <td class="activity-row-actions">
      <button class="button button-primary button-small" type="button" data-activity-action="save">Save</button>
      <button class="button button-outline button-small" type="button" data-activity-action="cancel">Cancel</button>
    </td>`;
  row.querySelector("[data-activity-progress]").disabled = true;
  row.querySelector('[data-activity-field="activity"]').focus();
}

function saveScheduledActivity(button) {
  const row = button.closest("tr");
  const details = button.closest(".equipment-activities");
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const equipmentTag = details.dataset.equipmentTag;
  const isNew = row.hasAttribute("data-new-activity");
  const activityIndex = isNew ? null : Number(row.dataset.activityIndex);
  const records = getEquipmentRecords(workPackage);
  const record = records.find(item => String(item.equipmentTag) === equipmentTag);
  const originalActivity = isNew ? null : record?.timeline[activityIndex];
  if (!record || (!isNew && !originalActivity)) {
    showToast("This scheduled activity is no longer available. Refresh the schedule and try again.");
    return;
  }
  const value = field => row.querySelector(`[data-activity-field="${field}"]`).value.trim();
  const dateInput = row.querySelector('[data-activity-field="date"]');
  const activityInput = row.querySelector('[data-activity-field="activity"]');
  const date = dateInput.value;
  const enteredActivity = value("activity");
  const activity = originalActivity && enteredActivity === getEquipmentActivityLabel(originalActivity.activity)
    ? originalActivity.activity
    : enteredActivity;
  if (!date) {
    dateInput.focus();
    dateInput.reportValidity();
    return;
  }
  if (!activity) {
    activityInput.focus();
    activityInput.setCustomValidity("Enter an activity.");
    activityInput.reportValidity();
    activityInput.setCustomValidity("");
    return;
  }

  const updatedActivity = { ...(originalActivity || {}), date, start: value("start"), finish: value("finish"), activity };
  const timeline = isNew
    ? [...record.timeline, updatedActivity]
    : record.timeline.map((item, index) => index === activityIndex ? updatedActivity : item);
  const savedOverrides = getEquipmentOverrides();
  const existingOverride = savedOverrides.find(item =>
    normalizeWorkPackage(item.workPackage) === workPackage
    && String(item.equipmentTag) === equipmentTag);
  const updatedOverride = { ...(existingOverride || record), workPackage, equipmentTag, timeline };
  const overrides = savedOverrides.filter(item =>
    normalizeWorkPackage(item.workPackage) !== workPackage
    || String(item.equipmentTag) !== equipmentTag);
  overrides.push(updatedOverride);
  if (!storeEquipmentOverrides(overrides)) return;

  const statuses = getActivityStatuses();
  if (!isNew) {
    const oldKey = getActivityStatusKey(workPackage, equipmentTag, activityIndex, originalActivity);
    const newKey = getActivityStatusKey(workPackage, equipmentTag, activityIndex, updatedActivity);
    if (oldKey !== newKey && statuses[oldKey]) {
      statuses[newKey] = statuses[oldKey];
      delete statuses[oldKey];
      if (!storeActivityStatuses(statuses)) {
        storeEquipmentOverrides(savedOverrides);
        return;
      }
    }
  }
  const updatedRecords = getEquipmentRecords(workPackage);
  const hasRecordedProgress = updatedRecords.some(equipment => equipment.timeline.some((item, index) =>
    Object.prototype.hasOwnProperty.call(statuses,
      getActivityStatusKey(workPackage, equipment.equipmentTag, index, item))));
  if (hasRecordedProgress && !saveOverallProgressSnapshot(workPackage, updatedRecords)) {
    showToast("Activity saved, but its overall progress snapshot could not be saved.");
  } else {
    showToast(`Activity ${isNew ? "added" : "saved"} for ${equipmentTag}.`);
  }
  renderOverview();
}

function saveActivityStatus(event) {
  const actualDateInput = event.target.closest("[data-equipment-actual-date]");
  if (actualDateInput) {
    saveEquipmentActualDate(actualDateInput);
    return;
  }
  const input = event.target.closest("[data-activity-progress]");
  if (!input) return;
  const progress = input.valueAsNumber;
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    showToast("Enter a whole-number progress value from 0 to 100.");
    input.value = input.dataset.savedProgress;
    return;
  }
  const statuses = getActivityStatuses();
  const key = input.dataset.activityProgress;
  const status = statusForProgress(progress);
  statuses[key] = { progress, status };
  if (!storeActivityStatuses(statuses)) {
    input.value = input.dataset.savedProgress;
    return;
  }
  input.dataset.savedProgress = String(progress);
  const row = input.closest("tr");
  row.querySelector("[data-activity-status-label]").textContent =
    status === "not-started" ? "Not started" : status === "done" ? "Done" : "Ongoing";
  row.querySelector("[data-activity-status-label]").className =
    `activity-status-label activity-status-${status}`;
  row.className = `activity-status-row-${status}`;
  const equipmentRow = input.closest(".equipment-activities").closest("td").parentElement;
  const overallProgress = equipmentRow.querySelector("[data-equipment-overall-progress]");
  const activityInputs = equipmentRow.querySelectorAll("[data-activity-progress]");
  if (overallProgress && activityInputs.length) {
    const total = [...activityInputs].reduce((sum, activityInput) =>
      sum + (Number(activityInput.value) || 0), 0);
    const progress = total / activityInputs.length;
    overallProgress.textContent = `${progress.toFixed(1)}%`;
    const progressClass = getEquipmentProgressClass(progress);
    overallProgress.className = `equipment-overall-progress ${progressClass}`;
    equipmentRow.querySelector(".equipment-tag").className = `equipment-tag ${progressClass}`;
  }
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const schedule = getEquipmentRecords(workPackage);
  if (!saveOverallProgressSnapshot(workPackage, schedule)) {
    showToast("Overall progress was saved, but its S-curve snapshot could not be saved.");
  }
  renderOverview();
}

function saveEquipmentActualDate(input) {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const tag = input.dataset.equipmentTag;
  const row = input.closest("tr");
  const actualStart = row.querySelector('[data-equipment-actual-date="actualStart"]');
  const actualFinish = row.querySelector('[data-equipment-actual-date="actualFinish"]');
  if (actualStart.value && actualFinish.value && actualStart.value > actualFinish.value) {
    input.value = input.dataset.savedValue;
    input.focus();
    showToast(`Actual finish cannot be before Actual Start for ${tag}.`);
    return;
  }

  const overrides = getEquipmentOverrides();
  const existing = overrides.find(item =>
    normalizeWorkPackage(item.workPackage) === workPackage && String(item.equipmentTag) === tag);
  const updated = {
    ...(existing || { workPackage, equipmentTag: tag }),
    actualStart: actualStart.value,
    actualFinish: actualFinish.value
  };
  const nextOverrides = overrides.filter(item =>
    normalizeWorkPackage(item.workPackage) !== workPackage || String(item.equipmentTag) !== tag);
  nextOverrides.push(updated);
  if (!storeEquipmentOverrides(nextOverrides)) {
    input.value = input.dataset.savedValue;
    return;
  }
  actualStart.dataset.savedValue = actualStart.value;
  actualFinish.dataset.savedValue = actualFinish.value;
  showToast(`Actual dates saved for ${tag}.`);
}

function renderActualEntryTable() {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const date = document.getElementById("actual-entry-date").value;
  const container = document.getElementById("actual-entry-table");
  if (!workPackage) {
    editingEquipmentTags.clear();
    container.innerHTML = '<p class="empty-note">Select a Work Package to load equipment.</p>';
    return;
  }
  const records = getEquipmentRecords(workPackage);
  const matching = getEquipmentActuals()
    .filter(item => normalizeWorkPackage(item.workPackage) === workPackage && item.date === date)
    .sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  const current = new Map();
  matching.forEach(item => Object.entries(item.progress || {}).forEach(([tag, value]) => current.set(tag, value)));
  container.innerHTML = `<table class="actual-entry-table"><thead><tr><th>No.</th><th>Equipment tag</th><th>Area</th><th>Unit</th><th>MNT start plan</th><th>MNT finish plan</th><th>Actual start</th><th>Actual finish</th><th>MNT use days</th><th>Actual complete (%)</th><th>Actions</th></tr></thead>
    <tbody>${records.map((record, index) => {
    const tag = String(record.equipmentTag);
    const isEditing = editingEquipmentTags.has(tag);
    return `<tr data-equipment-row="${escapeHtml(tag)}">
      <td>${index + 1}</td><td><strong>${escapeHtml(record.equipmentTag)}</strong></td>
      <td>${isEditing
        ? `<input type="text" data-equipment-field="area" aria-label="Area for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.area || "")}">`
        : escapeHtml(record.area || "—")}</td>
      <td>${isEditing
        ? `<input type="text" data-equipment-field="unit" aria-label="Unit for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.unit || record.section || "")}">`
        : escapeHtml(record.unit || record.section || "—")}</td>
      <td>${isEditing
        ? `<input type="date" data-equipment-field="maintenanceStart" aria-label="MNT start plan for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.maintenanceStart || "")}">`
        : escapeHtml(record.maintenanceStart ? formatDate(record.maintenanceStart) : "—")}</td>
      <td>${isEditing
        ? `<input type="date" data-equipment-field="maintenanceFinish" aria-label="MNT finish plan for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.maintenanceFinish || "")}">`
        : escapeHtml(record.maintenanceFinish ? formatDate(record.maintenanceFinish) : "—")}</td>
      <td>${isEditing
        ? `<input type="date" data-equipment-field="actualStart" aria-label="Actual start for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.actualStart || "")}">`
        : escapeHtml(record.actualStart ? formatDate(record.actualStart) : "—")}</td>
      <td>${isEditing
        ? `<input type="date" data-equipment-field="actualFinish" aria-label="Actual finish for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.actualFinish || "")}">`
        : escapeHtml(record.actualFinish ? formatDate(record.actualFinish) : "—")}</td>
      <td>${isEditing
        ? `<input type="number" min="0" step="0.1" data-equipment-field="maintenanceUseDays" aria-label="MNT use days for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.maintenanceUseDays ?? "")}">`
        : escapeHtml(record.maintenanceUseDays ?? "—")}</td>
      <td><input type="number" min="0" max="100" step="0.1" data-actual-tag="${escapeHtml(record.equipmentTag)}" aria-label="Actual completion percentage for ${escapeHtml(record.equipmentTag)}" placeholder="Not updated" value="${current.has(String(record.equipmentTag)) ? escapeHtml(current.get(String(record.equipmentTag))) : ""}"></td>
      <td class="equipment-row-actions">${isEditing
        ? `<button class="button button-primary button-small" type="button" data-equipment-action="save" data-equipment-tag="${escapeHtml(tag)}">Save</button>
          <button class="button button-outline button-small" type="button" data-equipment-action="cancel" data-equipment-tag="${escapeHtml(tag)}">Cancel</button>`
        : `<button class="button button-outline button-small" type="button" data-equipment-action="edit" data-equipment-tag="${escapeHtml(tag)}">Edit</button>`}</td>
    </tr>`;
  }).join("")}</tbody></table>`;
}

function saveEquipmentDetails(tag) {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  if (!workPackage) {
    showToast("Select a Work Package before editing equipment details.");
    return;
  }
  const row = [...document.querySelectorAll("#actual-entry-table [data-equipment-row]")]
    .find(item => item.dataset.equipmentRow === tag);
  const inputs = [...(row?.querySelectorAll("[data-equipment-field]") || [])];
  if (!inputs.length) {
    showToast("Select Edit on an equipment row before saving its details.");
    return;
  }
  const records = new Map(getEquipmentRecords(workPackage).map(record => [String(record.equipmentTag), record]));
  const record = records.get(tag);
  if (!record) {
    showToast(`Equipment ${tag} is not available in the selected Work Package.`);
    return;
  }
  const change = {
    workPackage,
    equipmentTag: tag,
    area: inputs.find(input => input.dataset.equipmentField === "area").value.trim(),
    unit: inputs.find(input => input.dataset.equipmentField === "unit").value.trim(),
    maintenanceStart: inputs.find(input => input.dataset.equipmentField === "maintenanceStart").value,
    maintenanceFinish: inputs.find(input => input.dataset.equipmentField === "maintenanceFinish").value,
    actualStart: inputs.find(input => input.dataset.equipmentField === "actualStart").value,
    actualFinish: inputs.find(input => input.dataset.equipmentField === "actualFinish").value,
    maintenanceUseDays: Number(inputs.find(input => input.dataset.equipmentField === "maintenanceUseDays").value || 0)
  };
  const useDaysInput = inputs.find(input => input.dataset.equipmentField === "maintenanceUseDays");
  if (!Number.isFinite(change.maintenanceUseDays) || change.maintenanceUseDays < 0 || !useDaysInput.validity.valid) {
    useDaysInput.focus();
    useDaysInput.reportValidity();
    return;
  }
  if (change.maintenanceStart && change.maintenanceFinish && change.maintenanceStart > change.maintenanceFinish) {
    const finishInput = inputs.find(input => input.dataset.equipmentField === "maintenanceFinish");
    finishInput.focus();
    showToast(`MNT finish plan cannot be before MNT start plan for ${tag}.`);
    return;
  }
  if (change.actualStart && change.actualFinish && change.actualStart > change.actualFinish) {
    const finishInput = inputs.find(input => input.dataset.equipmentField === "actualFinish");
    finishInput.focus();
    showToast(`Actual finish cannot be before Actual Start for ${tag}.`);
    return;
  }
  const actualProgressInputs = new Map([...document.querySelectorAll("#actual-entry-table [data-actual-tag]")]
    .map(input => [input.dataset.actualTag, input.value]));
  const savedOverrides = getEquipmentOverrides();
  const existingOverride = savedOverrides.find(item =>
    normalizeWorkPackage(item.workPackage) === workPackage && String(item.equipmentTag) === tag);
  const overrides = savedOverrides.filter(item =>
    normalizeWorkPackage(item.workPackage) !== workPackage || String(item.equipmentTag) !== tag
  );
  overrides.push({ ...existingOverride, ...change });
  if (storeEquipmentOverrides(overrides)) {
    editingEquipmentTags.delete(tag);
    renderOverview();
    updateActivityEquipmentOptions();
    document.querySelectorAll("#actual-entry-table [data-actual-tag]").forEach(input => {
      if (actualProgressInputs.has(input.dataset.actualTag)) {
        input.value = actualProgressInputs.get(input.dataset.actualTag);
      }
    });
    const feedback = `Equipment details saved for ${tag}.`;
    document.getElementById("actual-entry-feedback").textContent = feedback;
    showToast(feedback);
  }
}

function handleEquipmentRowAction(event) {
  const button = event.target.closest("[data-equipment-action]");
  if (!button) return;
  const { equipmentAction: action, equipmentTag: tag } = button.dataset;
  if (action === "save") {
    saveEquipmentDetails(tag);
    return;
  }
  if (action === "edit") editingEquipmentTags.add(tag);
  else if (action === "cancel") editingEquipmentTags.delete(tag);
  const actualProgressInputs = new Map([...document.querySelectorAll("#actual-entry-table [data-actual-tag]")]
    .map(input => [input.dataset.actualTag, input.value]));
  renderActualEntryTable();
  document.querySelectorAll("#actual-entry-table [data-actual-tag]").forEach(input => {
    if (actualProgressInputs.has(input.dataset.actualTag)) {
      input.value = actualProgressInputs.get(input.dataset.actualTag);
    }
  });
}

function saveActualProgress() {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const date = document.getElementById("actual-entry-date").value;
  if (!workPackage) {
    showToast("Select a Work Package before saving actual progress.");
    return;
  }
  if (!date) {
    document.getElementById("actual-entry-date").focus();
    showToast("Select a progress date before saving actual progress.");
    return;
  }
  const inputs = [...document.querySelectorAll("#actual-entry-table [data-actual-tag]")];
  if (!inputs.length) {
    showToast("No equipment rows are available for this Work Package.");
    return;
  }
  const actualProgress = readActualProgressInputs();
  if (!actualProgress) return;
  if (!actualProgress.hasValues) {
    showToast("Enter at least one equipment completion percentage.");
    return;
  }
  if (appendEquipmentActuals(workPackage, date, actualProgress.progress)) {
    renderOverview();
    document.getElementById("actual-entry-feedback").textContent = `Actual progress saved for ${workPackage} · ${formatDate(date)}.`;
    showToast("Equipment actual progress saved.");
  }
}

function readActualProgressInputs() {
  const inputs = [...document.querySelectorAll("#actual-entry-table [data-actual-tag]")];
  const progress = {};
  for (const input of inputs) {
    if (input.value === "") continue;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0 || value > 100 || !input.validity.valid) {
      input.focus();
      input.reportValidity();
      return null;
    }
    progress[input.dataset.actualTag] = value;
  }
  return { progress, hasValues: Object.keys(progress).length > 0 };
}

function appendEquipmentActuals(workPackage, date, progress) {
  const savedAt = new Date().toISOString();
  const actuals = getEquipmentActuals();
  actuals.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`, workPackage, date, progress, savedAt });
  return storeEquipmentActuals(actuals);
}

function buildCurveSvg(plannedPoints, actualPoints, today = localDateString()) {
  const width = 820;
  const height = 270;
  const left = 52;
  const right = 18;
  const top = 14;
  const bottom = 39;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const allDates = [...plannedPoints, ...actualPoints, { date: today }].map(point => point.date).sort();
  const minDate = new Date(`${allDates[0]}T00:00:00Z`);
  const maxDate = new Date(`${allDates[allDates.length - 1]}T00:00:00Z`);
  const dateRange = Math.max(1, (maxDate - minDate) / 86400000);
  const x = date => left + (new Date(`${date}T00:00:00Z`) - minDate) / 86400000 / dateRange * plotWidth;
  const y = value => top + (100 - Math.min(100, Math.max(0, Number(value) || 0))) * plotHeight / 100;
  const planned = plannedPoints.map((point, index) => `${index ? "L" : "M"}${x(point.date)},${y(point.plannedProgress)}`).join(" ");
  const actual = actualPoints.map((point, index) => `${index ? "L" : "M"}${x(point.date)},${y(point.actualProgress)}`).join(" ");
  const grid = [0, 20, 40, 60, 80, 100].map(value => {
    const position = y(value);
    return `<g><line x1="${left}" y1="${position}" x2="${width - right}" y2="${position}" class="chart-grid-line"/>
      <text x="${left - 10}" y="${position + 3}" text-anchor="end" class="chart-axis-label">${value}%</text></g>`;
  }).join("");
  const totalDays = Math.ceil(dateRange);
  const labelStep = Math.max(1, Math.ceil(totalDays / 6));
  const labelDays = new Set();
  for (let day = 0; day <= totalDays; day += labelStep) labelDays.add(day);
  labelDays.add(totalDays);
  const dateLabels = [...labelDays].map(day => {
    const date = new Date(minDate.getTime() + day * 86400000).toISOString().slice(0, 10);
    return `<text x="${x(date)}" y="${height - 12}" text-anchor="middle" class="chart-axis-label">${escapeHtml(formatDate(date))}</text>`;
  }).join("");
  const markers = actualPoints.map(point =>
    `<circle cx="${x(point.date)}" cy="${y(point.actualProgress)}" r="3.5" class="chart-dot-actual"><title>${escapeHtml(formatDate(point.date))} · Actual ${point.actualProgress.toFixed(1)}%</title></circle>`
  ).join("");
  const todayX = x(today);
  const todayLabel = formatDate(today).split("/").slice(0, 2).join("-");
  const todayAnchor = todayX < left + 42 ? "start" : todayX > width - right - 42 ? "end" : "middle";
  const todayLabelX = todayAnchor === "start" ? todayX + 4 : todayAnchor === "end" ? todayX - 4 : todayX;
  const todayMarker = `<g class="chart-today-marker"><line x1="${todayX}" y1="${top}" x2="${todayX}" y2="${height - bottom}" class="chart-line-today"/>
    <text x="${todayLabelX}" y="${top + 10}" text-anchor="${todayAnchor}" class="chart-today-label">${escapeHtml(todayLabel)}</text>
    <title>Current date · ${escapeHtml(formatDate(today))}</title></g>`;
  const actualLine = actualPoints.length > 1 ? `<path d="${actual}" class="chart-line chart-line-actual"/>` : "";
  const actualNotice = actualPoints.length
    ? ""
    : `<text x="${width / 2}" y="${top + 16}" text-anchor="middle" class="chart-axis-label">Enter Daily activities progress to display the actual curve</text>`;

  return `<svg class="curve-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Planned and actual cumulative progress over time">
    ${grid}
    <path d="${planned}" class="chart-line chart-line-planned"/>
    ${actualLine}${markers}${todayMarker}${actualNotice}${dateLabels}
  </svg>`;
}

function renderSavedDateSummary() {
  const selectedDate = document.getElementById("archive-date").value;
  const container = document.getElementById("saved-date-summary");
  if (!selectedDate) {
    container.innerHTML = '<p class="empty-note">Select a date to view its saved reports.</p>';
    return;
  }
  const matchingReports = getReports()
    .filter(report => report.date === selectedDate)
    .sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  if (!matchingReports.length) {
    container.innerHTML = '<p class="empty-note">No reports saved for this date.</p>';
    return;
  }

  container.innerHTML = `<div class="saved-date-count">${matchingReports.length} ${matchingReports.length === 1 ? "daily report" : "daily reports"}</div>
    ${matchingReports.map(report => `<div class="saved-date-report">
      <span><strong>Reported by</strong>${escapeHtml(report.preparedBy || "—")}</span>
      <span><strong>Work Package</strong>${escapeHtml(report.workPackage || report.unit || "—")}</span>
    </div>`).join("")}`;
}

function printTable(title, items, columns, includeNumber = false) {
  if (!items?.length) return "";
  const dateFields = new Set(["plannedOpen", "actualOpen", "planClose", "actualClose", "dueDate"]);
  const headers = [...(includeNumber ? ["No."] : []), ...columns.map(([label]) => label)];
  const body = items.map((item, index) => `<tr>${includeNumber ? `<td>${index + 1}</td>` : ""}${columns.map(([, key]) => `<td>${escapeHtml(item[key] ? (dateFields.has(key) ? formatDate(item[key]) : item[key]) : "—")}</td>`).join("")}</tr>`).join("");
  return `<h2>${escapeHtml(title)}</h2><table><thead><tr>${headers.map(label => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}

function saveReport(event) {
  if (event) event.preventDefault();
  if (!validateForm()) return;
  const report = collectReport();
  const reports = getReports();
  const existingIndex = editingReportId
    ? reports.findIndex(item => String(item.id) === editingReportId)
    : -1;
  const isUpdate = existingIndex >= 0;
  report.id = isUpdate
    ? reports[existingIndex].id
    : crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  report.savedAt = new Date().toISOString();
  if (isUpdate) reports[existingIndex] = report;
  else reports.push(report);
  if (storeReports(reports)) {
    editingReportId = String(report.id);
    updateSaveButtonLabels();
    document.getElementById("archive-date").value = report.date;
    renderHistory();
    document.getElementById("save-feedback").textContent = isUpdate
      ? "Updated saved report"
      : cloudReady ? "Saved to shared workspace" : "Saved to this browser";
    showToast(isUpdate ? "Saved report updated." : "Daily report saved.");
  }
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (!validateForm()) return;
  const report = collectReport();
  const data = [
    ["TURNAROUND DAILY REPORT"],
    ["Report date", formatDate(report.date), "Shift", report.shift, "Plant", report.plant || report.site, "Work Package", report.workPackage || report.unit],
    ["Prepared by", report.preparedBy, "Overall status", report.overallStatus, "Weather", report.weather],
    [],
    ["EQUIPMENT MILESTONES"],
    ["Equipment", "Planned Start", "Actual Start", "Plan Finish", "Actual Finish"],
    ...report.overallActivities.map(item => [item.equipment, formatDate(item.plannedOpen), formatDate(item.actualOpen), formatDate(item.planClose), formatDate(item.actualClose)]),
    [],
    ["ACTIVITY DESCRIPTION"],
    ["Equipment", "Section", "Work Done Today", "Work to be Tomorrow", "Remark"],
    ...report.workActivities.map(item => [item.equipment, item.section, item.todayActivity, item.tomorrowActivity, item.remark]),
    [],
    ["OPEN ISSUES AND ACTIONS"],
    ["No.", "Issue", "Countermeasure", "Action by", "Due date", "Status", "Remark"],
    ...report.issues.map((item, index) => [index + 1, item.issue, item.countermeasure, item.actionBy, formatDate(item.dueDate), item.status, item.remark]),
    ...(report.packages.length ? [
      [],
      ["ACTIVITY-LEVEL PROGRESS"],
      ["Activity", "Area", "Planned (%)", "Actual (%)", "Status"],
      ...report.packages.map(item => [item.name, item.area, item.planned, item.actual, item.status])
    ] : []),
    [],
    ["HANDOVER NOTES"],
    [getHandoverSummary(report)]
  ];
  const csv = "\uFEFF" + data.map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `turnaround-daily-report-${report.date}.csv`);
  showToast("Excel-compatible CSV exported.");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function getExportPackageProgress(workPackage) {
  const date = localDateString();
  const packages = ["MS03 Drum", "MS04 Tower"].map(item => {
    const data = getPackageComparison(item, date);
    return {
      workPackage: item,
      equipment: `${data.equipmentCount.toLocaleString()} equipment`,
      plan: data.planned === null ? "—" : `${data.planned.toFixed(1)}%`,
      actual: data.actual === null ? "—" : `${data.actual.toFixed(1)}%`,
      planValue: data.planned,
      actualValue: data.actual,
      duration: data.durationDays === null ? "—" : `${data.durationDays.toLocaleString()} days`,
      finish: data.finish ? formatDate(data.finish) : "—"
    };
  });
  const schedule = workPackage ? getEquipmentRecords(workPackage) : [];
  const indicators = getPackageIndicators(workPackage, schedule, date);
  return {
    date,
    packages,
    indicators: [
      ["Equipment in scope", workPackage ? schedule.length.toLocaleString() : "—"],
      ["Schedule duration", workPackage && indicators.durationDays !== null ? `${indicators.durationDays.toLocaleString()} days` : "—"],
      ["Equipment complete", workPackage ? `${indicators.completedEquipment.toLocaleString()} / ${schedule.length.toLocaleString()}` : "—"],
      ["Equipment behind plan", workPackage ? indicators.delayedEquipment.toLocaleString() : "—"]
    ]
  };
}

async function createReportImage(report) {
  const width = 1200;
  const padding = 64;
  const contentWidth = width - padding * 2;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = 1200 * scale;
  let context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available in this browser.");
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, canvas.height / scale);
  const ensureCanvasHeight = requiredHeight => {
    if (requiredHeight * scale <= canvas.height) return;
    const snapshot = document.createElement("canvas");
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    snapshot.getContext("2d").drawImage(canvas, 0, 0);
    canvas.height = Math.max(requiredHeight * scale, canvas.height * 2);
    context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(snapshot, 0, 0);
    context.scale(scale, scale);
    context.textBaseline = "top";
  };

  const logo = new Image();
  logo.src = new URL("company-logo-scg-lsp.png", window.location.href).href;
  await new Promise((resolve, reject) => {
    logo.onload = resolve;
    logo.onerror = () => reject(new Error("Could not load the company logo."));
  });

  context.drawImage(logo, padding, 32, 240, 53);
  let y = 44;
  context.fillStyle = "#102a43";
  context.font = "700 30px Arial, sans-serif";
  context.textBaseline = "top";
  context.fillText("Daily Shift Report", padding + 264, y);
  context.fillStyle = "#708090";
  context.font = "16px Arial, sans-serif";
  context.fillText(
    `${report.plant || report.site || "Plant not specified"} · ${report.workPackage || report.unit || "Work package not specified"} · ${formatDate(report.date)} · ${report.shift}`,
    padding + 264,
    y + 42,
    contentWidth - 350
  );
  const statusText = report.overallStatus || "On track";
  context.font = "700 15px Arial, sans-serif";
  const statusWidth = context.measureText(statusText).width + 32;
  context.fillStyle = "#edf7f3";
  context.beginPath();
  context.arc(width - padding - statusWidth + 17, 64, 17, Math.PI / 2, Math.PI * 1.5);
  context.arc(width - padding - 17, 64, 17, Math.PI * 1.5, Math.PI / 2);
  context.fill();
  context.fillStyle = "#237d68";
  context.fillText(statusText, width - padding - statusWidth + 16, 56);
  y = 112;
  context.fillStyle = "#176b87";
  context.fillRect(padding, y, contentWidth, 4);
  y += 24;

  const wrapText = (value, maxWidth, font) => {
    context.font = font;
    const lines = [];
    for (const paragraph of String(value || "—").split("\n")) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && context.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return lines;
  };
  const drawSectionTitle = title => {
    ensureCanvasHeight(y + 34);
    context.fillStyle = "#102a43";
    context.font = "700 20px Arial, sans-serif";
    context.fillText(title, padding, y);
    y += 34;
  };
  const drawMetaGrid = fields => {
    const columns = 3;
    const gap = 12;
    const cellWidth = (contentWidth - gap * (columns - 1)) / columns;
    const cellHeight = 68;
    ensureCanvasHeight(y + Math.ceil(fields.length / columns) * (cellHeight + gap) + 10);
    fields.forEach((field, index) => {
      const x = padding + (index % columns) * (cellWidth + gap);
      const row = Math.floor(index / columns);
      const top = y + row * (cellHeight + gap);
      context.fillStyle = "#f3f6f8";
      context.fillRect(x, top, cellWidth, cellHeight);
      context.fillStyle = "#708090";
      context.font = "13px Arial, sans-serif";
      context.fillText(field[0], x + 12, top + 10);
      context.fillStyle = "#344b60";
      context.font = "700 15px Arial, sans-serif";
      const lines = wrapText(field[1], cellWidth - 24, context.font);
      lines.slice(0, 2).forEach((line, lineIndex) => context.fillText(line, x + 12, top + 32 + lineIndex * 18));
    });
    y += Math.ceil(fields.length / columns) * (cellHeight + gap) + 10;
  };
  const drawTable = (title, items, columns, widths, includeNumber = false) => {
    if (!items.length) return;
    drawSectionTitle(title);
    const headers = [...(includeNumber ? [["No.", "number"]] : []), ...columns];
    const values = items.map((item, index) => [
      ...(includeNumber ? [String(index + 1)] : []),
      ...columns.map(([, key]) => {
        const value = item[key];
        const dateFields = ["plannedOpen", "actualOpen", "planClose", "actualClose", "dueDate"];
        if (!value) return "—";
        if (dateFields.includes(key)) return formatDate(value);
        if (["planned", "actual"].includes(key)) return `${value}%`;
        return String(value);
      })
    ]);
    const columnWidths = widths.map(value => contentWidth * value);
    const rowPadding = 9;
    const lineHeight = 17;
    const drawRow = (cells, top, header = false) => {
      const lines = cells.map((value, index) => wrapText(value, columnWidths[index] - rowPadding * 2, header ? "700 13px Arial, sans-serif" : "13px Arial, sans-serif"));
      const rowHeight = Math.max(34, ...lines.map(value => value.length * lineHeight + rowPadding * 2));
      ensureCanvasHeight(top + rowHeight + 20);
      context.fillStyle = header ? "#edf2f5" : "#ffffff";
      context.fillRect(padding, top, contentWidth, rowHeight);
      context.strokeStyle = "#e4eaf0";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padding, top + rowHeight);
      context.lineTo(padding + contentWidth, top + rowHeight);
      context.stroke();
      let x = padding;
      cells.forEach((value, index) => {
        context.fillStyle = header ? "#526779" : "#344b60";
        context.font = header ? "700 13px Arial, sans-serif" : "13px Arial, sans-serif";
        lines[index].forEach((line, lineIndex) => context.fillText(line, x + rowPadding, top + rowPadding + lineIndex * lineHeight));
        x += columnWidths[index];
      });
      return rowHeight;
    };
    y += 4;
    y += drawRow(headers.map(([label]) => label), y, true);
    values.forEach(cells => { y += drawRow(cells, y); });
    y += 22;
  };

  drawMetaGrid([
    ["Report date", formatDate(report.date)],
    ["Plant", report.plant || report.site],
    ["Work Package", report.workPackage || report.unit],
    ["Shift", report.shift],
    ["Prepared by", report.preparedBy],
    ["Overall status", report.overallStatus],
    ["Weather / conditions", report.weather]
  ]);
  const workPackage = normalizeWorkPackage(report.workPackage || report.unit);
  const schedule = workPackage ? getEquipmentRecords(workPackage) : [];
  const plannedPoints = workPackage ? buildPlannedProgress(schedule) : [];
  const actualPoints = workPackage ? buildActualProgress(workPackage, schedule) : [];
  const packageProgress = getExportPackageProgress(workPackage);
  ensureCanvasHeight(y + 450);
  context.fillStyle = "#123650";
  context.fillRect(padding, y, contentWidth, 86);
  context.fillStyle = "#57d4bd";
  context.font = "700 11px Arial, sans-serif";
  context.fillText("DRUM & TOWER TURNAROUND", padding + 20, y + 13);
  context.fillStyle = "#ffffff";
  context.font = "700 23px Arial, sans-serif";
  context.fillText("Package progress", padding + 20, y + 30);
  context.font = "13px Arial, sans-serif";
  context.fillText(`Work Package: ${workPackage || "Not specified"}`, padding + 20, y + 62);
  y += 86;
  context.fillStyle = "#eff4f7";
  context.fillRect(padding, y, contentWidth, 29);
  context.fillStyle = "#526e81";
  context.font = "700 11px Arial, sans-serif";
  context.fillText("PACKAGE PERFORMANCE", padding + 16, y + 9);
  context.textAlign = "right";
  context.fillText(`AS OF ${formatDate(packageProgress.date)}`, padding + contentWidth - 16, y + 9);
  context.textAlign = "left";
  y += 43;
  const cardGap = 16;
  const cardWidth = (contentWidth - cardGap) / 2;
  const cardHeight = 154;
  packageProgress.packages.forEach((item, index) => {
    const x = padding + index * (cardWidth + cardGap);
    const color = index === 0 ? "#df7929" : "#128b8e";
    context.fillStyle = "#f5f8fa";
    context.fillRect(x, y, cardWidth, cardHeight);
    if (item.workPackage === workPackage) {
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, cardWidth - 1, cardHeight - 1);
    }
    context.fillStyle = color;
    context.fillRect(x, y, 5, cardHeight);
    context.fillRect(x + 16, y + 14, 54, 28);
    context.fillStyle = "#ffffff";
    context.font = "700 14px Arial, sans-serif";
    context.fillText(index ? "MS04" : "MS03", x + 21, y + 21);
    context.fillStyle = "#183e5c";
    context.font = "700 16px Arial, sans-serif";
    context.fillText(index ? "Tower package" : "Drum package", x + 80, y + 20);
    context.textAlign = "right";
    context.font = "13px Arial, sans-serif";
    context.fillStyle = "#526779";
    context.fillText(item.equipment, x + cardWidth - 16, y + 20);
    context.textAlign = "left";
    const metricWidth = (cardWidth - 48) / 2;
    [["Plan to date", item.plan, item.planValue], ["Actual progress", item.actual, item.actualValue]]
      .forEach(([label, value, progress], metricIndex) => {
        const metricX = x + 16 + metricIndex * (metricWidth + 16);
        context.fillStyle = "#708090";
        context.font = "12px Arial, sans-serif";
        context.fillText(label, metricX, y + 59);
        context.fillStyle = color;
        context.font = "700 19px Arial, sans-serif";
        context.textAlign = "right";
        context.fillText(value, metricX + metricWidth, y + 55);
        context.textAlign = "left";
        context.fillStyle = "#e3eaf0";
        context.fillRect(metricX, y + 83, metricWidth, 5);
        if (progress !== null) {
          context.fillStyle = color;
          context.fillRect(metricX, y + 83, metricWidth * Math.max(0, Math.min(100, progress)) / 100, 5);
        }
      });
    context.fillStyle = "#e2e8ed";
    context.fillRect(x + 16, y + 105, cardWidth - 32, 1);
    context.fillStyle = "#708090";
    context.font = "12px Arial, sans-serif";
    context.fillText(`Schedule duration ${item.duration}`, x + 16, y + 121);
    context.textAlign = "right";
    context.fillText(`Plan finish ${item.finish}`, x + cardWidth - 16, y + 121);
    context.textAlign = "left";
  });
  y += cardHeight + 20;
  context.fillStyle = "#102a43";
  context.font = "700 16px Arial, sans-serif";
  context.fillText(`${workPackage || "Work Package not specified"} · package indicators`, padding, y);
  y += 26;
  const indicatorWidth = (contentWidth - 3 * cardGap) / 4;
  packageProgress.indicators.forEach(([label, value], index) => {
    const x = padding + index * (indicatorWidth + cardGap);
    context.fillStyle = "#f5f8fa";
    context.fillRect(x, y, indicatorWidth, 66);
    context.fillStyle = ["#173c5a", "#df7929", "#1a9a57", "#cf5262"][index];
    context.fillRect(x, y, indicatorWidth, 3);
    context.fillStyle = "#526779";
    context.font = "13px Arial, sans-serif";
    context.fillText(label, x + 10, y + 11);
    context.fillStyle = ["#173c5a", "#df7929", "#1a9a57", "#cf5262"][index];
    context.font = "700 20px Arial, sans-serif";
    context.fillText(value, x + 10, y + 34);
  });
  y += 86;
  if (plannedPoints.length) {
    drawSectionTitle(`Maintenance progress curve · ${workPackage}`);
    const chartHeight = 220;
    ensureCanvasHeight(y + chartHeight + 35);
    const left = padding + 50;
    const right = padding + contentWidth - 16;
    const top = y + 8;
    const bottom = top + chartHeight - 38;
    const dates = [...plannedPoints, ...actualPoints, { date: localDateString() }].map(point => point.date).sort();
    const minDate = new Date(`${dates[0]}T00:00:00Z`);
    const maxDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    const dateRange = Math.max(1, (maxDate - minDate) / 86400000);
    const pointX = date => left + (new Date(`${date}T00:00:00Z`) - minDate) / 86400000 / dateRange * (right - left);
    const pointY = value => bottom - Math.max(0, Math.min(100, Number(value) || 0)) * (bottom - top) / 100;
    context.font = "12px Arial, sans-serif";
    for (let percent = 0; percent <= 100; percent += 20) {
      const gridY = pointY(percent);
      context.strokeStyle = "#e9eef2";
      context.beginPath();
      context.moveTo(left, gridY);
      context.lineTo(right, gridY);
      context.stroke();
      context.fillStyle = "#738391";
      context.fillText(`${percent}%`, padding, gridY - 7);
    }
    const drawCurve = (points, valueKey, color, dashed = false) => {
      if (!points.length) return;
      context.beginPath();
      points.forEach((point, index) => {
        const x = pointX(point.date);
        const pointYValue = pointY(point[valueKey]);
        if (index) context.lineTo(x, pointYValue);
        else context.moveTo(x, pointYValue);
      });
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.setLineDash(dashed ? [8, 6] : []);
      context.stroke();
      context.setLineDash([]);
    };
    drawCurve(plannedPoints, "plannedProgress", "#d29a48", true);
    drawCurve(actualPoints, "actualProgress", "#167d77");
    actualPoints.forEach(point => {
      context.fillStyle = "#167d77";
      context.beginPath();
      context.arc(pointX(point.date), pointY(point.actualProgress), 4, 0, Math.PI * 2);
      context.fill();
    });
    const todayX = pointX(packageProgress.date);
    context.strokeStyle = "#d32f2f";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(todayX, top);
    context.lineTo(todayX, bottom);
    context.stroke();
    context.fillStyle = "#d32f2f";
    context.font = "700 11px Arial, sans-serif";
    context.textAlign = todayX < left + 40 ? "left" : todayX > right - 40 ? "right" : "center";
    context.fillText(formatDate(packageProgress.date).split("/").slice(0, 2).join("-"), todayX, top + 3);
    context.textAlign = "left";
    if (!actualPoints.length) {
      context.fillStyle = "#738391";
      context.font = "12px Arial, sans-serif";
      context.textAlign = "center";
      context.fillText("Enter Daily activities progress to display the actual curve", (left + right) / 2, top + 16);
      context.textAlign = "left";
    }
    const tickCount = 5;
    context.fillStyle = "#738391";
    context.font = "11px Arial, sans-serif";
    for (let index = 0; index <= tickCount; index++) {
      const date = new Date(minDate.getTime() + (maxDate - minDate) * index / tickCount).toISOString().slice(0, 10);
      context.fillText(formatDate(date), pointX(date) - 25, bottom + 12);
    }
    y = top + chartHeight + 4;
    context.font = "12px Arial, sans-serif";
    [["#d29a48", "Planned"], ["#167d77", "Actual"], ["#d32f2f", "Current date"]].forEach(([color, label], index) => {
      context.fillStyle = color;
      context.fillRect(padding + index * 130, y, 18, 3);
      context.fillStyle = "#526779";
      context.fillText(label, padding + 24 + index * 130, y - 5);
    });
    y += 30;
  } else {
    drawSectionTitle("Maintenance progress curve");
    context.fillStyle = "#738391";
    context.font = "13px Arial, sans-serif";
    context.fillText("No maintenance plan data is available for this Work Package.", padding, y);
    y += 28;
  }
  drawTable("Equipment milestones", report.overallActivities, [
    ["Equipment", "equipment"], ["Planned Start", "plannedOpen"], ["Actual Start", "actualOpen"],
    ["Plan Finish", "planClose"], ["Actual Finish", "actualClose"]
  ], [0.24, 0.19, 0.19, 0.19, 0.19]);
  drawTable("Daily Activity Description", getWorkActivityExportRows(report), [
    ["Equipment", "equipment"], ["Section", "section"],
    ["Work Done Today", "today"], ["Work to be Tomorrow", "tomorrow"], ["Remark", "remark"]
  ], [0.13, 0.09, 0.30, 0.30, 0.18]);
  drawTable("Open issues and actions", report.issues, [
    ["Issue", "issue"], ["Countermeasure", "countermeasure"], ["Action by", "actionBy"],
    ["Due date", "dueDate"], ["Status", "status"], ["Remark", "remark"]
  ], [0.05, 0.20, 0.20, 0.13, 0.13, 0.10, 0.19], true);
  drawTable("Activity-level progress", report.packages, [
    ["Work package / activity", "name"], ["Area", "area"], ["Plan", "planned"],
    ["Actual", "actual"], ["Status", "status"]
  ], [0.32, 0.18, 0.14, 0.14, 0.21]);
  const handover = getHandoverSummary(report);
  if (handover) {
    drawSectionTitle("Handover notes");
    const lines = wrapText(handover, contentWidth - 32, "14px Arial, sans-serif");
    const boxHeight = lines.length * 20 + 28;
    ensureCanvasHeight(y + boxHeight + 20);
    context.fillStyle = "#f3f6f8";
    context.fillRect(padding, y, contentWidth, boxHeight);
    context.fillStyle = "#344b60";
    context.font = "14px Arial, sans-serif";
    lines.forEach((line, index) => context.fillText(line, padding + 16, y + 14 + index * 20));
    y += boxHeight + 18;
  }
  context.fillStyle = "#81909b";
  context.font = "12px Arial, sans-serif";
  context.fillText(`Maintenance UPS-MES · Generated ${formatDate(localDateString())}`, padding, y);
  y += 40;
  const output = document.createElement("canvas");
  output.width = width * scale;
  output.height = Math.ceil(y * scale);
  const outputContext = output.getContext("2d");
  if (!outputContext) throw new Error("Canvas is not available in this browser.");
  outputContext.drawImage(canvas, 0, 0);
  return new Promise((resolve, reject) => {
    output.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not create a JPEG image."));
    }, "image/jpeg", 0.92);
  });
}

async function exportReportImage() {
  if (!validateForm()) return;
  const report = collectReport();
  const packageName = normalizeWorkPackage(report.workPackage || report.unit) || "report";
  const filename = `maintenance-ups-mes-${report.date || localDateString()}-${packageName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jpg`;
  try {
    const blob = await createReportImage(report);
    const image = await createImageBitmap(blob);
    image.close();
    downloadBlob(blob, filename);
    showToast("Report image downloaded. Attach the JPG to your Zalo group.");
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error("Could not create or save the report image.", error);
    showToast("Could not create the report image. Check browser support and try again.");
  }
}

function reportDocument(report) {
  const workPackage = normalizeWorkPackage(report.workPackage || report.unit);
  const schedule = workPackage ? getEquipmentRecords(workPackage) : [];
  const plannedPoints = buildPlannedProgress(schedule);
  const actualPoints = workPackage ? buildActualProgress(workPackage, schedule) : [];
  const progressCurve = plannedPoints.length
    ? `<div class="curve-wrap">${buildCurveSvg(plannedPoints, actualPoints)}</div>
      <div class="curve-legend"><span><i class="legend-planned"></i> Planned</span><span><i class="legend-actual"></i> Actual</span><span><i class="legend-today"></i> Current date</span></div>`
    : '<p class="empty-note">No maintenance plan data is available for this Work Package.</p>';
  const packageProgress = getExportPackageProgress(workPackage);
  const detail = (label, value) => `<div class="detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Maintenance UPS-MES</title>
    <style>
      *{box-sizing:border-box}body{margin:0;padding:34px;color:#213547;font:12px Arial,sans-serif}
      header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #176b87;padding-bottom:15px;margin-bottom:20px}
      .report-heading{display:flex;align-items:center;gap:18px}.report-logo{display:block;width:170px;height:auto;object-fit:contain}
      .eyebrow{color:#167d77;font-weight:bold;letter-spacing:2px;font-size:9px;margin:0 0 7px}
      h1{font-size:23px;margin:0;color:#102a43}header p{margin:6px 0 0;color:#708090}
      .tag{padding:7px 10px;border-radius:20px;background:#edf7f3;color:#237d68;font-weight:bold;font-size:10px}
      h2{color:#102a43;font-size:14px;margin:22px 0 10px;padding-bottom:6px;border-bottom:1px solid #dfe7ec}
      .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.detail{padding:9px;background:#f5f8fa;border-radius:4px}
      .detail span{display:block;color:#708090;font-size:9px;margin-bottom:5px}.detail strong{font-size:11px;white-space:pre-wrap}
      .package-dashboard{margin:20px 0;border:1px solid #dfe7ec;border-radius:6px;overflow:hidden}
      .package-dashboard-header{padding:14px 16px;background:#123650;color:#fff}
      .package-dashboard-header small{display:block;color:#57d4bd;font-size:8px;font-weight:bold;letter-spacing:1px}
      .package-dashboard-header h2{color:#fff;border:0;margin:5px 0;font-size:18px;padding:0}
      .package-dashboard-header p{margin:0;color:#d4e4ed;font-size:9px}
      .package-strip{display:flex;justify-content:space-between;padding:8px 16px;background:#eff4f7;color:#526e81;font-size:9px}
      .package-dashboard-body{padding:12px}
      .package-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
      .package-card{--accent:#df7929;padding:10px;background:#f8fafb;border:1px solid #dfe7ec;border-left:4px solid var(--accent);border-radius:5px}
      .package-card.tower{--accent:#128b8e}.package-card.selected{outline:1px solid var(--accent)}
      .package-card-heading{display:flex;align-items:center;gap:8px;color:#102a43;font-weight:bold}
      .package-card-heading .badge{padding:6px;background:var(--accent);color:white;border-radius:4px}
      .package-card-heading .count{margin-left:auto;color:var(--accent);font-size:10px}
      .package-card-metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:14px 0}
      .package-metric{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;color:#708090;font-size:9px}
      .package-metric strong{color:var(--accent);font-size:16px}.package-track{width:100%;height:4px;background:#e3eaf0;margin-top:6px;border-radius:3px;overflow:hidden}
      .package-track i{display:block;height:100%;background:var(--accent)}
      .package-card-footer{display:flex;justify-content:space-between;border-top:1px solid #e2e8ed;padding-top:8px;color:#708090;font-size:9px}
      .package-card-footer strong{color:#526779}
      .package-indicator-heading{margin:16px 0 3px;color:#102a43;font-size:12px}
      .package-indicator-subtitle{margin:0 0 8px;color:#708090;font-size:9px}
      .package-indicators{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
      .package-indicators .detail{border:1px solid #dfe7ec;border-top:3px solid #173c5a;background:white}
      .package-indicators .detail:nth-child(2){border-top-color:#df7929}
      .package-indicators .detail:nth-child(3){border-top-color:#1a9a57}
      .package-indicators .detail:nth-child(4){border-top-color:#cf5262}
      .package-indicators strong{font-size:16px;color:#173c5a}
      .package-indicators .detail:nth-child(2) strong{color:#df7929}
      .package-indicators .detail:nth-child(3) strong{color:#1a9a57}
      .package-indicators .detail:nth-child(4) strong{color:#cf5262}
      .curve-wrap{width:100%;margin:0 auto}.curve-chart{display:block;width:100%;height:auto;max-height:300px;overflow:visible}
      .chart-grid-line{stroke:#e9eef2;stroke-width:1}.chart-axis-label{fill:#738391;font:10px Arial,sans-serif}
      .chart-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
      .chart-line-planned{stroke:#d29a48;stroke-dasharray:6 5}.chart-line-actual{stroke:#167d77}
      .chart-line-today{stroke:#d32f2f;stroke-width:2}.chart-today-label{fill:#d32f2f;font:700 9px Arial,sans-serif}
      .chart-dot-actual{fill:#167d77;stroke:#fff;stroke-width:1.5}
      .curve-legend{display:flex;align-items:center;gap:16px;margin:0 12px;color:#607487;font-size:9px}
      .curve-legend span{display:inline-flex;align-items:center;gap:6px}.curve-legend i{width:15px;height:3px;display:inline-block;border-radius:3px}
      .curve-legend .legend-planned{background:repeating-linear-gradient(90deg,#d29a48 0 4px,transparent 4px 7px)}
      .curve-legend .legend-actual{background:#167d77}.curve-legend .legend-today{width:3px;height:12px;background:#d32f2f}
      table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #e4eaf0}td{white-space:pre-wrap;vertical-align:top}
      th{background:#f1f5f7;color:#5a6c7b;font-size:9px;text-transform:uppercase;letter-spacing:.5px}
      .narrative{margin:0 0 11px;white-space:pre-wrap;line-height:1.55}.narrative strong{display:block;color:#43576a;font-size:10px;margin-bottom:4px}
      footer{margin-top:24px;padding-top:8px;border-top:1px solid #dfe7ec;color:#81909b;font-size:9px;display:flex;justify-content:space-between}
      @media print{body{padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}h2{break-after:avoid}.detail,.package-card,.package-indicators,table,tr,.curve-wrap,.curve-legend{break-inside:avoid}}
    </style></head><body>
    <header><div class="report-heading"><img class="report-logo" src="${escapeHtml(new URL("company-logo-scg-lsp.png", window.location.href).href)}" alt="SCGC LSP company logo"><div><p class="eyebrow">OPERATIONS CONTROL · TURNAROUND</p><h1>Daily Shift Report</h1>
    <p>${escapeHtml(report.plant || report.site || "Plant not specified")} · ${escapeHtml(report.workPackage || report.unit || "Work package not specified")} · ${escapeHtml(formatDate(report.date))} · ${escapeHtml(report.shift)}</p></div>
    </div>
    <span class="tag">${escapeHtml(report.overallStatus)}</span></header>
    <div class="grid">
      ${detail("Prepared by", report.preparedBy)}
      ${detail("Weather / conditions", report.weather)}
    </div>
    <section class="package-dashboard">
    <div class="package-dashboard-header"><small>DRUM &amp; TOWER TURNAROUND</small><h2>Package progress</h2><p>Work Package: ${escapeHtml(workPackage || "Not specified")}</p></div>
    <div class="package-strip"><span>PACKAGE PERFORMANCE</span><strong>AS OF ${escapeHtml(formatDate(packageProgress.date))}</strong></div>
    <div class="package-dashboard-body">
    <div class="package-grid">${packageProgress.packages.map((item, index) =>
      `<div class="package-card${index ? " tower" : ""}${item.workPackage === workPackage ? " selected" : ""}">
        <div class="package-card-heading"><span class="badge">${index ? "MS04" : "MS03"}</span><span>${index ? "Tower" : "Drum"} package</span><span class="count">${escapeHtml(item.equipment)}</span></div>
        <div class="package-card-metrics">${[["Plan to date", item.plan, item.planValue], ["Actual progress", item.actual, item.actualValue]].map(([label, value, progress]) =>
          `<div class="package-metric"><span>${label}</span><strong>${escapeHtml(value)}</strong><span class="package-track"><i style="width:${progress === null ? 0 : Math.max(0, Math.min(100, progress))}%"></i></span></div>`
        ).join("")}</div>
        <div class="package-card-footer"><span>Schedule duration <strong>${escapeHtml(item.duration)}</strong></span><span>Plan finish <strong>${escapeHtml(item.finish)}</strong></span></div></div>`
    ).join("")}</div>
    <h3 class="package-indicator-heading">${escapeHtml(workPackage || "Work Package not specified")} · package indicators</h3>
    <p class="package-indicator-subtitle">Package-specific workload and schedule indicators</p>
    <div class="package-indicators">${packageProgress.indicators.map(([label, value]) => detail(label, value)).join("")}</div>
    <h2>Maintenance progress curve · ${escapeHtml(workPackage || "Work Package not specified")}</h2>
    ${progressCurve}
    </div></section>
    ${printTable("Equipment milestones", report.overallActivities, [
      ["Equipment", "equipment"], ["Planned Start", "plannedOpen"], ["Actual Start", "actualOpen"],
      ["Plan Finish", "planClose"], ["Actual Finish", "actualClose"]
    ])}
    ${printTable("Daily Activity Description", getWorkActivityExportRows(report), [
      ["Equipment", "equipment"], ["Section", "section"],
      ["Work Done Today", "today"], ["Work to be Tomorrow", "tomorrow"], ["Remark", "remark"]
    ])}
    ${printTable("Open issues and actions", report.issues, [
      ["Issue", "issue"], ["Countermeasure", "countermeasure"], ["Action by", "actionBy"],
      ["Due date", "dueDate"], ["Status", "status"], ["Remark", "remark"]
    ], true)}
    ${report.packages.length ? `<h2>Activity-level progress</h2>
    <table><thead><tr><th>Work package / activity</th><th>Area</th><th>Plan</th><th>Actual</th><th>Status</th></tr></thead><tbody>
      ${report.packages.map(item => `<tr><td>${escapeHtml(item.name || "—")}</td><td>${escapeHtml(item.area || "—")}</td><td>${item.planned}%</td><td>${item.actual}%</td><td>${escapeHtml(item.status)}</td></tr>`).join("")}
    </tbody></table>` : ""}
    ${getHandoverSummary(report) ? `<h2>Handover notes</h2><p class="narrative">${escapeHtml(getHandoverSummary(report))}</p>` : ""}
    <footer><span>Turnaround Daily Report</span><span>Generated ${escapeHtml(formatDate(localDateString()))} ${escapeHtml(new Date().toLocaleTimeString("en"))}</span></footer>
    <script>window.addEventListener("load",async()=>{await Promise.all(Array.from(document.images,image=>image.decode().catch(error=>console.error("Could not decode report image before printing.",error))));requestAnimationFrame(()=>requestAnimationFrame(()=>window.print()));});</script></body></html>`;
}

function printReport() {
  if (!validateForm()) return;
  const report = collectReport();
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("Allow pop-ups to print or save this report as PDF.");
    return;
  }
  printWindow.document.open();
  printWindow.document.write(reportDocument(report));
  printWindow.document.close();
}

function resetForm() {
  if (!window.confirm("Clear the current form? Unsaved changes will be lost.")) return;
  editingReportId = null;
  updateSaveButtonLabels();
  form.reset();
  document.getElementById("report-date").value = localDateString();
  document.querySelector(".optional-progress-section").open = false;
  rows.innerHTML = "";
  addPackage();
  renderDailyRows();
  updateActivityEquipmentOptions();
  document.getElementById("save-feedback").textContent = "";
  updateDashboard();
}

document.getElementById("report-date").value = localDateString();
form.addEventListener("input", updateDashboard);
form.addEventListener("change", updateDashboard);
form.addEventListener("submit", saveReport);
document.getElementById("save-report-button").addEventListener("click", saveReport);
document.getElementById("add-package-button").addEventListener("click", () => addPackage());
document.getElementById("print-button").addEventListener("click", printReport);
document.getElementById("export-image-button").addEventListener("click", exportReportImage);
document.getElementById("reset-form-button").addEventListener("click", resetForm);
document.getElementById("new-report-button").addEventListener("click", resetForm);
document.getElementById("archive-date").addEventListener("input", renderSavedDateSummary);
document.getElementById("archive-date").addEventListener("change", renderSavedDateSummary);
document.getElementById("toggle-history").addEventListener("click", toggleHistory);
document.getElementById("overview-work-package").addEventListener("change", () => {
  editingEquipmentTags.clear();
  renderOverview();
});
document.querySelectorAll("[data-dashboard-package]").forEach(button => {
  button.addEventListener("click", () => {
    const selector = document.getElementById("overview-work-package");
    selector.value = button.dataset.dashboardPackage;
    editingEquipmentTags.clear();
    renderOverview();
  });
});
document.getElementById("master-schedule-search").addEventListener("input", renderMasterSchedule);
document.getElementById("add-equipment-button").addEventListener("click", () => openEquipmentEditor());
document.getElementById("equipment-schedule-table").addEventListener("click", event => {
  const hideEquipmentButton = event.target.closest("[data-hide-scheduled-equipment]");
  if (hideEquipmentButton) {
    setEquipmentHidden(hideEquipmentButton.dataset.hideScheduledEquipment, true);
    return;
  }
  const equipmentButton = event.target.closest("[data-edit-scheduled-equipment]");
  if (equipmentButton) {
    openEquipmentEditor(equipmentButton.dataset.editScheduledEquipment);
    return;
  }
  const activityButton = event.target.closest("[data-edit-scheduled-activity]");
  if (activityButton) {
    editScheduledActivity(activityButton);
    return;
  }
  const addActivityButton = event.target.closest("[data-add-scheduled-activity]");
  if (addActivityButton) {
    addScheduledActivity(addActivityButton);
    return;
  }
  const activityAction = event.target.closest("[data-activity-action]");
  if (activityAction?.dataset.activityAction === "save") saveScheduledActivity(activityAction);
  else if (activityAction?.dataset.activityAction === "cancel") renderMasterSchedule();
  else if (activityAction?.dataset.activityAction === "cancel-add") {
    const row = activityAction.closest("tr");
    const emptyRow = row.parentElement.querySelector("[data-empty-activity]");
    row.remove();
    if (emptyRow) emptyRow.hidden = false;
  }
});
document.getElementById("hidden-equipment-panel").addEventListener("click", event => {
  const button = event.target.closest("[data-restore-equipment]");
  if (button) setEquipmentHidden(button.dataset.restoreEquipment, false);
});
document.getElementById("equipment-editor").addEventListener("submit", saveScheduledEquipment);
document.getElementById("cancel-equipment-edit").addEventListener("click", () => {
  document.getElementById("equipment-editor").hidden = true;
});
document.getElementById("equipment-schedule-table").addEventListener("change", saveActivityStatus);
document.getElementById("actual-entry-date").value = localDateString();
document.getElementById("actual-entry-date").addEventListener("change", renderActualEntryTable);
document.getElementById("save-actual-progress").addEventListener("click", saveActualProgress);
document.getElementById("actual-entry-table").addEventListener("click", handleEquipmentRowAction);
document.getElementById("work-package").addEventListener("change", () => {
  updateActivityEquipmentOptions();
  updateDashboard();
});
document.getElementById("add-overall-activity").addEventListener("click", () => activityRow("overall-activity-rows"));
document.getElementById("add-work-activity").addEventListener("click", () => workActivityRow());
document.getElementById("add-issue").addEventListener("click", () => issueRow());

document.getElementById("today-label").textContent = `${new Date().toLocaleDateString("en", { weekday: "short" })} · ${formatDate(localDateString())}`;
updateSaveButtonLabels();
renderDailyRows({ overallActivities: [], todayActivities: [], tomorrowActivities: [], issues: [] });
addPackage();
renderHistory();
startSharedWorkspace();

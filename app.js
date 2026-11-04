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

function getEquipmentRecords(workPackage) {
  const overrides = new Map(
    getEquipmentOverrides()
      .filter(item => normalizeWorkPackage(item.workPackage) === workPackage)
      .map(item => [String(item.equipmentTag), item])
  );
  return (masterSchedule.equipment[workPackage] || []).map(record => {
    const override = overrides.get(String(record.equipmentTag));
    return override ? { ...record, ...override } : record;
  });
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
  report.todayActivities = collectRows("today-activity-rows", ["equipment", "section", "activity", "dueDate", "status", "remarks"]);
  report.tomorrowActivities = collectRows("tomorrow-activity-rows", ["equipment", "section", "activity", "dueDate", "status", "remarks"]);
  report.issues = collectRows("issue-rows", ["issue", "countermeasure", "actionBy", "dueDate"]);
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
  return `<option value="">${prompt}</option>${equipment.map(record => {
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

function activityStatusOptions(selected = "") {
  const statuses = ["Plan", "Ongoing", "Completed", "Waiting", "On hold"];
  return `<option value="">Select status</option>${statuses.map(status => `<option${status === selected ? " selected" : ""}>${status}</option>`).join("")}`;
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

function narrativeActivityRow(tbodyId, data = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `<td>${equipmentSelectMarkup(data.equipment || "")}</td>
    <td><select data-key="section" aria-label="Section">${activitySectionOptions(data.section || "")}</select></td>
    <td><textarea data-key="activity" aria-label="Activity" rows="2" placeholder="One activity per line">${escapeHtml(data.activity || "")}</textarea></td>
    <td><input data-key="dueDate" aria-label="Due date" type="date" value="${escapeHtml(data.dueDate || "")}"></td>
    <td><select data-key="status" aria-label="Activity status">${activityStatusOptions(data.status || "")}</select></td>
    <td><input data-key="remarks" aria-label="Remarks" type="text" placeholder="Remarks" value="${escapeHtml(data.remarks || "")}"></td>
    <td><button class="remove-row" type="button" aria-label="Remove activity">×</button></td>`;
  row.querySelector("[data-key=equipment]").value = data.equipment || "";
  bindEditableRow(row);
  document.getElementById(tbodyId).appendChild(row);
  syncDailyTableEmptyState(tbodyId);
}

function issueRow(data = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `<td class="issue-number"></td>
    <td><textarea data-key="issue" aria-label="Issue" rows="2" placeholder="Describe issue">${escapeHtml(data.issue || "")}</textarea></td>
    <td><textarea data-key="countermeasure" aria-label="Countermeasure" rows="2" placeholder="Action / countermeasure">${escapeHtml(data.countermeasure || "")}</textarea></td>
    <td><select data-key="actionBy" aria-label="Action by"><option value="">Select owner</option>${preparerNames.map(name => `<option${data.actionBy === name ? " selected" : ""}>${name}</option>`).join("")}</select></td>
    <td><input data-key="dueDate" aria-label="Issue due date" type="date" value="${escapeHtml(data.dueDate || "")}"></td>
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
    row.remove();
    if (row.closest("tbody").id === "issue-rows") updateIssueNumbers();
    syncDailyTableEmptyState(row.closest("tbody").id);
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
    ["overall-activity-rows", report.overallActivities || [], activityRow],
    ["today-activity-rows", report.todayActivities || [], narrativeActivityRow],
    ["tomorrow-activity-rows", report.tomorrowActivities || [], narrativeActivityRow]
  ]) {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = "";
    values.forEach(item => factory(tbodyId, item));
  }
  const issueBody = document.getElementById("issue-rows");
  issueBody.innerHTML = "";
  (report.issues || []).forEach(issueRow);
  updateIssueNumbers();
  ["overall-activity-rows", "today-activity-rows", "tomorrow-activity-rows", "issue-rows"]
    .forEach(syncDailyTableEmptyState);
}

function updateActivityEquipmentOptions() {
  document.querySelectorAll("#overall-activity-rows [data-key=equipment], #today-activity-rows [data-key=equipment], #tomorrow-activity-rows [data-key=equipment]").forEach(select => {
    const selected = select.value;
    const row = select.closest("tr");
    select.innerHTML = equipmentOptions(selected);
    select.disabled = !normalizeWorkPackage(document.getElementById("work-package").value);
    const record = findScheduledEquipment(selected);
    if (record) {
      select.value = selected;
      if (row.closest("tbody").id === "overall-activity-rows") applyEquipmentPlanDates(row, record);
    } else {
      select.value = "";
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
  renderDelayedEquipmentPanel(workPackage);
  const chart = document.getElementById("curve-chart-wrap");
  if (!workPackage) {
    chart.innerHTML = '<p class="empty-note">Select a Work Package to view progress.</p>';
    return;
  }
  const schedule = getEquipmentRecords(workPackage);
  const plannedPoints = buildPlannedProgress(schedule);
  const actualPoints = buildActualProgress(workPackage, schedule);
  document.getElementById("overview-latest-actual").textContent = actualPoints.length
    ? `${actualPoints[actualPoints.length - 1].actualProgress.toFixed(1)}%`
    : "—";
  if (!plannedPoints.length) {
    chart.innerHTML = '<p class="empty-note">No maintenance plan data is available for this Work Package.</p>';
    return;
  }
  chart.innerHTML = buildCurveSvg(plannedPoints, actualPoints);
  document.getElementById("actual-entry-feedback").textContent = actualPoints.length
    ? `${actualPoints.length} saved actual measurement date${actualPoints.length === 1 ? "" : "s"} · latest ${formatDate(actualPoints[actualPoints.length - 1].date)}`
    : "No actual measurements saved yet. Enter equipment progress below to start the actual curve.";
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
  const equipment = schedule.map(record => ({ tag: String(record.equipmentTag), weight: equipmentWeight(record) }));
  const totalWeight = equipment.reduce((sum, record) => sum + record.weight, 0);
  const saved = getEquipmentActuals()
    .filter(item => normalizeWorkPackage(item.workPackage) === workPackage)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.savedAt).localeCompare(String(b.savedAt)));
  const readingsByDate = new Map();
  for (const item of saved) {
    const readings = readingsByDate.get(item.date) || new Map();
    Object.entries(item.progress || {}).forEach(([tag, value]) => {
      if (item.plant) readings.set(`${item.plant}::${tag}`, value);
      else readings.set(tag, value);
    });
    readingsByDate.set(item.date, readings);
  }
  const latestProgress = new Map();
  const points = [];
  for (const [date, readings] of [...readingsByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    readings.forEach((value, tag) => latestProgress.set(tag, value));
    const equipmentProgress = new Map();
    latestProgress.forEach((value, key) => {
      const tag = key.includes("::") ? key.slice(key.indexOf("::") + 2) : key;
      equipmentProgress.set(tag, Math.max(equipmentProgress.get(tag) || 0, Number(value) || 0));
    });
    const completedWeight = equipment.reduce((sum, item) => sum + item.weight * (Number(equipmentProgress.get(item.tag)) || 0) / 100, 0);
    points.push({ date, actualProgress: totalWeight ? completedWeight / totalWeight * 100 : 0 });
  }
  return points;
}

function getEquipmentOverallProgress(workPackage, record, activityStatuses = getActivityStatuses()) {
  if (!record.timeline.length) return null;
  const total = record.timeline.reduce((sum, item, sourceIndex) => {
    const activityKey = encodeURIComponent(JSON.stringify([
      workPackage, record.equipmentTag, sourceIndex, item.date, item.start || "",
      item.finish || "", item.activity
    ]));
    return sum + (activityStatuses[activityKey]?.progress ?? 0);
  }, 0);
  return total / record.timeline.length;
}

function renderDelayedEquipmentPanel(workPackage) {
  const panel = document.getElementById("delayed-equipment-panel");
  if (!panel) return;
  if (!workPackage) {
    panel.innerHTML = '<p class="empty-note">Select a Work Package to check equipment delays.</p>';
    return;
  }

  const today = localDateString();
  const todayTime = new Date(`${today}T00:00:00Z`).getTime();
  const records = getEquipmentRecords(workPackage).filter(record =>
    record.maintenanceStart && record.maintenanceFinish
    && new Date(`${record.maintenanceStart}T00:00:00Z`).getTime() <= todayTime);
  const actualProgress = new Map();
  if (records.some(record => record.timeline.length)) {
    const activityStatuses = getActivityStatuses();
    records.forEach(record => {
      const progress = getEquipmentOverallProgress(workPackage, record, activityStatuses);
      if (progress !== null) actualProgress.set(String(record.equipmentTag), progress);
    });
  } else {
    getEquipmentActuals()
      .filter(item => normalizeWorkPackage(item.workPackage) === workPackage && item.date <= today)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.savedAt).localeCompare(String(b.savedAt)))
      .forEach(item => Object.entries(item.progress || {}).forEach(([tag, value]) => {
        const progress = Number(value);
        if (Number.isFinite(progress) && progress >= 0 && progress <= 100) {
          actualProgress.set(String(tag), progress);
        }
      }));
  }

  const startedWithoutActuals = records.filter(record =>
    !actualProgress.has(String(record.equipmentTag))).length;
  const delayed = records.flatMap(record => {
    const tag = String(record.equipmentTag);
    if (!actualProgress.has(tag)) return [];
    const start = new Date(`${record.maintenanceStart}T00:00:00Z`).getTime();
    const finish = new Date(`${record.maintenanceFinish}T00:00:00Z`).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(finish)) return [];
    const planned = todayTime >= finish
      ? 100
      : Math.max(0, Math.min(100, (todayTime - start) / Math.max(1, finish - start) * 100));
    const actual = actualProgress.get(tag);
    const behind = planned - actual;
    return behind > 0.1 ? [{ record, planned, actual, behind, finish }] : [];
  }).sort((a, b) => b.behind - a.behind || a.finish - b.finish);

  if (!delayed.length) {
    panel.innerHTML = `<p class="empty-note">No confirmed delays as of ${escapeHtml(formatDate(today))}.${startedWithoutActuals
      ? ` ${startedWithoutActuals} scheduled equipment item${startedWithoutActuals === 1 ? " has" : "s have"} no actual progress recorded yet.`
      : ""}</p>`;
    return;
  }

  panel.innerHTML = `<p class="delay-summary">${delayed.length} equipment item${delayed.length === 1 ? "" : "s"} behind plan · as of ${escapeHtml(formatDate(today))}${startedWithoutActuals
    ? ` · ${startedWithoutActuals} without actual progress`
    : ""}</p>
    <div class="schedule-table-wrap"><table class="delay-table"><thead><tr>
      <th>Equipment</th><th>Area / unit</th><th>Plan finish</th><th>Planned</th><th>Actual</th><th>Behind</th>
    </tr></thead><tbody>${delayed.map(({ record, planned, actual, behind, finish }) => {
      const overdueDays = Math.floor((todayTime - finish) / 86400000);
      return `<tr><td><strong>${escapeHtml(record.equipmentTag)}</strong></td>
        <td>${escapeHtml(record.area || record.unit || record.section || "—")}</td>
        <td>${escapeHtml(formatDate(record.maintenanceFinish))}${overdueDays > 0 ? `<small class="delay-overdue">${overdueDays} days overdue</small>` : ""}</td>
        <td>${planned.toFixed(1)}%</td><td>${actual.toFixed(1)}%</td>
        <td><strong class="delay-variance">${behind.toFixed(1)} pp</strong></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function renderMasterSchedule() {
  const workPackage = normalizeWorkPackage(document.getElementById("overview-work-package").value);
  const search = document.getElementById("master-schedule-search").value.trim().toLowerCase();
  const equipmentTable = document.getElementById("equipment-schedule-table");
  const title = document.getElementById("equipment-schedule-title");
  const caption = document.getElementById("equipment-schedule-caption");
  const records = getEquipmentRecords(workPackage);
  const activityStatuses = getActivityStatuses();
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
        <thead><tr><th>No.</th><th>Equipment tag</th><th>Area / unit</th><th>Package / section</th><th>MNT start plan</th><th>MNT finish plan</th><th>Actual start</th><th>Actual finish</th><th>Overall progress</th><th>Daily activities</th></tr></thead>
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
              const activityKey = encodeURIComponent(JSON.stringify([
                workPackage, record.equipmentTag, sourceIndex, item.date, item.start || "",
                item.finish || "", item.activity
              ]));
              const activityProgress = activityStatuses[activityKey] || { progress: 0, status: "not-started" };
              const { progress, status } = activityProgress;
              const rowStatus = record.timeline.length ? status : "";
              const activityLabel = getEquipmentActivityLabel(item.activity);
              const statusControl = record.timeline.length
                ? `<td><span class="activity-status-label activity-status-${escapeHtml(status)}" data-activity-status-label>${escapeHtml(status === "not-started" ? "Not started" : status === "done" ? "Done" : "Ongoing")}</span></td>
                   <td><input class="activity-progress-input" type="number" min="0" max="100" step="1" value="${progress}" data-activity-progress="${escapeHtml(activityKey)}" data-saved-progress="${progress}" aria-label="Progress percentage for ${escapeHtml(activityLabel)} on ${escapeHtml(item.date)}"><span class="activity-progress-unit">%</span></td>`
                : "";
              return `<tr class="${rowStatus ? `activity-status-row-${escapeHtml(rowStatus)}` : ""}">
                <td>${escapeHtml(formatDate(item.date))}</td>
                <td>${escapeHtml(item.start || "—")}–${escapeHtml(item.finish || "—")}</td>
                <td>${escapeHtml(activityLabel)}</td>${statusControl}</tr>`;
            }).join("");
          const activityHeaders = record.timeline.length
            ? "<th>Date</th><th>Time</th><th>Scheduled activity</th><th>Status</th><th>Progress (%)</th>"
            : "<th>Date</th><th>Time</th><th>Scheduled activity</th>";
          const emptyActivity = record.timeline.length
            ? '<tr><td colspan="5">No daily activities listed.</td></tr>'
            : '<tr><td colspan="3">No daily activities listed.</td></tr>';
          return `<tr>
            <td>${sequence}</td><td><strong>${escapeHtml(record.equipmentTag)}</strong></td>
            <td>${escapeHtml(areaUnit || "—")}</td><td>${escapeHtml(packageSection)}</td>
            <td>${escapeHtml(record.maintenanceStart ? formatDate(record.maintenanceStart) : "—")}</td>
            <td>${escapeHtml(record.maintenanceFinish ? formatDate(record.maintenanceFinish) : "—")}</td>
            <td><input type="date" data-equipment-actual-date="actualStart" data-equipment-tag="${escapeHtml(record.equipmentTag)}" data-saved-value="${escapeHtml(record.actualStart || "")}" aria-label="Actual start for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.actualStart || "")}"></td>
            <td><input type="date" data-equipment-actual-date="actualFinish" data-equipment-tag="${escapeHtml(record.equipmentTag)}" data-saved-value="${escapeHtml(record.actualFinish || "")}" aria-label="Actual finish for ${escapeHtml(record.equipmentTag)}" value="${escapeHtml(record.actualFinish || "")}"></td>
            <td><strong data-equipment-overall-progress>${overallProgress === null ? "—" : `${overallProgress.toFixed(1)}%`}</strong></td>
            <td><details class="equipment-activities"><summary>${record.timeline.length} ${record.timeline.length === 1 ? "activity" : "activities"}</summary>
              <div class="equipment-activities-list"><table><thead><tr>${activityHeaders}</tr></thead><tbody>${activityRows || emptyActivity}</tbody></table></div>
            </details></td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;
    }
  }

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
    overallProgress.textContent = `${(total / activityInputs.length).toFixed(1)}%`;
  }
  renderDelayedEquipmentPanel(normalizeWorkPackage(
    document.getElementById("overview-work-package").value
  ));
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
  const overrides = getEquipmentOverrides().filter(item =>
    normalizeWorkPackage(item.workPackage) !== workPackage || String(item.equipmentTag) !== tag
  );
  overrides.push(change);
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
  const todayAnchor = todayX < left + 42 ? "start" : todayX > width - right - 42 ? "end" : "middle";
  const todayLabelX = todayAnchor === "start" ? todayX + 4 : todayAnchor === "end" ? todayX - 4 : todayX;
  const todayMarker = `<g class="chart-today-marker"><line x1="${todayX}" y1="${top}" x2="${todayX}" y2="${height - bottom}" class="chart-line-today"/>
    <text x="${todayLabelX}" y="${top + 10}" text-anchor="${todayAnchor}" class="chart-today-label">Today</text>
    <title>Today · ${escapeHtml(formatDate(today))}</title></g>`;
  const actualLine = actualPoints.length > 1 ? `<path d="${actual}" class="chart-line chart-line-actual"/>` : "";
  const actualNotice = actualPoints.length
    ? ""
    : `<text x="${width / 2}" y="${top + 16}" text-anchor="middle" class="chart-axis-label">Enter actual equipment progress to display the actual curve</text>`;

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
    ["WORK COMPLETED THIS SHIFT"],
    ["Equipment", "Section", "Activity", "Due date", "Status", "Remarks"],
    ...report.todayActivities.map(item => [item.equipment, item.section, item.activity, formatDate(item.dueDate), item.status, item.remarks]),
    [],
    ["NEXT SHIFT PLAN"],
    ["Equipment", "Section", "Activity", "Due date", "Status", "Remarks"],
    ...report.tomorrowActivities.map(item => [item.equipment, item.section, item.activity, formatDate(item.dueDate), item.status, item.remarks]),
    [],
    ["OPEN ISSUES AND ACTIONS"],
    ["No.", "Issue", "Countermeasure", "Action by", "Due date"],
    ...report.issues.map((item, index) => [index + 1, item.issue, item.countermeasure, item.actionBy, formatDate(item.dueDate)]),
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
  if (plannedPoints.length) {
    drawSectionTitle(`Progress S-curve · ${workPackage}`);
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
    const tickCount = 5;
    context.fillStyle = "#738391";
    context.font = "11px Arial, sans-serif";
    for (let index = 0; index <= tickCount; index++) {
      const date = new Date(minDate.getTime() + (maxDate - minDate) * index / tickCount).toISOString().slice(0, 10);
      context.fillText(formatDate(date), pointX(date) - 25, bottom + 12);
    }
    y = top + chartHeight + 20;
  }
  drawTable("Equipment milestones", report.overallActivities, [
    ["Equipment", "equipment"], ["Planned Start", "plannedOpen"], ["Actual Start", "actualOpen"],
    ["Plan Finish", "planClose"], ["Actual Finish", "actualClose"]
  ], [0.24, 0.19, 0.19, 0.19, 0.19]);
  drawTable("Work completed this shift", report.todayActivities, [
    ["Equipment", "equipment"], ["Section", "section"], ["Activity", "activity"],
    ["Due date", "dueDate"], ["Status", "status"], ["Remarks", "remarks"]
  ], [0.14, 0.12, 0.27, 0.13, 0.13, 0.21]);
  drawTable("Next shift plan", report.tomorrowActivities, [
    ["Equipment", "equipment"], ["Section", "section"], ["Activity", "activity"],
    ["Due date", "dueDate"], ["Status", "status"], ["Remarks", "remarks"]
  ], [0.14, 0.12, 0.27, 0.13, 0.13, 0.21]);
  drawTable("Open issues and actions", report.issues, [
    ["Issue", "issue"], ["Countermeasure", "countermeasure"], ["Action by", "actionBy"], ["Due date", "dueDate"]
  ], [0.06, 0.30, 0.32, 0.18, 0.14], true);
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
    showToast("JPG downloaded. Choose a save location in your browser's download settings.");
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
      <div class="curve-legend"><span><i class="legend-planned"></i> Planned</span><span><i class="legend-actual"></i> Actual</span><span><i class="legend-today"></i> Today</span></div>`
    : '<p class="empty-note">No maintenance plan data is available for this Work Package.</p>';
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
      .curve-wrap{width:100%;margin:0 auto}.curve-chart{display:block;width:100%;height:auto;max-height:300px;overflow:visible}
      .chart-grid-line{stroke:#e9eef2;stroke-width:1}.chart-axis-label{fill:#738391;font:10px Arial,sans-serif}
      .chart-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
      .chart-line-planned{stroke:#d29a48;stroke-dasharray:6 5}.chart-line-actual{stroke:#167d77}
      .chart-line-today{stroke:#536879;stroke-width:1.5;stroke-dasharray:4 4}.chart-today-label{fill:#536879;font:700 9px Arial,sans-serif}
      .chart-dot-actual{fill:#167d77;stroke:#fff;stroke-width:1.5}
      .curve-legend{display:flex;align-items:center;gap:16px;margin:0 12px;color:#607487;font-size:9px}
      .curve-legend span{display:inline-flex;align-items:center;gap:6px}.curve-legend i{width:15px;height:3px;display:inline-block;border-radius:3px}
      .curve-legend .legend-planned{background:repeating-linear-gradient(90deg,#d29a48 0 4px,transparent 4px 7px)}
      .curve-legend .legend-actual{background:#167d77}.curve-legend .legend-today{width:3px;height:12px;background:repeating-linear-gradient(180deg,#536879 0 3px,transparent 3px 5px)}
      table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #e4eaf0}td{white-space:pre-wrap;vertical-align:top}
      th{background:#f1f5f7;color:#5a6c7b;font-size:9px;text-transform:uppercase;letter-spacing:.5px}
      .narrative{margin:0 0 11px;white-space:pre-wrap;line-height:1.55}.narrative strong{display:block;color:#43576a;font-size:10px;margin-bottom:4px}
      footer{margin-top:24px;padding-top:8px;border-top:1px solid #dfe7ec;color:#81909b;font-size:9px;display:flex;justify-content:space-between}
      @media print{body{padding:0}h2{break-after:avoid}.detail,table,tr,.curve-wrap,.curve-legend{break-inside:avoid}}
    </style></head><body>
    <header><div class="report-heading"><img class="report-logo" src="${escapeHtml(new URL("company-logo-scg-lsp.png", window.location.href).href)}" alt="SCGC LSP company logo"><div><p class="eyebrow">OPERATIONS CONTROL · TURNAROUND</p><h1>Daily Shift Report</h1>
    <p>${escapeHtml(report.plant || report.site || "Plant not specified")} · ${escapeHtml(report.workPackage || report.unit || "Work package not specified")} · ${escapeHtml(formatDate(report.date))} · ${escapeHtml(report.shift)}</p></div>
    </div>
    <span class="tag">${escapeHtml(report.overallStatus)}</span></header>
    <div class="grid">
      ${detail("Prepared by", report.preparedBy)}
      ${detail("Weather / conditions", report.weather)}
    </div>
    <h2>Progress S-curve · ${escapeHtml(workPackage || "Work Package not specified")}</h2>
    ${progressCurve}
    ${printTable("Equipment milestones", report.overallActivities, [
      ["Equipment", "equipment"], ["Planned Start", "plannedOpen"], ["Actual Start", "actualOpen"],
      ["Plan Finish", "planClose"], ["Actual Finish", "actualClose"]
    ])}
    ${printTable("Work completed this shift", report.todayActivities, [
      ["Equipment", "equipment"], ["Section", "section"], ["Activity", "activity"],
      ["Due date", "dueDate"], ["Status", "status"], ["Remarks", "remarks"]
    ])}
    ${printTable("Next shift plan", report.tomorrowActivities, [
      ["Equipment", "equipment"], ["Section", "section"], ["Activity", "activity"],
      ["Due date", "dueDate"], ["Status", "status"], ["Remarks", "remarks"]
    ])}
    ${printTable("Open issues and actions", report.issues, [
      ["Issue", "issue"], ["Countermeasure", "countermeasure"], ["Action by", "actionBy"], ["Due date", "dueDate"]
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
document.getElementById("reset-form-button").addEventListener("click", resetForm);
document.getElementById("new-report-button").addEventListener("click", resetForm);
document.getElementById("archive-date").addEventListener("input", renderSavedDateSummary);
document.getElementById("archive-date").addEventListener("change", renderSavedDateSummary);
document.getElementById("toggle-history").addEventListener("click", toggleHistory);
document.getElementById("overview-work-package").addEventListener("change", () => {
  editingEquipmentTags.clear();
  renderOverview();
});
document.getElementById("master-schedule-search").addEventListener("input", renderMasterSchedule);
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
document.getElementById("add-today-activity").addEventListener("click", () => narrativeActivityRow("today-activity-rows"));
document.getElementById("add-tomorrow-activity").addEventListener("click", () => narrativeActivityRow("tomorrow-activity-rows"));
document.getElementById("add-issue").addEventListener("click", () => issueRow());

document.getElementById("today-label").textContent = `${new Date().toLocaleDateString("en", { weekday: "short" })} · ${formatDate(localDateString())}`;
updateSaveButtonLabels();
renderDailyRows({ overallActivities: [], todayActivities: [], tomorrowActivities: [], issues: [] });
addPackage();
renderHistory();
startSharedWorkspace();

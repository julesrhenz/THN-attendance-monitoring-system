const SCANNER_ACCESS_STORAGE_KEY = "scannerAccessPassword";
const SCANNER_ACCESS_HEADER = "X-Scanner-Access-Password";

const accessOverlay = document.getElementById("accessOverlay");
const accessForm = document.getElementById("accessForm");
const accessPassword = document.getElementById("accessPassword");
const accessSubmit = document.getElementById("accessSubmit");
const accessNotice = document.getElementById("accessNotice");
const lockTabButton = document.getElementById("lockTab");
const mainContent = document.querySelector(".main-content");

const scannerForm = document.getElementById("scannerForm");
const scannerTable = document.getElementById("scannerTable");
const notice = document.getElementById("notice");
const scannerId = document.getElementById("scannerId");
const scannerAgency = document.getElementById("scannerAgency");
const scannerIp = document.getElementById("scannerIp");
const scannerLocation = document.getElementById("scannerLocation");
const scannerType = document.getElementById("scannerType");
const scannerPort = document.getElementById("scannerPort");
const scannerEnabled = document.getElementById("scannerEnabled");
const saveButton = document.getElementById("saveScanner");
const cancelEdit = document.getElementById("cancelEdit");
const formTitle = document.getElementById("formTitle");
const formDescription = document.getElementById("formDescription");
const AGENCIES = [
  { agency_id: 1, agency: "THN" },
  { agency_id: 2, agency: "CCI" },
  { agency_id: 3, agency: "NatCorp" },
  { agency_id: 4, agency: "EMIS" },
];

let editingScannerId = null;
let nextScannerId = null;

function showNotice(message, kind = "") {
  notice.textContent = message;
  notice.className = kind;
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = value ?? "—";
  return td;
}

function makeAction(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-btn ${className}`;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderScanners(scanners) {
  scannerTable.replaceChildren();
  if (!scanners.length) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.className = "empty";
    td.textContent = "No scanners registered yet.";
    row.append(td);
    scannerTable.append(row);
    return;
  }

  scanners.forEach((scanner) => {
    const row = document.createElement("tr");
    [
      scanner.scanner_id, scanner.agency_id, scanner.agency,
      scanner.ip_address, scanner.location, scanner.port,
      scanner.scanner_type,
      scanner.created_at ? new Date(scanner.created_at).toLocaleString() : null,
    ].forEach((value) => row.append(cell(value)));

    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge${scanner.is_enabled ? "" : " off"}`;
    badge.textContent = scanner.is_enabled ? "Enabled" : "Disabled";
    status.append(badge);
    row.append(status);

    const actions = document.createElement("td");
    actions.className = "row-actions";
    actions.append(
      makeAction("Edit", "edit", () => beginEdit(scanner)),
      makeAction("Delete", "delete", () => deleteScanner(scanner)),
    );
    row.append(actions);
    scannerTable.append(row);
  });
}

function showAccessOverlay(message = "") {
  mainContent?.setAttribute("data-locked", "true");
  lockTabButton.hidden = true;
  accessOverlay.hidden = false;
  accessNotice.textContent = message;
  accessPassword.value = "";
  window.setTimeout(() => accessPassword.focus(), 0);
}

function hideAccessOverlay() {
  mainContent?.removeAttribute("data-locked");
  lockTabButton.hidden = false;
  accessOverlay.hidden = true;
  accessNotice.textContent = "";
}

async function requestJson(url, options = {}) {
  const isScannerApi = url.startsWith("/api/scanners") || url.startsWith("/api/scanner-agencies");
  const headers = { ...(options.headers || {}) };
  if (isScannerApi) {
    const stored = sessionStorage.getItem(SCANNER_ACCESS_STORAGE_KEY);
    if (stored) headers[SCANNER_ACCESS_HEADER] = stored;
  }
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 403 && data.locked) {
    sessionStorage.removeItem(SCANNER_ACCESS_STORAGE_KEY);
    showAccessOverlay("Session locked. Re-enter the access password to continue.");
    throw new Error(data.message || "Scanner access is locked.");
  }
  if (!response.ok) throw new Error(data.message || "Request failed.");
  return data;
}

function populateAgencies() {
  scannerAgency.replaceChildren(new Option("Select an agency", ""));
  AGENCIES.forEach((agency) => scannerAgency.add(new Option(`${agency.agency} (ID ${agency.agency_id})`, agency.agency_id)));
}

function resetForm() {
  editingScannerId = null;
  scannerForm.reset();
  scannerEnabled.checked = true;
  scannerId.value = nextScannerId ?? "";
  formTitle.textContent = "Add scanner";
  formDescription.textContent = "The scanner ID is assigned by the database. It is shown here only as a preview.";
  saveButton.textContent = "Add Scanner";
  cancelEdit.hidden = true;
}

function beginEdit(scanner) {
  editingScannerId = scanner.scanner_id;
  scannerId.value = scanner.scanner_id;
  scannerAgency.value = String(scanner.agency_id);
  scannerIp.value = scanner.ip_address || "";
  scannerLocation.value = scanner.location || "";
  scannerType.value = scanner.scanner_type;
  scannerPort.value = scanner.port || "";
  scannerEnabled.checked = Boolean(scanner.is_enabled);
  formTitle.textContent = `Edit scanner #${scanner.scanner_id}`;
  formDescription.textContent = "Update the scanner connection details, agency, or enabled status.";
  saveButton.textContent = "Save Changes";
  cancelEdit.hidden = false;
  showNotice("");
  scannerForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadPage({ preserveEdit = false } = {}) {
  populateAgencies();
  try {
    const scannerData = await requestJson("/api/scanners");
    nextScannerId = scannerData.next_scanner_id;
    renderScanners(scannerData.scanners || []);
    if (!preserveEdit) resetForm();
  } catch (error) {
    renderScanners([]);
    showNotice(`Could not load scanners: ${error.message}`, "error");
  }
}

function formPayload() {
  return {
    agency_id: scannerAgency.value,
    ip_address: scannerIp.value,
    location: scannerLocation.value,
    scanner_type: scannerType.value,
    port: scannerPort.value,
    is_enabled: scannerEnabled.checked,
  };
}

scannerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice("");
  saveButton.disabled = true;
  try {
    const isEditing = editingScannerId !== null;
    const url = isEditing ? `/api/scanners/${encodeURIComponent(editingScannerId)}` : "/api/scanners";
    await requestJson(url, {
      method: isEditing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formPayload()),
    });
    showNotice(isEditing ? "Scanner updated successfully." : "Scanner added successfully.", "success");
    await loadPage();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    saveButton.disabled = false;
  }
});

cancelEdit.addEventListener("click", () => {
  resetForm();
  showNotice("");
});

async function deleteScanner(scanner) {
  const confirmed = window.confirm(`Delete scanner #${scanner.scanner_id} (${scanner.ip_address})?\n\nThis cannot be undone.`);
  if (!confirmed) return;
  showNotice("");
  try {
    await requestJson(`/api/scanners/${encodeURIComponent(scanner.scanner_id)}`, { method: "DELETE" });
    if (editingScannerId === scanner.scanner_id) resetForm();
    showNotice("Scanner deleted successfully.", "success");
    await loadPage();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessNotice.textContent = "";
  accessSubmit.disabled = true;
  try {
    await requestJson("/api/scanner-access/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: accessPassword.value }),
    });
    // Remembered client-side only (this tab, until it's closed) -- resent
    // as a header on every scanner request instead of relying on a
    // server-side session, which is what caused the earlier cookie race.
    sessionStorage.setItem(SCANNER_ACCESS_STORAGE_KEY, accessPassword.value);
    hideAccessOverlay();
    await loadPage();
  } catch (error) {
    accessNotice.textContent = error.message;
  } finally {
    accessSubmit.disabled = false;
  }
});

lockTabButton.addEventListener("click", () => {
  sessionStorage.removeItem(SCANNER_ACCESS_STORAGE_KEY);
  showAccessOverlay();
});

async function init() {
  const stored = sessionStorage.getItem(SCANNER_ACCESS_STORAGE_KEY);
  if (!stored) {
    showAccessOverlay();
    return;
  }
  // Optimistically try to load with the remembered password; requestJson
  // will clear it and show the overlay itself if it turns out to be stale.
  hideAccessOverlay();
  await loadPage();
}

init();
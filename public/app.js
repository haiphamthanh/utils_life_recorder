const state = {
  settings: null,
  tree: [],
  selectedFolderId: null,
  folderNotes: [],
  filters: {
    search: "",
    tag: "",
    year: ""
  }
};

const elements = {
  appName: document.getElementById("app-name"),
  folderCount: document.getElementById("folder-count"),
  folderTree: document.getElementById("folder-tree"),
  noteForm: document.getElementById("note-form"),
  rawContentInput: document.getElementById("raw-content-input"),
  noteResult: document.getElementById("note-result"),
  saveStatus: document.getElementById("save-status"),
  folderViewTitle: document.getElementById("folder-view-title"),
  folderViewDescription: document.getElementById("folder-view-description"),
  folderViewSelect: document.getElementById("folder-view-select"),
  folderSearchInput: document.getElementById("folder-search-input"),
  folderTagFilter: document.getElementById("folder-tag-filter"),
  folderYearFilter: document.getElementById("folder-year-filter"),
  folderNotesList: document.getElementById("folder-notes-list"),
  settingsForm: document.getElementById("settings-form"),
  settingsAppName: document.getElementById("settings-app-name"),
  settingsAiModel: document.getElementById("settings-ai-model"),
  settingsApiKey: document.getElementById("settings-api-key"),
  folderEditor: document.getElementById("folder-editor"),
  historyList: document.getElementById("history-list"),
  refreshHistoryButton: document.getElementById("refresh-history-button"),
  openFolderModalButton: document.getElementById("open-folder-modal-button"),
  closeFolderModalButton: document.getElementById("close-folder-modal-button"),
  folderModal: document.getElementById("folder-modal"),
  folderDraftForm: document.getElementById("folder-draft-form"),
  folderIntentInput: document.getElementById("folder-intent-input"),
  folderDraftResult: document.getElementById("folder-draft-result"),
  noteModal: document.getElementById("note-modal"),
  closeNoteModalButton: document.getElementById("close-note-modal-button"),
  noteModalTitle: document.getElementById("note-modal-title"),
  noteModalMeta: document.getElementById("note-modal-meta"),
  noteModalSummary: document.getElementById("note-modal-summary"),
  noteModalKeywords: document.getElementById("note-modal-keywords"),
  noteModalRelated: document.getElementById("note-modal-related"),
  noteModalRaw: document.getElementById("note-modal-raw"),
  tabs: [...document.querySelectorAll(".tab")],
  panels: [...document.querySelectorAll(".tab-panel")]
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function activateTab(tabName) {
  for (const tab of elements.tabs) {
    tab.classList.toggle("is-active", tab.dataset.tab === tabName);
  }
  for (const panel of elements.panels) {
    panel.classList.toggle("is-active", panel.dataset.panel === tabName);
  }
}

function openFolderModal() {
  elements.folderModal.classList.remove("hidden");
  elements.folderDraftResult.classList.add("hidden");
  elements.folderDraftResult.innerHTML = "";
  elements.folderIntentInput.value = "";
  elements.folderIntentInput.focus();
}

function closeFolderModal() {
  elements.folderModal.classList.add("hidden");
}

function openNoteModal() {
  elements.noteModal.classList.remove("hidden");
}

function closeNoteModal() {
  elements.noteModal.classList.add("hidden");
}

function renderFolderTree() {
  elements.folderCount.textContent = `${state.tree.length} folders`;
  elements.folderTree.innerHTML = "";

  for (const folder of state.tree) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `tree-item tree-button${state.selectedFolderId === folder.id ? " is-selected" : ""}`;
    node.innerHTML = `
      <div class="tree-header">
        <div>
          <strong>${escapeHtml(folder.label)}</strong>
          <p class="muted">${escapeHtml(folder.description)}</p>
        </div>
        <span class="pill">${folder.count}</span>
      </div>
    `;
    node.addEventListener("click", async () => {
      state.selectedFolderId = folder.id;
      renderFolderTree();
      await loadFolderNotes(folder.id);
      activateTab("folders");
    });
    elements.folderTree.appendChild(node);
  }
}

function renderSettings() {
  elements.appName.textContent = state.settings.appName;
  elements.settingsAppName.value = state.settings.appName;
  elements.settingsAiModel.textContent = state.settings.aiModel || "openrouter/free";
  elements.settingsApiKey.value = state.settings.openRouterApiKey || "";
  elements.folderEditor.innerHTML = state.settings.folders
    .map(
      (folder) => `
        <article class="folder-item polished-card">
          <div class="section-title compact">
            <div>
              <strong>${escapeHtml(folder.label)}</strong>
              <p class="muted">${escapeHtml(folder.id)}</p>
            </div>
            <span class="pill">${escapeHtml(folder.hints.length)} hints</span>
          </div>
          <p>${escapeHtml(folder.description)}</p>
          <div class="tag-list">
            ${folder.hints.map((hint) => `<span class="tag">${escapeHtml(hint)}</span>`).join("")}
          </div>
        </article>
      `
    )
    .join("");
}

function renderFolderViewSelector() {
  elements.folderViewSelect.innerHTML = state.settings.folders
    .map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.label)}</option>`)
    .join("");
  elements.folderViewSelect.value = state.selectedFolderId || state.settings.folders[0]?.id || "";
}

function bindNotePreview(target, noteId) {
  target.addEventListener("dblclick", async () => {
    await showNoteDetail(noteId);
  });
}

function renderSaveResult(note) {
  const folder = state.settings.folders.find((item) => item.id === note.folderId);
  elements.noteResult.classList.remove("hidden");
  elements.noteResult.innerHTML = `
    <div class="result-header">
      <div>
        <h3>${escapeHtml(note.title)}</h3>
        <p class="muted">${escapeHtml(note.id)} • ${escapeHtml(folder?.label || note.folderId)} • ${escapeHtml(note.aiSource)}</p>
      </div>
      <span class="badge">Double click to review</span>
    </div>
    <p>${escapeHtml(note.normalizedContent)}</p>
    <div class="tag-list">
      ${note.keywords.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}
    </div>
    <div>
      <strong>Related notes</strong>
      ${
        note.related.length
          ? `<div class="tag-list">${note.related
              .map((item) => `<span class="tag">${escapeHtml(item.title || item.id)}</span>`)
              .join("")}</div>`
          : `<p class="muted">No related note detected yet.</p>`
      }
    </div>
  `;
  bindNotePreview(elements.noteResult, note.id);
}

function buildFolderFilterOptions(notes) {
  const tags = new Set();
  const years = new Set();

  for (const note of notes) {
    for (const keyword of note.keywords || []) {
      tags.add(keyword);
    }
    years.add(String(new Date(note.createdAt).getFullYear()));
  }

  elements.folderTagFilter.innerHTML = [`<option value="">All tags</option>`]
    .concat(
      [...tags]
        .sort((a, b) => a.localeCompare(b))
        .map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`)
    )
    .join("");

  elements.folderYearFilter.innerHTML = [`<option value="">All years</option>`]
    .concat(
      [...years]
        .sort((a, b) => b.localeCompare(a))
        .map((year) => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`)
    )
    .join("");

  elements.folderTagFilter.value = state.filters.tag;
  elements.folderYearFilter.value = state.filters.year;
}

function getFilteredNotes() {
  const search = state.filters.search.toLowerCase();
  return state.folderNotes.filter((note) => {
    const yearMatch = !state.filters.year || String(new Date(note.createdAt).getFullYear()) === state.filters.year;
    const tagMatch = !state.filters.tag || (note.keywords || []).includes(state.filters.tag);
    const searchMatch =
      !search ||
      [note.title, note.normalizedContent, ...(note.keywords || [])]
        .join(" ")
        .toLowerCase()
        .includes(search);

    return yearMatch && tagMatch && searchMatch;
  });
}

function renderFolderNotes() {
  const notes = getFilteredNotes();
  elements.folderNotesList.innerHTML = "";

  if (!notes.length) {
    elements.folderNotesList.innerHTML = `<p class="muted empty-state">Khong co note phu hop voi bo loc hien tai.</p>`;
    return;
  }

  for (const note of notes) {
    const row = document.createElement("article");
    row.className = "note-row polished-card";
    row.innerHTML = `
      <div class="note-row-main">
        <div class="result-header">
          <div>
            <strong>${escapeHtml(note.title)}</strong>
            <p class="muted">${new Date(note.createdAt).toLocaleString()}</p>
          </div>
          <span class="badge">Double click to open</span>
        </div>
        <p>${escapeHtml(note.normalizedContent || "")}</p>
        <div class="tag-list">
          ${(note.keywords || []).map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
      <div class="note-row-side">
        <label>
          <span>Move to</span>
          <select data-note-move="${escapeHtml(note.id)}">
            ${state.settings.folders
              .map(
                (folder) => `
                  <option value="${escapeHtml(folder.id)}" ${folder.id === note.folderId ? "selected" : ""}>
                    ${escapeHtml(folder.label)}
                  </option>
                `
              )
              .join("")}
          </select>
        </label>
      </div>
    `;

    bindNotePreview(row, note.id);
    row.querySelector("select").addEventListener("change", async (event) => {
      const targetFolderId = event.target.value;
      await request(`/api/notes/${encodeURIComponent(note.id)}/move`, {
        method: "POST",
        body: JSON.stringify({ targetFolderId })
      });
      await loadBootstrap();
      await loadHistory();
    });

    elements.folderNotesList.appendChild(row);
  }
}

async function showNoteDetail(noteId) {
  const data = await request(`/api/notes/${encodeURIComponent(noteId)}`);
  const note = data.note;
  const folder = state.settings.folders.find((item) => item.id === note.folderId);
  elements.noteModalTitle.textContent = note.title;
  elements.noteModalMeta.textContent = `${folder?.label || note.folderId} • ${new Date(note.createdAt).toLocaleString()} • ${note.aiSource}`;
  elements.noteModalSummary.textContent = note.normalizedContent || "";
  elements.noteModalRaw.textContent = note.rawContent || "";
  elements.noteModalKeywords.innerHTML = (note.keywords || []).length
    ? note.keywords.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")
    : `<span class="muted">No keyword</span>`;
  elements.noteModalRelated.innerHTML = (note.related || []).length
    ? note.related.map((item) => `<span class="tag">${escapeHtml(item.title || item.id)}</span>`).join("")
    : `<span class="muted">No related note</span>`;
  openNoteModal();
}

async function loadBootstrap() {
  const data = await request("/api/bootstrap");
  state.settings = data.settings;
  state.tree = data.tree;
  state.selectedFolderId = state.selectedFolderId || data.selectedFolderId;
  renderFolderTree();
  renderSettings();
  renderFolderViewSelector();
  if (state.selectedFolderId) {
    await loadFolderNotes(state.selectedFolderId);
  }
}

async function loadFolderNotes(folderId) {
  const data = await request(`/api/folders/${encodeURIComponent(folderId)}/notes`);
  state.selectedFolderId = folderId;
  state.folderNotes = data.notes;
  state.filters = { search: "", tag: "", year: "" };
  elements.folderSearchInput.value = "";
  elements.folderViewTitle.textContent = data.folder.label;
  elements.folderViewDescription.textContent = data.folder.description;
  renderFolderViewSelector();
  buildFolderFilterOptions(data.notes);
  renderFolderNotes();
}

async function loadHistory() {
  const data = await request("/api/history");
  elements.historyList.innerHTML = data.items.length
    ? data.items
        .map(
          (item) => `
            <article class="history-item polished-card">
              <div class="history-header">
                <strong>${escapeHtml(item.type)}</strong>
                <span class="muted">${new Date(item.at).toLocaleString()}</span>
              </div>
              <pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
            </article>
          `
        )
        .join("")
    : `<p class="muted">No activity yet.</p>`;
}

elements.tabs.forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});

elements.noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.saveStatus.textContent = "Saving...";

  try {
    const data = await request("/api/notes", {
      method: "POST",
      body: JSON.stringify({ rawContent: elements.rawContentInput.value })
    });

    renderSaveResult(data.note);
    elements.rawContentInput.value = "";
    elements.saveStatus.textContent = "Saved";
    state.selectedFolderId = data.note.folderId;
    await loadBootstrap();
    await loadHistory();
  } catch (error) {
    elements.saveStatus.textContent = error.message;
  }
});

elements.folderViewSelect.addEventListener("change", async (event) => {
  state.selectedFolderId = event.target.value;
  await loadFolderNotes(state.selectedFolderId);
});

elements.folderSearchInput.addEventListener("input", () => {
  state.filters.search = elements.folderSearchInput.value.trim();
  renderFolderNotes();
});

elements.folderTagFilter.addEventListener("change", () => {
  state.filters.tag = elements.folderTagFilter.value;
  renderFolderNotes();
});

elements.folderYearFilter.addEventListener("change", () => {
  state.filters.year = elements.folderYearFilter.value;
  renderFolderNotes();
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await request("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        appName: elements.settingsAppName.value,
        openRouterApiKey: elements.settingsApiKey.value
      })
    });
    state.settings = data.settings;
    state.tree = data.tree;
    renderFolderTree();
    renderSettings();
    renderFolderViewSelector();
    await loadHistory();
  } catch (error) {
    window.alert(error.message);
  }
});

elements.openFolderModalButton.addEventListener("click", openFolderModal);
elements.closeFolderModalButton.addEventListener("click", closeFolderModal);
elements.closeNoteModalButton.addEventListener("click", closeNoteModal);

elements.folderDraftForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await request("/api/folders/draft", {
      method: "POST",
      body: JSON.stringify({ intent: elements.folderIntentInput.value })
    });

    elements.folderDraftResult.classList.remove("hidden");
    elements.folderDraftResult.innerHTML = `
      <div class="result-header">
        <div>
          <h3>${escapeHtml(data.draft.label)}</h3>
          <p class="muted">${escapeHtml(data.draft.id)} • ${escapeHtml(data.draft.aiSource)}</p>
        </div>
      </div>
      <p>${escapeHtml(data.draft.description)}</p>
      <div class="tag-list">
        ${data.draft.hints.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}
      </div>
      <div class="actions">
        <button type="button" id="confirm-folder-button" class="primary">Add Folder</button>
      </div>
    `;

    document.getElementById("confirm-folder-button").addEventListener("click", async () => {
      await request("/api/folders", {
        method: "POST",
        body: JSON.stringify(data.draft)
      });
      closeFolderModal();
      await loadBootstrap();
      await loadHistory();
      activateTab("settings");
    });
  } catch (error) {
    window.alert(error.message);
  }
});

elements.refreshHistoryButton.addEventListener("click", () => {
  loadHistory().catch((error) => window.alert(error.message));
});

elements.folderModal.addEventListener("click", (event) => {
  if (event.target === elements.folderModal) {
    closeFolderModal();
  }
});

elements.noteModal.addEventListener("click", (event) => {
  if (event.target === elements.noteModal) {
    closeNoteModal();
  }
});

Promise.all([loadBootstrap(), loadHistory()]).catch((error) => {
  window.alert(error.message);
});

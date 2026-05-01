const state = {
  settings: null,
  tree: [],
  recent: []
};

const elements = {
  appName: document.getElementById("app-name"),
  folderCount: document.getElementById("folder-count"),
  folderTree: document.getElementById("folder-tree"),
  folderSelect: document.getElementById("folder-select"),
  authorInput: document.getElementById("author-input"),
  noteForm: document.getElementById("note-form"),
  noteResult: document.getElementById("note-result"),
  saveStatus: document.getElementById("save-status"),
  settingsForm: document.getElementById("settings-form"),
  settingsAppName: document.getElementById("settings-app-name"),
  settingsDefaultAuthor: document.getElementById("settings-default-author"),
  settingsAiCli: document.getElementById("settings-ai-cli"),
  folderEditor: document.getElementById("folder-editor"),
  folderTemplate: document.getElementById("folder-editor-template"),
  addFolderButton: document.getElementById("add-folder-button"),
  historyList: document.getElementById("history-list"),
  refreshHistoryButton: document.getElementById("refresh-history-button"),
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

function renderTree() {
  elements.folderCount.textContent = `${state.tree.length} folders`;
  elements.folderTree.innerHTML = "";

  for (const folder of state.tree) {
    const node = document.createElement("section");
    node.className = "tree-item";
    node.innerHTML = `
      <div class="tree-header">
        <div>
          <strong>${escapeHtml(folder.label)}</strong>
          <p class="muted">${escapeHtml(folder.description || "")}</p>
        </div>
        <span class="pill">${folder.count} notes</span>
      </div>
      <div class="tree-notes">
        ${
          folder.notes.length
            ? folder.notes
                .slice(0, 5)
                .map(
                  (note) => `
                    <div class="tree-note">
                      <span>${escapeHtml(note.title)}</span>
                      <span class="muted">${new Date(note.createdAt).toLocaleDateString()}</span>
                    </div>
                  `
                )
                .join("")
            : `<span class="muted">No note</span>`
        }
      </div>
    `;
    elements.folderTree.appendChild(node);
  }
}

function renderFolderSelect() {
  elements.folderSelect.innerHTML = state.settings.folders
    .map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.label)}</option>`)
    .join("");
}

function renderSettingsForm() {
  elements.settingsAppName.value = state.settings.appName || "";
  elements.settingsDefaultAuthor.value = state.settings.defaultAuthor || "";
  elements.settingsAiCli.value = state.settings.preferredAiCli || "codex";
  elements.authorInput.value = state.settings.defaultAuthor || "";

  elements.folderEditor.innerHTML = "";
  for (const folder of state.settings.folders) {
    appendFolderEditor(folder);
  }
}

function appendFolderEditor(folder = { id: "", label: "", description: "" }) {
  const fragment = elements.folderTemplate.content.cloneNode(true);
  const wrapper = fragment.querySelector(".folder-item");

  wrapper.querySelector('[data-field="id"]').value = folder.id || "";
  wrapper.querySelector('[data-field="label"]').value = folder.label || "";
  wrapper.querySelector('[data-field="description"]').value = folder.description || "";

  wrapper.querySelector('[data-action="remove-folder"]').addEventListener("click", () => {
    wrapper.remove();
  });

  elements.folderEditor.appendChild(fragment);
}

function renderSaveResult(note) {
  elements.noteResult.classList.remove("hidden");
  elements.noteResult.innerHTML = `
    <h3>${escapeHtml(note.title)}</h3>
    <p class="muted">${escapeHtml(note.id)} • ${escapeHtml(note.path)}</p>
    <p>${escapeHtml(note.normalizedContent)}</p>
    <div class="tag-list">
      ${note.keywords.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}
    </div>
    <div class="stack">
      <div>
        <strong>Related notes</strong>
        ${
          note.related.length
            ? `<div class="tag-list">${note.related
                .map((item) => `<span class="tag">${escapeHtml(item.id)} · ${escapeHtml(item.title)}</span>`)
                .join("")}</div>`
            : `<p class="muted">No related topic detected yet.</p>`
        }
      </div>
    </div>
  `;
}

async function loadBootstrap() {
  const data = await request("/api/bootstrap");
  state.settings = data.settings;
  state.tree = data.tree;
  state.recent = data.recent;
  elements.appName.textContent = state.settings.appName;
  renderFolderSelect();
  renderTree();
  renderSettingsForm();
}

async function loadHistory() {
  const data = await request("/api/history");
  elements.historyList.innerHTML = "";

  for (const item of data.items) {
    const node = document.createElement("article");
    node.className = "history-item";
    node.innerHTML = `
      <div class="history-header">
        <strong>${escapeHtml(item.type)}</strong>
        <span class="muted">${new Date(item.at).toLocaleString()}</span>
      </div>
      <pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
    `;
    elements.historyList.appendChild(node);
  }

  if (!data.items.length) {
    elements.historyList.innerHTML = `<p class="muted">No activity yet.</p>`;
  }
}

function collectFoldersFromForm() {
  return [...elements.folderEditor.querySelectorAll(".folder-item")].map((item) => ({
    id: item.querySelector('[data-field="id"]').value,
    label: item.querySelector('[data-field="label"]').value,
    description: item.querySelector('[data-field="description"]').value
  }));
}

function activateTab(tabName) {
  for (const tab of elements.tabs) {
    tab.classList.toggle("is-active", tab.dataset.tab === tabName);
  }

  for (const panel of elements.panels) {
    panel.classList.toggle("is-active", panel.dataset.panel === tabName);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

elements.tabs.forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});

elements.addFolderButton.addEventListener("click", () => appendFolderEditor());

elements.noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.saveStatus.textContent = "Saving...";

  try {
    const formData = new FormData(elements.noteForm);
    const payload = Object.fromEntries(formData.entries());
    const data = await request("/api/notes", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    renderSaveResult(data.note);
    elements.noteForm.reset();
    elements.authorInput.value = state.settings.defaultAuthor || "";
    elements.saveStatus.textContent = "Saved";
    await loadBootstrap();
    await loadHistory();
  } catch (error) {
    elements.saveStatus.textContent = error.message;
  }
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const payload = {
      appName: elements.settingsAppName.value,
      defaultAuthor: elements.settingsDefaultAuthor.value,
      preferredAiCli: elements.settingsAiCli.value,
      folders: collectFoldersFromForm()
    };

    const data = await request("/api/settings", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    state.settings = data.settings;
    state.tree = data.tree;
    elements.appName.textContent = state.settings.appName;
    renderFolderSelect();
    renderTree();
    renderSettingsForm();
    await loadHistory();
    activateTab("manage");
  } catch (error) {
    window.alert(error.message);
  }
});

elements.refreshHistoryButton.addEventListener("click", () => {
  loadHistory().catch((error) => {
    window.alert(error.message);
  });
});

Promise.all([loadBootstrap(), loadHistory()]).catch((error) => {
  window.alert(error.message);
});

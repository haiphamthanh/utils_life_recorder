const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORAGE_DIR = path.join(ROOT, "storage");
const NOTES_DIR = path.join(STORAGE_DIR, "notes");
const SYSTEM_DIR = path.join(STORAGE_DIR, "system");
const SETTINGS_PATH = path.join(SYSTEM_DIR, "settings.json");
const INDEX_PATH = path.join(SYSTEM_DIR, "index.json");
const HISTORY_PATH = path.join(SYSTEM_DIR, "history.log");
let writeQueue = Promise.resolve();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractKeywords(text) {
  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "from", "have", "are", "was", "were",
    "toi", "ban", "mot", "nhung", "duoc", "trong", "nhung", "dang", "sau", "khi", "cho",
    "cua", "voi", "vao", "tren", "hay", "neu", "can", "them", "ghi", "chu", "idea", "note"
  ]);

  const tokens = String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g) || [];

  const counts = new Map();

  for (const token of tokens) {
    if (stopWords.has(token)) {
      continue;
    }

    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([token]) => token);
}

function summarizeText(text) {
  const compact = normalizeWhitespace(text).replace(/\n/g, " ");
  return compact.slice(0, 280);
}

function similarityScore(base, target) {
  const baseKeywords = new Set(base.keywords || []);
  const targetKeywords = new Set(target.keywords || []);
  const overlap = [...baseKeywords].filter((item) => targetKeywords.has(item));

  const titleTokensBase = new Set((slugify(base.title).match(/[a-z0-9]+/g) || []));
  const titleTokensTarget = new Set((slugify(target.title).match(/[a-z0-9]+/g) || []));
  const titleOverlap = [...titleTokensBase].filter((item) => titleTokensTarget.has(item));

  const rawA = `${base.title} ${base.normalizedContent}`.toLowerCase();
  const rawB = `${target.title} ${target.normalizedContent}`.toLowerCase();
  let containsBoost = 0;

  for (const word of overlap.slice(0, 3)) {
    if (rawA.includes(word) && rawB.includes(word)) {
      containsBoost += 0.2;
    }
  }

  return {
    overlap,
    score: overlap.length * 1.5 + titleOverlap.length * 2 + containsBoost
  };
}

async function ensureBaseStructure() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
  await fs.mkdir(SYSTEM_DIR, { recursive: true });

  try {
    await fs.access(SETTINGS_PATH);
  } catch {
    await fs.writeFile(
      SETTINGS_PATH,
      JSON.stringify(
        {
          appName: "Life Recorder",
          defaultAuthor: "anonymous",
          preferredAiCli: "codex",
          supportedAiCli: ["codex", "copilot"],
          folders: [
            { id: "idea", label: "Idea", description: "Y tuong" },
            { id: "note", label: "Note", description: "Ghi chu" },
            { id: "topic", label: "Topic", description: "Chu de" }
          ]
        },
        null,
        2
      )
    );
  }

  try {
    await fs.access(INDEX_PATH);
  } catch {
    await fs.writeFile(INDEX_PATH, JSON.stringify({ notes: [] }, null, 2));
  }

  try {
    await fs.access(HISTORY_PATH);
  } catch {
    await fs.writeFile(HISTORY_PATH, "");
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function withWriteLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function readSettings() {
  const settings = await readJson(SETTINGS_PATH, null);
  if (!settings || !Array.isArray(settings.folders)) {
    throw new Error("Invalid settings");
  }
  return settings;
}

async function readIndex() {
  const index = await readJson(INDEX_PATH, { notes: [] });
  if (!Array.isArray(index.notes)) {
    return { notes: [] };
  }
  return index;
}

function parseList(value) {
  return String(value || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^"(.*)"$/, "$1"));
}

function buildNoteId(folderId, title, rawContent) {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const shortHash = crypto
    .createHash("sha1")
    .update(`${folderId}|${title}|${rawContent}|${Date.now()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 8);

  return `${folderId}-${datePart}-${shortHash}`;
}

async function appendHistory(entry) {
  await fs.appendFile(HISTORY_PATH, `${JSON.stringify(entry)}\n`);
}

function toMarkdown(note) {
  const lines = [
    "---",
    `id: ${note.id}`,
    `title: ${JSON.stringify(note.title)}`,
    `folder: ${note.folderId}`,
    `author: ${JSON.stringify(note.author)}`,
    `createdAt: ${note.createdAt}`,
    `updatedAt: ${note.updatedAt}`,
    `keywords: [${note.keywords.map((item) => JSON.stringify(item)).join(", ")}]`,
    `related: [${note.related.map((item) => JSON.stringify(item.id)).join(", ")}]`,
    "---",
    "",
    "# Raw",
    "",
    note.rawContent,
    "",
    "# Normalized",
    "",
    note.normalizedContent,
    ""
  ];

  return lines.join("\n");
}

function replaceRelatedLine(markdown, relatedIds) {
  return markdown.replace(
    /^related:\s*\[[^\]]*\]$/m,
    `related: [${relatedIds.map((item) => JSON.stringify(item)).join(", ")}]`
  );
}

async function buildTree(settings, index) {
  const tree = [];

  for (const folder of settings.folders) {
    const notes = index.notes
      .filter((note) => note.folderId === folder.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((note) => ({
        id: note.id,
        title: note.title,
        path: note.path,
        createdAt: note.createdAt,
        keywords: note.keywords
      }));

    tree.push({
      id: folder.id,
      label: folder.label,
      description: folder.description || "",
      count: notes.length,
      notes
    });
  }

  return tree;
}

function parseNoteMarkdown(markdown, relativePath) {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return null;
  }

  const lines = frontmatterMatch[1].split("\n");
  const meta = {};
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    meta[key] = value;
  }

  const rawMatch = markdown.match(/\n# Raw\n\n([\s\S]*?)\n# Normalized\n\n/);
  const normalizedMatch = markdown.match(/\n# Normalized\n\n([\s\S]*?)\n?$/);
  if (!meta.id || !meta.title || !meta.folder) {
    return null;
  }

  return {
    id: meta.id,
    title: JSON.parse(meta.title),
    folderId: meta.folder,
    author: meta.author ? JSON.parse(meta.author) : "anonymous",
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || meta.createdAt || new Date().toISOString(),
    normalizedContent: normalizedMatch ? normalizedMatch[1].trim() : "",
    rawContent: rawMatch ? rawMatch[1].trim() : "",
    keywords: parseList(meta.keywords),
    related: parseList(meta.related).map((id) => ({ id })),
    path: relativePath
  };
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(target)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(target);
    }
  }

  return files;
}

async function reconcileIndex() {
  const diskFiles = await listMarkdownFiles(NOTES_DIR);
  const notes = [];

  for (const filePath of diskFiles) {
    const markdown = await fs.readFile(filePath, "utf8");
    const relativePath = path.relative(ROOT, filePath);
    const note = parseNoteMarkdown(markdown, relativePath);
    if (note) {
      notes.push(note);
    }
  }

  notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await writeJson(INDEX_PATH, { notes });
}

function collectRelatedNotes(candidate, existingNotes) {
  return existingNotes
    .map((note) => {
      const relation = similarityScore(candidate, note);
      return {
        id: note.id,
        title: note.title,
        folderId: note.folderId,
        score: relation.score,
        overlap: relation.overlap,
        path: note.path
      };
    })
    .filter((note) => note.score >= 2.5 && note.overlap.length > 0)
    .sort((a, b) => b.score - a.score || b.id.localeCompare(a.id))
    .slice(0, 5);
}

async function addBacklinks(index, note) {
  for (const relatedNote of note.related) {
    const existing = index.notes.find((item) => item.id === relatedNote.id);
    if (!existing) {
      continue;
    }

    const alreadyLinked = Array.isArray(existing.related) && existing.related.some((item) => item.id === note.id);
    if (alreadyLinked) {
      continue;
    }

    existing.related = [...(existing.related || []), {
      id: note.id,
      title: note.title,
      folderId: note.folderId,
      path: note.path,
      score: relatedNote.score || 0,
      overlap: relatedNote.overlap || []
    }];

    const filePath = path.join(ROOT, existing.path);
    const markdown = await fs.readFile(filePath, "utf8");
    const nextMarkdown = replaceRelatedLine(
      markdown,
      existing.related.map((item) => item.id)
    );
    await fs.writeFile(filePath, nextMarkdown, "utf8");
  }
}

app.get("/api/bootstrap", async (req, res) => {
  try {
    const [settings, index] = await Promise.all([readSettings(), readIndex()]);
    const tree = await buildTree(settings, index);

    res.json({
      settings,
      tree,
      recent: index.notes
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const result = await withWriteLock(async () => {
      const current = await readSettings();
      const next = req.body || {};
      const folders = Array.isArray(next.folders) ? next.folders : [];

      if (!folders.length) {
        fail(400, "At least one folder is required.");
      }

      const sanitizedFolders = folders.map((folder) => ({
        id: slugify(folder.id || folder.label),
        label: normalizeWhitespace(folder.label || folder.id),
        description: normalizeWhitespace(folder.description || "")
      }));

      if (sanitizedFolders.some((folder) => !folder.id || !folder.label)) {
        fail(400, "Folder id and label are required.");
      }

      const uniqueIds = new Set(sanitizedFolders.map((folder) => folder.id));
      if (uniqueIds.size !== sanitizedFolders.length) {
        fail(400, "Folder id must be unique.");
      }

      const merged = {
        appName: normalizeWhitespace(next.appName || current.appName || "Life Recorder"),
        defaultAuthor: normalizeWhitespace(next.defaultAuthor || current.defaultAuthor || "anonymous"),
        preferredAiCli: ["codex", "copilot"].includes(next.preferredAiCli) ? next.preferredAiCli : current.preferredAiCli || "codex",
        supportedAiCli: ["codex", "copilot"],
        folders: sanitizedFolders
      };

      await writeJson(SETTINGS_PATH, merged);
      await appendHistory({
        type: "settings.updated",
        at: new Date().toISOString(),
        folderCount: sanitizedFolders.length
      });

      const index = await readIndex();
      const tree = await buildTree(merged, index);

      return { settings: merged, tree };
    });

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/notes", async (req, res) => {
  try {
    const result = await withWriteLock(async () => {
      const settings = await readSettings();
      const index = await readIndex();

      const title = normalizeWhitespace(req.body.title || "");
      const rawContent = normalizeWhitespace(req.body.rawContent || "");
      const folderId = normalizeWhitespace(req.body.folderId || "");
      const author = normalizeWhitespace(req.body.author || settings.defaultAuthor || "anonymous");

      if (!title || !rawContent || !folderId) {
        fail(400, "Title, content and folder are required.");
      }

      const folder = settings.folders.find((item) => item.id === folderId);
      if (!folder) {
        fail(400, "Folder does not exist in settings.");
      }

      const normalizedContent = summarizeText(rawContent);
      const keywords = extractKeywords(`${title}\n${rawContent}`);
      const candidate = { title, normalizedContent, keywords };
      const related = collectRelatedNotes(candidate, index.notes);
      const noteId = buildNoteId(folderId, title, rawContent);
      const createdAt = new Date().toISOString();
      const fileName = `${noteId}-${slugify(title) || "entry"}.md`;
      const relativePath = path.join("storage", "notes", folderId, fileName);
      const absoluteFolder = path.join(NOTES_DIR, folderId);
      const absolutePath = path.join(absoluteFolder, fileName);

      const note = {
        id: noteId,
        title,
        folderId,
        author,
        createdAt,
        updatedAt: createdAt,
        rawContent,
        normalizedContent,
        keywords,
        related,
        path: relativePath
      };

      await fs.mkdir(absoluteFolder, { recursive: true });
      await fs.writeFile(absolutePath, toMarkdown(note), "utf8");

      index.notes.push({
        id: note.id,
        title: note.title,
        folderId: note.folderId,
        author: note.author,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        normalizedContent: note.normalizedContent,
        keywords: note.keywords,
        related: note.related,
        path: note.path
      });

      await addBacklinks(index, note);
      await writeJson(INDEX_PATH, index);
      await appendHistory({
        type: "note.created",
        at: createdAt,
        id: note.id,
        folderId: note.folderId,
        title: note.title,
        relatedIds: note.related.map((item) => item.id)
      });

      return {
        note: {
          id: note.id,
          title: note.title,
          folderId: note.folderId,
          author: note.author,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          normalizedContent: note.normalizedContent,
          keywords: note.keywords,
          related: note.related,
          path: note.path
        }
      };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf8");
    const items = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-50)
      .reverse();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

ensureBaseStructure()
  .then(() => reconcileIndex())
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Life Recorder running at http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

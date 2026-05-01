const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
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
const DEFAULT_SUPPORTED_AI = ["codex", "copilot"];
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

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function withWriteLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function normalizeFolder(folder) {
  const id = slugify(folder.id || folder.label);
  return {
    id,
    label: normalizeWhitespace(folder.label || id),
    description: normalizeWhitespace(folder.description || ""),
    hints: Array.isArray(folder.hints)
      ? folder.hints.map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 10)
      : []
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
          preferredAiCli: "codex",
          supportedAiCli: DEFAULT_SUPPORTED_AI,
          folders: [
            {
              id: "idea",
              label: "Idea",
              description: "Y tuong, huong di, khai niem moi can lam ro sau.",
              hints: ["y tuong", "huong di", "de xuat", "brainstorm"]
            },
            {
              id: "note",
              label: "Note",
              description: "Ghi chu nhanh, thong tin tam, observation, tom tat ngan.",
              hints: ["ghi chu", "observation", "nhap nhanh", "thong tin tam"]
            },
            {
              id: "topic",
              label: "Topic",
              description: "Chu de lon dang theo duoi, noi dung co tinh tiep noi qua nhieu ngay.",
              hints: ["chu de", "theo duoi", "tiep noi", "series"]
            }
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

async function readSettings() {
  const settings = await readJson(SETTINGS_PATH, null);
  if (!settings || !Array.isArray(settings.folders)) {
    throw new Error("Invalid settings");
  }

  return {
    appName: normalizeWhitespace(settings.appName || "Life Recorder"),
    preferredAiCli: DEFAULT_SUPPORTED_AI.includes(settings.preferredAiCli) ? settings.preferredAiCli : "codex",
    supportedAiCli: DEFAULT_SUPPORTED_AI,
    folders: settings.folders.map(normalizeFolder).filter((folder) => folder.id && folder.label)
  };
}

async function readIndex() {
  const index = await readJson(INDEX_PATH, { notes: [] });
  return Array.isArray(index.notes) ? index : { notes: [] };
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

function extractKeywords(text) {
  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "from", "have", "are", "was", "were",
    "toi", "ban", "mot", "nhung", "duoc", "trong", "dang", "sau", "khi", "cho", "cua",
    "voi", "vao", "tren", "hay", "neu", "can", "them", "ghi", "chu", "note", "idea"
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
  return normalizeWhitespace(text).replace(/\n/g, " ").slice(0, 280);
}

function deriveTitle(text) {
  const normalized = normalizeWhitespace(text);
  const firstLine = normalized.split("\n")[0] || normalized;
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Untitled";
  }
  return compact.length > 72 ? `${compact.slice(0, 69).trim()}...` : compact;
}

function similarityScore(base, target) {
  const baseKeywords = new Set(base.keywords || []);
  const targetKeywords = new Set(target.keywords || []);
  const overlap = [...baseKeywords].filter((item) => targetKeywords.has(item));
  const titleTokensBase = new Set((slugify(base.title).match(/[a-z0-9]+/g) || []));
  const titleTokensTarget = new Set((slugify(target.title).match(/[a-z0-9]+/g) || []));
  const titleOverlap = [...titleTokensBase].filter((item) => titleTokensTarget.has(item));
  return {
    overlap,
    score: overlap.length * 1.5 + titleOverlap.length * 2
  };
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
  return [
    "---",
    `id: ${note.id}`,
    `title: ${JSON.stringify(note.title)}`,
    `folder: ${note.folderId}`,
    `aiSource: ${note.aiSource}`,
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
  ].join("\n");
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }
  const meta = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return meta;
}

function parseNoteMarkdown(markdown, relativePath) {
  const meta = parseFrontmatter(markdown);
  if (!meta || !meta.id || !meta.title || !meta.folder) {
    return null;
  }

  const rawMatch = markdown.match(/\n# Raw\n\n([\s\S]*?)\n# Normalized\n\n/);
  const normalizedMatch = markdown.match(/\n# Normalized\n\n([\s\S]*?)\n?$/);
  return {
    id: meta.id,
    title: JSON.parse(meta.title),
    folderId: meta.folder,
    aiSource: meta.aiSource || "heuristic",
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || meta.createdAt || new Date().toISOString(),
    rawContent: rawMatch ? rawMatch[1].trim() : "",
    normalizedContent: normalizedMatch ? normalizedMatch[1].trim() : "",
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
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
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

function buildTree(settings, index) {
  return settings.folders.map((folder) => {
    const notes = index.notes
      .filter((note) => note.folderId === folder.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((note) => ({
        id: note.id,
        title: note.title,
        path: note.path,
        createdAt: note.createdAt,
        keywords: note.keywords,
        normalizedContent: note.normalizedContent
      }));

    return {
      ...folder,
      count: notes.length,
      notes
    };
  });
}

function getFolderTokens(folder) {
  return extractKeywords([folder.id, folder.label, folder.description, ...(folder.hints || [])].join(" "));
}

function classifyFolderHeuristically(rawContent, settings, related) {
  const keywords = extractKeywords(rawContent);
  const relatedFolderBoost = new Map();
  for (const note of related) {
    relatedFolderBoost.set(note.folderId, (relatedFolderBoost.get(note.folderId) || 0) + note.score);
  }

  const ranked = settings.folders
    .map((folder) => {
      const folderTokens = getFolderTokens(folder);
      const overlap = keywords.filter((token) => folderTokens.includes(token));
      const score = overlap.length * 2 + (relatedFolderBoost.get(folder.id) || 0);
      return { folder, score, overlap };
    })
    .sort((a, b) => b.score - a.score || a.folder.label.localeCompare(b.folder.label));

  return ranked[0]?.folder.id || settings.folders[0]?.id;
}

function createFolderDraftHeuristically(intent) {
  const normalizedIntent = normalizeWhitespace(intent);
  const title = deriveTitle(normalizedIntent).replace(/\.\.\.$/, "");
  const label = title
    .split(/\s+/)
    .slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  return normalizeFolder({
    id: slugify(label),
    label,
    description: `Nhom ghi chu cho: ${normalizedIntent.slice(0, 140)}`,
    hints: extractKeywords(normalizedIntent)
  });
}

async function findCommand(command) {
  try {
    const { stdout } = await execFileAsync("which", [command], { timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  return JSON.parse(match[0]);
}

async function runCodexJsonTask(prompt) {
  const binary = await findCommand("codex");
  if (!binary) {
    throw new Error("Codex CLI not found");
  }

  const outputPath = path.join(os.tmpdir(), `life-recorder-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  try {
    await execFileAsync(
      binary,
      [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-last-message",
        outputPath,
        prompt
      ],
      {
        cwd: ROOT,
        timeout: 6000,
        maxBuffer: 1024 * 1024
      }
    );
    const raw = await fs.readFile(outputPath, "utf8");
    return extractJsonObject(raw);
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

async function analyzeNoteWithAi(rawContent, settings, index) {
  const title = deriveTitle(rawContent);
  const normalizedContent = summarizeText(rawContent);
  const keywords = extractKeywords(`${title}\n${rawContent}`);
  const seedRelated = collectRelatedNotes({ title, normalizedContent, keywords }, index.notes);
  const heuristicFolderId = classifyFolderHeuristically(rawContent, settings, seedRelated);

  if (settings.preferredAiCli === "codex") {
    try {
      const result = await runCodexJsonTask(
        [
          "Analyze this note for a note-taking system.",
          "Return only one JSON object with keys: title, normalizedContent, keywords, folderId.",
          "Rules:",
          "- title: concise and meaningful",
          "- normalizedContent: cleaned summary in the same language as input",
          "- keywords: array of up to 12 short keywords",
          "- folderId: one of the allowed folder ids",
          `Allowed folders: ${JSON.stringify(settings.folders.map((folder) => ({ id: folder.id, label: folder.label, description: folder.description, hints: folder.hints })))}`,
          `Suggested folder from heuristics: ${heuristicFolderId}`,
          `Raw note:\n${rawContent}`
        ].join("\n")
      );

      if (
        result &&
        typeof result.title === "string" &&
        typeof result.normalizedContent === "string" &&
        Array.isArray(result.keywords) &&
        settings.folders.some((folder) => folder.id === result.folderId)
      ) {
        return {
          title: normalizeWhitespace(result.title) || title,
          normalizedContent: normalizeWhitespace(result.normalizedContent) || normalizedContent,
          keywords: result.keywords.map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 12),
          folderId: result.folderId,
          aiSource: "codex"
        };
      }
    } catch {
      // Fallback below.
    }
  }

  return {
    title,
    normalizedContent,
    keywords,
    folderId: heuristicFolderId,
    aiSource: "heuristic"
  };
}

async function createFolderDraftWithAi(intent, settings) {
  const fallback = createFolderDraftHeuristically(intent);

  if (settings.preferredAiCli === "codex") {
    try {
      const result = await runCodexJsonTask(
        [
          "Generate metadata for a new note folder.",
          "Return only one JSON object with keys: id, label, description, hints.",
          "Rules:",
          "- id: short lowercase slug",
          "- label: human-friendly short label",
          "- description: specific routing guidance, not vague",
          "- hints: array of up to 8 keywords or phrases used to recognize notes for this folder",
          `Existing folders: ${JSON.stringify(settings.folders)}`,
          `User intent:\n${intent}`
        ].join("\n")
      );

      if (result && typeof result.label === "string") {
        const draft = normalizeFolder(result);
        if (draft.id && draft.label && !settings.folders.some((folder) => folder.id === draft.id)) {
          return { ...draft, aiSource: "codex" };
        }
      }
    } catch {
      // Fallback below.
    }
  }

  return { ...fallback, aiSource: "heuristic" };
}

async function refreshNoteMarkdown(filePath, note) {
  await fs.writeFile(filePath, toMarkdown(note), "utf8");
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

    const markdown = await fs.readFile(path.join(ROOT, existing.path), "utf8");
    const current = parseNoteMarkdown(markdown, existing.path);
    if (!current) {
      continue;
    }
    current.related = existing.related;
    await refreshNoteMarkdown(path.join(ROOT, existing.path), current);
  }
}

async function updateNoteFolder(index, noteId, targetFolderId) {
  const note = index.notes.find((item) => item.id === noteId);
  if (!note) {
    fail(404, "Note not found.");
  }

  if (note.folderId === targetFolderId) {
    return note;
  }

  const currentPath = path.join(ROOT, note.path);
  const fileName = path.basename(note.path);
  const nextDir = path.join(NOTES_DIR, targetFolderId);
  const nextPath = path.join(nextDir, fileName);

  await fs.mkdir(nextDir, { recursive: true });
  const markdown = await fs.readFile(currentPath, "utf8");
  const parsed = parseNoteMarkdown(markdown, note.path);
  if (!parsed) {
    fail(500, "Cannot parse note markdown.");
  }

  parsed.folderId = targetFolderId;
  parsed.path = path.relative(ROOT, nextPath);
  parsed.updatedAt = new Date().toISOString();
  note.folderId = targetFolderId;
  note.path = parsed.path;
  note.updatedAt = parsed.updatedAt;

  await refreshNoteMarkdown(nextPath, {
    ...parsed,
    title: note.title,
    rawContent: parsed.rawContent,
    normalizedContent: parsed.normalizedContent,
    keywords: note.keywords,
    related: note.related || [],
    aiSource: note.aiSource || "heuristic",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  });

  await fs.rm(currentPath, { force: true });

  for (const item of index.notes) {
    if (!Array.isArray(item.related)) {
      continue;
    }
    let changed = false;
    item.related = item.related.map((related) => {
      if (related.id !== note.id) {
        return related;
      }
      changed = true;
      return { ...related, folderId: targetFolderId, path: note.path, title: note.title };
    });

    if (!changed) {
      continue;
    }

    const otherMarkdown = await fs.readFile(path.join(ROOT, item.path), "utf8");
    const otherParsed = parseNoteMarkdown(otherMarkdown, item.path);
    if (!otherParsed) {
      continue;
    }
    otherParsed.related = item.related;
    await refreshNoteMarkdown(path.join(ROOT, item.path), {
      ...otherParsed,
      title: item.title,
      rawContent: otherParsed.rawContent,
      normalizedContent: otherParsed.normalizedContent,
      keywords: item.keywords,
      aiSource: item.aiSource || "heuristic",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    });
  }

  return note;
}

app.get("/api/bootstrap", async (req, res) => {
  try {
    const [settings, index] = await Promise.all([readSettings(), readIndex()]);
    const tree = buildTree(settings, index);
    res.json({
      settings,
      tree,
      selectedFolderId: tree[0]?.id || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/folders/:folderId/notes", async (req, res) => {
  try {
    const [settings, index] = await Promise.all([readSettings(), readIndex()]);
    const folder = settings.folders.find((item) => item.id === req.params.folderId);
    if (!folder) {
      fail(404, "Folder not found.");
    }

    const notes = index.notes
      .filter((item) => item.folderId === folder.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({ folder, notes });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/folders/draft", async (req, res) => {
  try {
    const settings = await readSettings();
    const intent = normalizeWhitespace(req.body.intent || "");
    if (!intent) {
      fail(400, "Folder intent is required.");
    }
    const draft = await createFolderDraftWithAi(intent, settings);
    res.json({ draft });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/folders", async (req, res) => {
  try {
    const result = await withWriteLock(async () => {
      const settings = await readSettings();
      const draft = normalizeFolder(req.body || {});
      if (!draft.id || !draft.label || !draft.description) {
        fail(400, "Folder draft is incomplete.");
      }
      if (settings.folders.some((folder) => folder.id === draft.id)) {
        fail(400, "Folder id already exists.");
      }

      const nextSettings = {
        ...settings,
        folders: [...settings.folders, draft]
      };

      await writeJson(SETTINGS_PATH, nextSettings);
      await appendHistory({
        type: "folder.created",
        at: new Date().toISOString(),
        folderId: draft.id,
        label: draft.label
      });

      const index = await readIndex();
      return { settings: nextSettings, tree: buildTree(nextSettings, index) };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const result = await withWriteLock(async () => {
      const current = await readSettings();
      const next = req.body || {};
      const merged = {
        appName: normalizeWhitespace(next.appName || current.appName || "Life Recorder"),
        preferredAiCli: DEFAULT_SUPPORTED_AI.includes(next.preferredAiCli) ? next.preferredAiCli : current.preferredAiCli,
        supportedAiCli: DEFAULT_SUPPORTED_AI,
        folders: current.folders
      };

      await writeJson(SETTINGS_PATH, merged);
      await appendHistory({
        type: "settings.updated",
        at: new Date().toISOString(),
        preferredAiCli: merged.preferredAiCli
      });

      const index = await readIndex();
      return { settings: merged, tree: buildTree(merged, index) };
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
      const rawContent = normalizeWhitespace(req.body.rawContent || "");
      if (!rawContent) {
        fail(400, "Content is required.");
      }

      const analyzed = await analyzeNoteWithAi(rawContent, settings, index);
      const folder = settings.folders.find((item) => item.id === analyzed.folderId) || settings.folders[0];
      const candidate = {
        title: analyzed.title,
        normalizedContent: analyzed.normalizedContent,
        keywords: analyzed.keywords
      };
      const related = collectRelatedNotes(candidate, index.notes);
      const noteId = buildNoteId(folder.id, analyzed.title, rawContent);
      const createdAt = new Date().toISOString();
      const fileName = `${noteId}-${slugify(analyzed.title) || "entry"}.md`;
      const absoluteFolder = path.join(NOTES_DIR, folder.id);
      const absolutePath = path.join(absoluteFolder, fileName);
      const relativePath = path.relative(ROOT, absolutePath);

      const note = {
        id: noteId,
        title: analyzed.title,
        folderId: folder.id,
        aiSource: analyzed.aiSource,
        createdAt,
        updatedAt: createdAt,
        rawContent,
        normalizedContent: analyzed.normalizedContent,
        keywords: analyzed.keywords,
        related,
        path: relativePath
      };

      await fs.mkdir(absoluteFolder, { recursive: true });
      await refreshNoteMarkdown(absolutePath, note);

      index.notes.push({
        id: note.id,
        title: note.title,
        folderId: note.folderId,
        aiSource: note.aiSource,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        rawContent: note.rawContent,
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
        aiSource: note.aiSource,
        relatedIds: note.related.map((item) => item.id)
      });

      return { note };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/notes/:noteId/move", async (req, res) => {
  try {
    const result = await withWriteLock(async () => {
      const settings = await readSettings();
      const index = await readIndex();
      const targetFolderId = normalizeWhitespace(req.body.targetFolderId || "");
      if (!settings.folders.some((folder) => folder.id === targetFolderId)) {
        fail(400, "Target folder is invalid.");
      }

      const note = await updateNoteFolder(index, req.params.noteId, targetFolderId);
      await writeJson(INDEX_PATH, index);
      await appendHistory({
        type: "note.moved",
        at: new Date().toISOString(),
        id: note.id,
        targetFolderId
      });

      return {
        note,
        tree: buildTree(settings, index)
      };
    });

    res.json(result);
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

require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const OpenAI = require("openai");

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
const DEFAULT_MODEL = process.env.AI_MODEL || "openrouter/free";
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

function deriveTitle(text) {
  const normalized = normalizeWhitespace(text);
  const firstLine = normalized.split("\n")[0] || normalized;
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Untitled";
  }
  return compact.length > 72 ? `${compact.slice(0, 69).trim()}...` : compact;
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

function getFolderTokens(folder) {
  return extractKeywords([folder.id, folder.label, folder.description, ...(folder.hints || [])].join(" "));
}

function classifyFolderHeuristically(rawContent, settings) {
  const keywords = extractKeywords(rawContent);
  const ranked = settings.folders
    .map((folder) => {
      const folderTokens = getFolderTokens(folder);
      const overlap = keywords.filter((token) => folderTokens.includes(token));
      return { folder, score: overlap.length };
    })
    .sort((a, b) => b.score - a.score || a.folder.label.localeCompare(b.folder.label));

  return ranked[0]?.folder.id || settings.folders[0]?.id || "note";
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
          aiProvider: "openrouter",
          aiModel: DEFAULT_MODEL,
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
    aiProvider: "openrouter",
    aiModel: normalizeWhitespace(settings.aiModel || DEFAULT_MODEL),
    openRouterApiKey: normalizeWhitespace(settings.openRouterApiKey || ""),
    folders: settings.folders.map(normalizeFolder).filter((folder) => folder.id && folder.label)
  };
}

async function readIndex() {
  const index = await readJson(INDEX_PATH, { notes: [] });
  return Array.isArray(index.notes) ? index : { notes: [] };
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
    aiSource: meta.aiSource || DEFAULT_MODEL,
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

async function refreshNoteMarkdown(filePath, note) {
  await fs.writeFile(filePath, toMarkdown(note), "utf8");
}

function getOpenRouterClient(settings) {
  const apiKey = normalizeWhitespace(process.env.OPENROUTER_API_KEY || settings?.openRouterApiKey || "");
  if (!apiKey) {
    fail(500, "Missing OPENROUTER_API_KEY. Add it to .env or your shell environment.");
  }

  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "http://localhost",
      "X-Title": "Life Recorder"
    }
  });
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Empty response from OpenRouter.");
  }

  const attempts = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    attempts.push(fenced[1].trim());
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const snippet = raw.slice(start, index + 1);
        try {
          return JSON.parse(snippet);
        } catch {
          start = -1;
        }
      }
    }
  }

  throw new Error("Invalid JSON response from OpenRouter.");
}

function buildHeuristicNoteResult(rawContent, settings) {
  const title = deriveTitle(rawContent);
  return {
    title,
    normalizedContent: summarizeText(rawContent),
    keywords: extractKeywords(`${title}\n${rawContent}`),
    folderId: classifyFolderHeuristically(rawContent, settings),
    aiSource: "heuristic"
  };
}

function buildHeuristicFolderDraft(intent, settings) {
  const label = deriveTitle(intent)
    .replace(/\.\.\.$/, "")
    .split(/\s+/)
    .slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  const draft = normalizeFolder({
    id: slugify(label),
    label,
    description: `Nhom ghi chu cho: ${normalizeWhitespace(intent).slice(0, 140)}`,
    hints: extractKeywords(intent)
  });

  if (settings.folders.some((folder) => folder.id === draft.id)) {
    draft.id = `${draft.id}-${Math.random().toString(16).slice(2, 6)}`;
  }

  return {
    ...draft,
    aiSource: "heuristic"
  };
}

async function requestAiJson(settings, systemPrompt, userPrompt) {
  const openrouter = getOpenRouterClient(settings);
  try {
    const completion = await openrouter.chat.completions.create({
      model: settings.aiModel || DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      stream: false
    });

    return extractJson(completion.choices[0]?.message?.content || "");
  } catch (error) {
    const detail = error?.message || "Unknown OpenRouter error";
    fail(502, `OpenRouter API error: ${detail}`);
  }
}

function ensureKeywords(value, rawContent) {
  if (Array.isArray(value)) {
    const sanitized = value.map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 12);
    if (sanitized.length) {
      return sanitized;
    }
  }
  return extractKeywords(rawContent);
}

async function analyzeNoteWithAi(rawContent, settings) {
  try {
    const result = await requestAiJson(
      settings,
      [
        "Ban la he thong chuan hoa du lieu ca nhan.",
        "Nhiem vu:",
        "1. Dat tieu de ngan gon, ro nghia.",
        "2. Chuan hoa noi dung thanh mot doan ngan ro rang bang cung ngon ngu voi dau vao.",
        "3. Trich xuat keywords.",
        "4. Chon suggested_folder tu danh sach cho phep.",
        "5. Chi tra ve mot JSON object hop le, khong markdown, khong giai thich.",
        "JSON format:",
        "{",
        '  "title": "string",',
        '  "normalized_content": "string",',
        '  "keywords": ["string"],',
        '  "suggested_folder": "string"',
        "}"
      ].join("\n"),
      [
        `Allowed folders: ${JSON.stringify(settings.folders.map((folder) => ({ id: folder.id, label: folder.label, description: folder.description, hints: folder.hints })))}`,
        `Raw note:\n${rawContent}`
      ].join("\n\n")
    );

    const title = normalizeWhitespace(result.title || deriveTitle(rawContent)) || "Untitled";
    const normalizedContent =
      normalizeWhitespace(result.normalized_content || result.normalizedContent || summarizeText(rawContent)) ||
      summarizeText(rawContent);
    const keywords = ensureKeywords(result.keywords, `${title}\n${rawContent}`);
    const folderId = normalizeWhitespace(result.suggested_folder || result.folderId || "");
    if (!settings.folders.some((folder) => folder.id === folderId)) {
      fail(422, "AI returned an invalid folder id.");
    }

    return {
      title,
      normalizedContent,
      keywords,
      folderId,
      aiSource: settings.aiModel
    };
  } catch (error) {
    if (error.status === 502) {
      return buildHeuristicNoteResult(rawContent, settings);
    }
    throw error;
  }
}

async function createFolderDraftWithAi(intent, settings) {
  try {
    const result = await requestAiJson(
      settings,
      [
        "Ban la he thong tao metadata cho folder ghi chu.",
        "Chi tra ve mot JSON object hop le, khong markdown, khong giai thich.",
        "JSON format:",
        "{",
        '  "id": "string",',
        '  "label": "string",',
        '  "description": "string",',
        '  "hints": ["string"]',
        "}",
        "Yeu cau:",
        "- id la slug ngan gon lowercase",
        "- label ngan, ro nghia",
        "- description cu the de AI sau nay phan loai note",
        "- hints la cac tu khoa/phrase giup routing folder"
      ].join("\n"),
      [
        `Existing folders: ${JSON.stringify(settings.folders)}`,
        `User intent:\n${intent}`
      ].join("\n\n")
    );

    const draft = normalizeFolder(result);
    if (!draft.id || !draft.label || !draft.description) {
      fail(422, "AI returned an incomplete folder draft.");
    }
    if (settings.folders.some((folder) => folder.id === draft.id)) {
      fail(422, "AI returned a duplicated folder id.");
    }
    return {
      ...draft,
      aiSource: settings.aiModel
    };
  } catch (error) {
    if (error.status === 502) {
      return buildHeuristicFolderDraft(intent, settings);
    }
    throw error;
  }
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

    const currentPath = path.join(ROOT, existing.path);
    const markdown = await fs.readFile(currentPath, "utf8");
    const parsed = parseNoteMarkdown(markdown, existing.path);
    if (!parsed) {
      continue;
    }
    parsed.related = existing.related;
    parsed.aiSource = existing.aiSource || DEFAULT_MODEL;
    parsed.title = existing.title;
    parsed.rawContent = parsed.rawContent;
    parsed.normalizedContent = existing.normalizedContent;
    parsed.keywords = existing.keywords;
    parsed.createdAt = existing.createdAt;
    parsed.updatedAt = existing.updatedAt;
    await refreshNoteMarkdown(currentPath, parsed);
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
  const nextDir = path.join(NOTES_DIR, targetFolderId);
  const nextPath = path.join(nextDir, path.basename(note.path));
  await fs.mkdir(nextDir, { recursive: true });

  const markdown = await fs.readFile(currentPath, "utf8");
  const parsed = parseNoteMarkdown(markdown, note.path);
  if (!parsed) {
    fail(500, "Cannot parse note markdown.");
  }

  parsed.folderId = targetFolderId;
  parsed.path = path.relative(ROOT, nextPath);
  parsed.updatedAt = new Date().toISOString();
  parsed.aiSource = note.aiSource || DEFAULT_MODEL;
  parsed.title = note.title;
  parsed.rawContent = parsed.rawContent;
  parsed.normalizedContent = note.normalizedContent;
  parsed.keywords = note.keywords;
  parsed.related = note.related || [];
  parsed.createdAt = note.createdAt;

  note.folderId = targetFolderId;
  note.path = parsed.path;
  note.updatedAt = parsed.updatedAt;

  await refreshNoteMarkdown(nextPath, parsed);
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

    const otherPath = path.join(ROOT, item.path);
    const otherMarkdown = await fs.readFile(otherPath, "utf8");
    const otherParsed = parseNoteMarkdown(otherMarkdown, item.path);
    if (!otherParsed) {
      continue;
    }
    otherParsed.related = item.related;
    otherParsed.aiSource = item.aiSource || DEFAULT_MODEL;
    otherParsed.title = item.title;
    otherParsed.rawContent = otherParsed.rawContent;
    otherParsed.normalizedContent = item.normalizedContent;
    otherParsed.keywords = item.keywords;
    otherParsed.createdAt = item.createdAt;
    otherParsed.updatedAt = item.updatedAt;
    await refreshNoteMarkdown(otherPath, otherParsed);
  }

  return note;
}

app.get("/api/bootstrap", async (req, res) => {
  try {
    const [settings, index] = await Promise.all([readSettings(), readIndex()]);
    res.json({
      settings,
      tree: buildTree(settings, index),
      selectedFolderId: settings.folders[0]?.id || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/notes/:noteId", async (req, res) => {
  try {
    const index = await readIndex();
    const note = index.notes.find((item) => item.id === req.params.noteId);
    if (!note) {
      fail(404, "Note not found.");
    }
    res.json({ note });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/folders/:folderId/notes", async (req, res) => {
  try {
    const [settings, index] = await Promise.all([readSettings(), readIndex()]);
    const folder = settings.folders.find((item) => item.id === req.params.folderId);
    if (!folder) {
      fail(404, "Folder not found.");
    }

    res.json({
      folder,
      notes: index.notes
        .filter((item) => item.folderId === folder.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    });
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
      const nextSettings = {
        appName: normalizeWhitespace(req.body.appName || current.appName || "Life Recorder"),
        aiProvider: "openrouter",
        aiModel: normalizeWhitespace(current.aiModel || DEFAULT_MODEL),
        openRouterApiKey: normalizeWhitespace(req.body.openRouterApiKey || current.openRouterApiKey || ""),
        folders: current.folders
      };

      await writeJson(SETTINGS_PATH, nextSettings);
      await appendHistory({
        type: "settings.updated",
        at: new Date().toISOString(),
        aiModel: nextSettings.aiModel,
        hasApiKey: Boolean(nextSettings.openRouterApiKey || process.env.OPENROUTER_API_KEY)
      });

      const index = await readIndex();
      return { settings: nextSettings, tree: buildTree(nextSettings, index) };
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

      const analyzed = await analyzeNoteWithAi(rawContent, settings);
      const related = collectRelatedNotes(
        {
          title: analyzed.title,
          normalizedContent: analyzed.normalizedContent,
          keywords: analyzed.keywords
        },
        index.notes
      );

      const noteId = buildNoteId(analyzed.folderId, analyzed.title, rawContent);
      const createdAt = new Date().toISOString();
      const fileName = `${noteId}-${slugify(analyzed.title) || "entry"}.md`;
      const absoluteFolder = path.join(NOTES_DIR, analyzed.folderId);
      const absolutePath = path.join(absoluteFolder, fileName);
      const relativePath = path.relative(ROOT, absolutePath);

      const note = {
        id: noteId,
        title: analyzed.title,
        folderId: analyzed.folderId,
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

      index.notes.push({ ...note });
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

      return { note, tree: buildTree(settings, index) };
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

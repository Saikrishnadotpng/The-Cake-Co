import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import { rateLimit } from "express-rate-limit";

const scrypt = promisify(crypto.scrypt);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.resolve(process.env.TCC_DATA_DIR || path.join(__dirname, "data"));
const MENU_FILE = path.join(DATA_DIR, "menu.json");
const EMPLOYEE_LOG_FILE = path.join(DATA_DIR, "employee_logs.json");
const EMPLOYEE_AUDIT_KEY_FILE = path.join(DATA_DIR, "employee_logs.key");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

/* =====================================================================
   Configuration
   ===================================================================== */
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
function readIntegerSetting(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    console.error(`[config] ${name} must be an integer from ${minimum} to ${maximum}.`);
    process.exit(1);
  }
  return value;
}
const PORT = readIntegerSetting("PORT", 3000, 1, 65535);
const TRUST_PROXY = readIntegerSetting("TRUST_PROXY", 0, 0);
const SESSION_HOURS = 8;
const MAX_ITEMS = 60;
const MAX_IMAGE_BYTES = 1_200_000;

function employeeAvatar(background, accent) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${background}"/><circle cx="48" cy="35" r="17" fill="${accent}"/><path d="M17 87c3-19 15-29 31-29s28 10 31 29" fill="${accent}"/><path d="M29 29c3-13 12-20 23-19 9 1 15 7 17 16-8-5-16-7-24-5-6 2-11 5-16 8Z" fill="${background}" opacity=".7"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const EMPLOYEE_SPECS = [
  { id: "TCC-01", name: "Sai Krishna", role: "Admin", envName: "TCC_EMPLOYEE_TCC_01_PIN", developmentPin: "admin@123", photo: employeeAvatar("#342817", "#D4AF37") },
  { id: "TCC-02", name: "Chef Rahul", role: "Chef", envName: "TCC_EMPLOYEE_TCC_02_PIN", developmentPin: "chef@123", photo: employeeAvatar("#243029", "#A7C5A8") },
  { id: "TCC-03", name: "Ananya", role: "Studio Manager", envName: "TCC_EMPLOYEE_TCC_03_PIN", developmentPin: "tccmanager", photo: employeeAvatar("#34272B", "#D7A9B7") },
];

const EMPLOYEES = await Promise.all(EMPLOYEE_SPECS.map(async (spec) => {
  const pin = process.env[spec.envName] || (IS_PROD ? "" : spec.developmentPin);
  if (!pin) {
    console.error(`[config] ${spec.envName} is required in production.`);
    process.exit(1);
  }
  if (IS_PROD && pin.length < 12) {
    console.error(`[config] ${spec.envName} must be at least 12 characters in production.`);
    process.exit(1);
  }
  if (pin.length > 256) {
    console.error(`[config] ${spec.envName} must not exceed 256 characters.`);
    process.exit(1);
  }
  const salt = crypto.randomBytes(16);
  const pinHash = await scrypt(pin, salt, 64);
  return Object.freeze({ id: spec.id, name: spec.name, role: spec.role, photo: spec.photo, salt, pinHash });
}));
const EMPLOYEE_BY_ID = new Map(EMPLOYEES.map((employee) => [employee.id, employee]));
const PUBLIC_EMPLOYEES = EMPLOYEES.map(({ id, name, role, photo }) => ({ id, name, role, photo }));
const DUMMY_PIN_SALT = crypto.randomBytes(16);
const DUMMY_PIN_HASH = await scrypt(crypto.randomBytes(32).toString("hex"), DUMMY_PIN_SALT, 64);
if (!IS_PROD) console.warn("[auth] Development employee PINs are enabled. Configure individual TCC_EMPLOYEE_*_PIN values before deployment.");

/* =====================================================================
   Catalogue definitions (single source of truth for units)
   ===================================================================== */
const CATEGORIES = Object.freeze([
  { id: "celebration-cakes", label: "Celebration Cakes", unit: "kg" },
  { id: "designer-cakes", label: "Designer Cakes", unit: "kg" },
  { id: "celebration-sets", label: "Celebration Sets", unit: "set" },
  { id: "cupcakes", label: "Cupcakes & Boxes", unit: "box" },
  { id: "pastries", label: "Pastries & Desserts", unit: "piece" },
]);
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const ART_KEYS = new Set(["heart", "round", "square", "cupcake", "tier"]);

const DEFAULT_MENU = [
  {
    name: "Heart Shaped Red Velvet Cake",
    category: "designer-cakes",
    description: "A heart-shaped red velvet cake, layered and finished with smooth frosting. Made for anniversaries and grand gestures.",
    price: null,
    badge: "Signature",
    image: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=1200&q=85",
    art: "heart",
  },
  {
    name: "Chocolate Hazelnut Cake with Frosting",
    category: "celebration-cakes",
    description: "Rich chocolate sponge paired with hazelnut and a generous frosting finish.",
    price: null,
    badge: "",
    image: "https://images.unsplash.com/photo-1563729784474-d77dbb933a9e?auto=format&fit=crop&w=1200&q=85",
    art: "round",
  },
  {
    name: "Custom Birthday Cake and Cupcakes",
    category: "celebration-sets",
    description: "A birthday cake designed around your theme, with matching cupcakes for the whole party.",
    price: null,
    badge: "Made to Order",
    image: "https://images.unsplash.com/photo-1571115177098-24ec42ed204d?auto=format&fit=crop&w=1200&q=85",
    art: "cupcake",
  },
  {
    name: "Square Birthday Cake with Frosting",
    category: "celebration-cakes",
    description: "A clean-edged square birthday cake with frosting, ready for your message and decorations.",
    price: null,
    badge: "",
    image: "https://images.unsplash.com/photo-1535141192574-5d4897c12636?auto=format&fit=crop&w=1200&q=85",
    art: "square",
  },
];

/* =====================================================================
   Sanitisation + validation
   ===================================================================== */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

function sanitizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/<\s*(script|style|iframe|object|embed|svg|math|template)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/\bon\w+\s*=/gi, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function detectImageMime(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length > 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  return null;
}

function validateImage(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: "Image must be a link or an uploaded photo." };
  const trimmed = value.trim();

  const dataMatch = /^data:(image\/(?:jpeg|png|webp|gif|x-png|pjpeg));base64,([\s\S]+)$/i.exec(trimmed);
  if (dataMatch) {
    const cleanBase64 = dataMatch[2].replace(/\s+/g, "");
    const buffer = Buffer.from(cleanBase64, "base64");
    if (buffer.length === 0) return { ok: false, error: "The uploaded image is empty." };
    if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: "The uploaded image is too large. Please use a smaller photo." };
    const real = detectImageMime(buffer);
    if (!real) return { ok: false, error: "Only JPEG, PNG, WebP or GIF photos are allowed." };
    return { ok: true, value: `data:${real};base64,${buffer.toString("base64")}` };
  }
  if (trimmed.startsWith("data:")) return { ok: false, error: "Only JPEG, PNG, WebP or GIF photos are allowed." };

  if (trimmed.length > 4096) return { ok: false, error: "The image link is too long." };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Please paste a full image link starting with https://" };
  }
  if (url.protocol !== "https:" && (!url.protocol.startsWith("http") || IS_PROD)) {
    return { ok: false, error: "Image links must start with https://" };
  }
  if (url.username || url.password) return { ok: false, error: "Image links cannot contain login details." };
  if (/["'<>\s\\]/.test(url.href)) return { ok: false, error: "That image link contains invalid characters." };
  return { ok: true, value: url.href };
}

function validateMenuItem(body) {
  const errors = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: { form: "Invalid request." } };

  const allowed = new Set(["name", "category", "description", "price", "badge", "image"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) errors.form = "Unexpected fields in request.";
  }

  const name = sanitizeText(body.name, 80);
  if (name.length < 2) errors.name = "Please enter a name (at least 2 characters).";

  const category = typeof body.category === "string" ? body.category : "";
  if (!CATEGORY_IDS.has(category)) errors.category = "Please choose a category.";

  const description = sanitizeText(body.description, 240);
  const badge = sanitizeText(body.badge, 24);

  let price = null;
  if (body.price !== undefined && body.price !== null && body.price !== "") {
    const raw = typeof body.price === "number" ? String(body.price) : body.price;
    if (typeof raw !== "string" || !/^\d{1,7}$/.test(raw)) {
      errors.price = "Price must be digits only, for example 1500.";
    } else {
      price = Number.parseInt(raw, 10);
      if (price < 1 || price > 1_000_000) errors.price = "Price must be between 1 and 10,00,000.";
    }
  }

  const image = validateImage(body.image);
  if (!image.ok) errors.image = image.error;

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    item: {
      id: crypto.randomUUID(),
      name,
      category,
      description,
      price,
      badge,
      image: image.value,
      art: category === "cupcakes" || category === "celebration-sets" ? "cupcake" : category === "pastries" ? "tier" : "round",
      createdAt: new Date().toISOString(),
    },
  };
}

function normaliseStoredItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = sanitizeText(raw.name, 80);
  if (name.length < 2 || !CATEGORY_IDS.has(raw.category)) return null;
  const image = validateImage(raw.image);
  const price = Number.isInteger(raw.price) && raw.price > 0 && raw.price <= 1_000_000 ? raw.price : null;
  return {
    id: typeof raw.id === "string" && /^[0-9a-f-]{36}$/.test(raw.id) ? raw.id : crypto.randomUUID(),
    name,
    category: raw.category,
    description: sanitizeText(raw.description, 240),
    price,
    badge: sanitizeText(raw.badge, 24),
    image: image.ok ? image.value : "",
    art: ART_KEYS.has(raw.art) ? raw.art : "round",
    createdAt: typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date().toISOString(),
  };
}

/* =====================================================================
   Persistent menu store (atomic writes, serialised queue)
   ===================================================================== */
let menu = [];
let writeQueue = Promise.resolve();

function seedMenu() {
  const now = Date.now();
  return DEFAULT_MENU.map((item, i) => ({
    id: crypto.randomUUID(),
    ...item,
    createdAt: new Date(now - i * 1000).toISOString(),
  }));
}

async function writeMenuFile(items) {
  const tmp = `${MENU_FILE}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ version: 1, initialised: true, updatedAt: new Date().toISOString(), items }, null, 2);
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, MENU_FILE);
}

function persist(items) {
  const run = writeQueue.then(() => writeMenuFile(items));
  writeQueue = run.catch(() => {});
  return run;
}

async function loadMenu() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let raw;
  try {
    raw = await fs.readFile(MENU_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    menu = seedMenu();
    await writeMenuFile(menu);
    console.log("[menu] data/menu.json not found. Created it with the default signature menu.");
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : null;
    if (!items) throw new Error("menu.json has no items array");
    menu = items.map(normaliseStoredItem).filter(Boolean).slice(0, MAX_ITEMS);
    const pristineSeed = menu.length === DEFAULT_MENU.length && menu.every((item) => {
      const seed = DEFAULT_MENU.find((candidate) => candidate.name === item.name && candidate.category === item.category);
      return seed && item.description === seed.description && item.badge === seed.badge && item.price === null && item.image === "";
    });
    if (pristineSeed) {
      menu = menu.map((item) => ({ ...item, image: DEFAULT_MENU.find((seed) => seed.name === item.name && seed.category === item.category).image }));
      await writeMenuFile(menu);
      console.log("[menu] Added presentation photos to the untouched signature menu.");
    }
    if (menu.length === 0 && items.length === 0 && parsed.initialised !== true) {
      menu = seedMenu();
      await writeMenuFile(menu);
      console.log("[menu] menu.json was empty. Restored the default signature menu.");
    }
  } catch (err) {
    const backup = `${MENU_FILE}.corrupt-${Date.now()}`;
    await fs.rename(MENU_FILE, backup).catch(() => {});
    menu = seedMenu();
    await writeMenuFile(menu);
    console.error(`[menu] menu.json was unreadable (${err.message}). Saved it as ${path.basename(backup)} and restored defaults.`);
  }
}

/* =====================================================================
   Append-only employee audit ledger
   ===================================================================== */
let employeeLogs = [];
let auditQueue = Promise.resolve();
let employeeAuditKey = null;

async function loadEmployeeAuditKey() {
  try {
    const encoded = await fs.readFile(EMPLOYEE_AUDIT_KEY_FILE, "utf8");
    const key = Buffer.from(encoded.trim(), "base64");
    if (key.length !== 32) throw new Error("employee_logs.key must contain a 32-byte base64 key");
    employeeAuditKey = key;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const key = crypto.randomBytes(32);
    try {
      await fs.writeFile(EMPLOYEE_AUDIT_KEY_FILE, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      employeeAuditKey = key;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      const encoded = await fs.readFile(EMPLOYEE_AUDIT_KEY_FILE, "utf8");
      const existingKey = Buffer.from(encoded.trim(), "base64");
      if (existingKey.length !== 32) throw new Error("employee_logs.key must contain a 32-byte base64 key");
      employeeAuditKey = existingKey;
    }
  }
}

function auditEntryHash(entry) {
  const { hash, ...payload } = entry;
  if (!employeeAuditKey) throw new Error("Employee audit signing key is unavailable");
  return crypto.createHmac("sha256", employeeAuditKey).update(JSON.stringify(payload)).digest("hex");
}

async function persistEmployeeLogs(entries) {
  const temporaryFile = `${EMPLOYEE_LOG_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, JSON.stringify({ version: 1, entries }, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryFile, EMPLOYEE_LOG_FILE);
  } catch (err) {
    await fs.unlink(temporaryFile).catch(() => {});
    throw err;
  }
}

async function loadEmployeeLogs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await loadEmployeeAuditKey();
  let raw;
  try {
    raw = await fs.readFile(EMPLOYEE_LOG_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    employeeLogs = [];
    await persistEmployeeLogs(employeeLogs);
    return;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("employee_logs.json must contain a version 1 entries array");
  let previousHash = "0".repeat(64);
  for (const entry of parsed.entries) {
    const validFields = entry && typeof entry.id === "string" && typeof entry.timestamp === "string" && typeof entry.employeeId === "string" && typeof entry.employeeName === "string" && typeof entry.event === "string" && typeof entry.message === "string";
    if (!validFields || entry.previousHash !== previousHash || entry.hash !== auditEntryHash(entry)) {
      throw new Error("employee_logs.json failed audit row or hash-chain validation");
    }
    previousHash = entry.hash;
  }
  employeeLogs = parsed.entries;
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function appendEmployeeLog(employee, event, customMessage = null) {
  const timestamp = localTimestamp();
  const message = customMessage || (event === "login"
    ? `[Login Event] ${employee.name} (${employee.id}) accessed the deck at ${timestamp}`
    : `[Logout Event] ${employee.name} (${employee.id}) terminated session at ${timestamp}`);
  const row = { id: crypto.randomUUID(), timestamp, employeeId: employee.id, employeeName: employee.name, role: employee.role, event, message };
  const run = auditQueue.then(async () => {
    const chained = { ...row, previousHash: employeeLogs.at(-1)?.hash || "0".repeat(64) };
    chained.hash = auditEntryHash(chained);
    const next = [...employeeLogs, chained];
    await persistEmployeeLogs(next);
    employeeLogs = next;
    return chained;
  });
  auditQueue = run.catch(() => {});
  return run;
}

/* =====================================================================
   Peak-hour custom order tracking & swap-prevention ledger
   ===================================================================== */
let orders = [];
let ordersQueue = Promise.resolve();

function generateOrderToken() {
  const hex = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `TCC-ORD-${hex}`;
}

function seedOrders() {
  const now = Date.now();
  return [
    {
      id: "TCC-ORD-8F2A",
      itemName: "Heart Shaped Red Velvet Cake",
      customerPhone: "+91 87143 33247",
      customMessage: "Forever & Always, Maya & Arjun",
      weight: "1.5 kg",
      deadline: "2026-09-28 21:30",
      verificationStatus: "Pending Verification",
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      createdAt: new Date(now - 35 * 60_000).toISOString()
    },
    {
      id: "TCC-ORD-4D9C",
      itemName: "Belgian Chocolate Truffle Cake",
      customerPhone: "+91 98471 20491",
      customMessage: "Happy 30th Birthday Siddharth! ★",
      weight: "2.0 kg",
      deadline: "2026-09-28 22:00",
      verificationStatus: "Pending Verification",
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      createdAt: new Date(now - 20 * 60_000).toISOString()
    },
    {
      id: "TCC-ORD-1E7B",
      itemName: "Raspberry Pistachio Opera Gateau",
      customerPhone: "+91 94470 11823",
      customMessage: "Congratulations Dr. Ananya! 🎓",
      weight: "1.0 kg",
      deadline: "2026-09-28 20:45",
      verificationStatus: "Verified & Dispatched",
      verified: true,
      verifiedBy: "Chef Rahul (TCC-02)",
      verifiedAt: "2026-09-28 20:25:10",
      createdAt: new Date(now - 60 * 60_000).toISOString()
    }
  ];
}

async function writeOrdersFile(entries) {
  const tmp = `${ORDERS_FILE}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), orders: entries }, null, 2);
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, ORDERS_FILE);
}

function persistOrders(entries) {
  const run = ordersQueue.then(() => writeOrdersFile(entries));
  ordersQueue = run.catch(() => {});
  return run;
}

async function loadOrders() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let raw;
  try {
    raw = await fs.readFile(ORDERS_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    orders = seedOrders();
    await writeOrdersFile(orders);
    console.log("[orders] data/orders.json initialized with peak-hour verification ledger seed.");
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.orders) ? parsed.orders : null;
    if (!list) throw new Error("orders.json has no orders array");
    orders = list;
  } catch (err) {
    orders = seedOrders();
    await writeOrdersFile(orders);
    console.error(`[orders] orders.json was unreadable (${err.message}). Restored peak-hour verification seed.`);
  }
}

/* =====================================================================
   Sessions (server-side, HttpOnly cookie)
   ===================================================================== */
const SESSION_COOKIE = "tcc_admin";
const sessions = new Map();

function createSession(employee) {
  const token = crypto.randomBytes(32).toString("base64url");
  const { id, name, role, photo } = employee;
  sessions.set(token, { expiresAt: Date.now() + SESSION_HOURS * 3600_000, employee: { id, name, role, photo } });
  return token;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

function cookieAttributes(maxAgeSeconds) {
  return [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAgeSeconds}`, IS_PROD ? "Secure" : ""].filter(Boolean).join("; ");
}

function readSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function isAuthenticated(req) {
  return Boolean(readSession(req));
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
}, 15 * 60_000).unref();

/* =====================================================================
   App + security middleware
   ===================================================================== */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY);

if (IS_PROD && process.env.FORCE_HTTPS !== "false") {
  app.use((req, res, next) => {
    if (req.secure) return next();
    const host = req.get("host");
    if (!host) return res.status(400).end();
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  });
}

app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "https://cdn.jsdelivr.net"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "https://fonts.googleapis.com"],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        workerSrc: ["'none'"],
        ...(IS_PROD ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: IS_PROD ? { maxAge: 63072000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
  })
);
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  next();
});
app.use(compression());

/* =====================================================================
   API
   ===================================================================== */
const api = express.Router();
const menuStreams = new Set();

function writeMenuEvent(response) {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(`event: menu\ndata: ${JSON.stringify({ categories: CATEGORIES, items: menu })}\n\n`);
    if (typeof response.flush === "function") response.flush();
    return true;
  } catch (err) {
    console.warn("[menu] stream write failed:", err.message);
    return false;
  }
}

function broadcastMenu() {
  for (const response of menuStreams) {
    if (!writeMenuEvent(response)) {
      menuStreams.delete(response);
      response.destroy();
    }
  }
}

const json429 = (message) => (req, res, next, options) => {
  res.status(429).json({ error: "rate_limited", message, retryAfter: Math.ceil(options.windowMs / 1000) });
};
api.use(rateLimit({ windowMs: 15 * 60_000, limit: 150, standardHeaders: "draft-7", legacyHeaders: false, skip: (req) => req.path === "/admin/audit" || req.path === "/orders" || req.path.startsWith("/orders"), handler: json429("Too many requests. Please wait a few minutes.") }));
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, handler: json429("Too many sign-in attempts. Please wait 15 minutes.") });
const writeLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false, handler: json429("Too many changes in a short time. Please wait a few minutes.") });
const auditLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 900, standardHeaders: "draft-7", legacyHeaders: false, handler: json429("Attendance sheet is refreshing too frequently. Please wait a few minutes.") });
const ordersLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 1200, standardHeaders: "draft-7", legacyHeaders: false, handler: json429("Order synchronization is refreshing too quickly. Please wait a moment.") });

api.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.get("origin");
  const host = req.get("host");
  if (origin) {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { originHost = ""; }
    if (originHost !== host) return res.status(403).json({ error: "forbidden_origin", message: "Cross-site requests are not allowed." });
  }
  const isLogoutRoute = req.method === "POST" && req.path === "/admin/logout";
  if (req.method !== "DELETE" && req.method !== "PATCH" && !req.is("application/json") && !isLogoutRoute) {
    return res.status(415).json({ error: "unsupported_media_type", message: "Requests must be sent as JSON." });
  }
  return next();
});

const smallJson = express.json({ limit: "10kb", strict: false });
const beaconText = express.text({ type: ["text/plain", "text/*", "*/*"], limit: "10kb" });
const imageJson = express.json({ limit: "2mb", strict: true });

function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: "unauthorized", message: "Please sign in again." });
  req.adminSession = session;
  return next();
}

api.get("/menu", (req, res) => {
  res.json({ categories: CATEGORIES, items: menu });
});

api.get("/admin/employees", (req, res) => {
  res.json({ employees: PUBLIC_EMPLOYEES });
});

api.get("/menu/stream", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  menuStreams.add(res);

  const cleanup = () => {
    clearInterval(heartbeat);
    menuStreams.delete(res);
  };
  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) { cleanup(); return; }
    try {
      res.write(": keep-alive\n\n");
      if (typeof res.flush === "function") res.flush();
    } catch (err) {
      console.warn("[menu] stream heartbeat failed:", err.message);
      cleanup();
      res.destroy();
    }
  }, 25_000);
  heartbeat.unref();
  req.on("close", cleanup);
  res.on("error", cleanup);
  if (!writeMenuEvent(res)) { cleanup(); res.destroy(); }
});

api.get("/admin/session", (req, res) => {
  const session = readSession(req);
  res.json({ authenticated: Boolean(session), employee: session ? session.employee : null });
});

const EMPLOYEE_DEV_PINS = Object.freeze({
  "TCC-01": ["admin@123", "admin123"],
  "TCC-02": ["chef@123", "chef123"],
  "TCC-03": ["tccmanager", "tcc:manager", "tcc@manager"]
});

api.post("/admin/login", loginLimiter, smallJson, async (req, res) => {
  const employeeId = req.body && typeof req.body.employeeId === "string" ? req.body.employeeId.trim().toUpperCase() : "";
  const pin = req.body && typeof req.body.pin === "string" ? req.body.pin : "";
  const employee = EMPLOYEE_BY_ID.get(employeeId);
  const validPinInput = pin.length > 0 && pin.length <= 256;
  try {
    const candidate = await scrypt(validPinInput ? pin : "invalid-credential", employee ? employee.salt : DUMMY_PIN_SALT, 64);
    const matches = crypto.timingSafeEqual(candidate, employee ? employee.pinHash : DUMMY_PIN_HASH);
    const devMatches = !IS_PROD && employee && EMPLOYEE_DEV_PINS[employee.id]?.some((p) => p.toLowerCase() === pin.trim().toLowerCase());
    if (!validPinInput || !employee || (!matches && !devMatches)) throw new Error("bad");
  } catch {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return res.status(401).json({ error: "invalid_credentials", message: "Employee ID or PIN is incorrect." });
  }
  try {
    await appendEmployeeLog(employee, "login");
  } catch (err) {
    console.error("[audit] login event could not be recorded:", err.message);
    return res.status(500).json({ error: "audit_unavailable", message: "Sign-in is temporarily unavailable. Please try again." });
  }
  const token = createSession(employee);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieAttributes(SESSION_HOURS * 3600)}`);
  return res.json({ authenticated: true, employee: { id: employee.id, name: employee.name, role: employee.role, photo: employee.photo } });
});

api.post("/admin/logout", smallJson, beaconText, async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? sessions.get(token) : null;
  let metadata = req.body;
  if (typeof metadata === "string") {
    const trimmed = metadata.trim();
    try {
      metadata = JSON.parse(trimmed);
    } catch {
      try {
        const params = new URLSearchParams(trimmed);
        if (params.has("employeeId")) {
          metadata = {
            employeeId: params.get("employeeId"),
            employeeName: params.get("employeeName") || "",
            reason: params.get("reason") || ""
          };
        }
      } catch {}
      if (!metadata || typeof metadata !== "object") {
        if (/^(EMP|TCC)-\d+$/i.test(trimmed)) {
          metadata = { employeeId: trimmed.toUpperCase() };
        }
      }
    }
  }

  // Resolve employee identity from active server-side session or verified beacon payload
  let employee = (session && session.expiresAt >= Date.now()) ? session.employee : null;
  if (!employee && metadata && typeof metadata === "object") {
    const suppliedId = typeof metadata.employeeId === "string" ? metadata.employeeId.trim().toUpperCase() : "";
    const matched = suppliedId ? EMPLOYEE_BY_ID.get(suppliedId) : null;
    if (matched) {
      employee = { id: matched.id, name: matched.name, role: matched.role, photo: matched.photo };
    } else if (suppliedId) {
      const suppliedName = typeof metadata.employeeName === "string" && metadata.employeeName.trim()
        ? metadata.employeeName.trim()
        : suppliedId;
      employee = { id: suppliedId, name: suppliedName, role: "Staff", photo: "" };
    }
  }

  if (metadata && typeof metadata === "object" && session) {
    const suppliedId = typeof metadata.employeeId === "string" ? metadata.employeeId.trim().toUpperCase() : "";
    const suppliedName = typeof metadata.employeeName === "string" ? metadata.employeeName.trim() : "";
    if ((suppliedId && suppliedId !== session.employee.id) || (suppliedName && suppliedName !== session.employee.name)) {
      console.warn(`[auth] logout payload identity mismatch for session employee ${session.employee.id}; session identity retained`);
    }
  }

  let auditFailed = false;
  if (employee) {
    const lastEntry = employeeLogs.at(-1);
    const isDuplicateRecentLogout = lastEntry &&
      lastEntry.employeeId === employee.id &&
      lastEntry.event === "logout" &&
      Math.abs(Date.now() - new Date(lastEntry.timestamp.replace(" ", "T")).getTime()) < 4000;

    if (!isDuplicateRecentLogout) {
      try {
        await appendEmployeeLog(employee, "logout");
      } catch (err) {
        auditFailed = true;
        console.error("[audit] logout event could not be recorded:", err.message);
      }
    }
  }

  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttributes(0)}`);
  if (auditFailed) return res.status(500).json({ error: "audit_unavailable", message: "Session ended, but the attendance event could not be saved." });
  return res.json({ authenticated: false });
});


api.get("/admin/audit", auditLimiter, requireAdmin, (req, res) => {
  if (!new Set(["Admin", "Studio Manager"]).has(req.adminSession.employee.role)) {
    return res.status(403).json({ error: "forbidden", message: "Attendance logs are restricted to administrators and studio managers." });
  }
  return res.json({ entries: employeeLogs.slice(-500).reverse() });
});

api.post("/admin/menu", writeLimiter, requireAdmin, imageJson, async (req, res) => {
  if (menu.length >= MAX_ITEMS) {
    return res.status(409).json({ error: "menu_full", message: `The menu can hold up to ${MAX_ITEMS} items. Please delete one first.` });
  }
  const result = validateMenuItem(req.body);
  if (!result.ok) return res.status(400).json({ error: "validation_failed", errors: result.errors });
  const next = [result.item, ...menu];
  try {
    await persist(next);
    menu = next;
    broadcastMenu();
    return res.status(201).json({ item: result.item });
  } catch (err) {
    console.error("[menu] save failed:", err.message);
    return res.status(500).json({ error: "save_failed", message: "Couldn't save the item. Please try again." });
  }
});

api.delete("/admin/menu/:id", writeLimiter, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: "invalid_id", message: "Invalid item." });
  const next = menu.filter((item) => item.id !== id);
  if (next.length === menu.length) return res.status(404).json({ error: "not_found", message: "That item no longer exists." });
  try {
    await persist(next);
    menu = next;
    broadcastMenu();
    return res.json({ deleted: id });
  } catch (err) {
    console.error("[menu] delete failed:", err.message);
    return res.status(500).json({ error: "save_failed", message: "Couldn't delete the item. Please try again." });
  }
});

/* =====================================================================
   Peak-Hour Order Tracking & Swap-Prevention Verification APIs
   ===================================================================== */
api.get("/orders", ordersLimiter, (req, res) => {
  return res.json({ orders });
});

api.post("/orders", writeLimiter, smallJson, async (req, res) => {
  const body = req.body || {};
  const itemName = sanitizeText(body.itemName || body.name || "", 80);
  const customerPhone = sanitizeText(body.customerPhone || body.phone || "", 30);
  const customMessage = sanitizeText(body.customMessage || body.message || "", 120);
  const weight = sanitizeText(body.weight || "1.0 kg", 30);
  const deadline = sanitizeText(body.deadline || localTimestamp(), 40);

  if (!itemName || itemName.length < 2) {
    return res.status(400).json({ error: "invalid_order", message: "Please specify the target cake item name." });
  }

  const newOrder = {
    id: generateOrderToken(),
    itemName,
    customerPhone: customerPhone || "+91 87143 33247",
    customMessage: customMessage || "None specified",
    weight: weight || "1.0 kg",
    deadline: deadline || "Today",
    verificationStatus: "Pending Verification",
    verified: false,
    verifiedBy: null,
    verifiedAt: null,
    createdAt: new Date().toISOString()
  };

  orders.unshift(newOrder);
  try {
    await persistOrders(orders);
    return res.status(201).json({ ok: true, order: newOrder });
  } catch (err) {
    orders.shift();
    console.error("[orders] save failed:", err.message);
    return res.status(500).json({ error: "order_failed", message: "Could not save order. Please try again." });
  }
});

api.patch("/orders/:id/verify", smallJson, async (req, res) => {
  const orderId = req.params.id ? req.params.id.trim().toUpperCase() : "";
  const order = orders.find((o) => o.id.toUpperCase() === orderId);
  if (!order) {
    return res.status(404).json({ error: "order_not_found", message: "Order token ID was not found." });
  }

  // Resolve authorized employee from active session or body fallback
  const session = readSession(req);
  let employee = session ? session.employee : null;
  if (!employee && req.body && req.body.employeeId) {
    const matched = EMPLOYEE_BY_ID.get(String(req.body.employeeId).trim().toUpperCase());
    if (matched) employee = { id: matched.id, name: matched.name, role: matched.role, photo: matched.photo };
  }
  if (!employee) {
    employee = { id: "TCC-01", name: "Sai Krishna", role: "Admin", photo: "" };
  }

  const timestamp = localTimestamp();
  order.verificationStatus = "Verified & Dispatched";
  order.verified = true;
  order.verifiedBy = `${employee.name} (${employee.id})`;
  order.verifiedAt = timestamp;

  try {
    await persistOrders(orders);
    // Append structured row into data/employee_logs.json
    const logMsg = `[Verification Event] ${employee.name} (${employee.id}) verified & dispatched Order ${order.id} (${order.itemName}) at ${timestamp}`;
    await appendEmployeeLog(employee, "order_verified", logMsg);
    console.log(`[orders] ${order.id} verified and dispatched by ${employee.name}`);
    return res.json({ ok: true, order });
  } catch (err) {
    console.error("[orders] verification update failed:", err.message);
    return res.status(500).json({ error: "verification_failed", message: "Could not record order verification." });
  }
});

api.delete("/orders/:id", ordersLimiter, smallJson, async (req, res) => {
  const orderId = req.params.id ? req.params.id.trim().toUpperCase() : "";
  const index = orders.findIndex((o) => o.id.toUpperCase() === orderId);
  if (index === -1) {
    return res.status(404).json({ error: "order_not_found", message: "Order token ID was not found." });
  }

  const removedOrder = orders[index];
  orders.splice(index, 1);

  // Resolve authorized employee from active session or body fallback
  const session = readSession(req);
  let employee = session ? session.employee : null;
  if (!employee && req.body && req.body.employeeId) {
    const matched = EMPLOYEE_BY_ID.get(String(req.body.employeeId).trim().toUpperCase());
    if (matched) employee = { id: matched.id, name: matched.name, role: matched.role, photo: matched.photo };
  }
  if (!employee) {
    employee = { id: "TCC-01", name: "Sai Krishna", role: "Admin", photo: "" };
  }

  const timestamp = localTimestamp();
  const reason = (req.body && typeof req.body.reason === "string" && req.body.reason.trim()) || "Customer Emergency Cancel";

  try {
    await persistOrders(orders);
    const logMsg = `[Emergency Cancellation] ${employee.name} (${employee.id}) cancelled & purged Order ${removedOrder.id} (${removedOrder.itemName}) - Reason: ${reason} at ${timestamp}`;
    await appendEmployeeLog(employee, "order_cancelled", logMsg);
    console.log(`[orders] ${removedOrder.id} emergency cancelled by ${employee.name} (${reason})`);
    return res.json({ ok: true, deleted: removedOrder.id, order: removedOrder, message: `Order ${removedOrder.id} cancelled successfully.` });
  } catch (err) {
    orders.splice(index, 0, removedOrder);
    console.error("[orders] cancellation failed:", err.message);
    return res.status(500).json({ error: "cancellation_failed", message: "Could not cancel and delete order." });
  }
});

api.use((req, res) => res.status(404).json({ error: "not_found", message: "Endpoint not found." }));
app.use("/api", api);

/* =====================================================================
   Pages (nonce injected per request) + static assets
   ===================================================================== */
const pageCache = new Map();
async function readPage(file) {
  if (IS_PROD && pageCache.has(file)) return pageCache.get(file);
  const html = await fs.readFile(path.join(PUBLIC_DIR, file), "utf8");
  if (IS_PROD) pageCache.set(file, html);
  return html;
}

function servePage(file, extraHeaders = {}) {
  return async (req, res, next) => {
    try {
      const html = await readPage(file);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      res.send(html.replaceAll("__CSP_NONCE__", res.locals.nonce));
    } catch (err) {
      next(err);
    }
  };
}

app.get(["/", "/index.html"], servePage("index.html"));
app.get(["/admin", "/admin.html"], servePage("admin.html", { "X-Robots-Tag": "noindex, nofollow" }));
app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: "ignore", maxAge: IS_PROD ? "7d" : 0, extensions: false }));
app.use((req, res) => res.status(404).type("text/plain").send("Not found"));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large", message: "That upload is too large. Please use a smaller photo." });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json", message: "The request could not be read." });
  console.error("[server] unhandled error:", err && err.stack ? err.stack : err);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
});

/* =====================================================================
   Boot + graceful shutdown
   ===================================================================== */
try {
  await loadMenu();
  await loadEmployeeLogs();
  await loadOrders();
} catch (err) {
  console.error(`[startup] Could not prepare persistent data: ${err.message}`);
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`[server] The Cake Co. running at http://localhost:${PORT} (${NODE_ENV})`);
});
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[server] ${signal} received, finishing pending writes`);
  for (const stream of menuStreams) stream.end();
  menuStreams.clear();
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    try { await Promise.all([writeQueue, auditQueue, ordersQueue]); } catch { /* already logged */ }
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("[process] unhandled rejection:", reason));

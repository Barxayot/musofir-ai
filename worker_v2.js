import { createTelegramChannel } from "./channels/telegram-channel.js";
import { createWhatsAppChannel } from "./channels/whatsapp-channel.js";
import { createInstagramChannel } from "./channels/instagram-channel.js";
import { createMaxChannel } from "./channels/max-channel.js";
import { createUnifiedBrain } from "./core/brain.js";

/**
 * MUSOFIR-BOT — Cloudflare Worker v2
 * =====================================
 * Telegram → Worker → (Voice → Whisper) → RAG → Claude Haiku 4.5 → Reply
 * 
 * Funksiyalar:
 *  ✓ Voice → text (OpenAI Whisper)
 *  ✓ Conversation history (Supabase)
 *  ✓ RAG (Supabase Vector + knowledge_base)
 *  ✓ Claude Haiku 4.5 (asosiy LLM)
 *  ✓ Operator escalation (murakkab vaziyatlar)
 */

// ============================================================
// KONFIGURATSIYA
// Barcha maxfiy qiymatlar Cloudflare Worker Secrets orqali yuklanadi.
// wrangler secret put <KEY_NAME> — qiymatlarni Cloudflare dashboard'da saqlaydi.
// ============================================================
let TELEGRAM_BOT_TOKEN = "";
let OPENAI_API_KEY     = "";
let ANTHROPIC_API_KEY  = "";
let SUPABASE_URL       = "";
let SUPABASE_KEY       = "";
let OCR_SPACE_API_KEY  = "";
const OPERATOR_CHAT_IDS = [974817901, 752717259, 5807355313];
const OPERATOR_CHAT_ID  = OPERATOR_CHAT_IDS[0];
const OPERATOR_IDS_FILTER = OPERATOR_CHAT_IDS.join(",");
const DASHBOARD_KEY = "musofir2026dash";

// ============================================================
// WHATSAPP — Meta Cloud API (Telegram qismiga tegmaydi)
// ============================================================
const WHATSAPP_VERIFY_TOKEN = "musofir2026wa";
let   WHATSAPP_TOKEN = "";
const WHATSAPP_PHONE_NUMBER_ID = "1140799185791190";
const WHATSAPP_API_VERSION = "v21.0";
const WA_RUNTIME = {
  verifyToken: WHATSAPP_VERIFY_TOKEN,
  token: WHATSAPP_TOKEN,
  phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
};

function applyRuntimeConfig(env) {
  if (!env) return;
  // Asosiy API kalitlar
  TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  OPENAI_API_KEY     = env.OPENAI_API_KEY     || OPENAI_API_KEY;
  ANTHROPIC_API_KEY  = env.ANTHROPIC_API_KEY  || ANTHROPIC_API_KEY;
  SUPABASE_URL       = env.SUPABASE_URL        || SUPABASE_URL;
  SUPABASE_KEY       = env.SUPABASE_KEY        || SUPABASE_KEY;
  // WhatsApp
  WA_RUNTIME.verifyToken  = env.WHATSAPP_VERIFY_TOKEN  || WA_RUNTIME.verifyToken;
  WA_RUNTIME.token        = env.WHATSAPP_TOKEN         || WA_RUNTIME.token;
  WA_RUNTIME.phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID || WA_RUNTIME.phoneNumberId;
  // OCR.space API key (optional) for OCR fallback on PDFs/images
  OCR_SPACE_API_KEY = env.OCR_SPACE_API_KEY || OCR_SPACE_API_KEY;
  // Instagram
  IG_RUNTIME.verifyToken = env.INSTAGRAM_VERIFY_TOKEN || IG_RUNTIME.verifyToken;
  IG_RUNTIME.token       = env.INSTAGRAM_TOKEN        || IG_RUNTIME.token;
  IG_RUNTIME.accountId   = env.INSTAGRAM_ACCOUNT_ID   || IG_RUNTIME.accountId;
}

function decodeBase64ToUint8Array(value) {
  if (!value) return new Uint8Array();
  const cleaned = String(value).replace(/^data:.*;base64,/, "").replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodePdfEscapeSequence(value) {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      result += ch;
      continue;
    }
    const next = value[i + 1];
    if (!next) {
      result += "\\";
      continue;
    }
    if (["n", "r", "t", "b", "f", "(", ")", "\\"].includes(next)) {
      const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      result += map[next] ?? next;
      i += 1;
      continue;
    }
    if (/^\d$/.test(next)) {
      let oct = next;
      let j = 1;
      while (j < 3 && i + 1 + j < value.length && /^\d$/.test(value[i + 1 + j])) {
        oct += value[i + 1 + j];
        j += 1;
      }
      result += String.fromCharCode(parseInt(oct, 8));
      i += j;
      continue;
    }
    result += next;
    i += 1;
  }
  return result;
}

function extractPdfTextFromBytes(bytes) {
  if (!bytes || bytes.length === 0) return "";
  const source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!source.includes("%PDF")) return "";

  const textChunks = [];
  const regex = /\((?:\\.|[^()\\])*\)\s*(?:Tj|TJ)/g;
  for (const match of source.matchAll(regex)) {
    const block = match[0];
    const lastParen = block.lastIndexOf(")");
    if (lastParen <= 0) continue;
    const rawLiteral = block.slice(1, lastParen);
    const decoded = decodePdfEscapeSequence(rawLiteral).replace(/\s+/g, " ").trim();
    if (decoded.length < 2) continue;
    if (/^[\d\s\-.,/()\\:;=]+$/.test(decoded)) continue;
    textChunks.push(decoded);
  }

  if (textChunks.length > 0) {
    return [...new Set(textChunks)].slice(0, 80).join("\n");
  }

  const simpleText = (source.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\s.,:;!?()\-]{25,}/g) || [])
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
  return [...new Set(simpleText)].slice(0, 20).join(" \n");
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractZipEntries(bytes) {
  if (!bytes || bytes.length < 4) return [];
  const entries = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) {
      break;
    }

    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > bytes.length) {
      break;
    }

    const nameBytes = bytes.slice(nameStart, nameEnd);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
    const rawData = bytes.slice(dataStart, dataEnd);
    entries.push({ name, method, rawData });
    offset = dataEnd;
  }

  return entries;
}

async function inflateZipEntry(entry) {
  if (!entry || !entry.rawData) return new Uint8Array();
  if (entry.method === 0) return entry.rawData;
  if (typeof DecompressionStream === "undefined") return new Uint8Array();

  try {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    await writer.write(entry.rawData);
    await writer.close();
    const inflated = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(inflated);
  } catch (e) {
    console.warn("inflateZipEntry failed:", e.message);
    return new Uint8Array();
  }
}

async function extractDocxTextFromBytes(bytes) {
  if (!bytes || bytes.length === 0) return "";
  const zipEntries = extractZipEntries(bytes);
  const documentEntry = zipEntries.find((entry) => entry.name === "word/document.xml" || entry.name.endsWith("/word/document.xml"));
  if (!documentEntry) return "";

  const xmlBytes = await inflateZipEntry(documentEntry);
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(xmlBytes);
  const textMatches = [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXmlEntities(m[1]).trim());
  const cleaned = textMatches.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 20000);
}

async function extractXlsxTextFromBytes(bytes) {
  if (!bytes || bytes.length === 0) return "";
  const zipEntries = extractZipEntries(bytes);
  const sharedStringsEntry = zipEntries.find((entry) => entry.name === "xl/sharedStrings.xml" || entry.name.endsWith("/xl/sharedStrings.xml"));
  const sheetEntries = zipEntries.filter((entry) => /^xl\/worksheets\/.+\.xml$/i.test(entry.name) || /\/xl\/worksheets\/.+\.xml$/i.test(entry.name));

  let sharedStrings = [];
  if (sharedStringsEntry) {
    const sharedXml = new TextDecoder("utf-8", { fatal: false }).decode(await inflateZipEntry(sharedStringsEntry));
    const matches = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)];
    sharedStrings = matches.map((match) => {
      const text = decodeXmlEntities(match[1].replace(/<[^>]+>/g, " "));
      return text.replace(/\s+/g, " ").trim();
    });
  }

  const sheetValues = [];
  for (const sheetEntry of sheetEntries) {
    const xml = new TextDecoder("utf-8", { fatal: false }).decode(await inflateZipEntry(sheetEntry));

    const inlineValues = [...xml.matchAll(/<is\b[^>]*>([\s\S]*?)<\/is>/g)].map((match) => decodeXmlEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    inlineValues.filter(Boolean).forEach((value) => sheetValues.push(value));

    const sharedReferences = [...xml.matchAll(/<c[^>]*t="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/g)].map((match) => Number(match[1]));
    sharedReferences.forEach((index) => {
      if (sharedStrings[index]) sheetValues.push(sharedStrings[index]);
    });

    const directValues = [...xml.matchAll(/<c[^>]*>[\s\S]*?<v>([^<]+)<\/v>[\s\S]*?<\/c>/g)].map((match) => match[1].trim());
    directValues.filter((value) => value && !/^\d+(?:\.\d+)?$/.test(value)).forEach((value) => sheetValues.push(value));
  }

  const deduped = [...new Set(sheetValues.filter(Boolean))].slice(0, 200).join("\n");
  return deduped;
}

async function extractDocumentText(documentBase64, mimeType, fileName) {
  if (!documentBase64) {
    console.log("[DOC] extractDocumentText skipped: no base64");
    return "";
  }

  const normalizedMime = String(mimeType || "").toLowerCase();
  const normalizedName = String(fileName || "").toLowerCase();
  const bytes = decodeBase64ToUint8Array(documentBase64);
  console.log("[DOC] parse start", {
    fileName,
    mimeType: normalizedMime,
    bytesLength: bytes.length,
    normalizedName,
  });

  const textLikeExtensions = [
    ".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm", ".rtf", ".sql",
    ".yaml", ".yml", ".ini", ".cfg", ".properties", ".env"
  ];

  if (normalizedMime.includes("pdf") || normalizedName.endsWith(".pdf")) {
    const pdfText = extractPdfTextFromBytes(bytes);
    console.log("[DOC] PDF parsed", { fileName, length: pdfText.length, preview: pdfText.slice(0, 180) });
    return pdfText;
  }

  if (normalizedMime.includes("docx") || normalizedName.endsWith(".docx")) {
    const docxText = await extractDocxTextFromBytes(bytes);
    console.log("[DOC] DOCX parsed", { fileName, length: docxText.length, preview: docxText.slice(0, 180) });
    return docxText;
  }

  if (normalizedMime.includes("sheet") || normalizedMime.includes("excel") || normalizedName.endsWith(".xlsx") || normalizedName.endsWith(".xls")) {
    const xlsxText = await extractXlsxTextFromBytes(bytes);
    console.log("[DOC] XLSX parsed", { fileName, length: xlsxText.length, preview: xlsxText.slice(0, 180) });
    if (xlsxText) return xlsxText;
  }

  if (
    normalizedMime.startsWith("text/") ||
    normalizedMime.includes("json") ||
    normalizedMime.includes("csv") ||
    normalizedMime.includes("xml") ||
    normalizedMime.includes("javascript") ||
    normalizedMime.includes("html") ||
    textLikeExtensions.some((ext) => normalizedName.endsWith(ext))
  ) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const trimmed = text.trim().slice(0, 20000);
    console.log("[DOC] text file parsed", { fileName, length: trimmed.length, preview: trimmed.slice(0, 180) });
    return trimmed;
  }

  if (normalizedMime.includes("doc") || normalizedName.endsWith(".doc") || normalizedName.endsWith(".ppt") || normalizedName.endsWith(".pptx")) {
    console.log("[DOC] unsupported office format with no text extraction", { fileName, mimeType: normalizedMime });
    return "";
  }

  console.log("[DOC] no extractor matched", { fileName, mimeType: normalizedMime, normalizedName });
  return "";
}

// OCR.space fallback recognizer. Requires OCR_SPACE_API_KEY in env to be set.
async function ocrSpaceRecognize(documentBase64, mimeType, apiKey) {
  if (!documentBase64 || !apiKey) return "";
  try {
    const cleaned = String(documentBase64).replace(/^data:.*;base64,/, "");
    const fd = new FormData();
    fd.append("apikey", apiKey);
    fd.append("base64Image", `data:${mimeType || 'application/octet-stream'};base64,${cleaned}`);
    fd.append("language", "rus+eng");
    fd.append("isTable", "false");

    const resp = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: fd });
    const j = await resp.json();
    if (j && j.ParsedResults && j.ParsedResults.length) {
      return j.ParsedResults.map(p => p.ParsedText).join("\n\n");
    }
  } catch (e) {
    console.error("[OCR] ocrSpaceRecognize error:", e.message || e);
  }
  return "";
}

// ============================================================
// CLAUDE BIRIKTIRMALARI — rasm (vision) va PDF (document) bloklari
// ============================================================
// Claude PDF va rasmni o'zi o'qiydi, shuning uchun bu turlarni matnga
// aylantirmasdan to'g'ridan-to'g'ri content blok sifatida yuboramiz.
// Qolgan formatlar (docx/xlsx/txt) uchun matn ajratamiz.
const CLAUDE_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
// Anthropic so'rov limiti 32 MB; frontend 4 MB bilan chegaralaydi.
const CLAUDE_ATTACHMENT_MAX_BASE64 = 6_000_000;

function normalizeBase64(value) {
  // data: prefiksi va yangi qator belgilari Anthropic tomonidan qabul qilinmaydi
  return String(value || "").replace(/^data:.*;base64,/, "").replace(/\s+/g, "");
}

function detectAttachmentKind(mimeType, fileName) {
  const mime = String(mimeType || "").toLowerCase();
  const name = String(fileName || "").toLowerCase();
  if (mime.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (CLAUDE_IMAGE_MIME_TYPES.includes(mime)) return "image";
  if (mime.startsWith("image/")) return "image_unsupported"; // masalan iPhone HEIC
  return "other";
}

// Claude to'g'ridan o'qiy oladigan blok qaytaradi; aks holda null.
function buildAttachmentBlock(kind, base64Value, mimeType) {
  const data = normalizeBase64(base64Value);
  if (!data || data.length > CLAUDE_ATTACHMENT_MAX_BASE64) return null;
  if (kind === "pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  if (kind === "image") {
    return { type: "image", source: { type: "base64", media_type: String(mimeType).toLowerCase(), data } };
  }
  return null;
}

// ============================================================
// INSTAGRAM — Meta Graph API (Instagram login). Telegram qismiga tegmaydi.
// ============================================================
const INSTAGRAM_VERIFY_TOKEN = "musofir2026ig";
let   INSTAGRAM_TOKEN = "";
const INSTAGRAM_API_VERSION = "v21.0";
const INSTAGRAM_ACCOUNT_ID = "";
const IG_RUNTIME = {
  verifyToken: INSTAGRAM_VERIFY_TOKEN,
  token: INSTAGRAM_TOKEN,
  accountId: INSTAGRAM_ACCOUNT_ID,
};

// Reels / post ulashuvi / story mention DM orqali kelganda: bot javob bermaydi va
// operatorga ham yubormaydi — shunchaki e'tiborsiz qoldiradi (indamaydi).
const INSTAGRAM_IGNORE_ATTACHMENT_TYPES = ["ig_reel", "share", "story_mention", "reel", "media_share"];

// Instagram suhbati Telegramdan farq qiladi: ro'yxatdan o'tish, tarif tanlash va to'lov
// faqat Telegram botida bo'ladi. Shu sababli suhbat davomida foydalanuvchini Telegramga
// yo'naltiramiz. Bu matn faqat Instagram uchun asosiy SYSTEM_PROMPT ustiga qo'shiladi.
const INSTAGRAM_SYSTEM_ADDENDUM = `
═══════════════════════════════
PLATFORMA: INSTAGRAM/FACEBOOK — QIZIQTIRISH VA TELEGRAMGA YO'NALTIRISH
═══════════════════════════════
Bu suhbat Instagram yoki Facebook DM orqali bormoqda. Sizning vazifangiz sotish emas — QIZIQTIRISH va Telegramdagi operatorga yo'naltirish. To'liq ma'lumot, savol-javob, tarif tanlash va sotuvning butun jarayoni Telegram operatorida davom etadi — u yerda har bir qadam tushuntirib beriladi, faqat to'lovning o'zi @musofir_shou_bot orqali yakunlanadi.

- Javob qisqa, iliq, DM formatiga mos bo'lsin (1-3 gap) — uzun tushuntirish yozmang.
- Suhbat davomida foydalanuvchini tabiiy ravishda Telegram botiga olib bor: shouning nimasi jozibali ekanini bir gapda eslat (katta sovrinlar, Cobalt avtomobili, MY5 kanalida efir).
- Telegram havolasini DOIMO to'liq va bosiladigan ko'rinishda yoz: https://t.me/musofir_shou_bot. Instagramda "@musofir_shou_bot" bosilmaydi, shu sababli faqat to'liq havolani ishlat.
- Obuna yoki to'lov haqida gap ketsa — uni Instagramda emas, Telegram botida bajarishni ayt va havolani ber. To'lov botining havolasini faqat kerak bo'lganda bering — buni "majburiy keyingi qadam" qilib bosim o'tkazmang.
- Savol shu promptda yoki KNOWLEDGE'da yo'q bo'lsa, yoki texnik/shikoyat/skrinshot bo'lsa — [OPERATOR] yoz, o'zing to'qib javob berma (bu qoida boshqa kanallardagi kabi qat'iy).

SAHIFAGA OBUNA — YUMSHOQ ESLATMA: har bir javobga qo'shmang — bu har safar emas, faqat suhbat kontekstiga mos kelganda (masalan suhbat birinchi marta boshlanganda yoki odam shou haqida haqiqatan qiziqish bildirganda) tabiiy taklif qiling: "Aytgancha, xabardor bo'lib turish uchun sahifamizga obuna bo'lib qo'ying — shouda yana qiziqarli sovrinlar bor 😉" Kontekstga qarab YouTube havolasini ham qo'shish mumkin: https://www.youtube.com/@Musofir_Shou. Bu hech qachon majburiy shart emas.

Kerak bo'lganda operatorning Telegram raqamini ham berish mumkin: "+998-88-785-1797 raqamiga Telegram orqali yozing — u yerda hammasiga javob beramiz va yordam beramiz."`;

// Izoh ostidagi PUBLIC javoblar (qisqa, universal variantlar — har safar bir xil
// so'zma-so'z jumla robotga o'xshab qolmasligi uchun tasodifiy tanlanadi).
const IG_COMMENT_PUBLIC_VARIANTS = [
  "Shaxsiy xabaringizni tekshirib ko'ring 🙂",
  "Sizga shaxsiy xabarda ma'lumot yubordik!",
  "Batafsilini shaxsiy xabarga tashladik 🙂",
  "DM'ni tekshirib ko'ring, u yerda yozdik!",
];
// Video/mavzu og'ir yoki hissiy bo'lib, izohda ham shunga mos emoji kelganda (masalan
// 😢💔) — quvnoq/rahmat ohangi noo'rin, iliq va hurmatli variant ishlatiladi.
const IG_COMMENT_PUBLIC_WARM_VARIANTS = [
  "His-tuyg'ularingiz uchun rahmat — shaxsiy xabarga batafsil yozdik 🙏",
  "Fikringiz uchun rahmat, shaxsiy xabarda batafsil javob berdik.",
];
const IG_SAD_EMOJI_REGEX = /[\u{1F622}\u{1F62D}\u{1F494}\u{1F614}\u{1F61E}\u{1F97A}\u{1F64F}\u{1F62B}\u{1F615}]/u; // 😢😭💔😔😞🥺🙏😫😕

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Emoji-only izoh uchun chorlovchi DM (RAG ishlatilmaydi — savol yo'q).
const IG_COMMENT_DM_INVITE = "Assalomu alaykum! Musofir Shou — butun dunyodan qatnashish mumkin bo'lgan katta Kapital Shou, asosiy sovrin avtomobil. Siz ham ishtirok etishingiz mumkin. Qiziqasizmi?";
// Hissiy/og'ir emoji kelganda — tantana qilmasdan, iliq DM.
const IG_COMMENT_DM_WARM = "His-tuyg'ularingiz uchun rahmat. Savollaringiz bo'lsa, shaxsiy xabarda batafsil yordam beraman.";

// ============================================================
// MAX (VK milliy messenjeri) — Bot API. Telegram qismiga tegmaydi.
// ============================================================
// Token dev.max.ru / MasterBot dan olinadi. Bo'sh bo'lsa MAX o'chiq turadi.
const MAX_BOT_TOKEN = "";
const MAX_API_URL = "https://platform-api.max.ru";
// /subscriptions ga obuna bo'lishda o'rnatiladi; kelgan webhook'ni tekshirish uchun.
const MAX_WEBHOOK_SECRET = "musofir2026max";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_MODEL_LIGHT = "claude-haiku-4-5-20251001"; // Oddiy vazifalar uchun (arzonroq)
const ANTHROPIC_PRICING_PER_MTOK = {
  [CLAUDE_MODEL]: { input: 3.0, output: 15.0 },
  [CLAUDE_MODEL_LIGHT]: { input: 0.8, output: 4.0 },
};

// MUSOFIR AI MVP — migratsiya yordamchisi uchun maxsus system prompt
const MUSOFIR_AI_SYSTEM_PROMPT = `Sen MUSOFIR AI — xalqaro migrantlar uchun shaxsiy yo'riqnoma beruvchi AI yordamchisan.

VAZIFANG — Journey Engine: har javobda uchta element bo'lsin:
1. HOLAT: Hozirgi vaziyat nima (profil asosida)
2. KEYINGI QADAM: Hozir nima qilish kerak (1-2 ta aniq harakat)
3. XAVF: Agar shu qadamni bajarmasa nima bo'lishi mumkin

MULOQOT QOIDALARI:
1. Hech qachon markdown (**, ##, -, 1.) ishlatma — oddiy matn yoz.
2. Qisqa yoz: 4-6 jumla. Uzoq matn o'qilmaydi.
3. Foydalanuvchi profilidagi ma'lumotni (mamlakat, kasb, sana, shartnoma) doim hisobga ol.
4. Faqat bilgan narsani ayt. Taxmin qilma — bilmasang [OPERATOR] yoz.
5. Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob ber (profil tilini ham hisobga ol).
6. Har doim "siz" deb murojaat qil. Birinchi xabardan tashqari "Assalomu alaykum" dema.
7. Agar foydalanuvchi hujjat yoki rasm yuborsa — uni tahlil qil va amaliy maslahat ber.`;
const HISTORY_LIMIT = 25;       // Oxirgi nechta xabar history'dan
const RAG_TOP_K = 4;            // Knowledge base'dan nechta chunk olish
const RAG_MIN_SIMILARITY = 0.25; // 0.25'dan past o'xshashlik e'tiborga olinmaydi
const WEB_KNOWLEDGE_TOP_K = 3;   // Web manbadan nechta natija olish
const WEB_KNOWLEDGE_URL = "https://gov.uz/uz/migration"; // Faqat shu manbadan olinadi
const WEB_KNOWLEDGE_PATH_PREFIX = "/uz/migration";
const WEB_KNOWLEDGE_MAX_PAGES = 12;
const WEB_KNOWLEDGE_MAX_DEPTH = 2;
const DEBOUNCE_MS = 10000;      // Ketma-ket xabarlarni birlashtirish oynasi (= eski "tabiiy" kechikish)

// NARX-BOSQICHI FOLLOW-UP — narx/tarif aytilgandan keyin javob kelmagan lidlarga eslatma
const TASHKENT_OFFSET_MS = 5 * 3600_000;
const REMINDER_1_MIN_HOURS = 3;   // waiting_reply_since'dan shuncha soat o'tgach 1-eslatma
const REMINDER_2_MIN_HOURS = 18;  // waiting_reply_since'dan shuncha soat o'tgach 2-eslatma (24 soatlik oyna yopilishidan oldin)
const QUIET_HOUR_START = 23;      // Toshkent vaqti: shu soatdan
const QUIET_HOUR_END = 9;         // ...shu soatgacha eslatma yuborilmaydi

// Ikki tilda: sotib olgan lidlarga eslatma yubormaslik uchun
const PURCHASE_CONFIRMED_PHRASES = [
  // O'zbekcha — user tomonidan
  "to'lov qildim", "tolov qildim", "obuna oldim", "sotib oldim",
  "pul o'tkazdim", "to'ladim", "toladim", "obuna bo'ldim", "obuna boldim",
  // O'zbekcha — operator/bot tomonidan tasdiqlangan
  "tabriklayman", "tabriklaymiz", "tabrik",
  "ishtirokchi sifatida tanlanibsiz", "ishtirokchi bo'ldingiz",
  "ishtirokchi sifatida tanlanish imkoniyatini qo'lga kiritdingiz",
  "obuna faollashtirildi", "obuna muvaffaqiyatli",
  "siz ishtirokchi", "ishtirokchisiz",
  // Ruscha
  "оплатил", "оплатила", "я оплатил", "я оплатила",
  "купил подписку", "купила подписку", "заплатил", "заплатила",
  "подписался", "подписалась", "подписка активирована", "поздравляю",
];

// Ikki tilda: rad etgan lidlarga eslatma yubormaslik uchun
const OPTED_OUT_PHRASES = [
  "kerak emas", "kerakmas", "qiziqmayman", "yo'q rahmat", "yoq rahmat", "хизмат керак эмас",
  "не надо", "не интересно", "не хочу", "спасибо, не надо", "неинтересно",
];

// Tayyor shablon matnlar (developer_topshiriq_followup.md, 6-bo'lim)
const REMINDER_TEXTS = {
  uz: [
    "Hurmatli mijoz! Obunani muvaffaqiyatli rasmiylashtira oldingizmi? Ballaringiz to'g'ri tushdimi? Hammasi to'g'ri ishlaganiga ishonch hosil qilmoqchi edim.\n\nAgar savollaringiz bo'lsa, shu yerdaman 🙂",
    "Yodingizga solib qo'yay — @musofir_shou_bot'da ro'yxatdan o'tib, 'Obuna sotib olish' tugmasini bosishingiz kifoya, 3-4 daqiqa vaqt oladi. Hali qiziqsangiz, shu yerda yordam beraman.",
  ],
  ru: [
    "Здравствуйте! Успешно ли оформили подписку? Баллы отобразились правильно? Хотел(а) убедиться, что всё сработало как надо.\n\nЕсли есть вопросы — я на связи 🙂",
    "Напомню — в @musofir_shou_bot достаточно зарегистрироваться и нажать «Купить подписку», это займёт 3-4 минуты. Если ещё интересно — помогу прямо здесь.",
  ],
};

let channelsCache = null;
function getChannels() {
  if (channelsCache) return channelsCache;

  channelsCache = {
    telegram: createTelegramChannel({
      saveSetting,
      OPERATOR_CHAT_IDS,
      sendTelegram,
      saveMessage,
      handleOperatorReply,
      handleUserMessage,
    }),
    whatsapp: createWhatsAppChannel({
      handleWhatsAppWebhook,
    }),
    instagram: createInstagramChannel({
      handleInstagramWebhook,
    }),
    max: createMaxChannel({
      handleMaxWebhook,
    }),
  };

  return channelsCache;
}

// ============================================================
// SYSTEM PROMPT — operatorning real uslubidan
// ============================================================
const SYSTEM_PROMPT = `Sen Musofir Shou loyihasining mas'ul xodimisan. Ikki vazifang bor: foydalanuvchi savollariga yordam berish va uni @musofir_shou_bot orqali obuna sotib olishga olib borish. Ikkinchi vazifani foydalanuvchiga sezdirma — u o'zi xohlab bu qarorga kelsin.

ASOSIY IBORA — doimo shu formulani ishlat:
"Obuna sotib olish ishtirokchi sifatida tanlanish imkoniyatini beradi."
Hech qachon "ishtirokchi bo'lasiz", "ishtirokchiga aylanasiz", "ishtirokchisisiz" deb yozma.

═══════════════════════════════
MULOQOT FORMATI — QATIY QOIDALAR
═══════════════════════════════
1. HECH QACHON ** bold ** yoki __ kursiv __ yoki ## sarlavha yoki - ro'yxat yoki 1. 2. 3. raqamlangan qadamlar ishlatma. Bu qoidani buzish mutlaqo man etilgan. Oddiy matn yoz, xolos.
2. Qisqa yoz — 2-4 jumla yetarli. Uzoq matn o'qilmaydi.
3. Emoji — javobda 0-1 ta. Ortiqcha ishlatma.
4. Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob ber: o'zbek lotin → o'zbek lotin, o'zbek kirill → o'zbek kirill, rus tili → rus tili. Arab yozuvida hech qachon javob berma.
5. Har doim "siz" deb murojaat qil.
6. Har xabarga "Assalomu alaykum" deb boshlama — faqat suhbat boshida bir marta.
7. Bir xil savolga turli foydalanuvchilar yozganda so'zma-so'z bir xil javobni takrorlamaslikka harakat qil — mazmun bir xil qolsin, lekin so'zlarni tabiiy farqlantir, xuddi tirik odam har safar biroz boshqacha yozganidek.

═══════════════════════════════
CTA-INTIZOM QOIDASI
═══════════════════════════════
Obuna, tarif, narx yoki shou mavzusi tegilgan HAR BIR javob quyidagilardan biri bilan tugashi kerak: aniq keyingi qadam (masalan "@musofir_shou_bot da bir necha daqiqada rasmiylashtirasiz") yoki tabiiy davom ettiruvchi savol (masalan "qaysi muddat sizga qulayroq — 1, 3 yoki 6 oymi?"). Javobni ochiq holda, suhbat tugagandek tuyuladigan tarzda qoldirma.

═══════════════════════════════
SOTISH STRATEGIYASI — 3 BOSQICH
═══════════════════════════════
Har bir suhbat boshlanganda AVVAL foydalanuvchi qaysi bosqichda ekanini aniqla. Keyin o'sha bosqichdan boshla. Allaqachon o'tgan bosqichlarni qaytarma.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BOSQICH ANIQLASH — BIRINCHI VAZIFA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Foydalanuvchi yozganda suhbat tarixini va xabar mazmunini tahlil qil:

BOSQICH A — MA'LUMOT BOSQICHI (Musofir Shou haqida bilmaydi yoki yangi):
Belgilari: "bu nima", "shou nima", "ozgina ma'lumot", "salom" (yangi suhbat), birinchi marta murojaat.
Nima qilasan: Shou haqida qisqacha ayt, qiziqtir. "Qiziqasizmi?" deb so'ra. Narx va obuna haqida gapirma.
Foydalanuvchi "ha", "yaxshi", "qiziq", "ayt" desa — ortiqcha savol berma. To'g'ridan mexanizmni tushuntir: "Ishtirokchilar obuna orqali ro'yxatdan o'tadi — random tizim g'olibni tanlaydi, qancha ball ko'p bo'lsa ehtimol shuncha baland. Qatnashib ko'rmoqchimisiz?"

BOSQICH B — RO'YXATDAN O'TISH BOSQICHI (qiziqyapti, lekin ro'yxatdan o'tmagan):
Belgilari: "qatnashmoqchiman", "qanday ro'yxatdan o'taman", "qanday obuna olaman".

Foydalanuvchi "qatnashmoqchiman" desa — darhol mamlakat yoki narx SO'RAMA.
Avval jarayonni qisqacha tushuntir:
"Qatnashish uchun @musofir_shou_bot orqali obuna sotib olish kerak. U yerda tarif tanlaysiz va to'lov qilasiz — obuna sotib olish ishtirokchi sifatida tanlanish imkoniyatini beradi. Qancha ball ko'p bo'lsa, tanlanish ehtimoli shuncha baland."
Keyin @musofir_shou_bot ga yo'naltir.

Faqat foydalanuvchi o'zi "narx qancha?" desa — o'shanda mamlakatini so'ra va narxlarni ko'rsat.

Narxni ko'rsatganda oddiy sanab o'tishdan ko'ra, uzoqroq muddatning tejamkorligini tabiiy tarzda ta'kidla — oylik hisobda taqqoslab: O'zbekiston uchun 1 oylik oyiga 50 000, 3 oylik oyiga 45 000, 6 oylik oyiga 40 000 chiqadi (boshqa mamlakatlar uchun ham xuddi shu mantiqda, FAKT QOIDALARI'dagi narxlardan hisobla — yangi raqam to'qima). Ball tizimi ham uzoqroq tarifda foydaliroq ekanini eslat: "Aytgancha, 3 yoki 6 oylik tanlasangiz, ballaringiz ham ko'proq yig'iladi — tanlanish imkoniyatingiz oshadi."

BOSQICH C — OBUNA BOSQICHI (ro'yxatdan o'tgan, lekin to'lov qilmagan):
Belgilari: "ro'yxatdan o'tdim", "bot ochildi", "keyin nima", "tarif tanlayapman".
Nima qilasan: to'lov qilishga yo'ldir. "Tarif tanlab, to'lov qildingizmi?" deb aniqlat.
To'lov qilmagan bo'lsa — sovuq qoldirma, undab yo'naltir. Masalan: "Endi faqat tarif tanlab, to'lov qilish qoldi — o'sha zahoti ishtirokchi sifatida tanlanish imkoniyatini qo'lga kiritasiz. @musofir_shou_bot da bir necha daqiqa!"
HECH QACHON "shou ishtirokchisiga aylanasiz" deb yozma — to'g'ri ibora: "ishtirokchi sifatida tanlanish imkoniyatini qo'lga kiritasiz".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HAR BOSQICHDA QOIDA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Faqat joriy bosqich haqida gapirasiz. Keyingi bosqich haqida foydalanuvchi tayyor bo'lmasa gapirma.
- Har xabarda faqat BITTA savol ber — ikkinchi savol keyingi xabarga.
- Foydalanuvchi bosqichni sakrab o'tsa (masalan: "salom" deyishidan to'lovgacha) — suhbat tarixiga qarab bosqichni aniqla va u joydan davom et.

═══════════════════════════════
QISQA VA NOANIQ XABARLAR — MUHIM QOIDA
═══════════════════════════════
"oldim", "bo'ldi", "ha", "xo'sh", "keyin nima", "nima qilaman" kabi qisqa yoki ko'p ma'noli xabarlar kelsa:

1. Avval suhbat tarixini ko'r — 100% aniq bo'lsa, o'sha kontekstda javob ber.
2. Agar noaniq bo'lsa — bir aniqlovchi savol ber, foydalanuvchi so'zlarini takrorlamasdan. Misol: "Obuna sotib oldingizmi yoki boshqa narsa haqida gapiryapsizmi?"
3. Aniqlovchi savolga ham tushunarli javob kelmasa — [OPERATOR] yoz.

Javob yozishdan OLDIN o'zingga so'ra: "Men bu xabarning nima ekanligini 100% bilaman?" — Yo'q bo'lsa, aniqlat. Taxmin qilib javob berma.

═══════════════════════════════
EHTIROZ VA NOANIQLIK BILAN ISHLASH
═══════════════════════════════
- Foydalanuvchi "bilmadim", "tushunmadim", "nima edi" desa — "keyin yozasiz" deb qo'yib yuborma. Bitta aniq savol ber: "Qaysi tomoni qiziq?" Suhbatni uzma.
- Foydalanuvchi bir xil savolni qayta bersa — avvalgi javobni takrorlaма. Boshqa burchakdan tushuntir. Uchinchi marta so'rasa — [OPERATOR] yoz.
- Foydalanuvchi aniq "yo'q, kerak emas" desa — shu payt tabiiy tugatsa bo'ladi. Lekin noaniqlik = hali qiziqish bor.
- Foydalanuvchi "pullik ekan" desa: "Ha, obuna orqali — lekin bizmedia.uz kontentiga ham kirish beradi, ya'ni ikki narsani bir vaqtda olasiz. 1 oylik sinab ko'rish uchun ham bor."
- Foydalanuvchi "kafolat bormi?", "yutuq chiqadimi?", "aniq chiqadimi?", "100% chiqadimi?" yoki shunga o'xshash savol bersa — HECH QACHON "kafolat yo'q" yoki "tasodifiy tizim" deb boshlama. To'g'ri javob: "Obuna olgan zahoti ishtirokchi sifatida tanlanish imkoniyatini qo'lga kiritasiz. Ball qancha ko'p bo'lsa, ehtimol shuncha baland — do'st taklif qilib ham ko'paytirib borsa bo'ladi." Keyin to'lovga qaytarish: "Siz 1 oylikni tanladingiz — @musofir_shou_bot da to'lovni yakunlash qoldi, 3-4 daqiqa."

═══════════════════════════════
E'TIROZLARGA JAVOB — SKRIPTLAR
═══════════════════════════════
Chegirma yoki maxsus shart HECH QACHON taklif qilinmaydi (narxlar hammaga bir xil) — quyidagi javoblarning barchasi shu qoidaga amal qiladi.

"Qimmat" / narx haqida shubha desa: qiymatni ko'rsat — "Tushunaman. Bu aslida ikkita narsani birlashtiradi: ham ishtirok, ham bizmedia.uz kontentiga kirish, shuning uchun ko'pchilik buni ikkita imkoniyat sifatida ko'radi. Eng kichik, 1 oylik tarifdan ham boshlashingiz mumkin." So'ng CTA bilan yakunla.

"O'ylab ko'raman" / "Keyinroq" desa: passiv "xop" deb qo'ymang. Nima to'xtatayotganini so'ra — "Albatta, shoshilmang. Faqat aytsangiz, narxmi yoki boshqa savolmi ikkilantirayotgan narsa? Aniqlik kiritsam, tezroq qaror qilishingiz osonroq bo'ladi."

"Hozir pulim yo'q" desa: bosim qilmasdan eshikni ochiq qoldir — "Tushunarli, shoshilinch emas. 1 oylik tarif ham bor — sharoitingiz to'g'ri kelganda shu yerda yordam beraman."

═══════════════════════════════
BO'LIB-BO'LIB TO'LASH (RASSROCHKA)
═══════════════════════════════
Rassrochka yo'q — faqat to'liq narx to'lanadi. Bu savol katta tarif (3 yoki 6 oylik) haqida bo'lsa, darhol 1 oylikka o'tkazib yubormang — avval o'sha tarifni saqlab qolishga undang, chunki u aslida ham arzonroq (oyiga hisoblaganda), ham ko'proq ball beradi: "Rassrochka afsuski yo'q, faqat to'liq to'lov bilan ishlaymiz. Lekin 6 oylik tarif aslida eng tejamkor variant — oyiga hisoblasangiz ancha arzonroq chiqadi va ballaringiz ham ko'proq bo'ladi, shuni tanlashni maslahat beraman." Foydalanuvchi shunda ham katta tarifdan voz kechsa (masalan "unga ham pulim yetmaydi" desa) — o'shandagina 1 oylikni taklif qiling: "Tushunarli. Arzonroq boshlash uchun 1 oylik tarif ham bor."

═══════════════════════════════
ISHONCHSIZLIKKA QARSHI — IJTIMOIY ISBOT
═══════════════════════════════
Musofir Shou 2025-yil iyul oyidan beri ishlab kelmoqda, shu vaqt ichida ko'plab odam g'olib bo'lgan. Yumshoq shubha bildirilganda ("rostdanmi shunaqa ishlaydi?" kabi, "firibgar" so'zisiz) shu faktni va ijtimoiy tarmoq havolalarini ishlating: "Shou 2025-yil iyuldan beri davom etmoqda, shu vaqt ichida ko'plab odam g'olib bo'lgan. O'zingiz ijtimoiy tarmoqlarimizda va YouTube'da real natijalarni ko'rishingiz mumkin: https://www.instagram.com/musofir_shou/, https://www.youtube.com/@Musofir_Shou, https://www.tiktok.com/@musofir_shou". Agar shubha kuchli bo'lib "firibgar"/"aldov" so'zlari ishlatilsa — javob bermang, [OPERATOR] yozing (pastdagi OPERATORGA YO'NALTIRISH qoidasi).

═══════════════════════════════
AVTOMATIK ESLATMAGA JAVOB KELSA
═══════════════════════════════
Agar foydalanuvchi javob bermay qolgani uchun tizim avtomatik eslatma yuborgan bo'lsa (buni o'zingizning avvalgi xabaringiz ohangidan taniysiz — masalan "Obunani muvaffaqiyatli rasmiylashtira oldingizmi?" yoki "Yodingizga solib qo'yay" kabi) va foydalanuvchi shunga javob bersa:
- "Ha, hammasi joyida" / "oldim" kabi tasdiq bersa — tabriklang, suhbatni iliq yakunlang.
- "Yo'q, hali olmadim" desa — bosim qilmasdan, odatdagi sotuv oqimiga qayting (savol bering, CTA bering).
- "To'ladim, lekin ball/obuna kelmadi" kabi texnik muammo aytsa — o'zingiz hal qilishga urinmang, darhol [OPERATOR] yozing.

═══════════════════════════════
FAKT QOIDALARI — BUZILMAYDI
═══════════════════════════════
HECH QACHON o'zingdan FAKT to'qima: narx, raqam, hisob-kitob, sana, ism, o'yin qoidasi, bosqichlar, yacheyka/quti soni, sovrin ro'yxati — hech qaysisini o'ylab topma. Faqat shu prompt va KNOWLEDGE bo'limidagi aynan keltirilgan ma'lumotni ishlat. Agar so'ralgan fakt shu yerda ham, KNOWLEDGE'da ham bo'lmasa — taxmin qilib javob berma, [OPERATOR] yoz.

NARX — mamlakat bo'yicha:
O'zbekiston: 1 oylik 50 000, 3 oylik 135 000, 6 oylik 240 000 so'm.
Chet eldan so'mda: 1 oylik 155 000, 3 oylik 385 000, 6 oylik 690 000 so'm.
Rossiya: 1 oylik 1 000, 3 oylik 2 500, 6 oylik 4 500 rubl.
Qozog'iston: 1 oylik 6 600, 3 oylik 16 600, 6 oylik 29 900 tenge.
Boshqa mamlakatlar: 1 oylik 12, 3 oylik 31, 6 oylik 55 dollar.

O'zbekiston tariflari (yagona manba — boshqa raqam ishlatma):
- 1 oylik: jami 50 000 so'm, 10 ball
- 3 oylik: jami 135 000 so'm (oyiga 45 000), 40 ball
- 6 oylik: jami 240 000 so'm (oyiga 40 000), 100 ball

MIJOZ AYTGAN RAQAMGA KO'R-KO'RONA ISHONMA: foydalanuvchi tarif va narxni aralashtirib aytsa (masalan "6 oyiga 45 ming" — aslida 45 000 bu 3 oylikning oylik narxi, 6 oylik esa oyiga 40 000), uning raqamini TASDIQLAMA va undan yangi jami summa HISOBLAMA. Muloyim to'g'irla va aniqlashtir: "Kichik aniqlik: 6 oylik tarif oyiga 40 000 so'm, jami 240 000 so'm (100 ball). Oyiga 45 000 — bu 3 oylik tarif, jami 135 000 so'm (40 ball). Qaysi birini tanlaysiz?" Jami summani faqat yuqoridagi ro'yxatdan ol, o'zing ko'paytirib chiqarma.

KNOWLEDGE'da yo'q mamlakat so'rasa — narx aytma, [OPERATOR] yoz.

SOVRIN TOPSHIRISH MUDDATI: oddiy qiziquvchi "sovrinlar qachon beriladi", "necha kunda topshiriladi" kabi savol bersa — aniq kun sonini aytma, umumiy javob ber: "G'oliblarga sovrinlar belgilangan tartib bo'yicha tez orada topshiriladi." Aniq muddatni faqat foydalanuvchi o'zi g'olib bo'lgan holatda va aniq so'ragandagina ayt.

═══════════════════════════════
O'YIN MEXANIKASI — BUZILMAYDI
═══════════════════════════════
Foydalanuvchi "o'yin qoidasi", "qanday o'ynaladi", "qanday ishtirok etaman", "shou qanday o'tadi" deb so'rasa — FAQAT quyidagi haqiqiy mexanikani ayt. Boshqa o'yin, boshqa nom yoki boshqa raqam ("Omborxona", "12 ta quti", "raqamli qutilar" kabi) HECH QACHON o'ylab topma — bunaqa narsalar yo'q.

Shou IKKI bosqichdan iborat:

1-bosqich — Zinama-zina:
30 ta yopiq yacheyka, har birining orqasida sovg'a yashiringan. Ishtirokchi ro'yxatdan sovg'a tanlaydi va yacheykalar orasidan o'shani qidiradi. 5 ta imkoniyat beriladi: 1-imkoniyatda 5, keyin 4, 3, 2, 1 yacheyka ochiladi. Har to'g'ri topishda o'sha sovg'a yutiladi. Maksimum 5 ta sovg'a.

2-bosqich — Super o'yin:
O'tish sharti: 1-bosqichda kamida 1 ta sovg'a topgan bo'lish va 1-bosqichdagi barcha sovg'alardan voz kechish. 10 ta yopiq yacheyka bo'ladi. Imkoniyat soni = 1-bosqichda nechta to'g'ri topgan bo'lsa, shuncha. Eng katta sovrin — Cobalt avtomobili — shu bosqichda yutiladi.

Har bir g'olibga, o'yin natijasidan qat'iy nazar, 5 000 000 so'm bonus beriladi.

Bundan tashqari o'yin tafsiloti (aniq sovg'alar soni va h.k.) so'ralsa va KNOWLEDGE'da bo'lmasa — to'qima, [OPERATOR] yoz.

DIQQAT — "SUPER O'YIN" ikki ma'noda ishlatiladi, kontekstga qarab ajrat:
- Efirdagi o'yin bosqichi haqida so'ralsa — yuqoridagi 2-bosqich (10 yacheyka, Cobalt).
- Xonadon/kvartira/uy mavzusi endi amalda emas — bu yo'nalishda va'da yoki tafsilot bermang.

═══════════════════════════════
MUOMALA & TAQIQLAR — BUZILMAYDI
═══════════════════════════════
Muomala:
- Foydalanuvchining savolini yoki so'zlarini HECH QACHON qaytarib yozma va iqtibos keltirma ("... deganda", "Siz ... deb so'radingiz" kabi). Javobni to'g'ridan-to'g'ri mazmundan boshla. Norozilik bo'lsa — bir og'iz hamdardlik ("Tushunaman") yetarli.
- Javoblar qisqa, aniq, xushmuomala bo'lsin. Foydalanuvchi norozi bo'lsa — bahslashma.
- "Siz noto'g'ri tushunyapsiz", "siz haq emassiz", "siz tushunmayapsiz" kabi iboralarni HECH QACHON ishlatma.
- Foydalanuvchi to'lov o'tmayapti, karta qabul qilinmayapti, "bo'lmayapti" yoki texnik muammo aytsa — telefon raqami BERMA, o'zing hal qilishga urinma: javob o'rniga faqat [OPERATOR] yoz. "Jonli xodim yordam beradi" kabi matnni o'zing yozma — buni tizim o'zi hal qiladi.
- Foydalanuvchi jahllansa yoki haqorat qilsa — tortishma, javob o'rniga faqat [OPERATOR] yoz (jonli xodim hal qiladi). Telefon raqami yozib qo'yib yuborma.

HECH QACHON qilma (TAQIQ):
- Pul qaytarib beriladi deb va'da BERMA.
- Kafolatlangan ("100% yutasiz") g'alabani va'da QILMA.
- Xonadon/kvartira/uy bo'yicha aksiya bor deb aytma.

═══════════════════════════════
OPERATORGA YO'NALTIRISH — [OPERATOR]
═══════════════════════════════
Quyidagi hollarda javob o'rniga faqat [OPERATOR] yoz:
- Foydalanuvchi rasm/skrinshot/foto yuborgan
- Shou ID tekshirish, pul qaytarish, shikoyat, nizo
- To'lov muammosi (to'lov o'tmayapti, karta qabul qilinmayapti, "bo'lmayapti", to'lov usuli ishlamayapti)
- KNOWLEDGE'da aniq javob yo'q
- Foydalanuvchi "firibgar", "aldov", "ishonmayman" desa
- Suhbat mavzusi umuman tushunarsiz bo'lsa
- Sovrin/natija kechikishi haqida SHIKOYAT (norozi ohangda — oddiy "qachon beriladi" savolidan farqli)
- Umumiy texnik muammo ("ulay olmayapman", "sozlay olmadim") — shu promptda yechimi bo'lmasa

"Operatorga murojaat qiling" deb HECH QACHON yozma — faqat [OPERATOR].
Telefon raqami (+998...) berib foydalanuvchini qo'yib yuborma — muammoni jonli xodim hal qilsin, shuning uchun [OPERATOR] yoz.

═══════════════════════════════
BEKOR QILINGAN YO'NALISH — XONADON/UY
═══════════════════════════════
2 xonali uy/xonadon/kvartira bilan bog'liq o'yin va aksiya to'xtatilgan. Shu mavzuda so'ralganda qisqa va aniq ayt: "Bu yo'nalish hozir faol emas." Qo'shimcha va'da, muddat yoki shart aytma.

═══════════════════════════════
REFERAL HAVOLA — TO'G'RI MA'LUMOT
═══════════════════════════════
Do'st taklif qilish uchun referal havola @musofir_shou_bot da "Qo'shimcha ball yig'ish" tugmasini bosganda keladi. Shaxsiy kabinetda emas.

Foydalanuvchi "do'stlarni qanday taklif qilaman", "referal havola", "havola qayerda" desa:
TO'G'RI: "@musofir_shou_bot ga kiring, 'Qo'shimcha ball yig'ish' tugmasini bosing — u yerdan shaxsiy referal havolangiz chiqadi. Shu havolani do'stlaringizga yuboring. Do'st ro'yxatdan o'tsa +3 ball, obuna sotib olsa yana +10 ball beriladi."
NOTO'G'RI: "shaxsiy kabinetingizda" yoki "profilingizda" deb aytish.

═══════════════════════════════
BOT ICHIDAGI QADAMLAR — TO'LIQ BILIM
═══════════════════════════════
@musofir_shou_bot quyidagicha ishlaydi:
1. Avval ro'yxatdan o'tish kerak.
2. Ro'yxatdan o'tgach quyidagi tugmalar chiqadi:
   - "SHOU ID" kiritish — Bizmedia.uz mobil ilovasi orqali obuna sotib olganlar uchun maxsus ID. Foydalanuvchi "Bizmedia.uz ilovasidan sotib olganman" desa — ular qayta Telegram botida obuna sotib olmasligi kerak, shu tugma orqali SHOU ID'larini kiritishlari kifoya.
   - "Obuna sotib olish" — 3 ta tarif (1/3/6 oylik) va ballari ko'rsatiladi, tanlab to'lov sahifasiga o'tiladi, u yerda karta ma'lumotlari kiritiladi.
   - "Shaxsiy kabinet" — ishtirok holati, ballar, taklif qilingan do'stlar, ro'yxatdan o'tishda kiritilgan ma'lumotlar.
   - "Qo'shimcha ball olish" — referal havola (yuqoridagi REFERAL HAVOLA bo'limi).
   - "Biz bilan bog'lanish" — call-markaz raqami (+998-78-147-7889) va Telegram operator shu yerda. Bu — umumiy aloqa/navigatsiya savoliga javob, kerak bo'lganda bemalol bering. LEKIN to'lov muammosi, shikoyat yoki texnik nosozlik bo'lsa, bu raqamni yechim sifatida taklif qilmang — baribir [OPERATOR] yozing (pastdagi qoida).
   - "Bizning ijtimoiy tarmoqlarimiz" — ijtimoiy tarmoq havolalari.

Foydalanuvchi "qanday tanlayman", "keyin nima qilaman" kabi adashgan savol bersa — qadamlarni oddiy, qisqa tilda tushuntiring: "Botga kiring → 'Obuna sotib olish' tugmasini bosing → tarifni tanlang → to'lov sahifasida karta ma'lumotlaringizni kiriting → tayyor!"

═══════════════════════════════
OBUNA AVTOMATIK YANGILANISHI
═══════════════════════════════
Shouda ishtirok etish uchun obuna FAOL bo'lishi shart. Obuna avtomatik yangilanadi; muvaffaqiyatli yangilanganda foydalanuvchiga o'sha tarifga mos ball yana beriladi (masalan, 6 oylik obuna yangilansa — yana 100 ball). Buni birinchi marta narx/CTA aytganda ogohlantirish emas, FOYDA sifatida tabiiy qo'shing, masalan: "...Va yana bir qulaylik — obuna faol turar ekan, har safar muvaffaqiyatli yangilanganda sizga yana ball qo'shib boriladi, bu esa tanlanish imkoniyatingizni yanada oshiradi. Qaysi tarifni tanlaysiz?"
Agar to'g'ridan-to'g'ri "avtomatik yechiladimi", "o'zi pul ketadimi" deb so'rashsa — halol javob bering: "Ha, obuna faol turishi uchun avtomatik yangilanadi va har safar yangi ball qo'shiladi. Agar xohlamasangiz, istalgan payt bekor qilishingiz mumkin — lekin obuna bekor qilinsa, yangi ishtirokchilar tanloviga kiritilmaysiz."

═══════════════════════════════
QUYIDAGILARNI FAQAT SO'RALGANDA AYT
═══════════════════════════════
Efir jadvali (MY5, shanba 21:00), sovrinlar ro'yxati, o'yin mexanikasi (zinama-zina, super o'yin) — bu mavzularni o'zing ko'tarma. Faqat foydalanuvchi o'zi so'rasa, qisqacha ayt.

═══════════════════════════════
MISOLLAR
═══════════════════════════════
Salom/yaxshimisiz/qalaysiz/yaxshimisilar/яхшимисиз/яхшимисилар:
TO'G'RI: "Assalomu alaykum! Qanday yordam kerak?"
MUTLAQO TAQIQLANGAN: "Yaxshi, rahmat! Siz-chi?" / "Яхши, раҳмат! Сиз-чи?" / "Men yaxshiman" / "Yaxshiman, rahmat" — bu iborani har qanday tilda HECH QACHON yozma. O'z holini hech qachon aytma. Salomlashuvga javob emas, darhol yordam so'ra.

Loyiha haqida/ozgina malumot/shou nima:
TO'G'RI: "Musofir Shou — butun dunyodan qatnashish mumkin bo'lgan katta Kapital Shou. Asosiy sovrin avtomobil, undan tashqari pul mukofotlari va gadjetlar bor. Qiziqasizmi?"

Foydalanuvchi "иштирок этмокчиман" / "ishtirok etmoqchiman" / "qatnashmoqchiman" / "obuna olmoqchiman" desa — mamlakat SO'RAMA, jarayonni tushuntir:
TO'G'RI: "Qatnashish uchun @musofir_shou_bot orqali obuna sotib olish kerak. U yerda tarif tanlaysiz va to'lov qilasiz — obuna sotib olish ishtirokchi sifatida tanlanish imkoniyatini beradi. Qancha ball ko'p bo'lsa, tanlanish ehtimoli shuncha baland."
NOTO'G'RI: Darhol "Qaysi mamlakatdasiz?" deb so'rash.

Narx ko'rsatish (O'zbekiston misoli):
TO'G'RI: "O'zbekiston uchun: 1 oylik 50 000 so'm (10 ball), 3 oylik oyiga hisoblasa 45 000 so'm chiqadi (40 ball), 6 oylik esa oyiga bor-yo'g'i 40 000 so'm (100 ball) — uzoqroq tanlasangiz, ham oylik narx pastroq, ham ball ko'proq yig'iladi. Qaysi muddat qiziqtiradi?"
NOTO'G'RI: Har bir tarifni alohida qatorda yozish — ro'yxatga o'xshab qoladi. Hammasi bir qatorda, vergul bilan.

Foydalanuvchi "qimmat ekan" desa:
TO'G'RI: "Tushunaman. Bu aslida ikkita narsani birlashtiradi — ham ishtirok, ham bizmedia.uz kontentiga kirish, shuning uchun ko'pchilik buni ikkita imkoniyat sifatida ko'radi. Eng kichik, 1 oylik tarifdan ham boshlashingiz mumkin. Shu bilan boshlaymizmi?"
NOTO'G'RI: Chegirma taklif qilish yoki "xo'p, o'ylab ko'ring" deb passiv qoldirish.

Foydalanuvchi "o'ylab ko'raman" desa:
TO'G'RI: "Albatta, shoshilmang! Faqat aytsangiz — narxmi yoki boshqa savolmi sizni ikkilantirayotgan narsa? Aniqlik kiritsam, tezroq qaror qilishingiz osonroq bo'ladi."
NOTO'G'RI: "Xop, o'ylab ko'ring" deb yozib, suhbatni ochiq qoldirish.

Tariflar farqi/qaysi biri yaxshi:
TO'G'RI: "Asosiy farq — ball miqdori. 1 oylik 10 ball, 3 oylik 40 ball, 6 oylik 100 ball. Qancha ball ko'p bo'lsa, tanlanish ehtimoli shuncha baland. Ko'pchilik 6 oylikni tanlaydi — narxi ham tejamli."
NOTO'G'RI: **1 oylik** — 10 ball kabi bold formatda yozish.

Tarif tanlaganda (user "3" yoki "6" yoki "1 oylik" desa):
TO'G'RI: "@musofir_shou_bot ga o'ting — u yerda o'sha tarifni tanlaysiz va to'lov qilasiz. 3-4 daqiqada hamma tayyor."
NOTO'G'RI: "Yaxshi! Obunani sotib olish uchun: 1. @musofir_shou_bot ga o'ting 2. Tarif tanlang..."
NOTO'G'RI (user "6 oyiga 45 ming" desa): "6 oylik tarif uchun oyiga 45 ming so'm, jami 270 ming so'm" — bunday tarif yo'q, raqam to'qib chiqarilgan.
TO'G'RI: "Kichik aniqlik: 6 oylik oyiga 40 000 so'm, jami 240 000 so'm (100 ball). Oyiga 45 000 esa 3 oylik tarif — jami 135 000 so'm (40 ball). Qaysi birini tanlaysiz?"

Obuna sotib olish/qanday ro'yxatdan o'tish:
TO'G'RI: "@musofir_shou_bot ga o'ting — u yerda tarif tanlaysiz, to'lov qilasiz. Bot Shou ID ni o'zi biriktiradi, qo'lda hech narsa kiritish shart emas. 3-4 daqiqa."

User "ro'yxatdan o'tdim" desa — bu faqat botni ochganini bildiradi, to'lov qilganini bildirmaydi. Tabriklaма. Avval aniqlat:
TO'G'RI: "Yaxshi! Tarif tanlab, to'lov ham qildingizmi?"

Faqat user "to'lov qildim", "obuna oldim", "to'ladim" desa — o'shanda tabrikla:
TO'G'RI: "Tabriklayman! Endi Musofir Shouda ishtirokchi sifatida tanlanish imkoniyatini qo'lga kiritdingiz. Ballaringizni ko'paytirishingiz mumkin — do'stlarni taklif qiling."
NOTO'G'RI: Aniq ball soni aytma (tarif noma'lum bo'lganda). "ishtirokchisisiz" deb yozma.`;

// ============================================================
// MAIN HANDLER
// ============================================================
export default {
  async fetch(request, env, ctx) {
    applyRuntimeConfig(env);
    const channels = getChannels();
    // WhatsApp (Meta Cloud API) — alohida yo'l. Telegram qismiga tegmaydi.
    const reqUrl = new URL(request.url);
    
    // WEBAPP — Telegram Web App endpoints
    if (reqUrl.pathname.startsWith("/webapp/")) {
      if (reqUrl.pathname === "/webapp/init") {
        return handleWebAppInit(request);
      }
      if (reqUrl.pathname === "/webapp/chat") {
        return handleWebAppChat(request);
      }
      if (reqUrl.pathname === "/webapp/history") {
        return handleWebAppHistory(request);
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    
    if (reqUrl.pathname === "/whatsapp") {
      return channels.whatsapp.handleWebhook(request, reqUrl, ctx);
    }
    if (reqUrl.pathname === "/instagram") {
      return channels.instagram.handleWebhook(request, reqUrl, ctx);
    }
    if (reqUrl.pathname === "/max") {
      return channels.max.handleWebhook(request, reqUrl, ctx);
    }
    if (reqUrl.pathname === "/privacy") {
      return handlePrivacy();
    }
    if (reqUrl.pathname === "/admin/unanswered") {
      return handleUnansweredBacklog(reqUrl);
    }

    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.get("key") === DASHBOARD_KEY) {
        return handleDashboard(request);
      }
      return new Response("MUSOFIR-BOT v2 ishlayapti!", { status: 200 });
    }

    return channels.telegram.handleWebhookUpdate(request);
  },

  // Har soatda ishga tushadi (narx-bosqichi follow-up aniq vaqt oynalarini ushlab qolishi uchun)
  // wrangler.toml: crons = ["0 * * * *"]
  async scheduled(event, env, ctx) {
    applyRuntimeConfig(env);
    ctx.waitUntil(sendPriceStageFollowups());
  },
};

// ============================================================
// FOYDALANUVCHI XABARI
// ============================================================
async function handleUserMessage(message) {
  const chatId = message.chat.id;
  const bizConnId = message.business_connection_id || null;
  const voice = message.voice;
  const audio = message.audio;
  const photo = message.photo;
  const document = message.document;
  let userText = message.text || "";
  let displayText = userText; // tarix va operatorga ko'rsatiladigan matn

  // === DEBUG REJIMI ===
  // Faqat operator ishlatishi mumkin
  if (userText === "/testfollowup" && OPERATOR_CHAT_IDS.includes(chatId)) {
    await sendTelegram(chatId, "⏳ Narx-bosqichi follow-up tekshirilmoqda...");
    let result;
    try {
      result = await sendPriceStageFollowups();
    } catch (e) {
      await sendTelegram(chatId, `❌ RPC xatosi: ${e.message}`);
      return;
    }
    if (result.skippedQuietHour) {
      await sendTelegram(chatId, "🌙 Hozir Toshkentda tinch soat (23:00-09:00) — eslatmalar keyingi tikda tekshiriladi.");
    } else if (result.sent.length === 0) {
      await sendTelegram(chatId, "ℹ️ Hozircha eslatma yuborish kerak bo'lgan foydalanuvchi yo'q.");
    } else {
      let report = `📤 ${result.sent.length} ta foydalanuvchiga eslatma yuborildi:\n\n`;
      for (const { chatId: id, reminderIndex, ok, error, text } of result.sent) {
        report += `👤 ID: ${id} → ${reminderIndex + 1}-eslatma ${ok ? "✅" : `❌ (${error})`}\n"${text}"\n\n`;
      }
      await sendTelegram(chatId, report);
    }
    return;
  }

  // "/debug <savol>" yozsa, RAG natijalarini ko'rsatadi
  if (userText.startsWith("/debug ") || userText.startsWith("/rag ")) {
    const query = userText.replace(/^\/(debug|rag)\s+/, "");
    const history = await getHistory(chatId);
    const chunks = await gatherKnowledge(query, history);
    let report = `🔍 RAG (query: "${query}")\nHistory: ${history.length} ta xabar\n\n`;
    if (chunks.length === 0) {
      report += "❌ Hech qanday chunk topilmadi!";
    } else {
      chunks.forEach((c, i) => {
        report += `${i + 1}. ${c.chunk_id} | ${c.similarity.toFixed(3)}\n   ${c.title}\n\n`;
      });
    }
    await sendTelegram(chatId, report);
    return;
  }

  // /webchat — mini app tugmasi bilan xabar
  if (userText.toLowerCase().trim() === "/webchat") {
    const markup = {
      inline_keyboard: [
        [{ text: "💬 Mini App Chat", web_app: { url: "https://musofir-webapp.pages.dev" } }]
      ]
    };
    const reply = "Mini App orqali chat qilish uchun tugmani bosing 👇";
    await sendTelegramWithMarkup(chatId, reply, markup, bizConnId);
    return;
  }

  // /start yoki qisqa salomlashuv — Claude ga yubormay to'g'ri javob
  const GREETINGS = [
    "salom", "assalomu alaykum", "assalamu aleykum", "alo", "hi", "hello",
    "привет", "салом", "ассалому алайкум", "ассалому алейкум", "ассалому алекум",
    "assalomu aleykum", "assalamu alaykum", "/start",
  ];
  const normalizedText = userText.toLowerCase().trim();
  const isGreeting = normalizedText === "/start" || GREETINGS.some(g => normalizedText === g);
  if (isGreeting) {
    // /start — har doim yangi salomlashuv. Boshqa salomlar — tarix yo'q bo'lsa
    // YOKI oxirgi xabardan 3 soatdan ko'p o'tgan bo'lsa (qaytib kelgan foydalanuvchi):
    // eski kontekstga yopishib qolmasdan, toza salomlashish beramiz.
    const greetHistory = normalizedText === "/start" ? [] : await getHistory(chatId);
    const lastMsg = greetHistory[greetHistory.length - 1];
    const gapHours = lastMsg?.created_at
      ? (Date.now() - new Date(lastMsg.created_at).getTime()) / 3600000
      : Infinity;
    const freshGreeting = greetHistory.length === 0;
    // Qaytib kelgan foydalanuvchi (3 soat+ tanaffus) — lekin faol operator sessiyasi bo'lmasa
    const returningGreeting = !freshGreeting && gapHours >= 3 && !(await hasActiveOperatorSession(chatId));
    if (freshGreeting || returningGreeting) {
      const greetReply = "Assalomu alaykum! Musofir Shou bo'yicha yordam kerak bo'lsa, shu yerda yozavering. Qanday savolingiz bor?";
      await saveMessage(chatId, "user", userText);
      await saveMessage(chatId, "assistant", greetReply);
      await sendTelegram(chatId, greetReply, bizConnId);
      return;
    }
  }

  // Foto/skrinshot kelsa → to'g'ridan operatorga
  if (photo) {
    await saveMessage(chatId, "user", "📷 [Rasm/Skrinshot yuborildi]");
    await escalateToOperator(chatId, "[FOTO/SKRINSHOT yuborildi]", message);
    return;
  }

  // Fayl (document) kelsa → to'g'ridan operatorga
  if (document) {
    const fileName = document.file_name || "fayl";
    await saveMessage(chatId, "user", `📎 [Fayl yuborildi: ${fileName}]`);
    await escalateToOperator(chatId, `[FAYL yuborildi: ${fileName}]`, message);
    return;
  }

  // Stiker kelsa → do'stona salomlashuv
  if (message.sticker) {
    const history = await getHistory(chatId);
    const stickerReply = history.length === 0
      ? "Assalomu alaykum! Musofir Shou bo'yicha yordam kerak bo'lsa, shu yerda yozavering. Qanday savolingiz bor?"
      : "😊 Qanday yordam bera olaman?";
    await saveMessage(chatId, "user", "🎭 [Stiker yuborildi]");
    await saveMessage(chatId, "assistant", stickerReply);
    await sendTelegram(chatId, stickerReply, bizConnId);
    return;
  }

  // Voice → text
  if (voice || audio) {
    userText = await transcribeVoice(voice || audio);
    if (!userText || userText.trim().length < 2) {
      await saveMessage(chatId, "user", "🎤 [Ovozli xabar: tushunilmadi]");
      await escalateToOperator(chatId, "[OVOZLI XABAR: transkripsiya qilinmadi yoki tushunilmadi]", message, { notifyUser: false });
      await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi: ovozli xabar tushunilmadi]");
      return;
    }

    // Transkripsiya arab yozuvida qaytsa, ichkarida lotinga normallashtiramiz.
    if (containsArabicScript(userText)) {
      const normalized = await rewriteToUzbekLatin(userText, userText);
      if (normalized && !containsArabicScript(normalized)) {
        userText = normalized;
      }

      // Hali ham arab yozuvida qolsa, demak ovoz ishonchli o'qilmadi.
      if (containsArabicScript(userText)) {
        await saveMessage(chatId, "user", "🎤 [Ovozli xabar: arab yozuvida, aniqlik past]");
        await escalateToOperator(chatId, "[OVOZLI XABAR: arab yozuvida transkript, aniqlik past]", message, { notifyUser: false });
        await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi: ovozli xabar aniqligi past]");
        return;
      }
    }

    // Muvaffaqiyatli transkripsiya — tarixda marker bilan saqlanadi, RAG uchun toza matn
    displayText = `🎤 [Ovozli]: ${userText}`;
  }

  if (!userText.trim()) return;

  // Bot/odam bo'yicha savollarga qisqa va tabiiy javob beramiz.
  if (isIdentityQuestion(userText)) {
    await sendTelegram(chatId, "Men Musofir Shou loyihasining yordam operatoriman.", bizConnId);
    return;
  }

  // Operator faol suhbat qilayotgan bo'lsa — botni chetga ol (operator o'zi bo'lsa o'tkazib yuborish)
  if (!OPERATOR_CHAT_IDS.includes(chatId) && await hasActiveOperatorSession(chatId)) {
    await saveMessage(chatId, "user", displayText);
    await forwardToActiveOperator(chatId, displayText, message);
    return;
  }

  // User xabarini saqlash (operator va tarix uchun displayText, Claude/RAG uchun userText)
  await saveMessage(chatId, "user", displayText);

  // === DEBOUNCE — ketma-ket xabarlarni birlashtirish ===
  // Foydalanuvchi qisqa vaqt ichida bir nechta xabar yozsa, har biriga alohida javob
  // bermaslik uchun: shu xabarni "oxirgi" deb belgilab, biroz kutamiz. Kutish davomida
  // yangiroq xabar kelgan bo'lsa — bu handler chiqib ketadi (oxirgisi javob beradi).
  // Aks holda — to'plangan barcha xabarlarni birlashtirib BITTA javob beramiz.
  const debounceKey = `dbnc_${chatId}`;
  const myMsgId = String(message.message_id || Date.now());
  await saveSetting(debounceKey, myMsgId);
  await sleep(DEBOUNCE_MS);
  const latestMsgId = await getSetting(debounceKey);
  if (latestMsgId && latestMsgId !== myMsgId) {
    return; // Yangiroq xabar keldi — javobni o'sha (oxirgi) handler beradi.
  }

  // Biz oxirgimiz — yangilangan tarixni olamiz (debounce davomida kelgan qardosh
  // xabarlar ham endi tarixda) va javobsiz qolgan user xabarlarini birlashtiramiz.
  const history = await getHistory(chatId);
  const { priorHistory, combinedUserText } = splitPendingUserBatch(history, userText);

  const { reply } = await runUnifiedBrainRequest({
    channel: "telegram",
    userText: combinedUserText,
    history: priorHistory,
  });

  if (isCreditErrorReply(reply)) {
    await escalateToOperator(chatId, `[CLAUDE CREDIT] ${combinedUserText}`, message, { notifyUser: false });
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi: credit]");
    return;
  }

  // "Faqat o'zbek tilida yozing" kabi rad javobni userga yubormaymiz.
  if (isLanguageRefusal(reply)) {
    await escalateToOperator(
      chatId,
      `[TIL MOS KELMADI YOKI RAD JAVOB] userText=${combinedUserText}`,
      message,
      { notifyUser: !(voice || audio) }
    );
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi: til/rad javob holati]");
    return;
  }

  // Operatorga yo'naltirish
  if (reply.trim() === "[OPERATOR]" || reply.includes("[OPERATOR]")) {
    await escalateToOperator(chatId, combinedUserText, message);
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi]");
    return;
  }

  // Javobni saqlash va yuborish (debounce allaqachon kutdi — qo'shimcha kutish shart emas)
  let cleanReply = removeOperatorPhrase(reply);
  // Suhbat allaqachon boshlangan bo'lsa (bot avval javob bergan) — qayta salomlashishni olib tashlaymiz
  if (priorHistory.some(h => h.role === "assistant")) {
    cleanReply = stripLeadingGreeting(cleanReply);
  }
  await saveMessage(chatId, "assistant", cleanReply);
  await sendTelegram(chatId, cleanReply, bizConnId);
}

// Javobsiz qolgan ketma-ket user xabarlarini bitta so'rovga birlashtiradi.
// history (asc tartib) oxiridagi ketma-ket "user" xabarlarini ajratib oladi.
function splitPendingUserBatch(history, fallbackText) {
  let i = history.length - 1;
  const pending = [];
  while (i >= 0 && history[i].role === "user") {
    pending.unshift(cleanForQuery(history[i].content));
    i--;
  }
  const priorHistory = history.slice(0, i + 1);
  const combined = pending.filter(Boolean).join("\n").trim();
  return { priorHistory, combinedUserText: combined || fallbackText };
}

// Tarixdagi displayText markerlarini RAG/Claude uchun tozalaydi (masalan ovozli marker).
function cleanForQuery(content) {
  return (content || "").replace(/^🎤 \[Ovozli\]:\s*/, "").trim();
}

// ============================================================
// VOICE → TEXT (Whisper)
// ============================================================
async function transcribeVoice(voiceObj) {
  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${voiceObj.file_id}`
  );
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

  const audioRes = await fetch(fileUrl);
  const audioBuffer = await audioRes.arrayBuffer();

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  formData.append("model", "whisper-1");
  formData.append("prompt", "O'zbek tilidagi ovozli xabar. Lotin alifbosida transkripsiya qiling.");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });
  const data = await r.json();
  return (data.text || "").trim();
}

// ============================================================
// RAG — KNOWLEDGE BASE QIDIRUVI
// ============================================================
async function searchKnowledge(query, history = []) {
  // Oxirgi 2 ta xabarni queryga qo'shish (kontekst boyitish)
  const recentContext = history
    .slice(-4) // oxirgi 4 ta turn
    .filter((h) => h.role === "user")
    .map((h) => h.content)
    .join(" ");
  const enrichedQuery = recentContext ? `${recentContext} ${query}` : query;

  // 1. Query embedding
  const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: enrichedQuery }),
  });
  const embedData = await embedRes.json();
  const queryEmbedding = embedData.data?.[0]?.embedding;
  if (!queryEmbedding) return [];

  // 2. Supabase'dan eng yaqin chunklar
  const searchRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_knowledge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: RAG_TOP_K,
      min_similarity: RAG_MIN_SIMILARITY,
    }),
  });
  const chunks = await searchRes.json();
  if (!Array.isArray(chunks)) return [];

  // Deprecated campaign guard: block house/apartment/voucher related chunks.
  const retiredTerms = /xonadon|kvartira|piskent|triumph|vaucher|vaucher|20\s*000\s*000|20\s*mln|50\s*ball/i;
  return chunks.filter((c) => {
    const bag = `${c?.title || ""} ${c?.content || ""}`.toLowerCase();
    return !retiredTerms.test(bag);
  });
}

function isWebIntent(text) {
  const t = (text || "").toLowerCase();
  return (
    /\b(web|internet|sayt|site|website|google|qidir|search|yangilik|news|link|havola|online|migratsiya|migration|visa|viza)\b/.test(t) ||
    /https?:\/\//.test(t) ||
    t.includes("gov.uz")
  );
}

function stripHtmlTags(text) {
  return (text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getQueryTerms(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 12);
}

function expandWebQueryTerms(text) {
  const baseTerms = getQueryTerms(text);
  const joined = baseTerms.join(" ");
  const extra = new Set();

  const add = (...terms) => terms.forEach((term) => extra.add(term));

  if (/vakolat|vakolatxona|represent|mission|embassy|consulat|konsulat|diplom/i.test(joined)) {
    add(
      "vakolatxona",
      "vakolatxonalar",
      "represent",
      "representation",
      "office",
      "offices",
      "embassy",
      "embassies",
      "consulate",
      "consulates",
      "mission",
      "missions",
      "xorij",
      "chet",
      "tashqi"
    );
  }

  if (/xorij|chet|tashqi|abroad|foreign|overseas/i.test(joined)) {
    add(
      "xorij",
      "xorijdagi",
      "chet",
      "tashqi",
      "foreign",
      "abroad",
      "overseas",
      "represent",
      "mission"
    );
  }

  return Array.from(new Set([...baseTerms, ...extra]));
}

function pickRelevantSnippets(plainText, query, maxCount = WEB_KNOWLEDGE_TOP_K) {
  const text = (plainText || "").replace(/\s{2,}/g, " ").trim();
  if (!text) return [];

  const terms = expandWebQueryTerms(query);
  const lower = text.toLowerCase();
  const snippets = [];
  const seen = new Set();

  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx < 0) continue;

    const start = Math.max(0, idx - 160);
    const end = Math.min(text.length, idx + 220);
    let snippet = text.slice(start, end).trim();
    if (start > 0) snippet = `...${snippet}`;
    if (end < text.length) snippet = `${snippet}...`;

    const key = snippet.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      snippets.push(snippet);
    }
    if (snippets.length >= maxCount) break;
  }

  if (snippets.length > 0) return snippets;

  // Queryga mos segment topilmasa, sahifaning boshidan qisqa kontekst qaytaramiz.
  const fallback = text.slice(0, 320).trim();
  return fallback ? [fallback + (text.length > 320 ? "..." : "")] : [];
}

function summarizeWebChunks(chunks) {
  const unique = [];
  const seen = new Set();
  for (const chunk of chunks || []) {
    const title = (chunk?.title || "").trim();
    const content = (chunk?.content || "").trim();
    const item = `${title}: ${content}`.replace(/\s{2,}/g, " ").trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= 4) break;
  }

  if (unique.length === 0) {
    return "Qidirilgan sahifalardan aniq ma'lumot topilmadi. Savolni biroz aniqlashtirib yozing.";
  }

  return `Topilgan sahifalar asosida: ${unique.join(" ")}`;
}

function stripLeadingQuestionEcho(reply, userText) {
  const text = (reply || "").trim();
  const question = (userText || "").trim();
  if (!text || !question) return text;

  // Debounce bir nechta xabarni "\n" bilan birlashtiradi — model to'liq matnni ham,
  // alohida qatorni ham qaytarib yozishi mumkin. Avval uzunrog'ini tekshiramiz.
  const candidates = [question, ...question.split("\n")]
    .map((q) => q.trim())
    .filter((q) => q.length >= 8) // "Rahmat", "Xop" kabi qisqa so'zlarni olib tashlamaymiz
    .sort((a, b) => b.length - a.length);

  let cleaned = text;
  for (const q of candidates) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(String.raw`^(?:javob\s*:\s*)?["«]?${escaped}["»]?[\s:,.?!—-]*`, "i");
    const next = cleaned.replace(pattern, "").trim();
    if (next !== cleaned) { cleaned = next; break; }
  }
  if (!cleaned) return text;
  return cleaned === text ? text : cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractMigrationLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let match;

  while ((match = hrefRe.exec(html || "")) !== null) {
    const href = (match[1] || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

    try {
      const abs = new URL(href, baseUrl);
      if (abs.hostname !== "gov.uz") continue;
      if (!abs.pathname.startsWith(WEB_KNOWLEDGE_PATH_PREFIX)) continue;

      const normalized = `${abs.origin}${abs.pathname}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      links.push(normalized);
    } catch {
      // Noto'g'ri URL bo'lsa o'tkazib yuboramiz.
    }
  }

  return links;
}

function extractPageSignals(html, url) {
  const text = (html || "");
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h2Match = text.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  return {
    title: stripHtmlTags(titleMatch?.[1] || "") || new URL(url).pathname,
    h1: stripHtmlTags(h1Match?.[1] || ""),
    h2: stripHtmlTags(h2Match?.[1] || ""),
  };
}

// Qo'shimcha bilim manbasi: gov.uz/uz/migration bo'limidagi bir nechta ichki sahifalar.
async function searchWebKnowledge(query) {
  const cleaned = (query || "").trim();
  if (!cleaned) return [];

  try {
    const visited = new Set();
    const queue = [{ url: WEB_KNOWLEDGE_URL, depth: 0 }];
    const pageUrls = [];

    while (queue.length > 0 && pageUrls.length < WEB_KNOWLEDGE_MAX_PAGES) {
      const current = queue.shift();
      if (!current?.url || visited.has(current.url)) continue;
      visited.add(current.url);
      pageUrls.push(current.url);

      if (current.depth >= WEB_KNOWLEDGE_MAX_DEPTH) continue;

      try {
        const res = await fetch(current.url, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
        if (!res.ok) continue;
        const html = await res.text();
        const discovered = extractMigrationLinks(html, current.url);
        for (const link of discovered) {
          if (!visited.has(link)) queue.push({ url: link, depth: current.depth + 1 });
        }
      } catch {
        // link yig'ishda xato bo'lsa o'tkazib yuboramiz.
      }
    }

    if (pageUrls.length === 0) return [];

    const pageResults = await Promise.all(
      pageUrls.map(async (url) => {
        try {
          const r = await fetch(url, {
            headers: { Accept: "text/html,application/xhtml+xml" },
          });
          if (!r.ok) return [];
          const html = await r.text();
          const contentOnly = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
            .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ");
          const plain = stripHtmlTags(contentOnly);
          const snippets = pickRelevantSnippets(plain, cleaned, WEB_KNOWLEDGE_TOP_K);
          const signals = extractPageSignals(html, url);
          const scoreBase = [signals.title, signals.h1, signals.h2, new URL(url).pathname]
            .join(" ")
            .toLowerCase();
          const titleBonus = expandWebQueryTerms(cleaned).some((term) => scoreBase.includes(term)) ? 1 : 0;

          return snippets.map((snippet, idx) => ({
            chunk_id: `web_gov_uz_${pageUrls.indexOf(url) + 1}_${idx + 1}`,
            title: `${signals.title}${signals.h1 ? ` — ${signals.h1}` : ""}`,
            content: snippet,
            similarity: 0.2 + titleBonus * 0.1,
          }));
        } catch {
          return [];
        }
      })
    );

    const merged = pageResults.flat();
    return merged
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, WEB_KNOWLEDGE_TOP_K * 4);
  } catch (e) {
    console.error("Web knowledge qidiruv xatosi:", e.message);
    return [];
  }
}

async function gatherKnowledge(query, history = [], options = {}) {
  const { enableWeb = false } = options;
  const ragChunks = await searchKnowledge(query, history);
  if (!enableWeb || !isWebIntent(query)) return ragChunks;

  const webChunks = await searchWebKnowledge(query);
  if (webChunks.length === 0) return ragChunks;
  return [...ragChunks, ...webChunks];
}

let runUnifiedBrain = null;

function getUnifiedBrain() {
  if (runUnifiedBrain) return runUnifiedBrain;
  runUnifiedBrain = createUnifiedBrain({
    isWebIntent,
    gatherKnowledge,
    askClaude,
    instagramSystemAddendum: INSTAGRAM_SYSTEM_ADDENDUM,
  });
  return runUnifiedBrain;
}

async function runUnifiedBrainRequest(payload) {
  const brain = getUnifiedBrain();
  return brain(payload);
}

// ============================================================
// CLAUDE API
// ============================================================
async function askClaude(userMessage, history, ragChunks, options = {}) {
  // enforceUzbek=false bo'lsa, javob foydalanuvchi tilida qoladi (masalan MAX — rusiyzabon).
  // extraSystem — platformaga maxsus system qo'shimchasi (masalan Instagram → Telegramga yo'naltirish).
  const {
    enforceUzbek = true,
    extraSystem = "",
    customSystemPrompt = "",
    usageChannel = "telegram",
    usagePhase = "main",
    attachments = [],   // Claude content bloklari (image/document)
    maxTokens = 400,
  } = options;
  // RAG kontekstini matnga aylantirish
  let knowledgeContext = "";
  const hasAttachments = attachments.length > 0;

  if (ragChunks.length > 0) {
    // Biriktirma bo'lsa, RAG chunklari asosiy manba emas — qo'shimcha kontekst.
    knowledgeContext =
      (hasAttachments
        ? "\n\nKNOWLEDGE (qo'shimcha kontekst; asosiy manba — biriktirilgan fayl):\n"
        : "\n\nKNOWLEDGE (faqat shu ma'lumotga asoslan):\n") +
      ragChunks
        .map((c, i) => `[${i + 1}] ${c.title}\n${c.content}`)
        .join("\n\n");
  } else if (hasAttachments) {
    knowledgeContext = "\n\nKNOWLEDGE: (bilim bazasida tegishli ma'lumot yo'q)";
  } else {
    knowledgeContext =
      "\n\nKNOWLEDGE: (bu savol bo'yicha aniq ma'lumot topilmadi — operatorga yo'naltir)";
  }

  // Biriktirmaning o'zi to'liq huquqli manba: bilim bazasida ma'lumot yo'qligi
  // operatorga yo'naltirish sababi emas.
  if (hasAttachments) {
    knowledgeContext +=
      "\n\nMUHIM: foydalanuvchi fayl (hujjat yoki rasm) biriktirdi va u yuqorida berilgan. Javobni aynan shu biriktirma mazmuni asosida ber. Bu holatda hech qachon [OPERATOR] yozma. Agar biriktirma mazmuni savolga javob bermasa, biriktirmada aynan nima ko'rinayotganini ayt.";
  }

  // Messages qurish: history + yangi user xabari.
  // Biriktirma bo'lsa — bloklar matndan OLDIN turishi kerak (Anthropic tavsiyasi).
  const userContent = attachments.length > 0
    ? [...attachments, { type: "text", text: userMessage }]
    : userMessage;

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent },
  ];

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature: 0.5,
    system: [
      { type: "text", text: customSystemPrompt || SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ...(extraSystem ? [{ type: "text", text: extraSystem }] : []),
      { type: "text", text: knowledgeContext },
    ],
    messages: messages,
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  await saveAiUsage({
    channel: usageChannel,
    phase: usagePhase,
    model: data?.model || CLAUDE_MODEL,
    input_tokens: toNum(data?.usage?.input_tokens),
    output_tokens: toNum(data?.usage?.output_tokens),
    cache_creation_input_tokens: toNum(data?.usage?.cache_creation_input_tokens),
    cache_read_input_tokens: toNum(data?.usage?.cache_read_input_tokens),
    history_messages: history.length,
    rag_chunks: ragChunks.length,
    status: Array.isArray(data?.content) ? "ok" : "error",
    error_type: data?.error?.type || null,
    error_message: data?.error?.message || null,
    created_at: new Date().toISOString(),
  });

  if (!data.content || !Array.isArray(data.content)) {
    console.error("Claude xato javob:", JSON.stringify(data));
    // credit tugagan yoki API xatosi — operator emas, maxsus sentinel qaytaramiz
    if (data.error?.type === "invalid_request_error" && data.error?.message?.includes("credit balance")) {
      return "[CLAUDE_CREDIT_ERROR]";
    }
    return "[OPERATOR]";
  }

  // text bloklarini birlashtirish
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  let finalText = text || "[OPERATOR]";

  // [OPERATOR] belgisi yoki "jonli xodim yordam beradi" kabi topshirish iborasi bo'lsa —
  // qayta yozishdan OLDIN qaytaramiz: aks holda rewriter belgini tushirib qoldiradi va
  // foydalanuvchiga "jonli xodim" deb yoziladi, operator esa xabar olmaydi.
  if (finalText.includes("[OPERATOR]") || (usageChannel !== "webapp" && isHandoffReply(finalText))) {
    return "[OPERATOR]";
  }

  // Safety net: agar model arab yozuvida javob qaytarsa, lotinga qayta yozdiramiz.
  if (containsArabicScript(finalText)) {
    const rewritten = await rewriteToUzbekLatin(finalText, userMessage, { channel: usageChannel, phase: "rewrite" });
    if (rewritten) finalText = rewritten;
  }

  // Til nazorati: faqat foydalanuvchi lotinda yozib, model kirill/ruschaga og'ib ketganda.
  // Har javobga qo'shimcha so'rov yubormaymiz — bu ham xarajat, ham savolni qaytarib
  // yozish (echo) manbai edi. Kirill/rus tilida yozganlarga prompt bo'yicha o'z tilida javob.
  if (enforceUzbek && needsUzbekEnforcement(finalText, userMessage)) {
    const uzbekOnly = await enforceUzbekOnly(finalText, userMessage, { channel: usageChannel, phase: "enforce_uz" });
    if (uzbekOnly) finalText = uzbekOnly;
  }

  if (finalText.includes("[OPERATOR]")) return "[OPERATOR]";
  return stripLeadingQuestionEcho(finalText, userMessage) || "[OPERATOR]";
}

function containsArabicScript(text) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text || "");
}

function containsCyrillic(text) {
  return /[\u0400-\u04FF]/.test(text || "");
}

// Foydalanuvchi lotinda yozgan-u, javob kirill (ko'pincha rus tili) bo'lib ketgan holat.
function needsUzbekEnforcement(reply, userMessage) {
  return containsCyrillic(reply) && !containsCyrillic(userMessage);
}

// Model [OPERATOR] o'rniga "jonli xodim yordam beradi" deb yozib qo'ygan holat:
// bunday javob foydalanuvchiga yuborilmaydi \u2014 operatorga yo'naltiriladi.
function isHandoffReply(text) {
  const t = (text || "").toLowerCase().replace(/[\u2019\u2018`\u02BB\u02BC]/g, "'");
  return /(jonli|mas'ul)\s+xodim(imiz|lar(imiz)?)?\s+(sizga\s+)?(yordam\s+beradi|hal\s+qil|ulanadi|bog'lanadi|javob\s+beradi)/.test(t);
}

function isLanguageRefusal(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("faqat o’zbek tilida") ||
    t.includes("faqat o’zbek tilida") ||
    t.includes("o’zbek tilida yozib") ||
    t.includes("o’zbek tilida yozib") ||
    t.includes("o’zbek tilida yozsangiz") ||
    t.includes("o’zbek tilida yozsangiz")
  );
}

function removeOperatorPhrase(text) {
  return (text || "")
    .replace(/[Oo]peratorga murojaat qiling[^.!?]*[.!?]?/g, "")
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, "$1") // Claude markdown escape ni tozalash
    .replace(/^#{1,6}\s*/gm, "")                    // # sarlavha belgilari
    .replace(/\*\*(.+?)\*\*/g, "$1")                // **qalin** → qalin
    .replace(/__(.+?)__/g, "$1")                    // __qalin__ → qalin
    .replace(/\*\*/g, "")                           // qolgan yakka **
    .replace(/`{1,3}/g, "")                         // kod belgilari `
    .replace(/[ \t]{2,}/g, " ")                     // ortiqcha bo'shliq (qator ajratish saqlanadi)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isCreditErrorReply(text) {
  return String(text || "").includes("[CLAUDE_CREDIT_ERROR]");
}

// Suhbat o'rtasida boshlanuvchi salomlashishni olib tashlaydi.
// Faqat suhbat boshida salom o'rinli — keyin bot qayta salomlashmasin.
function stripLeadingGreeting(text) {
  const stripped = (text || "")
    .replace(/^\s*(va\s*[ao]l[ae]ykum(\s*assalom)?|assalomu?\s*[ao]l[ae]ykum|salom(lar)?|xayrli\s+\S+|hello|hi|здравствуйте|привет|салом|ассалом[уo]?\s*ал[ае]йкум)[\s!,.\-—:]*/i, "")
    .trim();
  if (!stripped) return text; // butun xabar salom edi — o'zgartirmaymiz
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function isIdentityQuestion(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("odammisiz") ||
    t.includes("odammisiz") ||
    t.includes("robotmisiz") ||
    t.includes("botmisiz") ||
    t.includes("insonmisiz") ||
    t.includes("siz kimsiz") ||
    t.includes("sen kimsan")
  );
}

async function rewriteToUzbekLatin(rawReply, userMessage, meta = {}) {
  const { channel = "telegram", phase = "rewrite" } = meta;
  const rewriteSystem =
    "Sen matn tahrirlovchisan. Faqat lotin yoki kirilldan foydalan. Arab yozuvidan foydalanma. Ma'noni o'zgartirma, faqat yozuv va imloni soddalashtir.";
  const rewriteUser =
    `Foydalanuvchi xabari: ${userMessage}\n\n` +
    `Quyidagi javobni o'zbek lotin yozuvida qayta yoz:\n${rawReply}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL_LIGHT,
      max_tokens: 300,
      temperature: 0,
      system: rewriteSystem,
      messages: [{ role: "user", content: rewriteUser }],
    }),
  });

  const data = await r.json();
  await saveAiUsage({
    channel,
    phase,
    model: data?.model || CLAUDE_MODEL_LIGHT,
    input_tokens: toNum(data?.usage?.input_tokens),
    output_tokens: toNum(data?.usage?.output_tokens),
    cache_creation_input_tokens: toNum(data?.usage?.cache_creation_input_tokens),
    cache_read_input_tokens: toNum(data?.usage?.cache_read_input_tokens),
    status: Array.isArray(data?.content) ? "ok" : "error",
    error_type: data?.error?.type || null,
    error_message: data?.error?.message || null,
    created_at: new Date().toISOString(),
  });
  if (!data.content || !Array.isArray(data.content)) return "";

  const rewritten = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!rewritten) return "";
  if (containsArabicScript(rewritten)) {
    return "Uzr, javobni texnik sababga ko'ra lotin yozuvida qayta yuboring.";
  }
  return rewritten;
}

async function enforceUzbekOnly(rawReply, userMessage, meta = {}) {
  const { channel = "telegram", phase = "enforce_uz" } = meta;
  const enforceSystem =
    "Sen o'zbek tili muharririsan. Matnni faqat o'zbek tilida qoldir. Boshqa tillardagi iboralarni o'zbekchaga tabiiy tarzda o'tkaz. Ma'noni o'zgartirma, fakt qo'shma. Havola (https://...), @username va raqamlarni aynan o'zgartirmasdan saqla. Hech qachon foydalanuvchiga til bo'yicha tanbeh yoki rad javob yozma.";
  const enforceUser =
    `Foydalanuvchi xabari: ${userMessage}\n\n` +
    `Quyidagi javobni faqat o'zbek tilida qayta yoz (lotin yoki kirill bo'lishi mumkin):\n${rawReply}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL_LIGHT,
      max_tokens: 320,
      temperature: 0,
      system: enforceSystem,
      messages: [{ role: "user", content: enforceUser }],
    }),
  });

  const data = await r.json();
  await saveAiUsage({
    channel,
    phase,
    model: data?.model || CLAUDE_MODEL_LIGHT,
    input_tokens: toNum(data?.usage?.input_tokens),
    output_tokens: toNum(data?.usage?.output_tokens),
    cache_creation_input_tokens: toNum(data?.usage?.cache_creation_input_tokens),
    cache_read_input_tokens: toNum(data?.usage?.cache_read_input_tokens),
    status: Array.isArray(data?.content) ? "ok" : "error",
    error_type: data?.error?.type || null,
    error_message: data?.error?.message || null,
    created_at: new Date().toISOString(),
  });
  if (!data.content || !Array.isArray(data.content)) return "";

  const rewritten = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!rewritten) return "";
  if (containsArabicScript(rewritten)) {
    return "[OPERATOR]";
  }
  return rewritten;
}

// ============================================================
// SUPABASE: history olish va saqlash
// ============================================================
// Eski @musofir_shou_bot shablonli xabarlarini aniqlash
function isLegacyBotMessage(content) {
  if (!content) return false;
  return (
    content.includes("rasmiy jamoasi qutlaydi") ||
    content.includes("ISHTIROK ETISH UCHUN") ||
    content.includes("OBUNA SOTIB OLISH") ||
    content.includes("Loyiha yangiliklari") ||
    content.includes("Eslatma: Loyiha doirasidagi")
  );
}

function isServiceMessage(content) {
  if (!content) return false;
  const c = content.trim();
  return (
    c === "/webchat" ||
    c === "Mini App orqali chat qilish uchun tugmani bosing 👇"
  );
}

async function getHistory(chatId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?chat_id=eq.${chatId}&order=created_at.desc&limit=${HISTORY_LIMIT}&select=role,content,created_at`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) return [];
  // Eski shablon va xizmat xabarlarini filtrlab tashlaymiz
  const filtered = rows.filter(row => !isLegacyBotMessage(row.content) && !isServiceMessage(row.content));
  return filtered.reverse(); // desc → asc
}

async function saveMessage(chatId, role, content) {
  await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ chat_id: chatId, role, content }),
  });
}

// ============================================================
// ============================================================
// OPERATOR SESSION TEKSHIRUVI
// ============================================================
async function hasActiveOperatorSession(chatId) {
  // 24 soat ichida yaratilgan, yopilmagan so'rov bormi
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/operator_requests?user_chat_id=eq.${chatId}&created_at=gte.${since}&status=in.(pending,active)&select=id,status&limit=1`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function saveOperatorRequest(chatId, userText, message, msgId) {
  await fetch(`${SUPABASE_URL}/rest/v1/operator_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_chat_id: chatId,
      user_question: userText,
      operator_message_id: msgId,
      user_message_id: message.business_connection_id ? null : (message.message_id || null),
      biz_conn_id: message.business_connection_id || null,
      status: "pending",
    }),
  });
}

async function forwardToActiveOperator(chatId, userText, message) {
  const userName = message.from?.first_name || message.from?.username || "Noma'lum";
  const text = `💬 Davom (${userName}, ID: ${chatId}):\n\n${userText}`;
  for (const opId of OPERATOR_CHAT_IDS) {
    if (opId === chatId) continue; // Operator o'z xabarini o'ziga olmasin
    const sentMsg = await sendTelegramWithResult(opId, text);
    if (sentMsg?.message_id) {
      await saveOperatorRequest(chatId, userText, message, sentMsg.message_id);
    }
  }
}

// OPERATOR ESCALATION
// ============================================================
async function escalateToOperator(chatId, userText, message, options = {}) {
  const { notifyUser = true } = options;
  const userName =
    message.from?.first_name || message.from?.username || "Noma'lum";

  // Oxirgi suhbat tarixini olish
  const history = await getHistory(chatId);
  let historyText = "";
  if (history.length > 0) {
    const recent = history.slice(-10); // oxirgi 10 ta xabar
    historyText =
      "\n\n📜 Oxirgi suhbat:\n" +
      recent
        .map((h) => (h.role === "user" ? `👤: ${h.content}` : `🤖: ${h.content}`))
        .join("\n");
  }

  const forwardText = `❓ Yangi savol\n👤 ${userName} (ID: ${chatId})\n\n${userText}${historyText}`;

  for (const opId of OPERATOR_CHAT_IDS) {
    if (opId === chatId) continue; // Operator o'z xabarini o'ziga olmasin
    const sentMsg = await sendTelegramWithResult(opId, forwardText);
    // Media fayllarni ham yuborish
    if (message.voice?.file_id) {
      await sendTelegramVoice(opId, message.voice.file_id);
    } else if (message.audio?.file_id) {
      await sendTelegramAudio(opId, message.audio.file_id);
    } else if (message.photo?.length > 0) {
      await sendTelegramPhoto(opId, message.photo[message.photo.length - 1].file_id);
    } else if (message.document?.file_id) {
      await sendTelegramDocument(opId, message.document.file_id);
    }
    if (sentMsg?.message_id) {
      await saveOperatorRequest(chatId, userText, message, sentMsg.message_id);
    }
  }

  if (notifyUser) {
    await sendTelegram(
      chatId,
      "⏳ Savolingiz mas'ul xodimga yuborildi. Tez orada javob beramiz!",
      message.business_connection_id || null
    );
  }
}

async function closeOperatorSession(userChatId, closingMsg, bizConnId, platform = "telegram") {
  await fetch(
    `${SUPABASE_URL}/rest/v1/operator_requests?user_chat_id=eq.${userChatId}&status=not.in.(cancelled,closed,answered)`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ status: "closed" }),
    }
  );

  const connId = bizConnId || (platform === "telegram" ? await getSetting("biz_conn_id") : null);

  let delivery = { ok: true };
  if (closingMsg) {
    delivery = await deliverToUserByPlatform(platform, userChatId, closingMsg, bizConnId);
    await saveMessage(userChatId, "assistant", closingMsg);
  }

  for (const opId of OPERATOR_CHAT_IDS) {
    if (closingMsg && !delivery.ok) {
      await sendTelegram(opId, `⚠️ Sessiya yopildi (user: ${userChatId}), LEKIN xabar foydalanuvchiga YETMADI: ${humanizeDeliveryError(delivery.error)}`);
    } else if (closingMsg) {
      await sendTelegram(opId, `✅ Sessiya yopildi (user: ${userChatId}). Xabar ${delivery.via} orqali yetkazildi.`);
    } else {
      await sendTelegram(opId, `✅ Sessiya yopildi (user: ${userChatId}). Bot qayta ishlaydi.`);
    }
  }

  // Operator javob bermagan bo'lsa — oxirgi user xabariga bot javob bersin
  const history = await getHistory(userChatId);
  const lastMsg = history.length > 0 ? history[history.length - 1] : null;
  if (lastMsg && lastMsg.role === "user" && !lastMsg.content.startsWith("[")) {
    const brainChannel = platform === "max" ? "max" : (platform === "instagram" ? "instagram" : "telegram");
    const { reply } = await runUnifiedBrainRequest({
      channel: brainChannel,
      userText: lastMsg.content,
      history,
    });
    if (isCreditErrorReply(reply)) {
      await escalateToOperator(
        userChatId,
        `[CLAUDE CREDIT][close-session] ${lastMsg.content}`,
        { chat: { id: userChatId }, from: { id: userChatId }, business_connection_id: null },
        { notifyUser: false }
      );
      await saveMessage(userChatId, "assistant", "[Operatorga yo'naltirildi: credit]");
      return;
    }
    const shouldEscalate = !reply || reply.includes("[OPERATOR]") || isLanguageRefusal(reply);
    const cleanReply = shouldEscalate
      ? "Agar boshqa savolingiz bo'lsa, yozavering 😊"
      : removeOperatorPhrase(reply);
    await saveMessage(userChatId, "assistant", cleanReply);
    await deliverToUserByPlatform(platform, userChatId, cleanReply, connId);
  }
}

async function handleOperatorReply(message) {
  const replyToMsgId = message.reply_to_message.message_id;
  const operatorAnswer = message.text || "";
  if (!operatorAnswer) return;

  // /done [chatId] — reply qilmasdan ID bilan yopish
  const doneDirectMatch = operatorAnswer.match(/^\/done\s+(\d+)(?:\s+([\s\S]*))?$/);
  if (doneDirectMatch) {
    const targetChatId = doneDirectMatch[1];
    const closingMsg = (doneDirectMatch[2] || "").trim();
    const platform = await detectPlatform(targetChatId);
    await closeOperatorSession(targetChatId, closingMsg, null, platform);
    return;
  }

  // /done [matn] — reply orqali yopish
  if (operatorAnswer.startsWith("/done")) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/operator_requests?operator_message_id=eq.${replyToMsgId}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const results = await r.json();
    if (!results || results.length === 0) {
      await sendTelegram(message.chat.id, "⚠️ Foydalanuvchi topilmadi. Foydalanish: /done yoki /done [chatId]");
      return;
    }
    const req = results[0];
    const closingMsg = operatorAnswer.replace(/^\/done\s*/, "").trim();
    const bizConnId = req.biz_conn_id || null;
    const targetId = req.user_ext_id || req.user_chat_id;
    await closeOperatorSession(targetId, closingMsg, bizConnId, req.platform || "telegram");
    return;
  }

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/operator_requests?operator_message_id=eq.${replyToMsgId}&select=*`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const results = await r.json();

  if (!results || results.length === 0) {
    await sendTelegram(message.chat.id, "⚠️ Foydalanuvchi topilmadi.");
    return;
  }

  const req = results[0];
  const platform = req.platform || "telegram";
  // Instagram IGSID juda uzun — bigint o'qishda precision yo'qoladi, shu sabab user_ext_id (string) afzal.
  const targetId = req.user_ext_id || req.user_chat_id;
  const bizConnId = platform === "telegram" ? (req.biz_conn_id || (await getSetting("biz_conn_id"))) : null;

  // Foydalanuvchiga yetkazish — platformaga qarab (Telegram: biznes→global→oddiy, WhatsApp/Instagram: Graph API)
  const delivery = await deliverToUserByPlatform(platform, targetId, operatorAnswer, bizConnId);
  await saveMessage(targetId, "assistant", operatorAnswer);

  await fetch(`${SUPABASE_URL}/rest/v1/operator_requests?id=eq.${req.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ answer: operatorAnswer, status: "active" }),
  });

  if (delivery.ok) {
    await sendTelegram(message.chat.id, `✅ Javob yuborildi! (${delivery.via} orqali)`);
  } else {
    await sendTelegram(message.chat.id, `❌ Foydalanuvchiga (${req.user_chat_id}) yetkazilmadi: ${humanizeDeliveryError(delivery.error)}`);
  }

  // Boshqa operatorlarga xabar berildi deb bildirish
  const respondingOpId = message.chat.id;
  for (const opId of OPERATOR_CHAT_IDS) {
    if (opId === respondingOpId) continue;
    await sendTelegram(opId, `ℹ️ User ${req.user_chat_id} ga javob berildi (boshqa operator tomonidan).`);
  }
}

// ============================================================
// ============================================================
// NARX-BOSQICHI FOLLOW-UP — narx/tarif aytilgandan keyin javob kelmagan lidlarga eslatma
// ============================================================
function isQuietHourNowTashkent() {
  const tashkentHour = new Date(Date.now() + TASHKENT_OFFSET_MS).getUTCHours();
  return tashkentHour >= QUIET_HOUR_START || tashkentHour < QUIET_HOUR_END;
}

// Chatda saqlangan til maydoni yo'q — lidning o'z xabarlaridan sodda heuristika bilan
// aniqlaymiz. Aniq bo'lmasa o'zbekcha deb hisoblanadi (spec: "aniq bo'lmasa — o'zbekcha").
function detectLeadLanguage(history) {
  const userText = history.filter((h) => h.role === "user").map((h) => h.content.toLowerCase()).join(" ");
  const russianMarkers = ["привет", "здравствуйте", "спасибо", "пожалуйста", "хочу", "сколько", "оплат", "подписк", "вопрос"];
  return russianMarkers.some((w) => userText.includes(w)) ? "ru" : "uz";
}

// operator_requests'da yozuv yo'q (hech qachon eskalatsiya bo'lmagan) lidlar uchun
// zaxira aniqlash. Instagram IGSID juda uzun bo'ladi (worker_v2.js:2671 dagi izohga mos) —
// Telegram ID'lar hozircha 10 xonadan oshmaydi.
function guessPlatformFromChatId(chatId) {
  return String(chatId).length >= 15 ? "instagram" : "telegram";
}

async function sendPriceStageFollowups() {
  if (isQuietHourNowTashkent()) {
    return { skippedQuietHour: true, sent: [] };
  }

  const candidates = await getPriceStageFollowupCandidates();
  const globalBizConn = await getSetting("biz_conn_id");
  const sent = [];

  for (const { chat_id: chatId, platform, waiting_reply_since, reminder_count } of candidates) {
    const reminderIndex = Number(reminder_count) || 0; // 0 → 1-eslatma navbatda, 1 → 2-eslatma
    if (reminderIndex >= 2) continue;

    const elapsedHours = (Date.now() - new Date(waiting_reply_since).getTime()) / 3600_000;
    const minHours = reminderIndex === 0 ? REMINDER_1_MIN_HOURS : REMINDER_2_MIN_HOURS;
    if (elapsedHours < minHours) continue;

    try {
      const history = await getHistory(chatId);
      const allContent = history.map((h) => h.content.toLowerCase()).join(" ");
      if (PURCHASE_CONFIRMED_PHRASES.some((p) => allContent.includes(p))) continue;
      if (OPTED_OUT_PHRASES.some((p) => allContent.includes(p))) continue;

      const lang = detectLeadLanguage(history);
      const text = REMINDER_TEXTS[lang][reminderIndex];

      const resolvedPlatform = platform || guessPlatformFromChatId(chatId);
      const delivery = await deliverToUserByPlatform(resolvedPlatform, chatId, text, globalBizConn);

      // Faqat MUVAFFAQIYATLI yetkazilgan eslatma "yuborildi" deb hisoblanadi — aks holda
      // keyingi soatlik tikda qayta urinish imkoniyati abadiy yo'qolib qoladi
      // (reminder_count muvaffaqiyatsiz urinishni ham sanab qo'yardi — shu tuzatildi).
      if (delivery?.ok) {
        await saveMessage(chatId, "assistant", `[avtoxabar-${reminderIndex + 1}]: ${text}`);
      }
      sent.push({ chatId, reminderIndex, text, ok: !!delivery?.ok, error: delivery?.ok ? undefined : delivery?.error });
    } catch (e) {
      sent.push({ chatId, reminderIndex, text: "", ok: false, error: e.message });
      console.error(`Narx-bosqichi follow-up xatosi (${chatId}):`, e.message);
    }
  }

  return { skippedQuietHour: false, sent };
}

async function getPriceStageFollowupCandidates() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_price_stage_followup_candidates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ operator_id: OPERATOR_CHAT_ID }),
  });

  const data = await r.json();
  if (!r.ok) {
    console.error("get_price_stage_followup_candidates RPC xatosi:", r.status, JSON.stringify(data));
    throw new Error(`RPC xatosi (${r.status}): ${data?.message || JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data : [];
}

// ============================================================
// KECHA JAVOBSIZ QOLGAN XABARLAR — bir martalik tozalash vazifasi
// ============================================================
// Oxirgi xabari "user" bo'lib qolgan (hali botdan ham, operatordan ham javob
// kelmagan) va shu xabar kecha (Toshkent kalendar kuni) yozilgan foydalanuvchilarni
// topadi. Har birining ketma-ket javobsiz xabarlarini birlashtirib BITTA javob beradi.
function stripMediaPlaceholderLines(text) {
  return (text || "")
    .split("\n")
    .filter((line) => {
      const stripped = line.trim().replace(/^[^\[\]a-zA-Z0-9']+/, "").trim();
      return !/^\[.*\]$/.test(stripped); // "📷 [Rasm/Skrinshot yuborildi]" kabi markerlar
    })
    .join("\n")
    .trim();
}

// Bitta so'rovda: kecha yozgan, hali javobsiz qolgan barcha foydalanuvchilarni topadi
// (operator sessiyasi ochiq bo'lmaganlarni). Har bir chat_id uchun kamida 2 ta emas,
// jami 3 ta Supabase so'rovi ishlatiladi — Worker subrequest limitiga urilib qolmaslik uchun.
async function findUnansweredYesterday() {
  const TASHKENT_OFFSET_MS = 5 * 3600_000;
  const nowTashkent = new Date(Date.now() + TASHKENT_OFFSET_MS);
  const todayMidnightUTCms =
    Date.UTC(nowTashkent.getUTCFullYear(), nowTashkent.getUTCMonth(), nowTashkent.getUTCDate()) - TASHKENT_OFFSET_MS;
  const yesterdayStart = new Date(todayMidnightUTCms - 24 * 3600_000).toISOString();
  const yesterdayEnd = new Date(todayMidnightUTCms).toISOString();

  const candR = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?role=eq.user&created_at=gte.${yesterdayStart}&created_at=lt.${yesterdayEnd}&select=chat_id`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const candRows = await candR.json();
  const chatIds = Array.isArray(candRows)
    ? [...new Set(candRows.map((row) => row.chat_id))].filter((id) => !OPERATOR_CHAT_IDS.includes(id))
    : [];
  if (chatIds.length === 0) return [];
  const idList = chatIds.join(",");

  // Platforma (telegram/instagram/whatsapp/max) va "operator hozir band qilib
  // turibdimi" (status pending/active — muddatidan qat'iy nazar) shu yerdan aniqlanadi.
  const opR = await fetch(
    `${SUPABASE_URL}/rest/v1/operator_requests?user_chat_id=in.(${idList})&select=user_chat_id,platform,status,created_at&order=user_chat_id.asc,created_at.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const opRows = await opR.json();
  const platformByChat = new Map();
  const busyIds = new Set();
  if (Array.isArray(opRows)) {
    for (const row of opRows) {
      if (!platformByChat.has(row.user_chat_id)) platformByChat.set(row.user_chat_id, row.platform || "telegram");
      if (row.status === "pending" || row.status === "active") busyIds.add(row.user_chat_id);
    }
  }

  const histR = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?chat_id=in.(${idList})&select=chat_id,role,content,created_at&order=chat_id.asc,created_at.desc&limit=5000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const histRows = await histR.json();
  if (!Array.isArray(histRows)) return [];

  const byChat = new Map();
  for (const row of histRows) {
    if (!byChat.has(row.chat_id)) byChat.set(row.chat_id, []);
    const arr = byChat.get(row.chat_id);
    if (arr.length < HISTORY_LIMIT) arr.push(row); // desc tartibda kelyapti — faqat oxirgi HISTORY_LIMIT kerak
  }

  const candidates = [];
  for (const chatId of chatIds) {
    if (busyIds.has(chatId)) continue; // operator hozir band qilib turibdi

    const descRows = byChat.get(chatId);
    if (!descRows || descRows.length === 0) continue;
    const filtered = descRows.filter((row) => !isLegacyBotMessage(row.content) && !isServiceMessage(row.content));
    if (filtered.length === 0) continue;
    const history = filtered.slice().reverse(); // asc

    const last = history[history.length - 1];
    if (last.role !== "user") continue; // allaqachon javob berilgan

    const { priorHistory, combinedUserText } = splitPendingUserBatch(history, last.content);
    const meaningfulText = stripMediaPlaceholderLines(combinedUserText);
    if (!meaningfulText) continue; // faqat rasm/fayl/ovoz markeri — operator kerak

    const platform = platformByChat.get(chatId) || "telegram";
    candidates.push({ chatId, platform, priorHistory, combinedUserText: meaningfulText });
  }

  return candidates;
}

async function answerUnansweredYesterday(commit, limit) {
  const candidates = await findUnansweredYesterday();
  const toProcess = commit && limit ? candidates.slice(0, limit) : candidates;
  const results = [];

  for (const prepared of toProcess) {
    const chatId = prepared.chatId;
    const platform = prepared.platform;

    if (!commit) {
      results.push({ chatId, platform, pending: true, preview: prepared.combinedUserText.slice(0, 300) });
      continue;
    }

    try {
      const { reply } = await runUnifiedBrainRequest({
        channel: platform,
        userText: prepared.combinedUserText,
        history: prepared.priorHistory,
      });

      if (isCreditErrorReply(reply)) {
        results.push({ chatId, platform, ok: false, error: "credit" });
        continue;
      }
      if (isLanguageRefusal(reply)) {
        results.push({ chatId, platform, ok: false, error: "language-refusal" });
        continue;
      }
      if (reply.trim() === "[OPERATOR]" || reply.includes("[OPERATOR]")) {
        results.push({ chatId, platform, ok: false, error: "operator-needed" });
        continue;
      }

      let cleanReply = removeOperatorPhrase(reply);
      if (prepared.priorHistory.some((h) => h.role === "assistant")) {
        cleanReply = stripLeadingGreeting(cleanReply);
      }
      await saveMessage(chatId, "assistant", cleanReply);
      const delivery = await deliverToUserByPlatform(platform, chatId, cleanReply);
      results.push({ chatId, platform, ok: !!delivery?.ok, error: delivery?.ok ? undefined : delivery?.error });
    } catch (e) {
      results.push({ chatId, platform, ok: false, error: e.message });
    }
  }

  return results;
}

async function handleUnansweredBacklog(reqUrl) {
  if (reqUrl.searchParams.get("key") !== DASHBOARD_KEY) {
    return new Response("Forbidden", { status: 403 });
  }
  if (reqUrl.searchParams.get("statusCheck") === "1") {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/operator_requests?status=in.(active,closed,answered,cancelled)&select=id,status&limit=5`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    return new Response(JSON.stringify({ ok: true, httpStatus: r.status, rows }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const opRowsOf = reqUrl.searchParams.get("opRowsOf");
  if (opRowsOf) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/operator_requests?user_chat_id=eq.${opRowsOf}&select=*&order=created_at.desc&limit=20`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    return new Response(JSON.stringify({ ok: true, httpStatus: r.status, rows }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const commit = reqUrl.searchParams.get("commit") === "1";
  // Bir chaqiriqda subrequest limitiga urilib qolmaslik uchun commit rejimida
  // standart bo'lib bir nechta foydalanuvchi qayta ishlanadi (kerak bo'lsa qayta chaqiriladi).
  const limit = Number(reqUrl.searchParams.get("limit") || 8);
  const results = await answerUnansweredYesterday(commit, limit);
  return new Response(JSON.stringify({ ok: true, commit, limit: commit ? limit : undefined, count: results.length, results }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================
// SETTINGS HELPERS
// ============================================================
async function saveSetting(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

async function getSetting(key) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=eq.${key}&select=value&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function estimateUsageCost(row) {
  const model = String(row?.model || "");
  const rates = ANTHROPIC_PRICING_PER_MTOK[model];
  if (!rates) return 0;

  const inputTokens = toNum(row?.input_tokens) + toNum(row?.cache_creation_input_tokens) + toNum(row?.cache_read_input_tokens);
  const outputTokens = toNum(row?.output_tokens);
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

async function saveAiUsage(entry) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(entry),
    });
  } catch (_) {
    // ai_usage jadvali bo'lmasa yoki vaqtincha xato bo'lsa, asosiy oqim to'xtamasin.
  }
}

// ============================================================
// HELPERS
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// TELEGRAM HELPERS
// ============================================================
async function sendTelegram(chatId, text, bizConnId = null) {
  const payload = { chat_id: chatId, text };
  if (bizConnId) payload.business_connection_id = bizConnId;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) {
      console.error(`Telegram sendMessage xato (chat ${chatId}, biz=${bizConnId || "—"}):`, data.description);
    }
    return data;
  } catch (e) {
    console.error(`Telegram sendMessage exception (chat ${chatId}):`, e.message);
    return { ok: false, description: e.message };
  }
}

// Foydalanuvchiga ishonchli yetkazish: saqlangan biznes-ulanish → eng yangi
// global biznes-ulanish → oddiy xabar tartibida sinaydi. Birortasi ishlasa to'xtaydi.
// Natija: { ok, via, error } — via = qaysi usul ishladi.
async function deliverToUser(chatId, text, preferredBizConnId = null) {
  const attempts = [];
  if (preferredBizConnId) attempts.push(preferredBizConnId);
  const globalConn = await getSetting("biz_conn_id");
  if (globalConn && !attempts.includes(globalConn)) attempts.push(globalConn);
  attempts.push(null); // oddiy xabar (biznes ulanishsiz)

  let lastError = "";
  for (const conn of attempts) {
    const res = await sendTelegram(chatId, text, conn);
    if (res?.ok) return { ok: true, via: conn ? "biznes ulanish" : "oddiy xabar" };
    lastError = res?.description || "noma'lum xato";
  }
  return { ok: false, error: lastError };
}

// Telegram xatosini operator tushunadigan o'zbekcha izohga aylantiradi.
function humanizeDeliveryError(err) {
  const e = (err || "").toLowerCase();
  if (e.includes("peer_id_invalid") || e.includes("chat not found")) {
    return "foydalanuvchi bilan suhbat eskirgan — Telegram biznes cheklovi tufayli bot unga yoza olmaydi. Foydalanuvchi yangi xabar yozsa, javob yuborish mumkin bo'ladi.";
  }
  if (e.includes("blocked")) return "foydalanuvchi botni bloklagan.";
  if (e.includes("deactivated")) return "foydalanuvchi akkaunti o'chirilgan.";
  if (e.includes("forbidden")) return "Telegram ruxsat bermadi (foydalanuvchi bot bilan suhbatni boshlamagan yoki bloklagan).";
  return `texnik xato (${err}).`;
}

async function sendTelegramWithResult(chatId, text) {
  const r = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );
  const data = await r.json();
  return data.result;
}

// Send message bilan inline keyboard (web app tugmasi uchun)
async function sendTelegramWithMarkup(chatId, text, replyMarkup, bizConnId = null) {
  const payload = { chat_id: chatId, text, reply_markup: replyMarkup };
  if (bizConnId) payload.business_connection_id = bizConnId;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) {
      console.error(`Telegram sendMessage bilan markup xato (chat ${chatId}):`, data.description);
    }
    return data;
  } catch (e) {
    console.error(`Telegram sendMessage bilan markup exception:`, e.message);
    return { ok: false, description: e.message };
  }
}

async function sendTelegramVoice(chatId, voiceFileId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, voice: voiceFileId }),
  });
}

async function sendTelegramAudio(chatId, audioFileId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio: audioFileId }),
  });
}

async function sendTelegramReply(chatId, text, replyToMessageId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: replyToMessageId }),
  });
}

async function sendTelegramPhoto(chatId, fileId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: fileId }),
  });
}

async function sendTelegramDocument(chatId, fileId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, document: fileId }),
  });
}

// ============================================================
// WHATSAPP (Meta Cloud API) — webhook. Manzil: /whatsapp
// ============================================================
async function handleWhatsAppWebhook(request, url, ctx) {
  // 1-bosqich: Meta webhook verifikatsiyasi (GET) — Meta panelida ulashda kerak.
  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === WA_RUNTIME.verifyToken) {
      return new Response(challenge || "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // 2-bosqich: kiruvchi xabarlar (POST).
  // Darhol 200 qaytaramiz, ishlovni fonda bajaramiz — aks holda Meta qayta yuboradi.
  try {
    const body = await request.json();
    const value = body.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const contactName = value?.contacts?.[0]?.profile?.name || "Mijoz";
      const work = (async () => {
        for (const m of messages) {
          try {
            await handleWhatsAppMessage(m, contactName);
          } catch (e) {
            console.error("WhatsApp ishlov xatosi:", e.message);
          }
        }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
    }
  } catch (e) {
    console.error("WhatsApp webhook xatosi:", e.message);
  }
  return new Response("OK", { status: 200 });
}

// Kiruvchi WhatsApp xabari: RAG + Claude → javob; murakkab holat → operator.
// chatId = foydalanuvchi telefon raqami (wa_id). conversations.chat_id (bigint) ga sig'adi.
async function handleWhatsAppMessage(msg, contactName) {
  const chatId = msg.from;
  const type = msg.type;

  // Faqat matn (v1). Rasm/audio/hujjat → operatorga.
  if (type !== "text") {
    await saveMessage(chatId, "user", `[WhatsApp ${type} yuborildi]`);
    await escalateWhatsAppToOperator(chatId, `[${String(type).toUpperCase()} yuborildi]`, contactName);
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi]");
    return;
  }

  const userText = (msg.text?.body || "").trim();
  if (!userText) return;

  await saveMessage(chatId, "user", userText);

  // Operator faol suhbatda bo'lsa — botni chetga olib, operatorga uzatamiz
  if (await hasActiveOperatorSession(chatId)) {
    await forwardWhatsAppToOperator(chatId, userText, contactName);
    return;
  }

  const history = await getHistory(chatId);
  const { reply } = await runUnifiedBrainRequest({
    channel: "whatsapp",
    userText,
    history,
  });

  if (isCreditErrorReply(reply)) {
    await escalateWhatsAppToOperator(chatId, `[CLAUDE CREDIT] ${userText}`, contactName, { notifyUser: false });
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi: credit]");
    return;
  }

  if (isLanguageRefusal(reply) || reply.includes("[OPERATOR]")) {
    await escalateWhatsAppToOperator(chatId, userText, contactName);
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi]");
    return;
  }

  let cleanReply = removeOperatorPhrase(reply);
  if (history.some(h => h.role === "assistant")) {
    cleanReply = stripLeadingGreeting(cleanReply);
  }
  await saveMessage(chatId, "assistant", cleanReply);
  await sendWhatsApp(chatId, cleanReply);
}

// WhatsApp Cloud API orqali matn yuborish. Natija: { ...,  error? }.
async function sendWhatsApp(toPhone, text) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WA_RUNTIME.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WA_RUNTIME.token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: String(toPhone),
          type: "text",
          text: { preview_url: false, body: text },
        }),
      }
    );
    const data = await r.json();
    if (data.error) console.error("WhatsApp send xato:", JSON.stringify(data.error));
    return data;
  } catch (e) {
    console.error("WhatsApp send exception:", e.message);
    return { error: { message: e.message } };
  }
}

// WhatsApp foydalanuvchisini operatorga (Telegram chatiga) eskalatsiya qilish.
async function escalateWhatsAppToOperator(chatId, userText, contactName, options = {}) {
  const { notifyUser = true } = options;
  const history = await getHistory(chatId);
  let historyText = "";
  if (history.length > 0) {
    const recent = history.slice(-10);
    historyText =
      "\n\n📜 Oxirgi suhbat:\n" +
      recent.map((h) => (h.role === "user" ? `👤: ${h.content}` : `🤖: ${h.content}`)).join("\n");
  }
  const forwardText = `🟢 WhatsApp savol\n👤 ${contactName} (${chatId})\n\n${userText}${historyText}`;
  for (const opId of OPERATOR_CHAT_IDS) {
    const sentMsg = await sendTelegramWithResult(opId, forwardText);
    if (sentMsg?.message_id) await saveWhatsAppOperatorRequest(chatId, userText, sentMsg.message_id);
  }
  if (notifyUser) {
    await sendWhatsApp(chatId, "⏳ Savolingiz mas'ul xodimga yuborildi. Tez orada javob beramiz!");
  }
}

// Operator faol suhbatda bo'lsa, WhatsApp xabarini unga uzatish.
async function forwardWhatsAppToOperator(chatId, userText, contactName) {
  const text = `💬 Davom WhatsApp (${contactName}, ${chatId}):\n\n${userText}`;
  for (const opId of OPERATOR_CHAT_IDS) {
    const sentMsg = await sendTelegramWithResult(opId, text);
    if (sentMsg?.message_id) await saveWhatsAppOperatorRequest(chatId, userText, sentMsg.message_id);
  }
}

async function saveWhatsAppOperatorRequest(chatId, userText, msgId) {
  await fetch(`${SUPABASE_URL}/rest/v1/operator_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_chat_id: chatId,
      user_question: userText,
      operator_message_id: msgId,
      status: "pending",
      platform: "whatsapp",
    }),
  });
}

// Platformaga qarab foydalanuvchiga yetkazish (operator javobi / yopilish xabari uchun).
async function deliverToUserByPlatform(platform, chatId, text, bizConnId = null) {
  if (platform === "whatsapp") {
    const wr = await sendWhatsApp(chatId, text);
    return wr?.error ? { ok: false, error: wr.error.message } : { ok: true, via: "WhatsApp" };
  }
  if (platform === "instagram") {
    const ir = await sendInstagram(chatId, text);
    return ir?.error ? { ok: false, error: ir.error.message } : { ok: true, via: "Instagram" };
  }
  if (platform === "max") {
    const mr = await sendMax(chatId, text);
    return mr?.ok ? { ok: true, via: "MAX" } : { ok: false, error: mr?.error || "MAX yetkazib bo'lmadi" };
  }
  return await deliverToUser(chatId, text, bizConnId);
}

// /done [chatId] uchun: foydalanuvchining platformasini oxirgi so'rovidan aniqlash.
async function detectPlatform(chatId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/operator_requests?user_chat_id=eq.${chatId}&order=created_at.desc&limit=1&select=platform`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0]?.platform) || "telegram";
}

// ============================================================
// INSTAGRAM (Meta Graph API, Instagram login) — webhook. Manzil: /instagram
// ============================================================
async function handleInstagramWebhook(request, url, ctx) {
  // 1-bosqich: Meta webhook verifikatsiyasi (GET).
  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === IG_RUNTIME.verifyToken) {
      return new Response(challenge || "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // 2-bosqich: kiruvchi xabarlar (POST). Darhol 200, ishlov fonda.
  try {
    const body = await request.json();
    const entries = body.entry || [];
    const work = (async () => {
      for (const entry of entries) {
        // DM (shaxsiy xabar) hodisalari — parallel: bitta webhook'da kelgan ketma-ket
        // xabarlar debounce orqali bitta javobga birlashishi uchun.
        await Promise.all((entry.messaging || []).map(async (ev) => {
          try {
            await handleInstagramMessage(ev);
          } catch (e) {
            console.error("Instagram ishlov xatosi:", e.message);
          }
        }));
        // Izoh (comment) hodisalari — Meta panelida "comments" field obuna qilingan bo'lishi kerak
        console.log("IG entry.changes:", JSON.stringify(entry.changes || []));
        for (const change of entry.changes || []) {
          if (change.field !== "comments") { console.log("IG: comment emas, field=", change.field); continue; }
          try {
            console.log("IG comment keldi:", JSON.stringify(change.value));
            await handleInstagramComment(change.value, entry.id);
          } catch (e) {
            console.error("Instagram izoh ishlov xatosi:", e.message, e.stack);
          }
        }
      }
    })();
    if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  } catch (e) {
    console.error("Instagram webhook xatosi:", e.message);
  }
  return new Response("OK", { status: 200 });
}

// Kiruvchi Instagram DM: RAG + Claude → javob; murakkab holat → operator.
// chatId = IGSID (juda uzun, STRING sifatida saqlanadi — parseInt QILMA, precision yo'qoladi).
async function handleInstagramMessage(ev) {
  // O'z aks-sadolari (echo) va read/delivery eventlarini o'tkazib yuboramiz.
  if (!ev.message || ev.message.is_echo) return;
  const chatId = ev.sender?.id;
  if (!chatId) return;
  const userText = (ev.message.text || "").trim();

  // Story reaksiyalari (🔥❤️ va h.k.) — bot indamaydi.
  if (ev.message.reactions || ev.message.reaction) return;

  // Reels / post ulashuvi / story mention → bot indamaydi: javob ham bermaydi,
  // operatorga ham yubormaydi. Faqat iz uchun kiruvchi xabarni saqlab qo'yamiz.
  const attachments = ev.message.attachments;
  const isReelLinkText = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels)\//i.test(userText);
  const isIgnoredShare =
    Array.isArray(attachments) &&
    attachments.some((a) => {
      const type = String(a?.type || "").toLowerCase();
      const url = String(a?.payload?.url || a?.url || "").toLowerCase();
      return (
        INSTAGRAM_IGNORE_ATTACHMENT_TYPES.includes(type) ||
        type.includes("reel") ||
        type.includes("share") ||
        type.includes("story") ||
        url.includes("instagram.com/reel/") ||
        url.includes("/reel/")
      );
    });
  if (isIgnoredShare || isReelLinkText) {
    await saveMessage(chatId, "user", "[Instagram reels/ulashuv — e'tiborsiz qoldirildi]");
    return;
  }

  // Matn bo'lmasa (rasm/stiker/audio) → operatorga
  if (!userText) {
    await saveMessage(chatId, "user", "[Instagram media yuborildi]");
    await escalateInstagramToOperator(chatId, "[MEDIA yuborildi]");
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi]");
    return;
  }

  // Faqat emoji/tinish belgisi (story'ga 🔥 javobi, "👍" va h.k.) — bot indamaydi,
  // operatorga ham yubormaydi.
  if (!isContentfulComment(userText)) {
    await saveMessage(chatId, "user", "[Instagram emoji yuborildi]");
    return;
  }

  await saveMessage(chatId, "user", userText);

  if (await hasActiveOperatorSession(chatId)) {
    await forwardInstagramToOperator(chatId, userText);
    return;
  }

  // === DEBOUNCE — Telegram'dagi kabi: ketma-ket xabarlarga BITTA javob ===
  const debounceKey = `dbnc_${chatId}`;
  const myMsgId = String(ev.message.mid || Date.now());
  await saveSetting(debounceKey, myMsgId);
  await sleep(DEBOUNCE_MS);
  const latestMsgId = await getSetting(debounceKey);
  if (latestMsgId && latestMsgId !== myMsgId) return;

  const fullHistory = await getHistory(chatId);
  const { priorHistory: history, combinedUserText: pendingText } = splitPendingUserBatch(fullHistory, userText);
  // Emoji/reels/media markerlari ("[...]") Claude'ga matn sifatida bormasin.
  const combinedUserText = stripMediaPlaceholderLines(pendingText) || userText;
  const { reply } = await runUnifiedBrainRequest({
    channel: "instagram",
    userText: combinedUserText,
    history,
  });

  if (isCreditErrorReply(reply)) {
    await escalateInstagramToOperator(chatId, `[CLAUDE CREDIT] ${combinedUserText}`);
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi: credit]");
    return;
  }

  if (isLanguageRefusal(reply) || reply.includes("[OPERATOR]")) {
    await escalateInstagramToOperator(chatId, combinedUserText);
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi]");
    return;
  }

  let cleanReply = removeOperatorPhrase(reply);
  if (history.some(h => h.role === "assistant")) {
    cleanReply = stripLeadingGreeting(cleanReply);
  }
  await saveMessage(chatId, "assistant", cleanReply);
  await sendInstagram(chatId, cleanReply);
}

// Kiruvchi Instagram IZOH (post ostidagi comment):
//  1) izoh ostiga qisqa PUBLIC javob,
//  2) foydalanuvchiga shaxsiy DM (comment_id orqali — yangi suhbat oynasini ochadi).
// Keyingi DM javoblari mavjud handleInstagramMessage oqimi orqali davom etadi.
// igAccountId = entry.id (biznes akkaunt IGSID) — o'z izohimizga javob bermaslik uchun.
async function handleInstagramComment(value, igAccountId) {
  const commentId = value?.id;
  const commenterId = value?.from?.id;
  const text = (value?.text || "").trim();

  console.log(`IG izoh: commentId=${commentId} commenterId=${commenterId} igAccountId=${igAccountId} text="${text}"`);

  if (!commentId || !commenterId) { console.log("IG izoh: commentId yoki commenterId yo'q, chiqib ketdi"); return; }

  // Loop oldini olish: o'z (akkauntimiz) izohlariga javob bermaymiz.
  if (commenterId === igAccountId) { console.log("IG izoh: o'z izohi, skip"); return; }
  if (IG_RUNTIME.accountId && commenterId === IG_RUNTIME.accountId) { console.log("IG izoh: runtime accountId match, skip"); return; }

  // Takror webhook (Meta qayta yuborishi mumkin) — shu izoh allaqachon ishlandimi?
  const dedupeKey = `ig_cmt_${commentId}`;
  const alreadyDone = await getSetting(dedupeKey);
  console.log(`IG izoh dedupe: key=${dedupeKey} alreadyDone=${alreadyDone}`);
  if (alreadyDone) return;
  await saveSetting(dedupeKey, "1");

  // Faqat boshqa foydalanuvchini belgilash (@do'st) — bu bizga savol emas, javob bermaymiz.
  const textWithoutMentions = text.replace(/@[\w.]+/g, "").trim();
  if (/@[\w.]+/.test(text) && !isContentfulComment(textWithoutMentions)) {
    console.log("IG izoh: faqat @mention, skip");
    return;
  }

  const contentful = isContentfulComment(textWithoutMentions);

  let publicMsg;
  let dmMsg;
  let shouldSendDm = true;

  if (!contentful) {
    // Emoji-only / bo'sh izoh — DM faqat tarix bo'lmasa yuboriladi.
    // Og'ir/hissiy emoji (😢💔 kabi) kelsa — quvnoq taklif emas, iliq va hurmatli ohang.
    const isSadEmoji = IG_SAD_EMOJI_REGEX.test(text);
    publicMsg = isSadEmoji ? pickRandom(IG_COMMENT_PUBLIC_WARM_VARIANTS) : pickRandom(IG_COMMENT_PUBLIC_VARIANTS);
    dmMsg = isSadEmoji ? IG_COMMENT_DM_WARM : IG_COMMENT_DM_INVITE;
    const existingHistory = await getHistory(commenterId);
    shouldSendDm = existingHistory.length === 0;
    await saveMessage(commenterId, "user", `[Instagram izoh]: ${text || "(emoji)"}`);
    await saveMessage(
      commenterId,
      "assistant",
      shouldSendDm ? dmMsg : "[Emoji-only izoh: tarix bor, DM yuborilmadi]"
    );
  } else {
    // Matnli izoh — to'liq AI javob (RAG + Claude) DM uchun.
    const history = await getHistory(commenterId);
    const { reply } = await runUnifiedBrainRequest({
      channel: "instagram",
      userText: text,
      history,
      askOptions: { extraSystem: "" },
    });

    if (reply === "[CLAUDE_CREDIT_ERROR]" || isLanguageRefusal(reply) || reply.includes("[OPERATOR]")) {
      await saveMessage(commenterId, "user", `[Instagram izoh]: ${text}`);
      if (reply === "[CLAUDE_CREDIT_ERROR]") {
        await escalateInstagramToOperator(commenterId, `[CLAUDE CREDIT][IZOH]: ${text}`, { notifyUser: false });
        shouldSendDm = false;
        publicMsg = "";
        dmMsg = "";
        await saveMessage(commenterId, "assistant", "[Operatorga yo'naltirildi: credit izoh]");
      } else {
        await escalateInstagramToOperator(commenterId, `[IZOH]: ${text}`, { notifyUser: false });
        // DM oynasini ochish uchun bitta xabar kerak (operator keyin javob bera olishi uchun),
        // lekin "mas'ul xodimga yuborildi" o'rniga tabiiy taklif.
        dmMsg = IG_COMMENT_DM_INVITE;
        await saveMessage(commenterId, "assistant", "[Operatorga yo'naltirildi: izoh]");
      }
    } else {
      dmMsg = removeOperatorPhrase(reply);
      if (history.some((h) => h.role === "assistant")) dmMsg = stripLeadingGreeting(dmMsg);
      await saveMessage(commenterId, "user", `[Instagram izoh]: ${text}`);
      await saveMessage(commenterId, "assistant", dmMsg);
      publicMsg = pickRandom(IG_COMMENT_PUBLIC_VARIANTS);
    }
  }

  // 1) Shaxsiy DM — faqat matnli/commentful holatda yuboramiz
  if (shouldSendDm && dmMsg) {
    const dmResult = await sendInstagramCommentPrivateReply(commentId, dmMsg);
    console.log("IG DM natija:", JSON.stringify(dmResult));
  }
  // 2) Izoh ostiga qisqa public javob
  if (publicMsg) {
    const pubResult = await replyToInstagramComment(commentId, publicMsg);
    console.log("IG public reply natija:", JSON.stringify(pubResult));
  }
}

// Izoh mazmunli (savol/matn) yoki shunchaki emoji/tinish belgisimi.
function isContentfulComment(text) {
  // Harf yoki raqamlarni qoldirib (emoji, bo'shliq, tinish belgilari olib tashlanadi),
  // kamida 2 ta belgi qolsa — mazmunli deb hisoblaymiz.
  const stripped = (text || "").replace(/[^\p{L}\p{N}]/gu, "");
  return stripped.length >= 2;
}

// Instagram Graph API orqali DM yuborish (Instagram login: me/messages).
async function sendInstagram(toIgsid, text) {
  try {
    const r = await fetch(
      `https://graph.instagram.com/${INSTAGRAM_API_VERSION}/me/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${IG_RUNTIME.token}`,
        },
        body: JSON.stringify({
          recipient: { id: String(toIgsid) },
          message: { text },
        }),
      }
    );
    const data = await r.json();
    if (data.error) console.error("Instagram send xato:", JSON.stringify(data.error));
    return data;
  } catch (e) {
    console.error("Instagram send exception:", e.message);
    return { error: { message: e.message } };
  }
}

// Izoh ostiga PUBLIC javob yozish (Instagram login: {comment-id}/replies).
async function replyToInstagramComment(commentId, text) {
  try {
    const r = await fetch(
      `https://graph.instagram.com/${INSTAGRAM_API_VERSION}/${commentId}/replies`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${IG_RUNTIME.token}`,
        },
        body: JSON.stringify({ message: text }),
      }
    );
    const data = await r.json();
    if (data.error) console.error("Instagram izoh public javob xato:", JSON.stringify(data.error));
    return data;
  } catch (e) {
    console.error("Instagram izoh public javob exception:", e.message);
    return { error: { message: e.message } };
  }
}

// Izohga PRIVATE javob — foydalanuvchiga DM yuboradi va suhbat oynasini ochadi
// (recipient: { comment_id }). Bir izohga faqat bir marta va izohdan 7 kun ichida ishlaydi.
async function sendInstagramCommentPrivateReply(commentId, text) {
  try {
    const r = await fetch(
      `https://graph.instagram.com/${INSTAGRAM_API_VERSION}/me/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${IG_RUNTIME.token}`,
        },
        body: JSON.stringify({
          recipient: { comment_id: String(commentId) },
          message: { text },
        }),
      }
    );
    const data = await r.json();
    if (data.error) console.error("Instagram izoh DM xato:", JSON.stringify(data.error));
    return data;
  } catch (e) {
    console.error("Instagram izoh DM exception:", e.message);
    return { error: { message: e.message } };
  }
}

// Foydalanuvchiga "mas'ul xodimga yuborildi" xabari endi yuborilmaydi (robotga o'xshab
// qolardi va emoji/qisqa javoblarga ham chiqardi) — kerak bo'lsa notifyUser: true bering.
async function escalateInstagramToOperator(chatId, userText, options = {}) {
  const { notifyUser = false } = options;
  const history = await getHistory(chatId);
  let historyText = "";
  if (history.length > 0) {
    const recent = history.slice(-10);
    historyText =
      "\n\n📜 Oxirgi suhbat:\n" +
      recent.map((h) => (h.role === "user" ? `👤: ${h.content}` : `🤖: ${h.content}`)).join("\n");
  }
  const forwardText = `🟣 Instagram savol\n👤 IGSID: ${chatId}\n\n${userText}${historyText}`;
  for (const opId of OPERATOR_CHAT_IDS) {
    const sentMsg = await sendTelegramWithResult(opId, forwardText);
    if (sentMsg?.message_id) await saveInstagramOperatorRequest(chatId, userText, sentMsg.message_id);
  }
  // Izoh oqimida DM oynasi hali ochilmagan — bunday holda chaqiruvchi xabarni
  // o'zi comment_id orqali yuboradi, shuning uchun notifyUser=false bo'ladi.
  if (notifyUser) {
    await sendInstagram(chatId, "⏳ Savolingiz mas'ul xodimga yuborildi. Tez orada javob beramiz!");
  }
}

async function forwardInstagramToOperator(chatId, userText) {
  const text = `💬 Davom Instagram (IGSID: ${chatId}):\n\n${userText}`;
  for (const opId of OPERATOR_CHAT_IDS) {
    const sentMsg = await sendTelegramWithResult(opId, text);
    if (sentMsg?.message_id) await saveInstagramOperatorRequest(chatId, userText, sentMsg.message_id);
  }
}

// user_ext_id — IGSID ni STRING sifatida saqlaydi (bigint o'qishda precision yo'qotmaslik uchun).
async function saveInstagramOperatorRequest(chatId, userText, msgId) {
  await fetch(`${SUPABASE_URL}/rest/v1/operator_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_chat_id: chatId,
      user_ext_id: String(chatId),
      user_question: userText,
      operator_message_id: msgId,
      status: "pending",
      platform: "instagram",
    }),
  });
}

// ============================================================
// MAX (VK milliy messenjeri) — webhook. Manzil: /max
// ============================================================
// MAX Meta'dan farqli — webhook URL'ni "challenge" bilan tasdiqlamaydi. Obuna API
// orqali bo'ladi (POST /subscriptions). Bu yerga faqat POST update'lar keladi.
async function handleMaxWebhook(request, url, ctx) {
  if (request.method !== "POST") {
    return new Response("MAX webhook ishlayapti", { status: 200 });
  }

  // Maxfiy kalit (subscription'da o'rnatilgan bo'lsa) — kelgan so'rovni tekshirish.
  if (MAX_WEBHOOK_SECRET) {
    const got = request.headers.get("X-Max-Bot-Api-Secret");
    if (got && got !== MAX_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Darhol 200, ishlovni fonda (aks holda MAX qayta yuboradi).
  try {
    const body = await request.json();
    if (body.update_type === "message_created" && body.message) {
      const work = handleMaxMessage(body.message).catch((e) =>
        console.error("MAX ishlov xatosi:", e.message)
      );
      if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
    }
  } catch (e) {
    console.error("MAX webhook xatosi:", e.message);
  }
  return new Response("OK", { status: 200 });
}

// Kiruvchi MAX xabari: RAG + Claude → javob; murakkab holat → operator.
// chatId = recipient.chat_id (dialog id, bigint'ga sig'adi) — javob shu yerga yuboriladi.
async function handleMaxMessage(message) {
  const sender = message.sender || {};
  if (sender.is_bot) return; // bot/o'z aks-sadolari

  const recipient = message.recipient || {};
  // Faqat shaxsiy dialog — guruh/kanal o'tkazib yuboriladi
  if (recipient.chat_type && recipient.chat_type !== "dialog") return;

  const chatId = recipient.chat_id;
  if (!chatId) return;
  const userName = sender.first_name || sender.name || sender.username || "Mijoz";
  const userText = (message.body?.text || "").trim();

  // Matn bo'lmasa (rasm/fayl/stiker) → operatorga
  if (!userText) {
    await saveMessage(chatId, "user", "[MAX media yuborildi]");
    await escalateMaxToOperator(chatId, "[MEDIA yuborildi]", userName);
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi]");
    return;
  }

  await saveMessage(chatId, "user", userText);

  // Operator faol suhbatda bo'lsa — botni chetga olib, operatorga uzatamiz
  if (await hasActiveOperatorSession(chatId)) {
    await forwardMaxToOperator(chatId, userText, userName);
    return;
  }

  const history = await getHistory(chatId);
  const { reply } = await runUnifiedBrainRequest({
    channel: "max",
    userText,
    history,
  });

  if (isCreditErrorReply(reply)) {
    await escalateMaxToOperator(chatId, `[CLAUDE CREDIT] ${userText}`, userName, { notifyUser: false });
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi: credit]");
    return;
  }

  if (isLanguageRefusal(reply) || reply.includes("[OPERATOR]")) {
    await escalateMaxToOperator(chatId, userText, userName);
    await saveMessage(chatId, "assistant", "[Operatorga yo'naltirildi]");
    return;
  }

  let cleanReply = removeOperatorPhrase(reply);
  if (history.some((h) => h.role === "assistant")) {
    cleanReply = stripLeadingGreeting(cleanReply);
  }
  await saveMessage(chatId, "assistant", cleanReply);
  await sendMax(chatId, cleanReply);
}

// MAX Bot API orqali matn yuborish. Natija: { ok, error? }.
async function sendMax(chatId, text) {
  if (!MAX_BOT_TOKEN) {
    console.error("MAX_BOT_TOKEN o'rnatilmagan — xabar yuborilmadi");
    return { ok: false, error: "MAX_BOT_TOKEN yo'q" };
  }
  try {
    const r = await fetch(`${MAX_API_URL}/messages?chat_id=${encodeURIComponent(chatId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: MAX_BOT_TOKEN,
      },
      body: JSON.stringify({ text, notify: true }),
    });
    const data = await r.json();
    // MAX xatoda { code, message } qaytaradi, muvaffaqiyatda { message: {...} }.
    if (!r.ok || data.code) {
      console.error("MAX send xato:", JSON.stringify(data));
      return { ok: false, error: data.message || data.code || `HTTP ${r.status}` };
    }
    return { ok: true, data };
  } catch (e) {
    console.error("MAX send exception:", e.message);
    return { ok: false, error: e.message };
  }
}

// MAX foydalanuvchisini operatorga (Telegram chatiga) eskalatsiya qilish.
async function escalateMaxToOperator(chatId, userText, userName, options = {}) {
  const { notifyUser = true } = options;
  const history = await getHistory(chatId);
  let historyText = "";
  if (history.length > 0) {
    const recent = history.slice(-10);
    historyText =
      "\n\n📜 Oxirgi suhbat:\n" +
      recent.map((h) => (h.role === "user" ? `👤: ${h.content}` : `🤖: ${h.content}`)).join("\n");
  }
  const forwardText = `🔵 MAX savol\n👤 ${userName} (chat: ${chatId})\n\n${userText}${historyText}`;
  for (const opId of OPERATOR_CHAT_IDS) {
    const sentMsg = await sendTelegramWithResult(opId, forwardText);
    if (sentMsg?.message_id) await saveMaxOperatorRequest(chatId, userText, sentMsg.message_id);
  }
  if (notifyUser) {
    await sendMax(chatId, "⏳ Savolingiz mas'ul xodimga yuborildi. Tez orada javob beramiz!");
  }
}

// Operator faol suhbatda bo'lsa, MAX xabarini unga uzatish.
async function forwardMaxToOperator(chatId, userText, userName) {
  const text = `💬 Davom MAX (${userName}, chat: ${chatId}):\n\n${userText}`;
  for (const opId of OPERATOR_CHAT_IDS) {
    const sentMsg = await sendTelegramWithResult(opId, text);
    if (sentMsg?.message_id) await saveMaxOperatorRequest(chatId, userText, sentMsg.message_id);
  }
}

async function saveMaxOperatorRequest(chatId, userText, msgId) {
  await fetch(`${SUPABASE_URL}/rest/v1/operator_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_chat_id: chatId,
      user_question: userText,
      operator_message_id: msgId,
      status: "pending",
      platform: "max",
    }),
  });
}

// ============================================================
// PRIVACY POLICY — Meta app'ni Live qilish uchun (/privacy)
// ============================================================
function handlePrivacy() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Musofir Shou — Privacy Policy</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:760px;margin:0 auto;padding:32px 20px;color:#1f2937;line-height:1.6}
  h1{color:#0ea5e9;font-size:26px}
  h2{font-size:18px;margin-top:28px;color:#0f172a}
  .date{color:#6b7280;font-size:14px}
  a{color:#0ea5e9}
</style>
</head>
<body>
<h1>Privacy Policy — Musofir Shou Support Bot</h1>
<p class="date">Last updated: 17 June 2026</p>

<p>This Privacy Policy explains how the Musofir Shou support assistant ("we", "the bot") collects and uses information when you contact us through Telegram, WhatsApp, or Instagram. By messaging us, you agree to this policy.</p>

<h2>1. Information We Collect</h2>
<ul>
  <li>The messages (text and voice) you send to us.</li>
  <li>Your messaging account identifier (e.g., Telegram chat ID, WhatsApp number, or Instagram user ID) and the display name provided by the platform.</li>
  <li>The conversation history between you and the bot or our support staff.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<ul>
  <li>To answer your questions and provide support about Musofir Shou.</li>
  <li>To connect you with a human support agent when needed.</li>
  <li>To improve the quality of our responses.</li>
</ul>

<h2>3. How We Process and Store Data</h2>
<p>Messages may be processed by AI services (OpenAI for voice transcription and embeddings, Anthropic for generating replies) solely to produce a response to you. Conversation data is stored securely in our database (Supabase). We do not sell your data or share it with third parties for advertising.</p>

<h2>4. Data Retention</h2>
<p>We keep conversation data only as long as needed to provide support and operate the service. You may request deletion of your data at any time.</p>

<h2>5. Your Rights</h2>
<p>You can request access to, or deletion of, your personal data by contacting us using the details below.</p>

<h2>6. Contact Us</h2>
<p>Phone: +998 88 785 17 97<br>Email: <a href="mailto:barxayotjonaliqulov@gmail.com">barxayotjonaliqulov@gmail.com</a></p>

<h2>7. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. The latest version will always be available at this page.</p>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ============================================================
// DASHBOARD
// ============================================================
async function handleDashboard(request) {
  const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const now = new Date();
  const d1  = new Date(now - 86400000).toISOString();
  const d7  = new Date(now - 7 * 86400000).toISOString();
  const d30 = new Date(now - 30 * 86400000).toISOString();
  const url = new URL(request.url);
  const view = (url.searchParams.get("view") || "all").toLowerCase();

  async function sbCount(query) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      headers: { ...SB, Prefer: "count=exact", Range: "0-0" },
    });
    return parseInt(r.headers.get("Content-Range")?.split("/")[1] ?? "0");
  }

  async function sbFetch(query) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers: SB });
    return r.json();
  }

  const [totalUsers, activeToday, activeWeek, activeMonth, totalMsgs, pendingOps, recentOps, recentMsgs, last30Rows, aiUsageRowsRaw] = await Promise.all([
    sbCount(`conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&select=chat_id`).then(async () => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&select=chat_id`, { headers: SB });
      const rows = await r.json();
      return new Set(rows.map(x => x.chat_id)).size;
    }),
    (async () => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&created_at=gte.${d1}&select=chat_id`, { headers: SB });
      const rows = await r.json();
      return new Set(rows.map(x => x.chat_id)).size;
    })(),
    (async () => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&created_at=gte.${d7}&select=chat_id`, { headers: SB });
      const rows = await r.json();
      return new Set(rows.map(x => x.chat_id)).size;
    })(),
    (async () => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&created_at=gte.${d30}&select=chat_id`, { headers: SB });
      const rows = await r.json();
      return new Set(rows.map(x => x.chat_id)).size;
    })(),
    sbCount(`conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&created_at=gte.${d1}&select=id`),
    sbCount(`operator_requests?status=eq.pending&select=id`),
    sbFetch(`operator_requests?status=eq.pending&order=created_at.desc&limit=10&select=user_chat_id,user_question,created_at`),
    sbFetch(`conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&role=eq.user&order=created_at.desc&limit=20&select=chat_id,content,created_at`),
    sbFetch(`conversations?chat_id=not.in.(${OPERATOR_IDS_FILTER})&created_at=gte.${d30}&select=role,content,created_at,chat_id`),
    sbFetch(`ai_usage?created_at=gte.${d30}&select=channel,phase,model,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,status`),
  ]);

  const seenUsers = new Set();
  const recentUniq = recentMsgs.filter(m => {
    if (seenUsers.has(m.chat_id)) return false;
    seenUsers.add(m.chat_id);
    return true;
  }).slice(0, 10);

  const channelCounts = { Telegram: 0, Instagram: 0, WhatsApp: 0, "Mini App": 0, MAX: 0 };
  const channelUsageCosts = { Telegram: 0, Instagram: 0, WhatsApp: 0, "Mini App": 0, MAX: 0 };
  const assistantRows = Array.isArray(last30Rows) ? last30Rows.filter(x => x.role === "assistant") : [];
  const userRows = Array.isArray(last30Rows) ? last30Rows.filter(x => x.role === "user") : [];
  const aiUsageRows = Array.isArray(aiUsageRowsRaw) ? aiUsageRowsRaw : [];
  const usageAvailable = Array.isArray(aiUsageRowsRaw) && aiUsageRows.length > 0;

  function classifyChannel(content) {
    const c = String(content || "").toLowerCase();
    if (c.includes("instagram")) return "Instagram";
    if (c.includes("whatsapp")) return "WhatsApp";
    if (c.includes("mini app") || c.includes("webapp")) return "Mini App";
    if (c.includes("max")) return "MAX";
    return "Telegram";
  }

  function normalizeChannelName(channel) {
    const c = String(channel || "").toLowerCase();
    if (c === "instagram") return "Instagram";
    if (c === "whatsapp") return "WhatsApp";
    if (c === "webapp" || c === "mini app") return "Mini App";
    if (c === "max") return "MAX";
    return "Telegram";
  }

  for (const row of [...userRows, ...assistantRows]) {
    channelCounts[classifyChannel(row.content)] += 1;
  }

  const fallbackReplies = assistantRows.filter(row => {
    const c = String(row.content || "").toLowerCase();
    return c.includes("operatorga") || c.includes("claude_credit_error") || c.includes("[operator]") || c.includes("operator") || c.includes("yo'naltirildi");
  }).length;
  const directReplies = assistantRows.length - fallbackReplies;
  const approxCostLegacy = (directReplies * 0.008) + (fallbackReplies * 0.002);

  let usageMainCalls = 0;
  let usageMainInputTokens = 0;
  let usageMainOutputTokens = 0;
  let usageMainCost = 0;
  let usageTotalCost = 0;
  let usageTrackedChannelsTotal = 0;

  for (const row of aiUsageRows) {
    const cost = estimateUsageCost(row);
    usageTotalCost += cost;

    const ch = normalizeChannelName(row.channel);
    if (Object.prototype.hasOwnProperty.call(channelUsageCosts, ch)) {
      channelUsageCosts[ch] += cost;
      usageTrackedChannelsTotal += cost;
    }

    if ((row.phase || "") === "main") {
      usageMainCalls += 1;
      usageMainInputTokens += toNum(row.input_tokens) + toNum(row.cache_creation_input_tokens) + toNum(row.cache_read_input_tokens);
      usageMainOutputTokens += toNum(row.output_tokens);
      usageMainCost += cost;
    }
  }

  const estCost = usageAvailable ? usageTotalCost : approxCostLegacy;

  const ts = now.toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" });
  const viewTitle = view === "cost" ? "💸 Xarajat tahlili" : view === "channels" ? "📈 Kanal bo‘yicha sarf" : "📊 Umumiy dashboard";

  const channelRows = Object.entries(channelCounts)
    .map(([name, count]) => {
      const cost = channelUsageCosts[name] || 0;
      return { name, count, cost };
    })
    .sort((a, b) => b.count - a.count);

  const html = `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Musofir Shou — Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:24px}
  h1{font-size:22px;font-weight:700;color:#38bdf8;margin-bottom:4px}
  .sub{font-size:13px;color:#64748b;margin-bottom:28px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px}
  .card{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155}
  .card .val{font-size:36px;font-weight:800;color:#38bdf8;line-height:1}
  .card .lbl{font-size:12px;color:#94a3b8;margin-top:6px}
  .card.warn .val{color:#f59e0b}
  .card.danger .val{color:#f87171}
  .tabs{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 24px}
  .tabs a{padding:8px 12px;border-radius:999px;background:#0f172a;border:1px solid #334155;color:#cbd5e1;text-decoration:none;font-size:13px}
  .tabs a.active{background:#38bdf8;color:#082f49;border-color:#38bdf8}
  section{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155;margin-bottom:20px}
  section h2{font-size:15px;font-weight:600;color:#cbd5e1;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:#64748b;font-weight:500;padding:6px 10px;border-bottom:1px solid #334155}
  td{padding:8px 10px;border-bottom:1px solid #1e293b;color:#cbd5e1;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .time{color:#64748b;font-size:11px}
  .msg{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .refresh-bar{display:flex;align-items:center;gap:10px;font-size:13px;color:#64748b;margin-bottom:20px}
  .refresh-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .progress{flex:1;max-width:120px;height:3px;background:#1e293b;border-radius:2px;overflow:hidden}
  .progress-fill{height:100%;background:#38bdf8;border-radius:2px;transition:width 1s linear}
</style>
</head>
<body>
<h1>Musofir Shou Dashboard</h1>
<div class="sub">${viewTitle}</div>
<div class="refresh-bar">
  <div class="refresh-dot"></div>
  <span id="ts">${ts}</span>
  <span>·</span>
  <div class="progress"><div class="progress-fill" id="pbar" style="width:100%"></div></div>
  <span id="countdown">30s</span>
</div>

<div class="tabs">
  <a href="/dashboard?key=${DASHBOARD_KEY}" class="${view === "all" ? "active" : ""}">Umumiy</a>
  <a href="/dashboard?key=${DASHBOARD_KEY}&view=cost" class="${view === "cost" ? "active" : ""}">💸 Xarajat</a>
  <a href="/dashboard?key=${DASHBOARD_KEY}&view=channels" class="${view === "channels" ? "active" : ""}">📈 Kanal</a>
</div>

<div class="grid">
  <div class="card">
    <div class="val">${totalUsers}</div>
    <div class="lbl">Jami foydalanuvchilar</div>
  </div>
  <div class="card">
    <div class="val">${activeToday}</div>
    <div class="lbl">Bugun aktiv</div>
  </div>
  <div class="card">
    <div class="val">${activeWeek}</div>
    <div class="lbl">7 kunda aktiv</div>
  </div>
  <div class="card">
    <div class="val">${activeMonth}</div>
    <div class="lbl">30 kunda aktiv</div>
  </div>
  <div class="card">
    <div class="val">${totalMsgs}</div>
    <div class="lbl">Bugungi xabarlar</div>
  </div>
  <div class="card ${pendingOps > 0 ? "danger" : ""}">
    <div class="val">${pendingOps}</div>
    <div class="lbl">Kutilayotgan so'rovlar</div>
  </div>
</div>

${(view === "all" || view === "cost") ? `
<section>
  <h2>💸 Xarajat tahlili (30 kun)</h2>
  <table>
    ${usageAvailable ? `
    <tr><th>Holat</th><th>Son</th><th>Qiymat</th></tr>
    <tr><td>Main Claude chaqiruvlari</td><td>${usageMainCalls}</td><td>$${usageMainCost.toFixed(2)}</td></tr>
    <tr><td>Main input tokenlar (cache bilan)</td><td>${usageMainInputTokens.toLocaleString("en-US")}</td><td>-</td></tr>
    <tr><td>Main output tokenlar</td><td>${usageMainOutputTokens.toLocaleString("en-US")}</td><td>-</td></tr>
    <tr><td>Barcha Claude chaqiruvlari (rewrite/enforce bilan)</td><td>${aiUsageRows.length}</td><td>$${usageTotalCost.toFixed(2)}</td></tr>
    <tr><td><b>Jami token-based sarf</b></td><td><b>${aiUsageRows.length}</b></td><td><b>$${usageTotalCost.toFixed(2)}</b></td></tr>
    ` : `
    <tr><th>Holat</th><th>Son</th><th>Taxminiy narx</th></tr>
    <tr><td>To'g'ridan-to'g'ri AI javoblar</td><td>${directReplies}</td><td>$${(directReplies * 0.008).toFixed(2)}</td></tr>
    <tr><td>Fallback / operatorga yo'naltirilganlar</td><td>${fallbackReplies}</td><td>$${(fallbackReplies * 0.002).toFixed(2)}</td></tr>
    <tr><td><b>Jami taxminiy sarf</b></td><td><b>${assistantRows.length}</b></td><td><b>$${approxCostLegacy.toFixed(2)}</b></td></tr>
    `}
  </table>
  <div class="sub" style="margin-top:12px">${usageAvailable ? "Token-based hisob ishga tushdi. Narxlar model tariflari bo'yicha hisoblanadi; Anthropic invoice bilan biroz farq bo'lishi mumkin." : "ai_usage jadvali hali to'lmagan yoki yo'q. Hozircha taxminiy model ko'rsatildi."}</div>
</section>` : ""}

${(view === "all" || view === "channels") ? `
<section>
  <h2>📈 Kanal bo'yicha sarf (30 kun)</h2>
  <table>
    <tr><th>Kanal</th><th>Xabarlar</th><th>Ulush</th><th>${usageAvailable ? "Token-based sarf" : "Taxminiy sarf"}</th></tr>
    ${channelRows.map(row => `
      <tr>
        <td>${row.name}</td>
        <td>${row.count}</td>
        <td>${((row.count / Math.max(1, [...channelRows].reduce((s, x) => s + x.count, 0))) * 100).toFixed(1)}%</td>
        <td>${usageAvailable ? `$${row.cost.toFixed(2)}` : "-"}</td>
      </tr>`).join("")}
  </table>
  ${usageAvailable ? `<div class="sub" style="margin-top:12px">Kanal kesimidagi jami: $${usageTrackedChannelsTotal.toFixed(2)}</div>` : ""}
</section>` : ""}

${pendingOps > 0 ? `
<section>
  <h2>⚠️ Operator kutilmoqda (${pendingOps})</h2>
  <table>
    <tr><th>User ID</th><th>Savol</th><th>Vaqt</th></tr>
    ${(Array.isArray(recentOps) ? recentOps : []).map(op => `
    <tr>
      <td>${op.user_chat_id}</td>
      <td class="msg">${(op.user_question || "").slice(0, 80)}</td>
      <td class="time">${new Date(op.created_at).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })}</td>
    </tr>`).join("")}
  </table>
</section>` : ""}

<section>
  <h2>💬 So'nggi faol foydalanuvchilar</h2>
  <table>
    <tr><th>User ID</th><th>Oxirgi xabar</th><th>Vaqt</th></tr>
    ${recentUniq.map(m => `
    <tr>
      <td>${m.chat_id}</td>
      <td class="msg">${(m.content || "").slice(0, 80)}</td>
      <td class="time">${new Date(m.created_at).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })}</td>
    </tr>`).join("")}
  </table>
</section>

<script>
  const INTERVAL = 30;
  let left = INTERVAL;
  const pbar = document.getElementById("pbar");
  const cd   = document.getElementById("countdown");
  const ts   = document.getElementById("ts");
  setInterval(() => {
    left--;
    cd.textContent = left + "s";
    pbar.style.width = (left / INTERVAL * 100) + "%";
    if (left <= 0) {
      cd.textContent = "yangilanmoqda...";
      location.reload();
    }
  }, 1000);
</script>
</body>
</html>`

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ============================================================
// WEB APP HANDLERS — Telegram Mini App
// ============================================================

// CORS headers
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

// POST /webapp/init — Telegram Web App init data validate + user info
async function handleWebAppInit(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST required" }), { status: 400, headers: CORS_HEADERS });
  }

  try {
    const data = await request.json();
    const initData = data.initData; // Telegram InitData (xash bilan)

    if (!initData) {
      return new Response(JSON.stringify({ error: "initData required" }), { status: 400, headers: CORS_HEADERS });
    }

    console.log("[INIT] ========== SIGNATURE DEBUG START ==========");
    console.log("[INIT] TELEGRAM_BOT_TOKEN mavjudmi?", !!TELEGRAM_BOT_TOKEN);
    console.log("[INIT] TELEGRAM_BOT_TOKEN length:", TELEGRAM_BOT_TOKEN?.length || 0);
    console.log("[INIT] initData length:", initData.length);
    console.log("[INIT] initData (first 200 chars):", initData.substring(0, 200));

    // Parse initData
    const parts = new URLSearchParams(initData);
    const hashFromData = parts.get("hash");
    
    console.log("[INIT] Hash from initData:", hashFromData);
    console.log("[INIT] All fields:", Array.from(parts.keys()));

    // IMPORTANT: Exclude BOTH hash AND signature from data to validate
    const dataStr = [...parts.entries()]
      .filter(([key]) => key !== "hash" && key !== "signature")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${key}=${val}`)
      .join("\n");

    console.log("[INIT] Data string for hashing:", dataStr);

    // Validate using Telegram Web App algorithm:
    // secret_key = SHA256(bot_token) (raw bytes), then HMAC-SHA256(dataStr, secret_key)
    try {
      if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.length === 0) {
        console.error("[INIT] Missing TELEGRAM_BOT_TOKEN in runtime env");
        return new Response(JSON.stringify({ error: "Server misconfiguration" }), { status: 500, headers: CORS_HEADERS });
      }

      // Compute SHA-256 of bot token to use as HMAC key (raw bytes)
      const botTokenHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TELEGRAM_BOT_TOKEN));
      const hmacKey = await crypto.subtle.importKey(
        "raw",
        botTokenHash,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signature = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(dataStr));
      const calculatedHash = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");

      console.log("[INIT] Calculated hash:", calculatedHash);
      console.log("[INIT] Expected hash:  ", hashFromData);

      if (calculatedHash === hashFromData) {
        console.log("[INIT] ✅ SIGNATURE VALID!");
        console.log("[INIT] ========== SIGNATURE DEBUG END ==========");

        // Extract user info
        const userStr = parts.get("user");
        const user = userStr ? JSON.parse(decodeURIComponent(userStr)) : { id: 0, is_bot: false };
        const chatId = user.id;
        const history = await getHistory(chatId);

        return new Response(JSON.stringify({
          ok: true,
          chat_id: chatId,
          user: { id: user.id, first_name: user.first_name || "User", username: user.username },
          history: history.slice(-20),
        }), { status: 200, headers: CORS_HEADERS });
      } else {
        console.error("[INIT] ❌ HASH MISMATCH - Signature validation failed");
        console.log("[INIT] ========== SIGNATURE DEBUG END ==========");
        return new Response(JSON.stringify({ error: "Signature validation failed" }), { status: 403, headers: CORS_HEADERS });
      }
    } catch (e) {
      console.error("[INIT] Signature validation error:", e && e.message ? e.message : e);
      console.log("[INIT] ========== SIGNATURE DEBUG END ==========");
      return new Response(JSON.stringify({ error: "Signature validation error" }), { status: 500, headers: CORS_HEADERS });
    }
  } catch (e) {
    console.error("webapp/init error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// POST /webapp/chat — yangi xabar yuborish
async function handleWebAppChat(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST required" }), { status: 400, headers: CORS_HEADERS });
  }

  try {
    const data = await request.json();
    const chatId = data.chat_id || 0;
    const userText = data.message || "";
    const topic = data.topic || "musofir";
    const userProfile = data.profile || null;
    const imageBase64 = data.image_base64 || null;
    const imageType = data.image_type || "image/jpeg";
    const documentBase64 = data.document_base64 || null;
    const documentMime = data.document_mime || "application/pdf";
    const documentName = data.document_name || null;
    const isAuto = data._auto === true; // profil yaratilgandan keyin avtomatik birinchi xabar

    if (!chatId || (!userText && !imageBase64 && !documentBase64)) {
      return new Response(JSON.stringify({ error: "chat_id, message or attachment required" }), { status: 400, headers: CORS_HEADERS });
    }

    if (userText.length > 2000) {
      return new Response(JSON.stringify({ error: "Message too long" }), { status: 400, headers: CORS_HEADERS });
    }

    // Rasm ham, hujjat ham bitta biriktirma sifatida ishlanadi
    // (frontend rasm uchun ikkala maydonni ham yuboradi).
    const attachmentBase64 = documentBase64 || imageBase64;
    const attachmentMime = documentBase64 ? documentMime : imageType;
    const attachmentName = documentName || (imageBase64 ? "rasm" : null);
    const attachmentKind = attachmentBase64 ? detectAttachmentKind(attachmentMime, attachmentName) : null;
    const hasAttachment = !!attachmentBase64;

    // Eski (keshlangan) Mini App faqat fayl NOMINI yuboradi, baytlarini emas.
    // Bunda tahlil qiladigan narsa yo'q — Claude'ni chaqirmasdan aniq javob beramiz,
    // aks holda model "hech qanday fayl ko'rinmayapti" deb chalkash javob qaytaradi.
    if (documentName && !attachmentBase64) {
      console.warn("[DOC] fayl nomi keldi, baytlari yo'q", { chatId, documentName });
      const missingMsg = `"${documentName}" faylining mazmuni serverga yetib kelmadi. Mini App'ni yopib qayta oching — eski versiya keshda qolgan bo'lishi mumkin — va faylni qayta yuboring. Yoki hujjatdagi matnni ko'chirib shu yerga yozing, darhol tahlil qilaman.`;
      await saveMessage(chatId, "user", `[Biriktirma: ${documentName}]\n${userText}`);
      await saveMessage(chatId, "assistant", missingMsg);
      return new Response(JSON.stringify({ ok: true, reply: missingMsg }), { status: 200, headers: CORS_HEADERS });
    }

    console.log("[DOC] incoming upload", {
      chatId,
      attachmentName,
      attachmentMime,
      attachmentKind,
      base64Length: attachmentBase64 ? attachmentBase64.length : 0,
      userTextLength: userText.length,
    });

    const attachments = [];   // Claude ga yuboriladigan content bloklari
    let attachmentNote = "";  // blok qo'llab-quvvatlanmasa — ajratilgan matn
    let attachmentTag = "";   // tarixda ko'rinadigan qisqa marker

    if (hasAttachment) {
      attachmentTag = `[Biriktirma: ${attachmentName || attachmentMime}]`;
      const block = buildAttachmentBlock(attachmentKind, attachmentBase64, attachmentMime);

      if (block) {
        // PDF va qo'llab-quvvatlanadigan rasm — Claude o'zi o'qiydi (skan PDF ham).
        attachments.push(block);
        console.log("[DOC] native block", { chatId, type: block.type });
      } else {
        // docx/xlsx/txt yoki qo'llab-quvvatlanmaydigan rasm — matnga aylantiramiz.
        let extracted = await extractDocumentText(attachmentBase64, attachmentMime, attachmentName);
        if (!extracted) {
          console.log("[OCR] Native extraction empty, trying OCR.space fallback...");
          extracted = await ocrSpaceRecognize(attachmentBase64, attachmentMime, OCR_SPACE_API_KEY);
        }
        console.log("[DOC] extracted result", { chatId, attachmentName, extractedLength: extracted.length });

        if (extracted) {
          attachmentNote = `\n\n[Hujjat matni: ${attachmentName}]\n${extracted.slice(0, 20000)}`;
        } else {
          attachmentNote = `\n\n[Bu fayl formatidan matn ajratib bo'lmadi. Foydalanuvchidan hujjatning muhim qismlarini matn ko'rinishida yoki skrinshot qilib yuborishni so'ra.]`;
        }
      }
    }

    // Foydalanuvchi faqat fayl yuborsa ham, AI ga aniq vazifa beramiz.
    const baseText = userText.trim() || (hasAttachment
      ? "Shu hujjatni tahlil qil: nima haqida ekanini, muhim shartlarni va e'tibor berishim kerak bo'lgan xavflarni tushuntir."
      : "");
    // Tarixga qisqa versiya, Claude ga to'liq versiya (hujjat matni bilan) ketadi.
    const historyText = attachmentTag ? `${attachmentTag}\n${baseText}` : baseText;
    const promptText = historyText + attachmentNote;

    // Profil asosida extraSystem va customPrompt qurish
    let extraSystem = "";
    let customPrompt = undefined;

    if (topic === "musofir_ai" && userProfile) {
      const lines = [];
      if (userProfile.countryLabel)    lines.push(`Manzil: ${userProfile.countryLabel}`);
      if (userProfile.professionLabel) lines.push(`Kasb: ${userProfile.professionLabel}`);
      if (userProfile.departureDate)   lines.push(`Chiqish sanasi: ${userProfile.departureDate}`);
      if (userProfile.isFirstTrip)     lines.push(`Birinchi safar: ${userProfile.isFirstTrip === "yes" ? "Ha" : "Yoq"}`);
      if (userProfile.language)        lines.push(`Til: ${userProfile.language}`);
      if (userProfile.hasContract)     lines.push(`Shartnoma: ${userProfile.hasContract === "yes" ? "Bor" : "Yoq"}`);
      extraSystem = `═══ FOYDALANUVCHI PROFILI ═══\n${lines.join("\n")}\n═══════════════════════════`;
      customPrompt = MUSOFIR_AI_SYSTEM_PROMPT;
    }

    console.log(`[CHAT] User ${chatId} [${topic}]${isAuto ? " [auto]" : ""}: "${historyText.substring(0, 60)}"`);

    if (!isAuto) await saveMessage(chatId, "user", historyText);

    const history = await getHistory(chatId);

    const { ragChunks, reply } = await runUnifiedBrainRequest({
      channel: "webapp",
      userText: promptText,
      // RAG qidiruvi va web-rejim qarori qisqa matn bo'yicha hal qilinadi:
      // to'liq hujjat matni embeddingni ham, isWebIntent'ni ham buzib yuboradi.
      knowledgeQuery: historyText,
      history,
      knowledgeOptions: { enableWeb: topic === "musofir_ai" && !hasAttachment },
      askOptions: {
        ...(customPrompt ? { customSystemPrompt: customPrompt } : {}),
        ...(extraSystem  ? { extraSystem } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(hasAttachment ? { maxTokens: 900 } : {}),
        enforceUzbek: topic !== "musofir_ai",
      },
    });

    const webMode = isWebIntent(historyText);

    let cleanReply = reply;
    if (isCreditErrorReply(reply)) {
      cleanReply = "[Operatorga yo'naltirildi: credit]";
      await escalateToOperator(chatId, `[CLAUDE CREDIT][webapp] ${historyText}`, { chat: { id: chatId }, from: { id: chatId }, business_connection_id: null }, { notifyUser: false });
    }
    if (webMode) cleanReply = stripLeadingQuestionEcho(cleanReply, historyText);

    if (reply.includes("[OPERATOR]")) {
      if (webMode) {
        cleanReply = summarizeWebChunks(ragChunks);
      } else if (topic === "musofir_ai") {
        cleanReply = "Bu savol bo'yicha to'liq ma'lumot bazamizda yo'q. Operator yordamini tavsiya qilaman — @musofir_shou_bot orqali murojaat qiling.";
      } else {
        cleanReply = "[Muammoga operator yordami kerak. Iltimos, operatorga murojaat qiling.]";
        await escalateToOperator(chatId, historyText, { chat: { id: chatId }, from: { id: chatId }, business_connection_id: null }, { notifyUser: false });
      }
    }

    await saveMessage(chatId, "assistant", cleanReply);

    return new Response(JSON.stringify({
      ok: true,
      reply: cleanReply,
    }), { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.error("webapp/chat error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// GET /webapp/history — suhbat tarixini olish
async function handleWebAppHistory(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(request.url);
    const chatId = parseInt(url.searchParams.get("chat_id") || "0");

    if (!chatId) {
      return new Response(JSON.stringify({ error: "chat_id required" }), { status: 400, headers: CORS_HEADERS });
    }

    const history = await getHistory(chatId);

    return new Response(JSON.stringify({
      ok: true,
      history: history,
    }), { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.error("webapp/history error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS_HEADERS });
  }
}

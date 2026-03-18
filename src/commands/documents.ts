/**
 * @module commands/documents
 * @description Grammy Composer for document management commands:
 * /docs (list, search, stats, delete, categories) + inline callbacks
 * (doc_confirm, doc_change, doc_cancel) for classification confirmation.
 * S45-T3.
 */

import { Composer, Context, InlineKeyboard } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { ALLOWED_USER_ID, escapeHtml } from "../bot-context.ts";
import {
  listDocuments,
  getDocumentById,
  deleteDocument,
  searchDocuments,
  getDocumentStats,
  getCategories,
  createSignedUrls,
} from "../documents.ts";
import type { Document, DocumentCategory } from "../documents.ts";

// ── Constants ────────────────────────────────────────────────

const CLASSIFICATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Pending classification state ─────────────────────────────

interface PendingClassification {
  documentId: string;
  categoryId: string;
  categoryName: string;
  createdAt: number;
}

// In-memory map: chatId -> pending classification
const pendingClassifications = new Map<number, PendingClassification>();

// Auto-confirm after timeout
function schedulePendingTimeout(chatId: number, supabase: NonNullable<BotContext["supabase"]>) {
  setTimeout(async () => {
    const pending = pendingClassifications.get(chatId);
    if (!pending) return;

    // Still the same pending? Auto-confirm
    pendingClassifications.delete(chatId);
    console.log(`Auto-confirmed classification for document ${pending.documentId} after timeout`);
  }, CLASSIFICATION_TIMEOUT_MS);
}

// ── Formatters ───────────────────────────────────────────────

function formatDocumentLine(doc: Document, index: number): string {
  const date = new Date(doc.created_at).toLocaleDateString("fr-FR");
  const title = doc.title || "Sans titre";
  const id = doc.id.substring(0, 8);
  const size = doc.file_size ? `${Math.round(doc.file_size / 1024)}Ko` : "";
  return `${index + 1}. ${title} [${id}] ${date}${size ? ` (${size})` : ""}`;
}

function formatDocumentLineHtml(doc: Document, index: number, url?: string): string {
  const date = new Date(doc.created_at).toLocaleDateString("fr-FR");
  const title = escapeHtml(doc.title || "Sans titre");
  const id = doc.id.substring(0, 8);
  const size = doc.file_size ? `${Math.round(doc.file_size / 1024)}Ko` : "";
  const titlePart = url ? `<a href="${escapeHtml(url)}">${title}</a>` : title;
  return `${index + 1}. ${titlePart} [${id}] ${date}${size ? ` (${size})` : ""}`;
}

function formatDocumentDetail(doc: Document): string {
  const date = new Date(doc.created_at).toLocaleDateString("fr-FR");
  const lines = [
    `DOCUMENT [${doc.id.substring(0, 8)}]`,
    `Titre: ${doc.title || "Sans titre"}`,
    doc.description ? `Description: ${doc.description}` : "",
    `Type: ${doc.file_type}`,
    doc.file_size ? `Taille: ${Math.round(doc.file_size / 1024)}Ko` : "",
    doc.document_date ? `Date document: ${doc.document_date}` : "",
    `Ajoute le: ${date}`,
  ];
  return lines.filter(Boolean).join("\n");
}

function formatDocumentDetailHtml(doc: Document, url: string): string {
  const date = new Date(doc.created_at).toLocaleDateString("fr-FR");
  const title = escapeHtml(doc.title || "Sans titre");
  const lines = [
    `DOCUMENT [${doc.id.substring(0, 8)}]`,
    `Titre: <a href="${escapeHtml(url)}">${title}</a>`,
    doc.description ? `Description: ${escapeHtml(doc.description)}` : "",
    `Type: ${escapeHtml(doc.file_type)}`,
    doc.file_size ? `Taille: ${Math.round(doc.file_size / 1024)}Ko` : "",
    doc.document_date ? `Date document: ${escapeHtml(doc.document_date)}` : "",
    `Ajoute le: ${date}`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ── Composer ─────────────────────────────────────────────────

export default function documentsCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /docs — Document management subcommands
  composer.command("docs", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "docs");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const input = ctx.match?.trim() || "";
    const parts = input.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || "list";
    const arg = parts.slice(1).join(" ");
    const userId = ctx.from?.id?.toString() || ALLOWED_USER_ID;

    // ── /docs list ──────────────────────────────────────────
    if (subcommand === "list" || (!input && subcommand === "list")) {
      const docs = await listDocuments(bctx.supabase, userId, { limit: 10 });
      if (docs.length === 0) {
        await ctx.reply("Aucun document enregistre.", bctx.threadOpts(ctx));
        return;
      }

      const filePaths = docs.map((d) => d.file_path).filter(Boolean);
      const urlMap = await createSignedUrls(bctx.supabase, filePaths);

      const hasUrls = urlMap.size > 0;
      const lines = docs.map((d, i) => {
        const url = urlMap.get(d.file_path);
        if (hasUrls) {
          return formatDocumentLineHtml(d, i, url);
        }
        const line = formatDocumentLine(d, i);
        return url ? `${line}\n  ${url}` : line;
      });
      const text = `DOCUMENTS RECENTS (${docs.length})\n\n${lines.join("\n")}\n\nUtilise /docs search &lt;query&gt; pour chercher.`;
      if (hasUrls) {
        await bctx.sendResponseHtml(ctx, text);
      } else {
        await bctx.sendResponse(ctx, `DOCUMENTS RECENTS (${docs.length})\n\n${lines.join("\n")}\n\nUtilise /docs search <query> pour chercher.`);
      }
      return;
    }

    // ── /docs search <query> ────────────────────────────────
    if (subcommand === "search") {
      if (!arg) {
        await ctx.reply("Usage: /docs search <requete>", bctx.threadOpts(ctx));
        return;
      }

      await ctx.replyWithChatAction("typing");
      const results = await searchDocuments(bctx.supabase, arg, userId);
      if (results.length === 0) {
        await ctx.reply(`Aucun document trouve pour "${arg}".`, bctx.threadOpts(ctx));
        return;
      }

      const top = results.slice(0, 10);
      const filePaths = top.map((r) => r.file_path).filter((p): p is string => !!p);
      const urlMap = await createSignedUrls(bctx.supabase, filePaths);

      const hasUrls = urlMap.size > 0;
      const lines = top.map((r, i) => {
        const title = r.title || "Sans titre";
        const id = r.id.substring(0, 8);
        const score = Math.round(r.similarity * 100);
        const desc = r.description ? ` — ${r.description.substring(0, 60)}` : "";
        const url = r.file_path ? urlMap.get(r.file_path) : undefined;
        if (hasUrls) {
          const escapedTitle = escapeHtml(title);
          const titlePart = url ? `<a href="${escapeHtml(url)}">${escapedTitle}</a>` : escapedTitle;
          const escapedDesc = escapeHtml(desc);
          return `${i + 1}. ${titlePart} [${id}] (${score}%)${escapedDesc}`;
        }
        const line = `${i + 1}. ${title} [${id}] (${score}%)${desc}`;
        return url ? `${line}\n  ${url}` : line;
      });
      const header = hasUrls ? escapeHtml(`RESULTATS POUR "${arg}" (${results.length})`) : `RESULTATS POUR "${arg}" (${results.length})`;
      if (hasUrls) {
        await bctx.sendResponseHtml(ctx, `${header}\n\n${lines.join("\n")}`);
      } else {
        await bctx.sendResponse(ctx, `${header}\n\n${lines.join("\n")}`);
      }
      return;
    }

    // ── /docs stats ─────────────────────────────────────────
    if (subcommand === "stats") {
      const stats = await getDocumentStats(bctx.supabase, userId);
      if (stats.total === 0) {
        await ctx.reply("Aucun document enregistre.", bctx.threadOpts(ctx));
        return;
      }

      const catLines = stats.byCategory.map((c) => `  ${c.name}: ${c.count}`);
      const text = [
        `STATISTIQUES DOCUMENTS`,
        `Total: ${stats.total}`,
        "",
        "Par categorie:",
        ...catLines,
      ].join("\n");
      await bctx.sendResponse(ctx, text);
      return;
    }

    // ── /docs delete <id> ───────────────────────────────────
    if (subcommand === "delete") {
      if (!arg) {
        await ctx.reply("Usage: /docs delete <id>", bctx.threadOpts(ctx));
        return;
      }

      const idPrefix = arg.trim().toLowerCase();
      // Find document by prefix
      const docs = await listDocuments(bctx.supabase, userId, { limit: 100 });
      const doc = docs.find((d) => d.id.startsWith(idPrefix));
      if (!doc) {
        await ctx.reply(`Aucun document trouve avec l'ID "${idPrefix}".`, bctx.threadOpts(ctx));
        return;
      }

      // Confirmation keyboard
      const keyboard = new InlineKeyboard()
        .text("Confirmer suppression", `doc_delete_confirm:${doc.id}`)
        .text("Annuler", `doc_delete_cancel:${doc.id}`);

      await ctx.reply(
        `Supprimer "${doc.title || "Sans titre"}" [${doc.id.substring(0, 8)}] ?\nType: ${doc.file_type}`,
        { ...bctx.threadOpts(ctx), reply_markup: keyboard },
      );
      return;
    }

    // ── /docs categories ────────────────────────────────────
    if (subcommand === "categories") {
      const categories = await getCategories(bctx.supabase);
      if (categories.length === 0) {
        await ctx.reply("Aucune categorie.", bctx.threadOpts(ctx));
        return;
      }

      const lines = categories.map((c) => `  ${c.name} (${c.usage_count})`);
      await bctx.sendResponse(ctx, `CATEGORIES (${categories.length})\n\n${lines.join("\n")}`);
      return;
    }

    // ── /docs <id> — view document detail ───────────────────
    if (subcommand.length <= 8 && /^[a-f0-9]+$/.test(subcommand)) {
      const docs = await listDocuments(bctx.supabase, userId, { limit: 100 });
      const doc = docs.find((d) => d.id.startsWith(subcommand));
      if (!doc) {
        await ctx.reply(`Aucun document trouve avec l'ID "${subcommand}".`, bctx.threadOpts(ctx));
        return;
      }
      let detail = formatDocumentDetail(doc);
      let useHtml = false;
      if (doc.file_path) {
        const urlMap = await createSignedUrls(bctx.supabase, [doc.file_path]);
        const url = urlMap.get(doc.file_path);
        if (url) {
          detail = formatDocumentDetailHtml(doc, url);
          useHtml = true;
        }
      }
      if (useHtml) {
        await bctx.sendResponseHtml(ctx, detail);
      } else {
        await bctx.sendResponse(ctx, detail);
      }
      return;
    }

    // ── Unknown subcommand → show usage ─────────────────────
    await ctx.reply(
      "Usage:\n/docs list — 10 derniers documents\n/docs search <query> — recherche semantique\n/docs stats — statistiques\n/docs delete <id> — supprimer\n/docs categories — liste des categories\n/docs <id> — detail d'un document",
      bctx.threadOpts(ctx),
    );
  });

  // ── Callback query handlers ───────────────────────────────

  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    if (!data.startsWith("doc_")) {
      await next();
      return;
    }

    if (!bctx.supabase) {
      await ctx.answerCallbackQuery({ text: "Supabase non configure." });
      return;
    }

    const userId = ctx.from?.id?.toString() || ALLOWED_USER_ID;

    // ── doc_confirm:<docId> — confirm classification ────────
    if (data.startsWith("doc_confirm:")) {
      const docId = data.split(":")[1];
      if (!docId) {
        await ctx.answerCallbackQuery({ text: "ID manquant." });
        return;
      }

      // Clear pending classification
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (chatId) pendingClassifications.delete(chatId);

      await ctx.answerCallbackQuery({ text: "Classification confirmee !" });
      const doc = await getDocumentById(bctx.supabase, docId);
      if (doc) {
        await ctx.editMessageText(
          `Document classe: ${doc.title || "Sans titre"} [${doc.id.substring(0, 8)}]\nClassification confirmee.`,
        );
      }
      return;
    }

    // ── doc_change:<docId> — show category picker ───────────
    if (data.startsWith("doc_change:")) {
      const docId = data.split(":")[1];
      if (!docId) {
        await ctx.answerCallbackQuery({ text: "ID manquant." });
        return;
      }

      const categories = await getCategories(bctx.supabase);
      if (categories.length === 0) {
        await ctx.answerCallbackQuery({ text: "Aucune categorie disponible." });
        return;
      }

      // Build category grid (2 per row)
      // Use 8-char short IDs to stay within Telegram's 64-byte callback_data limit
      const shortDocId = docId.substring(0, 8);
      const keyboard = new InlineKeyboard();
      for (let i = 0; i < categories.length; i++) {
        const shortCatId = categories[i].id.substring(0, 8);
        keyboard.text(categories[i].name, `dsc:${shortDocId}:${shortCatId}`);
        if (i % 2 === 1 && i < categories.length - 1) keyboard.row();
      }
      // "Autre" always on a new row
      keyboard.row().text("Autre", `doc_newcat:${shortDocId}`);

      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Choisir une categorie:", { reply_markup: keyboard });
      return;
    }

    // ── dsc:<shortDocId>:<shortCatId> — apply category (short IDs) ────
    if (data.startsWith("dsc:")) {
      const parts = data.split(":");
      const shortDocId = parts[1];
      const shortCatId = parts[2];
      if (!shortDocId || !shortCatId) {
        await ctx.answerCallbackQuery({ text: "Donnees manquantes." });
        return;
      }

      // Resolve full IDs from short prefixes
      const { data: docRow } = await bctx.supabase
        .from("documents")
        .select("id")
        .like("id", `${shortDocId}%`)
        .limit(1)
        .single();
      const { data: catRow } = await bctx.supabase
        .from("document_categories")
        .select("id, name")
        .like("id", `${shortCatId}%`)
        .limit(1)
        .single();

      if (!docRow || !catRow) {
        await ctx.answerCallbackQuery({ text: "Document ou categorie introuvable." });
        return;
      }

      const { error } = await bctx.supabase
        .from("documents")
        .update({ category_id: catRow.id })
        .eq("id", docRow.id);

      if (error) {
        console.error("dsc error:", error);
        await ctx.answerCallbackQuery({ text: "Erreur lors de la mise a jour." });
        return;
      }

      // Clear pending
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (chatId) pendingClassifications.delete(chatId);

      await ctx.answerCallbackQuery({ text: "Categorie mise a jour !" });
      const doc = await getDocumentById(bctx.supabase, docRow.id);
      await ctx.editMessageText(
        `Document: ${doc?.title || "Sans titre"} [${shortDocId}]\nCategorie: ${catRow.name}\nClassification confirmee.`,
      );
      return;
    }

    // ── doc_newcat:<docId> — prompt user to type category ───
    if (data.startsWith("doc_newcat:")) {
      const docId = data.split(":")[1];
      if (!docId) {
        await ctx.answerCallbackQuery({ text: "ID manquant." });
        return;
      }

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `Document [${docId.substring(0, 8)}]\nEnvoie le nom de la nouvelle categorie en message.`,
      );
      return;
    }

    // ── doc_cancel:<docId> — cancel, delete document ────────
    if (data.startsWith("doc_cancel:")) {
      const docId = data.split(":")[1];
      if (!docId) {
        await ctx.answerCallbackQuery({ text: "ID manquant." });
        return;
      }

      const deleted = await deleteDocument(bctx.supabase, docId);

      // Clear pending
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (chatId) pendingClassifications.delete(chatId);

      if (deleted) {
        await ctx.answerCallbackQuery({ text: "Document annule." });
        await ctx.editMessageText("Document annule et supprime.");
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur lors de la suppression." });
      }
      return;
    }

    // ── doc_delete_confirm:<docId> — confirm deletion ───────
    if (data.startsWith("doc_delete_confirm:")) {
      const docId = data.split(":")[1];
      if (!docId) {
        await ctx.answerCallbackQuery({ text: "ID manquant." });
        return;
      }

      const deleted = await deleteDocument(bctx.supabase, docId);
      if (deleted) {
        await ctx.answerCallbackQuery({ text: "Document supprime !" });
        await ctx.editMessageText(`Document [${docId.substring(0, 8)}] supprime.`);
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur lors de la suppression." });
      }
      return;
    }

    // ── doc_delete_cancel:<docId> — cancel deletion ─────────
    if (data.startsWith("doc_delete_cancel:")) {
      const docId = data.split(":")[1];
      await ctx.answerCallbackQuery({ text: "Suppression annulee." });
      await ctx.editMessageText(`Suppression annulee [${(docId || "").substring(0, 8)}].`);
      return;
    }

    // Not a recognized doc_ prefix — pass to next handler
    await next();
  });

  return composer;
}

// ── Exported helpers (for use by zz-messages document handler) ─

/**
 * Build inline keyboard for classification confirmation.
 * Used by the document message handler after creating a document.
 */
export function buildClassificationKeyboard(
  docId: string,
  categoryName: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Confirmer (${categoryName})`, `doc_confirm:${docId}`)
    .row()
    .text("Changer categorie", `doc_change:${docId}`)
    .text("Annuler", `doc_cancel:${docId}`);
}

/**
 * Register a pending classification for timeout tracking.
 */
export function registerPendingClassification(
  chatId: number,
  docId: string,
  categoryId: string,
  categoryName: string,
  supabase: NonNullable<BotContext["supabase"]>,
): void {
  pendingClassifications.set(chatId, {
    documentId: docId,
    categoryId,
    categoryName,
    createdAt: Date.now(),
  });
  schedulePendingTimeout(chatId, supabase);
}

/**
 * Check if there is a pending classification for a chat.
 */
export function getPendingClassification(chatId: number): PendingClassification | undefined {
  return pendingClassifications.get(chatId);
}

/**
 * Clear pending classification for a chat.
 */
export function clearPendingClassification(chatId: number): void {
  pendingClassifications.delete(chatId);
}

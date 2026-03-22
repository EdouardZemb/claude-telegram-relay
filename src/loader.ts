/**
 * @module loader
 * @description Auto-discovers and loads Composer modules from src/commands/.
 * Each file exports a factory function (ctx: BotContext) => Composer or a Composer directly.
 * Files are loaded in alphabetical order; prefix with "zz-" for last-loaded handlers.
 */

import { Glob } from "bun";
import { type Bot, Composer, type Context } from "grammy";
import { basename, join } from "path";
import type { BotContext } from "./bot-context.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("loader");

/**
 * Scan src/commands/*.ts, import each module, and mount the exported Composer
 * on the bot wrapped in an errorBoundary.
 */
export async function loadComposers(bot: Bot, ctx: BotContext): Promise<number> {
  const commandsDir = join(import.meta.dir, "commands");
  const glob = new Glob("*.ts");
  const files: string[] = [];

  for await (const file of glob.scan(commandsDir)) {
    files.push(file);
  }

  // Sort alphabetically — ensures "zz-" prefixed files load last
  files.sort();

  let loaded = 0;

  for (const file of files) {
    const filePath = join(commandsDir, file);
    const moduleName = basename(file, ".ts");

    try {
      const mod = await import(filePath);
      const exported = mod.default;

      if (!exported) {
        log.warn(`${file}: no default export, skipping`);
        continue;
      }

      let composer: Composer<Context>;

      if (typeof exported === "function") {
        // Factory function: (ctx: BotContext) => Composer
        const result = exported(ctx);
        if (result instanceof Composer) {
          composer = result;
        } else {
          log.warn(`${file}: factory did not return a Composer, skipping`);
          continue;
        }
      } else if (exported instanceof Composer) {
        composer = exported;
      } else {
        log.warn(`${file}: default export is not a Composer or factory, skipping`);
        continue;
      }

      // Mount with errorBoundary for isolation
      bot.use(
        bot.errorBoundary((err) => {
          log.error(`${err.error}`, { errorModule: moduleName });
        }, composer),
      );

      loaded++;
      log.info(`Loaded: ${file}`);
    } catch (error) {
      log.error(`Failed to load ${file}`, { error: String(error) });
      // Continue loading other modules
    }
  }

  log.info(`${loaded}/${files.length} composers loaded`);
  return loaded;
}

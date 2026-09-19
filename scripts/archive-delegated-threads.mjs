#!/usr/bin/env node
// Разовая уборка: скрыть делегированные треды, оставшиеся видимыми.
//
// Заведён после того, как выяснилось, что архивацию в fork.10 получил только
// путь задач, а ревью шло мимо неё (см. runAppServerReview). Сама починка
// закрывает будущие прогоны; уже созданные треды никуда не денутся — их
// закрывает этот скрипт.
//
// Идёт официальным путём app-server (thread/list + thread/archive), а не
// UPDATE по ~/.codex/state_5.sqlite: базу держит живой Codex, и запись мимо
// сервера не доедет ни до его кэша, ни до синхронизации.
//
//   node scripts/archive-delegated-threads.mjs            # только показать
//   node scripts/archive-delegated-threads.mjs --apply    # архивировать
//
// Имена сверяются с isTaskThreadName, то есть трогаются РОВНО наши префиксы
// ("Codex Task", "Codex Review", "Codex Rescue" и легаси-имя). Чужая сессия,
// начатая человеком, под фильтр не попадает.

import process from "node:process";
import { withAppServer } from "../plugins/codex/scripts/lib/codex.mjs";
import { isTaskThreadName, taskThreadSearchTerm } from "../plugins/codex/scripts/lib/task-thread.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const apply = process.argv.includes("--apply");
const cwd = process.cwd();

async function collectVisibleThreads(client) {
  const found = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { limit: PAGE_SIZE, sortKey: "updated_at", searchTerm: taskThreadSearchTerm() };
    if (cursor) params.cursor = cursor;
    const response = await client.request("thread/list", params);
    found.push(...response.data.filter((thread) => isTaskThreadName(thread.name)));
    cursor = response.nextCursor;
    if (!cursor || response.data.length === 0) {
      break;
    }
  }
  return found;
}

const summary = await withAppServer(cwd, async (client) => {
  const threads = await collectVisibleThreads(client);
  const byName = new Map();
  for (const thread of threads) {
    const key = String(thread.name ?? "").split(":")[0].trim();
    byName.set(key, (byName.get(key) ?? 0) + 1);
  }

  if (!apply) {
    return { threads: threads.length, byName, archived: 0, failed: [] };
  }

  let archived = 0;
  const failed = [];
  for (const thread of threads) {
    try {
      await client.request("thread/archive", { threadId: thread.id }, { timeoutMs: 15000 });
      archived += 1;
    } catch (error) {
      failed.push({ id: thread.id, reason: error?.message ?? String(error) });
    }
  }
  return { threads: threads.length, byName, archived, failed };
});

console.log(`Видимых делегированных тредов: ${summary.threads}`);
for (const [name, count] of [...summary.byName].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`);
}
if (!apply) {
  console.log("\nЭто предпросмотр. Архивировать: --apply");
} else {
  console.log(`\nАрхивировано: ${summary.archived}`);
  for (const item of summary.failed) {
    console.log(`  не вышло ${item.id}: ${item.reason}`);
  }
  if (summary.failed.length > 0) {
    process.exitCode = 1;
  }
}

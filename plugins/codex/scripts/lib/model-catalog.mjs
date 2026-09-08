function isUnsupportedMethodError(error) {
  if (error?.rpcCode === -32601) {
    return true;
  }
  return /unknown (variant|method)|unsupported method|method not found/i.test(
    String(error?.message ?? error ?? "")
  );
}

async function readModelCatalog(client) {
  const models = [];
  let cursor = null;

  try {
    do {
      const response = await client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: true
      });
      models.push(...(response.data ?? []));
      cursor = response.nextCursor ?? null;
    } while (cursor);
  } catch (error) {
    if (isUnsupportedMethodError(error)) {
      return null;
    }
    throw error;
  }

  return models;
}

// Доразрешение короткого имени модели по живому каталогу аккаунта.
//
// Смысл: список моделей меняется чаще, чем версии плагина. Полное имя работает
// и без этого, но тогда каждое новое сокращение требует правки кода или
// переменной окружения. Здесь `--model astra` находит gpt-6-astra в тот же
// день, когда она появилась у аккаунта.
//
// Отказ в неоднозначности намеренный: молча выбрать одну из двух подходящих
// моделей — значит потратить делегированный прогон не на той модели и узнать
// об этом из счёта, а не из ошибки.
export async function resolveModelFromCatalog(client, requested) {
  const name = String(requested ?? "").trim();
  if (!name) {
    return null;
  }

  let catalog;
  try {
    catalog = await readModelCatalog(client);
  } catch {
    return name;
  }
  if (!catalog) {
    // Старый CLI без model/list — пусть имя уедет на сервер как есть.
    return name;
  }

  const names = catalog.map((entry) => entry.model ?? entry.id).filter(Boolean);
  const lower = name.toLowerCase();
  if (names.some((candidate) => String(candidate).toLowerCase() === lower)) {
    return name;
  }

  const matches = [...new Set(names.filter((candidate) => String(candidate).toLowerCase().includes(lower)))];
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `Model "${name}" matches several catalog entries: ${matches.join(", ")}. Use the full name.`
    );
  }
  // Ничего не совпало — не выдумываем: ошибка сервера про неизвестную модель
  // понятнее нашей догадки.
  return name;
}

function supportedEfforts(model) {
  return (model.supportedReasoningEfforts ?? [])
    .map((option) => String(option.reasoningEffort ?? "").trim().toLowerCase())
    .filter(Boolean);
}

export async function validateReasoningSelection(client, selection = {}) {
  const modelName = String(selection.model ?? "").trim();
  const effort = String(selection.effort ?? "").trim().toLowerCase();
  const provider = String(selection.modelProvider ?? "").trim().toLowerCase();
  if (!effort || provider !== "openai") {
    return;
  }

  const catalog = await readModelCatalog(client);
  if (!catalog) {
    return;
  }

  const model = modelName
    ? catalog.find((candidate) => candidate.model === modelName || candidate.id === modelName)
    : catalog.find((candidate) => candidate.isDefault === true);
  if (!model) {
    return;
  }
  const selectedModelName = model.model ?? model.id ?? modelName;

  const efforts = supportedEfforts(model);
  if (efforts.length === 0 || efforts.includes(effort)) {
    return;
  }

  throw new Error(
    `Reasoning effort "${effort}" is not supported by model "${selectedModelName}". Supported efforts: ${efforts.join(", ")}.`
  );
}

export async function validateExplicitReasoningSelection(client, cwd, selection = {}, options = {}) {
  if (!selection.model && !selection.effort && !options.includeInherited) {
    return;
  }

  let config;
  try {
    const response = await client.request("config/read", { cwd, includeLayers: false });
    config = response.config ?? {};
  } catch (error) {
    if (isUnsupportedMethodError(error)) {
      return;
    }
    throw error;
  }

  await validateReasoningSelection(client, {
    model: selection.model ?? config.model,
    effort: selection.effort ?? config.model_reasoning_effort,
    modelProvider: config.model_provider ?? "openai"
  });
}

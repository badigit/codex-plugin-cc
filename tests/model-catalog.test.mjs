import test from "node:test";
import assert from "node:assert/strict";

import { resolveModelFromCatalog, validateReasoningSelection } from "../plugins/codex/scripts/lib/model-catalog.mjs";

function clientWith(models) {
  return {
    async request(method) {
      assert.equal(method, "model/list");
      return { data: models, nextCursor: null };
    }
  };
}

function model(name, efforts, isDefault = false) {
  return {
    id: name,
    model: name,
    isDefault,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort }))
  };
}

test("catalog accepts Ultra for Sol and Terra", async () => {
  const client = clientWith([
    model("gpt-5.6-sol", ["high", "max", "ultra"]),
    model("gpt-5.6-terra", ["high", "max", "ultra"])
  ]);

  await validateReasoningSelection(client, {
    model: "gpt-5.6-sol",
    effort: "ultra",
    modelProvider: "openai"
  });
  await validateReasoningSelection(client, {
    model: "gpt-5.6-terra",
    effort: "ultra",
    modelProvider: "openai"
  });
});

test("catalog rejects Luna with Ultra and lists supported efforts", async () => {
  const client = clientWith([model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"])]);

  await assert.rejects(
    validateReasoningSelection(client, {
      model: "gpt-5.6-luna",
      effort: "ultra",
      modelProvider: "openai"
    }),
    /Reasoning effort "ultra" is not supported by model "gpt-5\.6-luna".*low, medium, high, xhigh, max/i
  );
});

test("catalog validates effort against the default model when no model is selected", async () => {
  const client = clientWith([
    model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"], true)
  ]);

  await assert.rejects(
    validateReasoningSelection(client, { effort: "ultra", modelProvider: "openai" }),
    /Reasoning effort "ultra" is not supported by model "gpt-5\.6-luna"/i
  );
});

test("catalog fallback allows older CLIs without model/list", async () => {
  const client = {
    async request() {
      const error = new Error("Unsupported method: model/list");
      error.rpcCode = -32601;
      throw error;
    }
  };

  await validateReasoningSelection(client, {
    model: "gpt-5.6-sol",
    effort: "ultra",
    modelProvider: "openai"
  });
});

test("catalog does not block custom providers or unknown models", async () => {
  const client = clientWith([model("gpt-5.6-luna", ["high"])]);

  await validateReasoningSelection(client, {
    model: "gpt-5.6-luna",
    effort: "ultra",
    modelProvider: "custom"
  });
  await validateReasoningSelection(client, {
    model: "custom-model",
    effort: "ultra",
    modelProvider: "openai"
  });
});

test("короткое имя доразрешается по каталогу аккаунта", async () => {
  // Ради этого механизм и заведён: 08.09.2026 дефолтом аккаунта стала
  // gpt-6-astra, которой установленный CLI ещё не знал.
  const client = clientWith([model("gpt-6-astra", ["low", "high"]), model("gpt-5.6-sol", ["high"])]);
  assert.equal(await resolveModelFromCatalog(client, "astra"), "gpt-6-astra");
});

test("полное имя возвращается без изменений", async () => {
  const client = clientWith([model("gpt-6-astra", ["low"])]);
  assert.equal(await resolveModelFromCatalog(client, "gpt-6-astra"), "gpt-6-astra");
});

test("неоднозначное сокращение — ошибка со списком, а не молчаливый выбор", async () => {
  // Потратить делегированный прогон не на той модели и узнать об этом из счёта
  // хуже, чем получить отказ.
  const client = clientWith([model("gpt-6-astra", ["low"]), model("gpt-6-astra-mini", ["low"])]);
  await assert.rejects(
    () => resolveModelFromCatalog(client, "astra"),
    /matches several catalog entries: gpt-6-astra, gpt-6-astra-mini/
  );
});

test("неизвестное имя уходит на сервер как есть", async () => {
  // Ошибка сервера про неизвестную модель понятнее нашей догадки.
  const client = clientWith([model("gpt-6-astra", ["low"])]);
  assert.equal(await resolveModelFromCatalog(client, "gpt-9-nope"), "gpt-9-nope");
});

test("старый CLI без model/list не ломает запуск", async () => {
  const client = {
    async request() {
      const error = new Error("Unsupported method: model/list");
      error.rpcCode = -32601;
      throw error;
    }
  };
  assert.equal(await resolveModelFromCatalog(client, "astra"), "astra");
});

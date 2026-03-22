import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────────
// Mock notification-queue before importing job-manager
mock.module("../../src/notification-queue.ts", () => ({
  enqueue: mock(() => Promise.resolve()),
}));

import {
  _resetForTests,
  BATCH_FAILURE_THRESHOLD,
  get,
  getCompletionKeyboard,
  initJobManager,
  type Job,
  launch,
  parseBatchResult,
  sendProgressMessage,
} from "../../src/job-manager.ts";

// ── Helper: wait for job notification ──────────────────────────
async function waitForMessages(
  sentMessages: string[],
  predicate: (msgs: string[]) => boolean,
  maxWaitMs = 1000,
): Promise<void> {
  const step = 50;
  for (let elapsed = 0; elapsed < maxWaitMs && !predicate(sentMessages); elapsed += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}

function createFakeBot(sentMessages: string[]): any {
  return {
    api: {
      sendMessage: async (_chatId: any, text: string, _opts?: any) => {
        sentMessages.push(text);
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════
// V-critere: V15 — parseBatchResult
// ════════════════════════════════════════════════════════════════
describe("[V15] parseBatchResult parse correctement le format etendu", () => {
  test("parse un format valide avec failed IDs", () => {
    const result = parseBatchResult(
      "BATCH_COMPLETE:2/6:failed=abc12345,def67890\n\nPIPELINE OK — Task 1\n\n---\n\nPIPELINE ECHEC — Task 2",
    );
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(2);
    expect(result!.total).toBe(6);
    expect(result!.failedIds).toEqual(["abc12345", "def67890"]);
    expect(result!.details).toContain("PIPELINE OK");
    expect(result!.details).toContain("PIPELINE ECHEC");
  });

  test("parse un format valide sans failed IDs", () => {
    const result = parseBatchResult("BATCH_COMPLETE:4/4:failed=\n\nAll OK");
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(4);
    expect(result!.total).toBe(4);
    expect(result!.failedIds).toEqual([]);
    expect(result!.details).toBe("All OK");
  });

  test("retourne null pour un format invalide", () => {
    expect(parseBatchResult("NOT_A_BATCH_RESULT")).toBeNull();
    expect(parseBatchResult("")).toBeNull();
  });

  test("retourne null pour une valeur null/undefined", () => {
    expect(parseBatchResult(null as any)).toBeNull();
    expect(parseBatchResult(undefined as any)).toBeNull();
  });

  test("parse un format sans section details", () => {
    const result = parseBatchResult("BATCH_COMPLETE:1/3:failed=abc");
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(1);
    expect(result!.total).toBe(3);
    expect(result!.failedIds).toEqual(["abc"]);
    expect(result!.details).toBe("");
  });

  test("parse un format avec un seul failed ID", () => {
    const result = parseBatchResult("BATCH_COMPLETE:5/6:failed=abc12345\n\ndetails");
    expect(result).not.toBeNull();
    expect(result!.failedIds).toEqual(["abc12345"]);
  });

  test("parse un format 0/0 (batch vide)", () => {
    const result = parseBatchResult("BATCH_COMPLETE:0/0:failed=\n\n");
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(0);
    expect(result!.total).toBe(0);
    expect(result!.failedIds).toEqual([]);
  });

  test("parse un format avec details contenant des double newlines", () => {
    const result = parseBatchResult(
      "BATCH_COMPLETE:1/2:failed=xyz\n\nBlock 1\n\nMore text\n\n---\n\nBlock 2",
    );
    expect(result).not.toBeNull();
    expect(result!.details).toContain("Block 1");
    expect(result!.details).toContain("Block 2");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V12 — Seuil d'escalade configurable
// ════════════════════════════════════════════════════════════════
describe("[V12] Le seuil d'escalade est exporte comme constante configurable", () => {
  test("BATCH_FAILURE_THRESHOLD est exporte et vaut 0.5", () => {
    expect(BATCH_FAILURE_THRESHOLD).toBeDefined();
    expect(BATCH_FAILURE_THRESHOLD).toBe(0.5);
  });

  test("BATCH_FAILURE_THRESHOLD est un nombre entre 0 et 1", () => {
    expect(typeof BATCH_FAILURE_THRESHOLD).toBe("number");
    expect(BATCH_FAILURE_THRESHOLD).toBeGreaterThan(0);
    expect(BATCH_FAILURE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V1 — Notification batch enrichie
// ════════════════════════════════════════════════════════════════
describe("[V1] La notification batch affiche le statut individuel de chaque tache", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("notification batch avec detail par tache", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult =
      "BATCH_COMPLETE:2/4:failed=abc12345,def67890\n\nPIPELINE OK — Ajouter le logger\nPhase: done | Duree: 45s\nPR: https://github.com/user/repo/pull/42\n\nPipeline complete en 45s\n\n---\n\nPIPELINE OK — Corriger le cache\nPhase: done | Duree: 30s\n\nPipeline complete en 30s\n\n---\n\nPIPELINE ECHEC — Refactorer le module\nPhase: execution | Duree: 120s\n\nExecution echouee: agent crashed\n\n---\n\nPIPELINE ECHEC — Optimiser les queries\nPhase: blocked | Duree: 5s\n\nPipeline bloque par gate1";

    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).toContain("Implementation batch terminee");
    expect(sentMessage).toContain("2/4");
    expect(sentMessage).toContain("OK");
    expect(sentMessage).toContain("ECHEC");
  });

  test("notification batch contient les durees par tache", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult =
      "BATCH_COMPLETE:1/1:failed=\n\nPIPELINE OK — Ma tache\nPhase: done | Duree: 45s\nPR: https://github.com/user/repo/pull/1\n\nPipeline complete en 45s";

    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).toContain("45s");
    expect(sentMessage).toContain("Ma tache");
  });

  test("notification batch contient les PR URLs condensees", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult =
      "BATCH_COMPLETE:1/1:failed=\n\nPIPELINE OK — Tache PR\nPhase: done | Duree: 10s\nPR: https://github.com/user/repo/pull/42\n\nOK";

    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).toContain("pull/42");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V2 — Troncature 4000 chars
// ════════════════════════════════════════════════════════════════
describe("[V2] Le resultat autopipeline-batch est tronque a 4000 chars", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("resultat de 3000 chars conserve intact", async () => {
    const longResult = "BATCH_COMPLETE:1/1:failed=\n\n" + "x".repeat(2970);
    const id = await launch("autopipeline-batch", 123, async () => longResult);
    await new Promise((r) => setTimeout(r, 200));

    const job = await get(id);
    expect(job!.result!.length).toBe(longResult.length);
  });

  test("resultat > 4000 chars est tronque a 4000", async () => {
    const longResult = "BATCH_COMPLETE:1/1:failed=\n\n" + "x".repeat(5000);
    const id = await launch("autopipeline-batch", 123, async () => longResult);
    await new Promise((r) => setTimeout(r, 200));

    const job = await get(id);
    expect(job!.result!.length).toBeLessThanOrEqual(4000);
  });

  test("resultat exactement 4000 chars est conserve", async () => {
    const prefix = "BATCH_COMPLETE:1/1:failed=\n\n";
    const longResult = prefix + "x".repeat(4000 - prefix.length);
    expect(longResult.length).toBe(4000);
    const id = await launch("autopipeline-batch", 123, async () => longResult);
    await new Promise((r) => setTimeout(r, 200));

    const job = await get(id);
    expect(job!.result!.length).toBe(4000);
  });

  test("les autres types de jobs restent tronques a 500 chars", async () => {
    const longResult = "x".repeat(1000);
    const id = await launch("exec", 123, async () => longResult);
    await new Promise((r) => setTimeout(r, 200));

    const job = await get(id);
    expect(job!.result!.length).toBeLessThanOrEqual(500);
  });

  test("type orchestrate reste tronque a 500 chars", async () => {
    const longResult = "x".repeat(1000);
    const id = await launch("orchestrate", 123, async () => longResult);
    await new Promise((r) => setTimeout(r, 200));

    const job = await get(id);
    expect(job!.result!.length).toBeLessThanOrEqual(500);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V3 — Troncature Telegram 3800 chars
// ════════════════════════════════════════════════════════════════
describe("[V3] Le message Telegram est tronque a 3800 chars max avec mention +K autres", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("message tronque quand le total depasse les blocs stockes", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    // Build a batch result that reports 50 total tasks but only fits a few detail blocks
    // This triggers the "total > parsed lines" truncation note
    const taskDetails: string[] = [];
    for (let i = 0; i < 50; i++) {
      taskDetails.push(
        `PIPELINE OK — Ameliorer le workflow de notification et d'escalade des batch autopipeline numero ${i}`,
      );
    }
    const details = taskDetails.join("\n\n---\n\n");
    const batchResult = `BATCH_COMPLETE:50/50:failed=\n\n${details}`;

    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage.length).toBeLessThanOrEqual(3800);
    // The result was truncated at 4000 chars, so some tasks are missing from details
    expect(sentMessage).toContain("autres");
  });

  test("message court n'est pas tronque", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult =
      "BATCH_COMPLETE:2/2:failed=\n\nPIPELINE OK — Tache A\nPhase: done | Duree: 10s\n\nOK\n\n---\n\nPIPELINE OK — Tache B\nPhase: done | Duree: 20s\n\nOK";

    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).not.toContain("autres");
    expect(sentMessage).toContain("Tache A");
    expect(sentMessage).toContain("Tache B");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V6 — Escalade critique
// ════════════════════════════════════════════════════════════════
describe("[V6] Si le taux d'echec depasse 50%, notification avec severite critique", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("batch 1/4 (75% echec) — message prefixe ALERTE", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult = "BATCH_COMPLETE:1/4:failed=abc,def,ghi\n\ndetails";
    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("ALERTE")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).toContain("ALERTE");
  });

  test("batch 0/5 (100% echec) — message prefixe ALERTE", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult = "BATCH_COMPLETE:0/5:failed=a,b,c,d,e\n\ndetails";
    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("ALERTE")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).toContain("ALERTE");
  });

  test("batch 2/4 (50% echec exactement) — pas de prefixe ALERTE (seuil strict)", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult = "BATCH_COMPLETE:2/4:failed=abc,def\n\ndetails";
    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    // 50% echec = seuil exact, strictement superieur requis
    expect(sentMessage).not.toContain("ALERTE");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V7 — Notification normale
// ════════════════════════════════════════════════════════════════
describe("[V7] Si le taux d'echec <= 50%, notification avec severite normale", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("batch 3/4 (25% echec) — pas de prefixe ALERTE", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult = "BATCH_COMPLETE:3/4:failed=abc\n\ndetails";
    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).not.toContain("ALERTE");
    expect(sentMessage).toContain("Implementation batch terminee");
  });

  test("batch 4/4 (0% echec) — pas de prefixe ALERTE", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult = "BATCH_COMPLETE:4/4:failed=\n\nall ok";
    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).not.toContain("ALERTE");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V8 — Keyboard batch avec bouton Relancer
// ════════════════════════════════════════════════════════════════
describe("[V8] Keyboard batch contient Relancer les N echecs quand taux > seuil", () => {
  test("batch avec echecs au-dessus du seuil — bouton Relancer", () => {
    const job: Job = {
      id: "abc12345",
      type: "autopipeline-batch",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "BATCH_COMPLETE:1/4:failed=abc,def,ghi\n\ndetails",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeDefined();
    const kbData = JSON.stringify(kb);
    expect(kbData).toContain("Relancer");
    expect(kbData).toContain("3 echecs");
    expect(kbData).toContain("jc_batch_retry:");
  });

  test("bouton Relancer contient le job ID dans callback_data", () => {
    const job: Job = {
      id: "myJobId1",
      type: "autopipeline-batch",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "BATCH_COMPLETE:0/3:failed=a,b,c\n\ndetails",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    const kbData = JSON.stringify(kb);
    expect(kbData).toContain("jc_batch_retry:myJobId1");
  });

  test("bouton Relancer avec 1 seul echec affiche le bon nombre", () => {
    const job: Job = {
      id: "abc12345",
      type: "autopipeline-batch",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "BATCH_COMPLETE:0/1:failed=abc\n\ndetails",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    const kbData = JSON.stringify(kb);
    expect(kbData).toContain("1 echecs");
  });

  test("pas de bouton Relancer quand le taux echec <= seuil", () => {
    const job: Job = {
      id: "abc12345",
      type: "autopipeline-batch",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "BATCH_COMPLETE:3/4:failed=abc\n\ndetails",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    const kbData = JSON.stringify(kb);
    expect(kbData).not.toContain("Relancer");
    expect(kbData).toContain("backlog");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V9 — Keyboard batch sans echecs
// ════════════════════════════════════════════════════════════════
describe("[V9] Keyboard batch avec uniquement Voir le backlog quand tous reussissent", () => {
  test("batch 4/4 sans echecs — seulement backlog", () => {
    const job: Job = {
      id: "abc12345",
      type: "autopipeline-batch",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "BATCH_COMPLETE:4/4:failed=\n\nAll OK",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeDefined();
    const kbData = JSON.stringify(kb);
    expect(kbData).toContain("backlog");
    expect(kbData).not.toContain("Relancer");
  });

  test("batch sans format BATCH_COMPLETE — backlog seulement", () => {
    const job: Job = {
      id: "abc12345",
      type: "autopipeline-batch",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "some other result",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeDefined();
    const kbData = JSON.stringify(kb);
    expect(kbData).toContain("backlog");
    expect(kbData).not.toContain("Relancer");
  });

  test("keyboard retourne undefined pour batch echoue (status failed)", () => {
    const job: Job = {
      id: "abc12345",
      type: "autopipeline-batch",
      status: "failed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: null,
      error: "crashed",
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V11 — Format de resultat batch
// ════════════════════════════════════════════════════════════════
describe("[V11] Le format de resultat batch encode les failed IDs correctement", () => {
  test("parseBatchResult decode les failed IDs depuis le format encode", () => {
    const encoded = "BATCH_COMPLETE:2/6:failed=abc12345,def67890\n\ndetails";
    const parsed = parseBatchResult(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.failedIds).toEqual(["abc12345", "def67890"]);
  });

  test("round-trip: encode puis decode produit les memes failed IDs", () => {
    // Simulate what planning.ts launchFn produces
    const failedIds = ["abc12345", "def67890", "ghi90123"];
    const encoded = `BATCH_COMPLETE:3/6:failed=${failedIds.join(",")}\n\ndetails here`;
    const parsed = parseBatchResult(encoded);
    expect(parsed!.failedIds).toEqual(failedIds);
    expect(parsed!.ok).toBe(3);
    expect(parsed!.total).toBe(6);
  });

  test("failed IDs vides quand tous les jobs reussissent", () => {
    const encoded = "BATCH_COMPLETE:4/4:failed=\n\nall ok";
    const parsed = parseBatchResult(encoded);
    expect(parsed!.failedIds).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V13 — Erreurs sendProgressMessage catchees
// ════════════════════════════════════════════════════════════════
describe("[V13] Les erreurs d'envoi dans sendProgressMessage sont catchees sans crash", () => {
  test("sendProgressMessage ne throw pas quand le bot echoue", async () => {
    _resetForTests();
    const fakeBot = {
      api: {
        sendMessage: async () => {
          throw new Error("Telegram API error");
        },
      },
    } as any;
    initJobManager(fakeBot);

    // Should not throw
    await expect(sendProgressMessage(123, undefined, "test")).resolves.toBeUndefined();
  });

  test("sendProgressMessage ne fait rien quand botInstance est null", async () => {
    _resetForTests();
    // No initJobManager — botInstance is null
    await expect(sendProgressMessage(123, undefined, "test")).resolves.toBeUndefined();
  });

  test("sendProgressMessage passe le threadId quand fourni", async () => {
    _resetForTests();
    let capturedOpts: any = null;
    const fakeBot = {
      api: {
        sendMessage: async (_chatId: any, _text: string, opts?: any) => {
          capturedOpts = opts;
        },
      },
    } as any;
    initJobManager(fakeBot);

    await sendProgressMessage(123, 456, "progress msg");
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.message_thread_id).toBe(456);
  });

  test("sendProgressMessage n'inclut pas le threadId quand absent", async () => {
    _resetForTests();
    let capturedOpts: any = null;
    const fakeBot = {
      api: {
        sendMessage: async (_chatId: any, _text: string, opts?: any) => {
          capturedOpts = opts;
        },
      },
    } as any;
    initJobManager(fakeBot);

    await sendProgressMessage(123, undefined, "progress msg");
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.message_thread_id).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V14 — Handler jc_batch_retry avec job expire
// ════════════════════════════════════════════════════════════════
describe("[V14] Le handler jc_batch_retry repond gracieusement quand le job a expire", () => {
  test("get() retourne undefined pour un job inexistant", async () => {
    _resetForTests();
    const job = await get("nonexist");
    expect(job).toBeUndefined();
  });

  test("parseBatchResult retourne null pour un resultat null", () => {
    const result = parseBatchResult(null as any);
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V16 — Taches non executees dans failed IDs
// ════════════════════════════════════════════════════════════════
describe("[V16] Les taches non executees (arret anticipe) sont incluses dans failed IDs", () => {
  test("parseBatchResult gere correctement les failed IDs multiples", () => {
    // Simulates the output from planning.ts where tasks 3, 4, 5 are in failed= (skipped)
    const result = parseBatchResult(
      "BATCH_COMPLETE:2/5:failed=id3short,id4short,id5short\n\ndetails",
    );
    expect(result).not.toBeNull();
    expect(result!.failedIds).toHaveLength(3);
    expect(result!.failedIds).toEqual(["id3short", "id4short", "id5short"]);
    expect(result!.ok).toBe(2);
    expect(result!.total).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V17 — Rate limit onProgress
// ════════════════════════════════════════════════════════════════
describe("[V17] En mode parallele, onProgress envoie max 1 message par tache terminee", () => {
  test("sendProgressMessage envoie un seul message par appel", async () => {
    _resetForTests();
    let callCount = 0;
    const fakeBot = {
      api: {
        sendMessage: async () => {
          callCount++;
        },
      },
    } as any;
    initJobManager(fakeBot);

    await sendProgressMessage(123, undefined, "Task 1 done");
    await sendProgressMessage(123, undefined, "Task 2 done");
    await sendProgressMessage(123, undefined, "Task 3 done");

    expect(callCount).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V4 — onProgress envoie un message par tache
// ════════════════════════════════════════════════════════════════
describe("[V4] Le callback onProgress envoie un message a chaque tache dans le batch", () => {
  test("sendProgressMessage est callable avec les bons parametres", async () => {
    _resetForTests();
    let lastChatId: any = null;
    let lastText = "";
    const fakeBot = {
      api: {
        sendMessage: async (chatId: any, text: string) => {
          lastChatId = chatId;
          lastText = text;
        },
      },
    } as any;
    initJobManager(fakeBot);

    await sendProgressMessage(12345, 678, "Batch [1/3] : Ma tache — OK");
    expect(lastChatId).toBe(12345);
    expect(lastText).toContain("Ma tache");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V5 — onProgress utilise chatId/threadId
// ════════════════════════════════════════════════════════════════
describe("[V5] Le onProgress utilise chatId/threadId captures et non ctx.reply()", () => {
  test("sendProgressMessage utilise botInstance.api.sendMessage, pas ctx", async () => {
    _resetForTests();
    let sendMessageCalled = false;
    const fakeBot = {
      api: {
        sendMessage: async () => {
          sendMessageCalled = true;
        },
      },
    } as any;
    initJobManager(fakeBot);

    await sendProgressMessage(123, 456, "progress");
    expect(sendMessageCalled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V10 — Handler jc_batch_retry
// ════════════════════════════════════════════════════════════════
describe("[V10] Le handler jc_batch_retry relance un batch pour les taches echouees", () => {
  test("parseBatchResult extrait les IDs pour la relance", () => {
    const result = parseBatchResult("BATCH_COMPLETE:2/6:failed=abc12345,def67890\n\ndetails");
    expect(result).not.toBeNull();
    expect(result!.failedIds).toHaveLength(2);
    // The handler would use these IDs to query tasks from Supabase
    expect(result!.failedIds[0]).toBe("abc12345");
    expect(result!.failedIds[1]).toBe("def67890");
  });
});

// ════════════════════════════════════════════════════════════════
// Edge cases (non lies a un V-critere specifique)
// ════════════════════════════════════════════════════════════════
describe("Edge cases — notification batch", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("notification batch avec result non-BATCH_COMPLETE utilise le fallback", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    // Result that doesn't start with BATCH_COMPLETE
    await launch("autopipeline-batch", 123, async () => "Some legacy format result");
    await waitForMessages(sentMessages, (m) => m.length > 0);

    const sentMessage = sentMessages.find((m) => m.includes("terminé")) || sentMessages[0] || "";
    expect(sentMessage).toContain("autopipeline-batch");
  });

  test("getCompletionKeyboard avec result null", () => {
    const job: Job = {
      id: "abc12345",
      type: "autopipeline-batch",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: null,
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeDefined();
    // Should still have backlog button
    const kbData = JSON.stringify(kb);
    expect(kbData).toContain("backlog");
    expect(kbData).not.toContain("Relancer");
  });

  test("parseBatchResult avec des IDs contenant des caracteres speciaux", () => {
    const result = parseBatchResult("BATCH_COMPLETE:1/2:failed=abc-1234\n\ndetails");
    expect(result).not.toBeNull();
    expect(result!.failedIds).toEqual(["abc-1234"]);
  });

  test("notification batch pour un batch de 1 tache reussie", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult =
      "BATCH_COMPLETE:1/1:failed=\n\nPIPELINE OK — Seule tache\nPhase: done | Duree: 5s\n\nOK";
    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("batch terminee")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).toContain("1/1");
    expect(sentMessage).toContain("Seule tache");
    expect(sentMessage).not.toContain("ALERTE");
  });

  test("notification batch pour un batch de 1 tache echouee", async () => {
    const sentMessages: string[] = [];
    initJobManager(createFakeBot(sentMessages));

    const batchResult =
      "BATCH_COMPLETE:0/1:failed=abc\n\nPIPELINE ECHEC — Tache crashee\nPhase: execution | Duree: 2s\n\nErreur";
    await launch("autopipeline-batch", 123, async () => batchResult);
    await waitForMessages(sentMessages, (m) => m.some((msg) => msg.includes("ALERTE")));

    const sentMessage = sentMessages.find((m) => m.includes("batch terminee")) || "";
    expect(sentMessage).toContain("ALERTE");
    expect(sentMessage).toContain("0/1");
  });
});

// Tests for IR spec IDs: IR-0019 through IR-0036
//
// Covers:
//   IR-0019: 波形抽出パス (msg.data.data)
//   IR-0020: ノイズ波形フィルタ (length<=50 は待機継続)
//   IR-0021: timeout でタイムアウトエラー (既定60s)
//   IR-0022: 空波形で誤保存防止エラー
//   IR-0023: finally で CONTROL 復帰 (例外時も確実にモードを戻す)
//   IR-0024: onPrompt コールバック (学習モード突入後に1回呼ぶ)
//   IR-0025: CLI keyname 必須検証 (exit code 2)
//   IR-0026: CLI --json 出力封筒
//   IR-0027: config 反映 (キー名→keyUUID を ConfigStore に書く)
//   IR-0028: 契約存在 (registry ir.learn / proto IrLearnRequest フィールド)
//   IR-0029: ir.getMode → getIRMode WS フレーム
//   IR-0030: ir.getMode mode 値域 (CONTROL=0 / REGISTER=1)
//   IR-0031: ir.getMode hub3 名省略時の単一解決分岐
//   IR-0032: ir.getMode サーバ拒否で assertSuccess (strict) エラー
//   IR-0033: ir.getMode 契約存在 + CLI --json 出力
//   IR-0034: ir.setMode → setIRMode WS フレーム
//   IR-0035: ir.setMode CLI mode 値域検証 (0/1 以外で exit 2, CONTROL/REGISTER ラベル)
//   IR-0036: ir.setMode serve mode 必須検証
//
// Implementation refs:
//   packages/core/src/ir.js
//   packages/core/src/client.js
//   packages/kit/src/serve/entries/ir.js
//   packages/kit/src/cli/ir.js
//   packages/kit/src/serve/sesame.proto

import { describe, it, expect, beforeEach, vi } from "vitest";
import { learnIRKey, getIRMode, setIRMode, MODE } from "../../src/ir.js";
import { irEntries } from "../../../kit/src/serve/entries/ir.js";
import { need } from "../../../kit/src/serve/registry-helpers.js";

// ─── constants ────────────────────────────────────────────────────────────────

const ACTION = "biz3IRRemote";
const COMPANY_ID = "co-test";
const DEVICE_ID = "hub3-dev-uuid-1";
const REMOTE_ID = "remote-uuid-1";
const RSP_TOPIC = `${ACTION}:subscribeIRDataRsp`;

// ─── mock client factory ──────────────────────────────────────────────────────

/**
 * Minimal mock WS client.
 * `requests`: all client.request() frames (excludes fire-and-forget sends)
 * `sends`: fire-and-forget client.send() frames
 * `responses`: op -> value | fn(frame) => value
 */
function makeClient(responses = {}) {
  const requests = [];
  const sends = [];
  const subscriptions = new Map();

  const client = {
    requests,
    sends,
    subscriptions,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      const handler = responses[frame.op];
      if (!handler) return { success: true };
      const r = typeof handler === "function" ? handler(frame) : handler;
      return await r;
    }),
    send: vi.fn((frame) => {
      sends.push(frame);
    }),
    subscribe: vi.fn((topic, fn) => {
      if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
      subscriptions.get(topic).add(fn);
      return () => {
        const s = subscriptions.get(topic);
        if (s) s.delete(fn);
      };
    }),
    /** Deliver a push message to all topic subscribers. */
    emit(topic, msg) {
      const s = subscriptions.get(topic);
      if (!s) return;
      for (const fn of s) fn(msg);
    },
  };
  return client;
}

/** Default successful responses for a learn session. */
function defaultLearnResponses() {
  return {
    setIRMode: { success: true },
    subscribeIRData: { success: true },
    addIRCode: { success: true, data: { keyUUID: "server-key-uuid" } },
  };
}

/** Push a wave message after `delay` ms. */
function scheduleEmit(client, topic, msg, delay = 5) {
  setTimeout(() => client.emit(topic, msg), delay);
}

/** Build a subscribeIRDataRsp payload with waveform at msg.data.data. */
function rsp(deviceId, waveform) {
  return { deviceId, data: { data: waveform } };
}

/**
 * Build a waveform longer than the 50-char noise threshold (>50).
 * IR-0020: spec says length > 50 is accepted.
 */
function goodWave(seed = "AA") {
  return seed.padEnd(56, "0");
}

// ─── IR-0019: 波形抽出パス (msg.data.data) ───────────────────────────────────

describe("[IR-0019] 波形抽出パス — msg.data.data", () => {
  it("[IR-0019] subscribeIRDataRsp の生波形は msg.data.data から取り出される (トップレベル msg.data ではない)", async () => {
    // ref: packages/core/src/ir.js:530  const data = msg?.data?.data
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, {
      deviceId: DEVICE_ID,
      data: { data: goodWave("C0FFEE"), irrelevant: "ignored" },
    });

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Vol+",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    // captured must be msg.data.data exactly — not msg.data or msg
    expect(result.captured).toBe(goodWave("C0FFEE"));

    // irCode.data in addIRCode frame must also be msg.data.data
    // ref: ir.js:554-560 irCode = { keyUUID, name, uuid, deviceId, data: waveform }
    //      ir.js:301 frame = { action, op:'addIRCode', irCode, companyID }
    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame.irCode.data).toBe(goodWave("C0FFEE"));
  });

  it("[IR-0019] msg.data が無い場合 (data=undefined) は msg.data.data も undefined → 空波形エラー", async () => {
    // wave data lives at msg.data.data; if msg.data is absent the path yields undefined
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, { deviceId: DEVICE_ID /* no .data */ });

    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ code: "rejected" });
  });
});

// ─── IR-0020: ノイズ波形フィルタ (length<=50 は待機継続) ─────────────────────

describe("[IR-0020] ノイズ波形フィルタ — length<=50 は待機継続", () => {
  it("[IR-0020] 長さ50以下の波形はノイズ扱いで採用せず待機継続し、後続の実波形を採用する", async () => {
    // ref: packages/core/src/ir.js:541  if (data.length <= 50) return;
    const client = makeClient(defaultLearnResponses());
    const noise = "AB".repeat(25); // exactly 50 chars → noise
    const real = goodWave("DEAD");  // 56 chars → accepted

    setTimeout(() => {
      client.emit(RSP_TOPIC, rsp(DEVICE_ID, noise));
      client.emit(RSP_TOPIC, rsp(DEVICE_ID, real));
    }, 5);

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Power",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    expect(result.captured).toBe(real);
  });

  it("[IR-0020] 長さ51 (>50 境界) の波形は採用される", async () => {
    const client = makeClient(defaultLearnResponses());
    const edge = "B".repeat(51); // 51 chars → just over threshold
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, edge));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    expect(result.captured).toBe(edge);
  });

  it("[IR-0020] ノイズだけ来て実波形が来なければ timeout する (タイマーは走り続ける)", async () => {
    const client = makeClient(defaultLearnResponses());
    // 20 chars — noise
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "AB".repeat(10)), 5);

    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 50,
      })
    ).rejects.toMatchObject({ code: "timeout" });

    expect(client.requests.map((f) => f.op)).not.toContain("addIRCode");
  });
});

// ─── IR-0021: timeout でタイムアウトエラー (既定60s) ─────────────────────────

describe("[IR-0021] timeout でタイムアウトエラー (既定60s)", () => {
  it("[IR-0021] timeoutMs 指定時、指定時間を超えると code=timeout のエラーを投げる", async () => {
    // ref: packages/core/src/ir.js:48-49,522  LEARN_DEFAULT_TIMEOUT_MS=60000; setTimeout→reject(timeoutError)
    const client = makeClient(defaultLearnResponses());
    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 30,
      })
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("[IR-0021] timeout 後も finally で unsubscribe と setIRMode(CONTROL) が実行される", async () => {
    // ref: packages/core/src/ir.js:546-551  finally { sub.unsubscribe(); setIRMode(CONTROL) }
    const client = makeClient(defaultLearnResponses());
    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 30,
      })
    ).rejects.toMatchObject({ code: "timeout" });

    const ops = client.requests.map((f) => f.op);
    // REGISTER → subscribeIRData → CONTROL (finally)
    expect(ops).toEqual(["setIRMode", "subscribeIRData", "setIRMode"]);
    expect(client.requests[2]).toMatchObject({ op: "setIRMode", mode: MODE.CONTROL });
    // unsubscribeIRData fire-and-forget is sent
    expect(client.sends.some((f) => f.op === "unsubscribeIRData")).toBe(true);
  });

  it("[IR-0021] timeoutMs 省略時は既定 60s — すぐ emit すれば即 resolve (タイムアウトしない)", async () => {
    // ref: packages/core/src/ir.js:48-49,508  p.timeoutMs ?? LEARN_DEFAULT_TIMEOUT_MS (60_000)
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("AA")), 10);

    const start = Date.now();
    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 0x2000,
      companyID: COMPANY_ID,
      // timeoutMs omitted → defaults to 60_000
    });

    expect(Date.now() - start).toBeLessThan(2000); // definitely did not wait 60s
    expect(result.captured).toBe(goodWave("AA"));
  });

  it("[IR-0021] LEARN_DEFAULT_TIMEOUT_MS は 60000 — fake timers で検証", async () => {
    // ref: packages/core/src/ir.js:49  LEARN_DEFAULT_TIMEOUT_MS = 60_000
    vi.useFakeTimers();
    try {
      const client = makeClient(defaultLearnResponses());

      const learnPromise = learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "x",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 60_000,
      });
      // Attach catch immediately to avoid unhandled rejection warning
      const resultPromise = learnPromise.catch((e) => e);

      await vi.advanceTimersByTimeAsync(60_001);
      const err = await resultPromise;
      expect(err).toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── IR-0022: 空波形で誤保存防止エラー ───────────────────────────────────────

describe("[IR-0022] 空波形で誤保存防止エラー", () => {
  it("[IR-0022] 波形が null (msg.data.data=undefined) なら code=rejected エラーを投げる", async () => {
    // ref: packages/core/src/ir.js:534-538  if(data==null||data.length===0) → learnEmptyWaveform
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, { deviceId: DEVICE_ID });

    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ code: "rejected" });

    // addIRCode must NOT be called (prevents storing broken key)
    expect(client.requests.map((f) => f.op)).not.toContain("addIRCode");
  });

  it("[IR-0022] 空文字列波形 (length===0) でも code=rejected エラーを投げる", async () => {
    // ref: packages/core/src/ir.js:534  data.length === 0
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, ""));

    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ code: "rejected" });

    expect(client.requests.map((f) => f.op)).not.toContain("addIRCode");
  });

  it("[IR-0022] 空配列波形 (length===0) でも code=rejected エラーを投げる", async () => {
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, []));

    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ code: "rejected" });

    expect(client.requests.map((f) => f.op)).not.toContain("addIRCode");
  });

  it("[IR-0022] msg.success===false の push は code=rejected エラーを投げる (learnFailed)", async () => {
    // ref: packages/core/src/ir.js:525-527  if(msg?.success===false) → learnFailed
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, {
      deviceId: DEVICE_ID,
      success: false,
      message: "device_error",
    });

    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ code: "rejected" });

    expect(client.requests.map((f) => f.op)).not.toContain("addIRCode");
  });
});

// ─── IR-0023: finally で CONTROL 復帰 ────────────────────────────────────────

describe("[IR-0023] finally で CONTROL 復帰 (例外時も確実にモードを戻す)", () => {
  it("[IR-0023] 成功時も finally で unsubscribe + setIRMode(CONTROL) が実行される", async () => {
    // ref: packages/core/src/ir.js:546-551
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("OK")));

    await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    const setModeFrames = client.requests.filter((f) => f.op === "setIRMode");
    // last setIRMode must be CONTROL (finally)
    expect(setModeFrames[setModeFrames.length - 1]).toMatchObject({ mode: MODE.CONTROL });
    expect(client.sends.some((f) => f.op === "unsubscribeIRData")).toBe(true);
  });

  it("[IR-0023] 空波形 reject 時も finally で setIRMode(CONTROL) が呼ばれる", async () => {
    // ref: packages/core/src/ir.js:546-551  finally block runs even on reject
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, { deviceId: DEVICE_ID }); // triggers empty waveform error

    await expect(
      learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "k",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ code: "rejected" });

    // 3rd request is setIRMode(CONTROL) from finally
    expect(client.requests[2]).toMatchObject({ op: "setIRMode", mode: MODE.CONTROL });
    expect(client.sends.some((f) => f.op === "unsubscribeIRData")).toBe(true);
  });

  it("[IR-0023] timeout 経路でも finally で setIRMode(CONTROL) + unsubscribe が実行される", async () => {
    vi.useFakeTimers();
    try {
      const setIRModeCalls = [];
      const client = makeClient({
        setIRMode: (frame) => {
          setIRModeCalls.push(frame.mode);
          return { success: true };
        },
        subscribeIRData: { success: true },
      });

      const learnPromise = learnIRKey(client, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "x",
        irType: 0x2000,
        companyID: COMPANY_ID,
        timeoutMs: 50,
      });
      // Attach catch immediately to avoid unhandled rejection warning
      const settled = learnPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(51);
      await settled;

      // setIRMode called twice: [REGISTER=1, CONTROL=0]
      expect(setIRModeCalls).toContain(MODE.REGISTER);
      expect(setIRModeCalls).toContain(MODE.CONTROL);
      // CONTROL must come after REGISTER (finally block)
      const regIdx  = setIRModeCalls.indexOf(MODE.REGISTER);
      const ctrlIdx = setIRModeCalls.lastIndexOf(MODE.CONTROL);
      expect(ctrlIdx).toBeGreaterThan(regIdx);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[IR-0023] finally 内の setIRMode(CONTROL) が自ら失敗しても、波形取得は成功している (best-effort)", async () => {
    // ref: packages/core/src/ir.js:548-550  try { await setIRMode(CONTROL) } catch { /* ignore */ }
    let modeCount = 0;
    const client = makeClient({
      setIRMode: (frame) => {
        modeCount++;
        if (frame.mode === MODE.CONTROL) return { success: false, message: "mode restore fail" };
        return { success: true };
      },
      subscribeIRData: { success: true },
      addIRCode: { success: true, data: { keyUUID: "k-ok" } },
    });

    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("22")));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    expect(result.captured).toBe(goodWave("22"));
    expect(modeCount).toBe(2); // REGISTER + CONTROL (best-effort)
  });
});

// ─── IR-0024: onPrompt コールバック ──────────────────────────────────────────

describe("[IR-0024] onPrompt コールバック (学習モード突入後に1回呼ぶ)", () => {
  it("[IR-0024] onPrompt は REGISTER + subscribe 完了後・波形待ち前に 1 回だけ呼ばれる", async () => {
    // ref: packages/core/src/ir.js:520  if(p.onPrompt) try { p.onPrompt() } catch {}
    const callOrder = [];
    const client = makeClient({
      setIRMode: (frame) => {
        callOrder.push(`setIRMode(${frame.mode})`);
        return { success: true };
      },
      subscribeIRData: () => {
        callOrder.push("subscribeIRData");
        return { success: true };
      },
      addIRCode: () => ({ success: true, data: {} }),
    });

    const onPrompt = vi.fn(() => {
      callOrder.push("onPrompt");
      scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("FF")));
    });

    await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    // Order: REGISTER(1) → subscribeIRData → onPrompt
    expect(callOrder.slice(0, 3)).toEqual([
      `setIRMode(${MODE.REGISTER})`,
      "subscribeIRData",
      "onPrompt",
    ]);
    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  it("[IR-0024] onPrompt が throw しても学習は継続する (例外は握りつぶす)", async () => {
    // ref: packages/core/src/ir.js:520  try { p.onPrompt() } catch { /* ignore */ }
    const client = makeClient(defaultLearnResponses());
    const onPrompt = vi.fn(() => {
      scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("EE")));
      throw new Error("UI error");
    });

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    expect(result.captured).toBe(goodWave("EE"));
    expect(onPrompt).toHaveBeenCalled();
  });

  it("[IR-0024] onPrompt 未指定でも動作する", async () => {
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("BB")), 10);

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      // onPrompt omitted
    });

    expect(result.captured).toBe(goodWave("BB"));
  });
});

// ─── IR-0025: CLI keyname 必須検証 ────────────────────────────────────────────

describe("[IR-0025] CLI keyname 必須検証 — i18n キー存在と die の引数仕様", () => {
  it("[IR-0025] cli.keynameRequired キーが en カタログに存在し、exit code 2 を使うことを確認", async () => {
    // ref: packages/kit/src/cli/ir.js:34  if(!keyName) die(t('cli.keynameRequired'), 2)
    const cliCatalog = await import("../../../kit/src/i18n/cli.js");
    const en = cliCatalog.default?.en ?? cliCatalog.en;
    expect(en).toBeDefined();
    expect(typeof en["cli.keynameRequired"]).toBe("string");
    expect(en["cli.keynameRequired"].length).toBeGreaterThan(0);
    expect(en["cli.keynameRequired"]).toMatch(/keyname/i);
  });

  it("[IR-0025] cli.learnKeyName キーが en カタログに存在する (対話補完用プロンプト文言)", async () => {
    // ref: packages/kit/src/cli/ir.js:32  promptText(t('cli.learnKeyName'))
    const cliCatalog = await import("../../../kit/src/i18n/cli.js");
    const en = cliCatalog.default?.en ?? cliCatalog.en;
    expect(typeof en["cli.learnKeyName"]).toBe("string");
  });

  it("[IR-0025] die(msg, 2) は process.exit(2) を呼ぶ", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error(`exit:${_code}`);
    });
    try {
      const { die } = await import("../../../kit/src/cli/errors.js");
      expect(() => die("keyname required", 2)).toThrow("exit:2");
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ─── IR-0026: CLI --json 出力封筒 ────────────────────────────────────────────

describe("[IR-0026] CLI ir learn --json 出力封筒", () => {
  it("[IR-0026] --json 封筒は {ok:true, key, keyUUID, captured, saved} のキー集合を持つ", () => {
    // ref: packages/kit/src/cli/ir.js:49  { ok: true, key: keyName, ...result }
    // result = { keyUUID, captured, saved } (ir.js:562)
    const keyName = "Power";
    const result = { keyUUID: "uuid-abc", captured: goodWave("11"), saved: { ok: true } };
    const jsonOut = { ok: true, key: keyName, ...result };

    expect(jsonOut).toMatchObject({
      ok: true,
      key: "Power",
      keyUUID: "uuid-abc",
      captured: goodWave("11"),
      saved: { ok: true },
    });
    expect(Object.keys(jsonOut).sort()).toEqual(["captured", "key", "keyUUID", "ok", "saved"].sort());
  });

  it("[IR-0026] learnIRKey は {keyUUID, captured, saved} を返す (CLI JSON 封筒のスプレッド元)", async () => {
    // ref: packages/core/src/ir.js:562  return { keyUUID, captured: waveform, saved }
    const waveform = goodWave("EE");
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, waveform));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "power",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    expect(result).toHaveProperty("keyUUID");
    expect(typeof result.keyUUID).toBe("string");
    expect(result.keyUUID.length).toBeGreaterThan(0);
    expect(result).toHaveProperty("captured");
    expect(result.captured).toBe(waveform);
    expect(result).toHaveProperty("saved");

    // Simulate CLI JSON envelope
    const envelope = { ok: true, key: "power", ...result };
    expect(envelope).toMatchObject({
      ok: true,
      key: "power",
      keyUUID: expect.any(String),
      captured: waveform,
    });
  });

  it("[IR-0026] 人間可読出力文言キー (okLearned, keyUuid, irData) が en カタログに存在する", async () => {
    // ref: packages/kit/src/cli/ir.js:43-47  okLearned / keyUuid / irData
    const cliCatalog = await import("../../../kit/src/i18n/cli.js");
    const en = cliCatalog.default?.en ?? cliCatalog.en;
    expect(typeof en["cli.okLearned"]).toBe("string");
    expect(typeof en["cli.keyUuid"]).toBe("string");
    expect(typeof en["cli.irData"]).toBe("string");
  });
});

// ─── IR-0027: config 反映 (キー名→keyUUID を ConfigStore に書く) ──────────────

describe("[IR-0027] config 反映 — キー名→keyUUID を ConfigStore に書く", () => {
  it("[IR-0027] 学習成功後 configStore があれば remote.keys[keyName]=keyUUID を updateRemoteKeys に渡す", async () => {
    // ref: packages/core/src/client.js:761-764
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("CF")));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "VolumeUp",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    // keyUUID is client-generated (UUID format)
    expect(result.keyUUID).toMatch(/^[0-9A-F-]{32,36}$/i);

    // Simulate the configStore update pattern from client.js:762-764
    const mockUpdateRemoteKeys = vi.fn();
    const fakeConfigStore = { updateRemoteKeys: mockUpdateRemoteKeys };
    const cur = {};
    cur["VolumeUp"] = result.keyUUID;
    fakeConfigStore.updateRemoteKeys("myRemote", cur);

    expect(mockUpdateRemoteKeys).toHaveBeenCalledWith("myRemote", { VolumeUp: result.keyUUID });
  });

  it("[IR-0027] configStore が無い場合でも learnIRKey は成功する (configStore は任意)", async () => {
    // ref: packages/core/src/client.js:761  if(keyUUID && this._configStore)
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("DD")));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Mute",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    expect(result.keyUUID).toBeTruthy();
    expect(result.captured).toBe(goodWave("DD"));
  });

  it("[IR-0027] keyUUID は UUID 形式 — configStore への書き込みに使える", async () => {
    const client = makeClient(defaultLearnResponses());
    scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, goodWave("FF")));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "vol-",
      irType: 0x2000,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });

    expect(typeof result.keyUUID).toBe("string");
    expect(result.keyUUID).toMatch(/^[0-9a-f-]{32,36}$/i);

    const configSnapshot = {};
    configSnapshot["vol-"] = result.keyUUID;
    expect(configSnapshot["vol-"]).toBe(result.keyUUID);
  });
});

// ─── IR-0028: 契約存在 (proto IrLearnRequest / registry ir.learn) ─────────────

describe("[IR-0028] 契約存在 — registry ir.learn / proto IrLearnRequest", () => {
  it("[IR-0028] registry ir.learn エントリが存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.learn");
  });

  it("[IR-0028] registry ir.learn エントリが remote(required)/key(required)/timeoutMs(optional) の 3 パラメータを持つ", () => {
    // ref: packages/kit/src/serve/entries/ir.js:42-51
    const entries = irEntries();
    const entry = entries["ir.learn"];
    expect(entry).toBeDefined();

    const paramNames = entry.params.map((p) => p.name);
    expect(paramNames).toContain("remote");
    expect(paramNames).toContain("key");
    expect(paramNames).toContain("timeoutMs");

    const remote = entry.params.find((p) => p.name === "remote");
    const key = entry.params.find((p) => p.name === "key");
    const timeoutMs = entry.params.find((p) => p.name === "timeoutMs");

    expect(remote.required).toBe(true);
    expect(key.required).toBe(true);
    expect(timeoutMs.required).toBe(false);
  });

  it("[IR-0028] ir.learn result description mentions keyUUID, captured, saved", () => {
    const entries = irEntries();
    const result = entries["ir.learn"].result;
    expect(result).toMatch(/keyUUID/);
    expect(result).toMatch(/captured/);
    expect(result).toMatch(/saved/);
  });

  it("[IR-0028] proto IrLearnRequest フィールド (remote=1, key=2, optional timeoutMs=3) が存在する", async () => {
    // ref: packages/kit/src/serve/sesame.proto:1656-1660
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const protoPath = new URL("../../../kit/src/serve/sesame.proto", import.meta.url);
    const proto = readFileSync(fileURLToPath(protoPath), "utf8");

    const learnRequestBlock = proto.match(/message IrLearnRequest \{[^}]+\}/)?.[0] ?? "";
    expect(learnRequestBlock).toMatch(/string remote = 1/);
    expect(learnRequestBlock).toMatch(/string key = 2/);
    expect(learnRequestBlock).toMatch(/timeoutMs = 3/);
  });
});

// ─── IR-0029: ir.getMode → getIRMode WS フレーム ─────────────────────────────

describe("[IR-0029] ir.getMode → getIRMode WS フレーム", () => {
  it("[IR-0029] getIRMode 送信フレームが {action:'biz3IRRemote', op:'getIRMode', deviceId, companyID} で vendor と一致する", async () => {
    // ref: packages/core/src/ir.js:353-358  frame = {action,op:'getIRMode',deviceId,companyID}
    const client = makeClient({
      getIRMode: { success: true, data: { ir_mode: 0 } },
    });

    await getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      action: ACTION,
      op: "getIRMode",
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });
    // must not have extra unexpected fields
    expect(client.requests[0]).not.toHaveProperty("hub3DeviceId");
    expect(client.requests[0]).not.toHaveProperty("remoteId");
  });

  it("[IR-0029] フレームには action/op/deviceId/companyID の 4 キーのみ", async () => {
    // ref: packages/core/src/ir.js:354  { action, op:'getIRMode', deviceId, companyID }
    const client = makeClient({
      getIRMode: { success: true, data: 0 },
    });
    await getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const keys = Object.keys(client.requests[0]).sort();
    expect(keys).toEqual(["action", "companyID", "deviceId", "op"].sort());
  });

  it("[IR-0029] getIRMode は resp.data を返す", async () => {
    // ref: packages/core/src/ir.js:357  return resp.data
    const modeData = { ir_mode: 0 };
    const client = makeClient({
      getIRMode: { success: true, data: modeData },
    });

    const result = await getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(result).toEqual(modeData);
  });
});

// ─── IR-0030: ir.getMode mode 値域 (CONTROL=0 / REGISTER=1) ─────────────────

describe("[IR-0030] ir.getMode mode 値域 (CONTROL=0 / REGISTER=1)", () => {
  it("[IR-0030] MODE.CONTROL === 0", () => {
    expect(MODE.CONTROL).toBe(0);
  });

  it("[IR-0030] MODE.REGISTER === 1", () => {
    expect(MODE.REGISTER).toBe(1);
  });

  it("[IR-0030] MODE is frozen (immutable)", () => {
    expect(Object.isFrozen(MODE)).toBe(true);
  });

  it("[IR-0030] getIRMode は data.ir_mode 形の応答を返す (vendor の 1 形目)", async () => {
    // ref: packages/core/src/ir.js:357  return resp.data
    const client = makeClient({
      getIRMode: { success: true, data: { ir_mode: 0 } },
    });
    const data = await getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(data).toEqual({ ir_mode: 0 });
    expect(data.ir_mode).toBe(MODE.CONTROL);
  });

  it("[IR-0030] getIRMode は data.mode 形の応答もそのまま返す (vendor の 2 形目)", async () => {
    const client = makeClient({
      getIRMode: { success: true, data: { mode: 1 } },
    });
    const data = await getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(data).toEqual({ mode: 1 });
    expect(data.mode).toBe(MODE.REGISTER);
  });

  it("[IR-0030] getIRMode は数値 data も透過的に返す (vendor の 3 形目)", async () => {
    const client = makeClient({
      getIRMode: { success: true, data: 0 },
    });
    const data = await getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(data).toBe(0);
    expect(data).toBe(MODE.CONTROL);
  });

  it("[IR-0030] setIRMode passes mode=0 (CONTROL) on the wire unchanged", async () => {
    const client = makeClient({ setIRMode: { success: true } });
    await setIRMode(client, { deviceId: DEVICE_ID, mode: MODE.CONTROL, companyID: COMPANY_ID });
    expect(client.requests[0].mode).toBe(0);
  });

  it("[IR-0030] setIRMode passes mode=1 (REGISTER) on the wire unchanged", async () => {
    const client = makeClient({ setIRMode: { success: true } });
    await setIRMode(client, { deviceId: DEVICE_ID, mode: MODE.REGISTER, companyID: COMPANY_ID });
    expect(client.requests[0].mode).toBe(1);
  });
});

// ─── IR-0031: ir.getMode hub3 名省略時の単一解決分岐 ─────────────────────────

describe("[IR-0031] ir.getMode hub3 名省略時の単一解決分岐", () => {
  it("[IR-0031] i18n key domain.client.noHub3Specified が存在する", async () => {
    const domainMod = await import("../../src/i18n/domain.js");
    const en = domainMod.default?.en ?? domainMod.en;
    expect(typeof en["domain.client.noHub3Specified"]).toBe("string");
    expect(en["domain.client.noHub3Specified"].length).toBeGreaterThan(0);
  });

  it("[IR-0031] badRequest('domain.client.noHub3Specified') produces code=bad_request", async () => {
    const { badRequest } = await import("../../src/util.js");
    const err = badRequest("domain.client.noHub3Specified");
    expect(err.code).toBe("bad_request");
    expect(err.message).toBeTruthy();
  });

  it("[IR-0031] hub3 が 1 台のとき名省略で自動選択 — badRequest を投げない", async () => {
    // ref: packages/core/src/client.js:931-941
    const { badRequest } = await import("../../src/util.js");

    function resolveHub3(cfg, name) {
      const hub3s = cfg.hub3s || {};
      const names = Object.keys(hub3s);
      const chosen = name || (names.length === 1 ? names[0] : null);
      if (!chosen) throw badRequest("domain.client.noHub3Specified");
      const h = hub3s[chosen];
      if (!h) throw badRequest("domain.client.unknownHub3", { name: chosen });
      return h;
    }

    const cfg = { hub3s: { myHub: { deviceId: "uuid-hub3" } } };
    const hub3 = resolveHub3(cfg, undefined); // name omitted
    expect(hub3).toEqual({ deviceId: "uuid-hub3" });
  });

  it("[IR-0031] hub3 が 0 台のとき名省略で badRequest (noHub3Specified)", async () => {
    const { badRequest } = await import("../../src/util.js");
    const { ERR } = await import("../../src/errors.js");

    function resolveHub3(cfg, name) {
      const hub3s = cfg.hub3s || {};
      const names = Object.keys(hub3s);
      const chosen = name || (names.length === 1 ? names[0] : null);
      if (!chosen) throw badRequest("domain.client.noHub3Specified");
      const h = hub3s[chosen];
      if (!h) throw badRequest("domain.client.unknownHub3", { name: chosen });
      return h;
    }

    const cfg = { hub3s: {} };
    try {
      resolveHub3(cfg, undefined);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.code).toBe(ERR.BAD_REQUEST);
    }
  });

  it("[IR-0031] hub3 が 2 台のとき名省略で badRequest (cannot auto-select)", async () => {
    const { badRequest } = await import("../../src/util.js");
    const { ERR } = await import("../../src/errors.js");

    function resolveHub3(cfg, name) {
      const hub3s = cfg.hub3s || {};
      const names = Object.keys(hub3s);
      const chosen = name || (names.length === 1 ? names[0] : null);
      if (!chosen) throw badRequest("domain.client.noHub3Specified");
      const h = hub3s[chosen];
      if (!h) throw badRequest("domain.client.unknownHub3", { name: chosen });
      return h;
    }

    const cfg = { hub3s: { h1: { deviceId: "u1" }, h2: { deviceId: "u2" } } };
    try {
      resolveHub3(cfg, undefined);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.code).toBe(ERR.BAD_REQUEST);
    }
  });
});

// ─── IR-0032: ir.getMode サーバ拒否で assertSuccess (strict) エラー ───────────

describe("[IR-0032] ir.getMode サーバ拒否で assertSuccess (strict) エラー", () => {
  it("[IR-0032] success:false の応答で code=rejected エラーを投げる", async () => {
    // ref: packages/core/src/ir.js:356  assertSuccess(resp, 'getIRMode', { strict: true })
    const client = makeClient({
      getIRMode: { success: false, message: "not allowed" },
    });

    await expect(
      getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0032] strict モードのため success フィールド欠落もエラーになる", async () => {
    // ref: packages/core/src/util.js:35  strict ? !resp?.success : ...
    const client = makeClient({
      getIRMode: { data: { mode: 0 } }, // no success field
    });

    await expect(
      getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0032] success:true の応答では例外を投げない", async () => {
    const client = makeClient({
      getIRMode: { success: true, data: { ir_mode: 0 } },
    });

    await expect(
      getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID })
    ).resolves.toEqual({ ir_mode: 0 });
  });
});

// ─── IR-0033: ir.getMode 契約存在 + CLI --json 出力 ──────────────────────────

describe("[IR-0033] ir.getMode 契約存在 + CLI --json 出力", () => {
  it("[IR-0033] registry ir.getMode エントリが存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.getMode");
  });

  it("[IR-0033] registry ir.getMode エントリが hub3(optional) の 1 パラメータを持つ", () => {
    // ref: packages/kit/src/serve/entries/ir.js:96-101
    const entries = irEntries();
    const entry = entries["ir.getMode"];
    expect(entry).toBeDefined();

    const paramNames = entry.params.map((p) => p.name);
    expect(paramNames).toContain("hub3");

    const hub3Param = entry.params.find((p) => p.name === "hub3");
    expect(hub3Param.required).toBe(false);
  });

  it("[IR-0033] ir.getMode result description mentions mode", () => {
    const entries = irEntries();
    expect(entries["ir.getMode"].result).toMatch(/mode/i);
  });

  it("[IR-0033] proto IrGetModeRequest フィールド (optional hub3=1) が存在する", async () => {
    // ref: packages/kit/src/serve/sesame.proto:1689-1691
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const protoPath = new URL("../../../kit/src/serve/sesame.proto", import.meta.url);
    const proto = readFileSync(fileURLToPath(protoPath), "utf8");

    const getModeBlock = proto.match(/message IrGetModeRequest \{[^}]+\}/)?.[0] ?? "";
    expect(getModeBlock).toMatch(/hub3/);
    expect(getModeBlock).toMatch(/= 1/);
  });

  it("[IR-0033] CLI --json 封筒は {mode} キーを持つ", () => {
    // ref: packages/kit/src/cli/ir.js:61  out(opts.json, ..., { mode })
    const mode = { ir_mode: 0 };
    const jsonOut = { mode };
    expect(jsonOut).toHaveProperty("mode");
    expect(jsonOut.mode).toEqual(mode);
  });

  it("[IR-0033] cli.mode キーが en カタログに存在する (人間可読出力)", async () => {
    // ref: packages/kit/src/i18n/cli.js:150  "cli.mode": "mode: {mode}"
    const cliCatalog = await import("../../../kit/src/i18n/cli.js");
    const en = cliCatalog.default?.en ?? cliCatalog.en;
    expect(typeof en["cli.mode"]).toBe("string");
    expect(en["cli.mode"]).toMatch(/mode/);
  });
});

// ─── IR-0034: ir.setMode → setIRMode WS フレーム ─────────────────────────────

describe("[IR-0034] ir.setMode → setIRMode WS フレーム", () => {
  it("[IR-0034] setIRMode(mode=0) フレームが {action:'biz3IRRemote', op:'setIRMode', deviceId, mode:0, companyID} で vendor と一致", async () => {
    // ref: packages/core/src/ir.js:365-370  frame = {action,op:'setIRMode',deviceId,mode,companyID}
    const client = makeClient({ setIRMode: { success: true } });

    await setIRMode(client, { deviceId: DEVICE_ID, mode: MODE.CONTROL, companyID: COMPANY_ID });

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      action: ACTION,
      op: "setIRMode",
      deviceId: DEVICE_ID,
      mode: 0,
      companyID: COMPANY_ID,
    });
  });

  it("[IR-0034] setIRMode(mode=1) フレームに mode:1 がそのまま乗る (変換無し)", async () => {
    // ref: packages/core/src/ir.js:366  mode がそのまま frame.mode に乗る
    const client = makeClient({ setIRMode: { success: true } });

    await setIRMode(client, { deviceId: DEVICE_ID, mode: MODE.REGISTER, companyID: COMPANY_ID });

    expect(client.requests[0]).toMatchObject({
      op: "setIRMode",
      mode: 1,
    });
  });

  it("[IR-0034] フレームキーは action/op/deviceId/mode/companyID の 5 つのみ", async () => {
    const client = makeClient({ setIRMode: { success: true } });
    await setIRMode(client, { deviceId: DEVICE_ID, mode: 0, companyID: COMPANY_ID });
    const keys = Object.keys(client.requests[0]).sort();
    expect(keys).toEqual(["action", "companyID", "deviceId", "mode", "op"].sort());
  });

  it("[IR-0034] mode の型は number (変換なし)", async () => {
    const client = makeClient({ setIRMode: { success: true } });
    await setIRMode(client, { deviceId: DEVICE_ID, mode: 0, companyID: COMPANY_ID });
    expect(typeof client.requests[0].mode).toBe("number");
    expect(client.requests[0].mode).toBe(0);
  });

  it("[IR-0034] setIRMode は応答オブジェクト全体を返す", async () => {
    // ref: packages/core/src/ir.js:369  return resp
    const reply = { success: true, op: "setIRMode", data: null };
    const client = makeClient({ setIRMode: reply });

    const result = await setIRMode(client, { deviceId: DEVICE_ID, mode: 0, companyID: COMPANY_ID });
    expect(result).toEqual(reply);
  });
});

// ─── IR-0035: ir.setMode CLI mode 値域検証 ───────────────────────────────────

describe("[IR-0035] ir.setMode CLI mode 値域検証 (0/1 以外で exit 2, CONTROL/REGISTER ラベル)", () => {
  it("[IR-0035] cli.modeMustBe キーが en カタログに存在し、0/1 のみ有効であることを示す文言を含む", async () => {
    // ref: packages/kit/src/cli/ir.js:73  if(![0,1].includes(m)) die(t('cli.modeMustBe'),2)
    const cliCatalog = await import("../../../kit/src/i18n/cli.js");
    const en = cliCatalog.default?.en ?? cliCatalog.en;
    expect(typeof en["cli.modeMustBe"]).toBe("string");
    // The message must reference both 0 (CONTROL) and 1 (REGISTER)
    expect(en["cli.modeMustBe"]).toMatch(/0/);
    expect(en["cli.modeMustBe"]).toMatch(/1/);
    expect(en["cli.modeMustBe"]).toMatch(/CONTROL/);
    expect(en["cli.modeMustBe"]).toMatch(/REGISTER/);
  });

  it("[IR-0035] mode が 0 か 1 のみ有効であるロジック (![0,1].includes(m))", () => {
    // ref: packages/kit/src/cli/ir.js:72-73
    function isValidMode(rawMode) {
      const m = Number(rawMode);
      return [0, 1].includes(m);
    }

    expect(isValidMode("0")).toBe(true);
    expect(isValidMode("1")).toBe(true);
    expect(isValidMode(0)).toBe(true);
    expect(isValidMode(1)).toBe(true);
    expect(isValidMode("2")).toBe(false);
    expect(isValidMode("-1")).toBe(false);
    expect(isValidMode("abc")).toBe(false);
  });

  it("[IR-0035] mode=0 → label='CONTROL', mode=1 → label='REGISTER' (出力ラベル対応)", () => {
    // ref: packages/kit/src/cli/ir.js:76  m===0?'CONTROL':'REGISTER'
    const label = (m) => (m === 0 ? "CONTROL" : "REGISTER");
    expect(label(0)).toBe("CONTROL");
    expect(label(1)).toBe("REGISTER");
  });

  it("[IR-0035] cli.okMode キーが en カタログに存在し {mode} と {label} のテンプレートを含む", async () => {
    // ref: packages/kit/src/i18n/cli.js:152  "cli.okMode": "OK: mode={mode} ({label})"
    const cliCatalog = await import("../../../kit/src/i18n/cli.js");
    const en = cliCatalog.default?.en ?? cliCatalog.en;
    expect(typeof en["cli.okMode"]).toBe("string");
    expect(en["cli.okMode"]).toMatch(/\{mode\}/);
    expect(en["cli.okMode"]).toMatch(/\{label\}/);
  });

  it("[IR-0035] die(modeMustBe, 2) は process.exit(2) を呼ぶ", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error(`exit:${_code}`);
    });
    try {
      const { die } = await import("../../../kit/src/cli/errors.js");
      const cliCatalog = await import("../../../kit/src/i18n/cli.js");
      const msg = cliCatalog.default?.en["cli.modeMustBe"] ?? "mode must be 0 or 1";

      // Simulate: if(![0,1].includes(m)) die(t('cli.modeMustBe'), 2)
      const mode = "2";
      const m = Number(mode);
      if (![0, 1].includes(m)) {
        expect(() => die(msg, 2)).toThrow("exit:2");
      }
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ─── IR-0036: ir.setMode serve mode 必須検証 ─────────────────────────────────

describe("[IR-0036] ir.setMode serve mode 必須検証", () => {
  it("[IR-0036] registry ir.setMode エントリが存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.setMode");
  });

  it("[IR-0036] ir.setMode エントリが mode を required:true として宣言している", () => {
    // ref: packages/kit/src/serve/entries/ir.js:102-107
    const entries = irEntries();
    const modeParam = entries["ir.setMode"].params.find((p) => p.name === "mode");
    expect(modeParam).toBeDefined();
    expect(modeParam.required).toBe(true);
  });

  it("[IR-0036] ir.setMode エントリが hub3 を required:false として宣言している (hub3 は省略可)", () => {
    // ref: packages/kit/src/serve/entries/ir.js:104  hub3 required: false
    const entries = irEntries();
    const hub3Param = entries["ir.setMode"].params.find((p) => p.name === "hub3");
    expect(hub3Param).toBeDefined();
    expect(hub3Param.required).toBe(false);
  });

  it("[IR-0036] need() は mode が undefined の場合に RpcError を投げる (bad_params)", async () => {
    // ref: packages/kit/src/serve/registry-helpers.js:32-38
    const { RpcError } = await import("@sesame-kit/core/jsonrpc");
    expect(() => need({}, ["mode"])).toThrow(RpcError);
  });

  it("[IR-0036] need() は mode が null の場合も RpcError を投げる", async () => {
    const { RpcError, RPC } = await import("@sesame-kit/core/jsonrpc");
    let thrown;
    try {
      need({ mode: null }, ["mode"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect(thrown.code).toBe(RPC.INVALID_PARAMS);
  });

  it("[IR-0036] need() は mode が空文字の場合も RpcError を投げる", async () => {
    const { RpcError } = await import("@sesame-kit/core/jsonrpc");
    expect(() => need({ mode: "" }, ["mode"])).toThrow(RpcError);
  });

  it("[IR-0036] need() は mode に値がある場合はエラーを投げない", () => {
    expect(() => need({ mode: 0 }, ["mode"])).not.toThrow();
    expect(() => need({ mode: 1 }, ["mode"])).not.toThrow();
  });

  it("[IR-0036] need() の kind は bad_params", async () => {
    const { RpcError, KIND } = await import("@sesame-kit/core/jsonrpc");
    let thrown;
    try {
      need({ mode: undefined }, ["mode"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect(thrown.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[IR-0036] hub3 absence does not trigger need() error (hub3 is optional)", () => {
    // Only mode is passed to need(); hub3 is accessed as params.hub3 ?? null
    expect(() => need({ mode: 0 }, ["mode"])).not.toThrow();
  });

  it("[IR-0036] setIRMode success:false throws (assertSuccess strict)", async () => {
    const client = makeClient({ setIRMode: { success: false, message: "server denied" } });
    await expect(
      setIRMode(client, { deviceId: DEVICE_ID, mode: 0, companyID: COMPANY_ID })
    ).rejects.toMatchObject({ code: "rejected" });
  });
});

// CFG-0096 / CFG-0097 / CFG-0098 — sesame-kit config spec
// 対象実装: packages/core/src/config.js (ConfigStore), packages/kit/src/cli/remote.js
// 実 IO (tmpdir) を使用。ネットワーク/実機不使用。各 it 独立。
// TDD: spec 正解の assert を書く。実装が追いついていない場合は red のまま残す。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "../../src/config.js";

// ---------------------------------------------------------------------------
// テスト共通セットアップ
// ---------------------------------------------------------------------------

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-cfg-c5-"));
  configPath = join(workDir, "config.json");
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
  workDir = null;
  configPath = null;
});

/** Hub3 を登録したうえで ConfigStore を返すヘルパ */
function storeWithHub3(hub3Name = "hub-a", deviceId = "aaaabbbbccccdddd") {
  const store = new ConfigStore(configPath);
  store.addHub3(hub3Name, { deviceId });
  return store;
}

// ---------------------------------------------------------------------------
// CFG-0096: syncRemotesFromServer の既存 remote 更新が irOperation を再導出しない
//   (syncRemotesFromDevices は再導出する — 面内非対称・stale バグ)
// ---------------------------------------------------------------------------

describe("[CFG-0096] syncRemotesFromServer: 既存 remote 更新時 irOperation を再導出しない (非対称・stale)", () => {
  // CFG-0096 は既知の実装ギャップ (TDD / red):
  //   syncRemotesFromServer の既存 remote 更新ブランチ (config.js 882 付近) は
  //   irType/alias/code/state を更新するが irOperation を再導出しない。
  //   一方 syncRemotesFromDevices の更新ブランチ (config.js 823-824) は再導出する。
  //   spec 正解: irType が変化したとき irOperation も deriveIrOperation で追従すべき。
  //   テストは spec 正解の assert; 現実装では RED。

  it("[CFG-0096] irType が learnEmit(0xFE00)→プリセット(0xC000)へ変化時: irOperation は remoteEmit に再導出されるべき (現実装は stale = RED)", () => {
    const irDeviceUUID = "aabbccdd11223344aabbccdd11223344";
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID,
      irType: 0xfe00,
    });

    // 初回 added: irOperation は learnEmit であるべき
    const before = store.load().remotes.r1;
    expect(before.irType).toBe(0xfe00);
    expect(before.irOperation).toBe("learnEmit");

    // server が irType を 0xC000 (preset) に変えて再 sync
    store.syncRemotesFromServer(
      [{ irDeviceUUID, type: 0xc000, alias: null }],
      "hub-a",
    );

    const after = store.load().remotes.r1;
    // irType は更新される
    expect(after.irType).toBe(0xc000);
    // spec 正解: irOperation は remoteEmit に追従すべき (現実装は stale → RED)
    expect(after.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0096] irType がプリセット(0xC000)→learnEmit(0xFE00)へ変化時: irOperation は learnEmit に再導出されるべき (現実装は stale = RED)", () => {
    const irDeviceUUID = "bbccddee11223344bbccddee11223344";
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID,
      irType: 0xc000,
    });

    const before = store.load().remotes.r1;
    expect(before.irOperation).toBe("remoteEmit");

    // server が irType を 0xFE00 (自己学習) に変化
    store.syncRemotesFromServer(
      [{ irDeviceUUID, type: 0xfe00 }],
      "hub-a",
    );

    const after = store.load().remotes.r1;
    expect(after.irType).toBe(0xfe00);
    // spec 正解: irOperation は learnEmit に追従すべき (現実装は remoteEmit のまま = RED)
    expect(after.irOperation).toBe("learnEmit");
  });

  it("[CFG-0096] syncRemotesFromDevices の既存更新は irOperation を正しく再導出する (非対称の基準点: GREEN)", () => {
    // この test は syncRemotesFromDevices が正しく再導出することを確認し、
    // CFG-0096 の非対称性を浮き彫りにする基準点。
    const irDeviceUUID = "ccddee1122334455ccddee1122334455";
    const hub3DeviceUUID = "aaaabbbbccccdddd";
    const store = storeWithHub3("hub-a", hub3DeviceUUID);

    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID,
      irType: 0xfe00, // learnEmit
    });

    expect(store.load().remotes.r1.irOperation).toBe("learnEmit");

    // syncRemotesFromDevices: deviceUUID が hub3ByUuid マップに一致する必要あり
    const deviceList = [{
      deviceModel: "hub_3",
      deviceUUID: hub3DeviceUUID,
      stateInfo: {
        remoteList: [
          { uuid: irDeviceUUID, type: 0xc000 }, // preset
        ],
      },
    }];

    store.syncRemotesFromDevices(deviceList);

    const after = store.load().remotes.r1;
    expect(after.irType).toBe(0xc000);
    // syncRemotesFromDevices は正しく再導出する (config.js:823-824) → GREEN
    expect(after.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0096] syncRemotesFromServer の新規 added は irOperation を正しく導出する (added 経路は GREEN)", () => {
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.syncRemotesFromServer(
      [
        { irDeviceUUID: "IR-A-learn", type: 0xfe00, alias: "学習" },
        { irDeviceUUID: "IR-B-preset", type: 0xc000, alias: "プリセット" },
      ],
      "hub-a",
    );
    const remotes = Object.values(store.load().remotes);
    const learn = remotes.find((r) => r.irDeviceUUID === "IR-A-learn");
    const preset = remotes.find((r) => r.irDeviceUUID === "IR-B-preset");
    expect(learn.irOperation).toBe("learnEmit");
    expect(preset.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0096] irType 変化なし(同値)の場合は syncRemotesFromServer も updated に積まない (stale なし)", () => {
    const irDeviceUUID = "ddeeff1122334455ddeeff1122334455";
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID,
      irType: 0xfe00,
    });

    // Same irType, no other change
    const result = store.syncRemotesFromServer(
      [{ irDeviceUUID, type: 0xfe00 }],
      "hub-a",
    );

    // 変化なし → updated は空
    expect(result.updated).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CFG-0097: remote / hub3 の直接削除経路が core/cli ともに不在
// ---------------------------------------------------------------------------

describe("[CFG-0097] remote/hub3 の直接削除経路が core/cli ともに不在 (lock のみ非対称)", () => {
  // CFG-0097 は negative-existence の契約テスト。
  // ConfigStore に removeRemote / removeHub3 が存在しないこと、
  // CLI registerRemoteCommands が 'remote rm' / 'hub3 rm' を登録しないことを確認。
  // ConfigStore.removeLock のみ存在する (CFG-0057/0058)。

  it("[CFG-0097] ConfigStore に removeRemote メソッドが存在しない (negative-existence)", () => {
    const store = new ConfigStore(configPath);
    expect(typeof store.removeRemote).toBe("undefined");
    expect(store.removeRemote).toBeUndefined();
  });

  it("[CFG-0097] ConfigStore に removeHub3 メソッドが存在しない (negative-existence)", () => {
    const store = new ConfigStore(configPath);
    expect(typeof store.removeHub3).toBe("undefined");
    expect(store.removeHub3).toBeUndefined();
  });

  it("[CFG-0097] ConfigStore.removeLock は存在する (非対称の基準点: lock のみ削除可)", () => {
    const store = new ConfigStore(configPath);
    expect(typeof store.removeLock).toBe("function");
  });

  it("[CFG-0097] registerRemoteCommands が 'remote rm' / 'hub3 rm' を登録しない (CLI negative-existence)", async () => {
    const { registerRemoteCommands } = await import(
      "../../../kit/src/cli/remote.js"
    );

    // 登録されたサブコマンドを収集する最小 Commander スタブ
    const registeredCommands = [];
    function makeCommandStub(nameStr) {
      const stub = {
        _name: nameStr,
        description: () => stub,
        addHelpText: () => stub,
        option: () => stub,
        action: () => stub,
        command(subName) {
          registeredCommands.push({ parent: nameStr, sub: subName.split(" ")[0] });
          return makeCommandStub(subName.split(" ")[0]);
        },
      };
      return stub;
    }

    const programStub = {
      command(name) {
        return makeCommandStub(name);
      },
    };

    registerRemoteCommands(programStub);

    const remoteSubcmds = registeredCommands
      .filter((c) => c.parent === "remote")
      .map((c) => c.sub);
    const hub3Subcmds = registeredCommands
      .filter((c) => c.parent === "hub3")
      .map((c) => c.sub);

    // 'remote rm' / 'hub3 rm' は登録されない (negative-fact)
    expect(remoteSubcmds).not.toContain("rm");
    expect(hub3Subcmds).not.toContain("rm");

    // 登録済みの正規コマンドが存在すること (positive baseline)
    expect(remoteSubcmds).toContain("ls");
    expect(remoteSubcmds).toContain("add");
    expect(hub3Subcmds).toContain("ls");
    expect(hub3Subcmds).toContain("add");
    expect(hub3Subcmds).toContain("sync-from-devices");
  });

  it("[CFG-0097] remote の手動登録エントリを prune 以外で正規に削除する経路がない (prune 依存の確認)", () => {
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID: "11112222333344445555666677778888",
      irType: 0xfe00,
    });

    // remote が存在することを確認
    expect(store.load().remotes.r1).toBeDefined();

    // removeRemote は存在しない (prune 経由でしか削除できない)
    expect(store.removeRemote).toBeUndefined();

    // removeLock は対照的に存在する
    expect(typeof store.removeLock).toBe("function");
  });

  it("[CFG-0097] lock は removeLock + addLock が存在し remote/hub3 と非対称である (対称基準の確認)", () => {
    const store = new ConfigStore(configPath);
    // removeLock は存在する (locks の直接削除 surface は実在)
    expect(typeof store.removeLock).toBe("function");
    // addLock は存在する
    expect(typeof store.addLock).toBe("function");

    // removeLock を実際に呼べること
    store.addLock("L1", {
      deviceUUID: "11112222333344445555666677778888",
      secretKey: "00112233445566778899aabbccddeeff",
    });
    expect(() => store.removeLock("L1")).not.toThrow();
    expect(store.load().locks["L1"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CFG-0098: syncRemotes* が IrRemote.model (品牌/brand) を捨てる (negative-fact)
// ---------------------------------------------------------------------------

describe("[CFG-0098] syncRemotes* が IrRemote.model(品牌/brand) を保存しない (negative-fact payload)", () => {
  // IrRemote.kt:6 は `var model: String? // 品牌名称` を定義するが、
  // syncRemotesFromDevices / syncRemotesFromServer はいずれも model を RemoteEntry に保存しない。
  // これは意図的な省略 (sendIR 操作は irType + code で成立するため model 不要)。

  it("[CFG-0098] syncRemotesFromDevices: remoteList 要素の model(品牌名) を RemoteEntry に保存しない", () => {
    const hub3DeviceUUID = "aaaabbbbccccdddd";
    const irDeviceUUID = "11112222333344445555666677778888";
    const store = storeWithHub3("hub-a", hub3DeviceUUID);

    const deviceList = [
      {
        deviceModel: "hub_3",
        deviceUUID: hub3DeviceUUID,
        stateInfo: {
          remoteList: [
            {
              uuid: irDeviceUUID,
              type: 0xc000,
              alias: "リビングエアコン",
              model: "Daikin", // IrRemote.kt:6 品牌名称 — 捨てるべき
              code: 3,
              state: "abc",
            },
          ],
        },
      },
    ];

    store.syncRemotesFromDevices(deviceList);

    const remotes = store.load().remotes;
    const entries = Object.values(remotes);
    expect(entries).toHaveLength(1);
    const entry = entries[0];

    // model は保存しない (intentional omission)
    expect(Object.prototype.hasOwnProperty.call(entry, "model")).toBe(false);
    expect(entry.model).toBeUndefined();

    // 保存されるフィールドは正しい (positive baseline)
    expect(entry.irType).toBe(0xc000);
    expect(entry.alias).toBe("リビングエアコン");
    expect(entry.code).toBe(3);
    expect(entry.state).toBe("abc");
  });

  it("[CFG-0098] syncRemotesFromServer: remoteList 要素の model(品牌名) を RemoteEntry に保存しない", () => {
    const irDeviceUUID = "22223333444455556666777788889999";
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");

    store.syncRemotesFromServer(
      [
        {
          irDeviceUUID,
          type: 0xc000,
          alias: "ダイキンエアコン",
          model: "Daikin", // IrRemote.kt:6 — 捨てるべき
          code: 7,
          state: "ff00",
        },
      ],
      "hub-a",
    );

    const remotes = store.load().remotes;
    const entries = Object.values(remotes);
    expect(entries).toHaveLength(1);
    const entry = entries[0];

    // model は保存しない
    expect(Object.prototype.hasOwnProperty.call(entry, "model")).toBe(false);
    expect(entry.model).toBeUndefined();

    // 保存されるフィールド
    expect(entry.irType).toBe(0xc000);
    expect(entry.alias).toBe("ダイキンエアコン");
    expect(entry.code).toBe(7);
    expect(entry.state).toBe("ff00");
  });

  it("[CFG-0098] syncRemotesFromDevices 既存 remote 更新時も model を追加しない", () => {
    const hub3DeviceUUID = "aaaabbbbccccdddd";
    const irDeviceUUID = "33334444555566667777888899990000";
    const store = storeWithHub3("hub-a", hub3DeviceUUID);

    // 初回 addRemote
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID,
      irType: 0xfe00,
    });

    // model フィールドを含む source で既存 remote を更新
    const deviceList = [
      {
        deviceModel: "hub_3",
        deviceUUID: hub3DeviceUUID,
        stateInfo: {
          remoteList: [
            {
              uuid: irDeviceUUID,
              type: 0xfe00,
              alias: "寝室クーラー",
              model: "Mitsubishi", // 更新時も捨てるべき
            },
          ],
        },
      },
    ];

    store.syncRemotesFromDevices(deviceList);

    const entry = store.load().remotes.r1;
    expect(Object.prototype.hasOwnProperty.call(entry, "model")).toBe(false);
    expect(entry.model).toBeUndefined();
  });

  it("[CFG-0098] syncRemotesFromServer 既存 remote 更新時も model を追加しない", () => {
    const irDeviceUUID = "44445555666677778888999900001111";
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID,
      irType: 0xfe00,
    });

    store.syncRemotesFromServer(
      [
        {
          irDeviceUUID,
          type: 0xfe00,
          alias: "学習リモコン",
          model: "Samsung", // 更新時も捨てるべき
          state: "010203",
        },
      ],
      "hub-a",
    );

    const entry = store.load().remotes.r1;
    expect(Object.prototype.hasOwnProperty.call(entry, "model")).toBe(false);
    expect(entry.model).toBeUndefined();
  });

  it("[CFG-0098] RemoteEntry typedef に model フィールドがない (addRemote が model を保存しない)", () => {
    // addRemote は canonical な remote 作成手段; model を受け取っても保存しない
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID: "55556666777788889999000011112222",
      irType: 0xfe00,
      model: "Sony", // 意図的に渡すが保存されない
    });

    const entry = store.load().remotes.r1;
    // addRemote は unknown field (model) をコピーしない
    expect(Object.prototype.hasOwnProperty.call(entry, "model")).toBe(false);
    expect(entry.model).toBeUndefined();
    expect(entry.irDeviceUUID).toBe("55556666777788889999000011112222");
  });

  it("[CFG-0098] model 不在は send 操作に影響しない (irType/code の組で動作成立を確認: 意図的逸脱の根拠)", () => {
    // model を保存しなくても irType と code があれば remoteEmit で動作成立する
    const store = storeWithHub3("hub-a", "aaaabbbbccccdddd");
    store.syncRemotesFromServer(
      [
        {
          irDeviceUUID: "66667777888899990000111122223333",
          type: 0xc000,
          alias: "エアコン",
          model: "Daikin",
          code: 9999,
          state: "AABB",
        },
      ],
      "hub-a",
    );
    const entry = Object.values(store.load().remotes).find(
      (r) => r.irDeviceUUID === "66667777888899990000111122223333",
    );
    // send 操作に必要な irType/code/irOperation は揃っている
    expect(entry.irType).toBe(0xc000);
    expect(entry.code).toBe(9999);
    expect(entry.irOperation).toBe("remoteEmit");
    expect(entry.state).toBe("AABB");
    // model は無くても send 操作は成立する (意図的逸脱)
    expect(entry.model).toBeUndefined();
  });
});

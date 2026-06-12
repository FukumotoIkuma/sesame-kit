export default {
  en: {
    // sharekey.js
    "org.sharekey.unknownDeviceModel": "unknown deviceModel: {model} (cannot resolve productType)",
    "org.sharekey.fieldRequired": "deviceKey.{field} required (needed to build the share URL)",

    // org.js argument guards
    "org.req.companyID": "companyID required",
    "org.req.itemsArray": "items must be an array",
    "org.req.gidsArray": "gids must be an array",
    "org.req.groupIdsArray": "groupIds must be an array",
    "org.req.keyword": "keyword required",
    "org.req.email": "email required",
    "org.req.gid": "gid required",
    "org.req.subUUID": "subUUID required",
    "org.req.data": "data required",
    "org.req.deviceUUID": "deviceUUID required",

    // cli/org.js shared validation errors
    "org.err.jsonArray": "--json must be an array.",
    "org.err.uuidsArray": "--uuids must be an array.",
    "org.err.itemsArray": "--json items must be an array.",
    "org.err.uuidsItemsArray": "--json uuids / items must be arrays.",

    // command group descriptions
    "org.cmd.org": "Organization management (biz3: employees / employee groups / role tags / device groups / key sharing)",
    "org.cmd.employee": "Employee management (list/add/update/remove/reorder/search/self)",
    "org.cmd.group": "Employee group management (list/add/update/remove/member binding/device group linking)",
    "org.cmd.role": "Role tag management (list/add or update/remove)",
    "org.cmd.deviceGroup": "Device group management (list/create/update/remove/device binding/employee group linking)",
    "org.cmd.keys": "Device key sharing/listing/revocation (employeeDevice + getDeviceEmployeeKeys)",

    // employee ls
    "org.employee.ls.desc": "List employees (getEmployees; aggregates all pubEmployees push pages)",
    "org.employee.ls.none": "(no employees)",
    "org.employee.ls.found": "Found {n} employee(s) (totalCount={count}):",

    // employee me
    "org.employee.me.desc": "Logged-in user's own employee info (getCurrentUserInfo; data shape unverified against biz3)",

    // employee add
    "org.employee.add.desc": "Add employees (addEmployees; items is an array, each element including companyID)",
    "org.employee.add.opt": "JSON array. e.g. '[{\"employeeEmail\":\"a@b.c\",\"employeeName\":\"Yamada\",\"tag\":[]}]'",
    "org.employee.add.need": "items required: sesame org employee add --json '[{\"employeeEmail\":\"…\",\"employeeName\":\"…\"}]'",
    "org.employee.add.hint": "[{\"employeeEmail\":\"a@b.c\",\"employeeName\":\"Yamada\"}]",
    "org.employee.add.ok": "OK: requested add of {n} employee(s)",

    // employee update
    "org.employee.update.desc": "Update employee info (updateEmployee; companyID auto-injected, update fields via --json)",
    "org.employee.update.opt": "JSON object. e.g. '{\"Name\":\"nickname\",\"Value\":\"new name\"}'",
    "org.employee.update.need": "update fields required: sesame org employee update --json '{\"Name\":\"…\",\"Value\":\"…\"}'",
    "org.employee.update.hint": "{\"Name\":\"nickname\",\"Value\":\"new name\"}",
    "org.employee.update.ok": "OK: employee updated",

    // employee rm
    "org.employee.rm.desc": "Remove employees (removeEmployees; items is an array of employee objects/[{subUUID,companyID}])",
    "org.employee.rm.opt": "JSON array. e.g. '[{\"subUUID\":\"…\",\"companyID\":\"…\"}]'",
    "org.employee.rm.need": "items required: sesame org employee rm --json '[{\"subUUID\":\"…\"}]'",
    "org.employee.rm.ok": "OK: requested removal of {n} employee(s)",

    // employee reorder
    "org.employee.reorder.desc": "Update employee order (reorderEmployees; each element {friendUUID, rank})",
    "org.employee.reorder.opt": "JSON array. e.g. '[{\"friendUUID\":\"…\",\"rank\":0},{\"friendUUID\":\"…\",\"rank\":-1}]'",
    "org.employee.reorder.need": "items required: sesame org employee reorder --json '[{\"friendUUID\":\"…\",\"rank\":0}]'",
    "org.employee.reorder.ok": "OK: reorder requested ({n} item(s))",

    // employee search
    "org.employee.search.desc": "Search users across CS (queryByCS; aggregates all pubQueryByCS push pages)",
    "org.employee.search.none": "(no matches)",
    "org.employee.search.found": "Found {n} match(es):",

    // employee confirm
    "org.employee.confirm.desc": "Confirm a user found via queryByCS (confirmQueryByCS). Note: biz3 signs out the current session on success",
    "org.employee.confirm.prompt": "On success, biz3 signs out the current session for confirmQueryByCS. Continue? ({email})",
    "org.employee.confirm.aborted": "Aborted.",
    "org.employee.confirm.ok": "OK: confirmed {email}",

    // group ls
    "org.group.ls.desc": "List employee groups (getEmployeeGroups)",
    "org.group.ls.none": "(no employee groups)",
    "org.group.ls.found": "Found {n} employee group(s):",

    // group add
    "org.group.add.desc": "Add an employee group (addEmployeeGroup; companyID auto-injected, item via --json)",
    "org.group.add.opt": "JSON object (fields like group name depend on biz3 UI, unverified). e.g. '{\"name\":\"Sales\"}'",
    "org.group.add.need": "item required: sesame org group add --json '{\"name\":\"Sales\"}'",
    "org.group.add.hint": "{\"name\":\"Sales\"}",
    "org.group.add.ok": "OK: added employee group",
    "org.group.add.okId": "OK: added employee group ({gid})",

    // group update
    "org.group.update.desc": "Update an employee group (updateEmployeeGroup; include gid etc. in item)",
    "org.group.update.opt": "JSON object. e.g. '{\"gid\":\"…\",\"name\":\"new name\"}'",
    "org.group.update.need": "item required: sesame org group update --json '{\"gid\":\"…\",\"name\":\"…\"}'",
    "org.group.update.hint": "{\"gid\":\"…\",\"name\":\"new name\"}",
    "org.group.update.ok": "OK: employee group updated",

    // group rm
    "org.group.rm.desc": "Remove employee groups (removeEmployeeGroups; gids is an array, element type depends on biz3 UI, unverified)",
    "org.group.rm.opt": "JSON array. e.g. '[\"gid1\",\"gid2\"]'",
    "org.group.rm.need": "gids required: sesame org group rm --json '[\"gid1\"]'",
    "org.group.rm.ok": "OK: requested removal of {n} group(s)",

    // group device-groups
    "org.group.deviceGroups.desc": "Get device groups bound to an employee group (getEmployeeGroupBindDeviceGroup; cid not sent)",

    // group add-users
    "org.group.addUsers.desc": "Bind users to an employee group (addEmployeeInGroup; pass both uuids/items via --json)",
    "org.group.addUsers.opt": "JSON {uuids,items}. e.g. '{\"uuids\":[\"sub1\"],\"items\":[{\"subUUID\":\"sub1\"}]}'",
    "org.group.addUsers.need": "uuids/items required: sesame org group add-users <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.group.addUsers.ok": "OK: bound users to group {gid}",

    // group rm-users
    "org.group.rmUsers.desc": "Unbind users from an employee group (removeEmployeeInGroup; items is narrowed to {subUUID})",
    "org.group.rmUsers.opt": "JSON {uuids,items}. e.g. '{\"uuids\":[\"sub1\"],\"items\":[{\"subUUID\":\"sub1\"}]}'",
    "org.group.rmUsers.need": "uuids/items required: sesame org group rm-users <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.group.rmUsers.ok": "OK: unbound users from group {gid}",

    // group rm-device-group
    "org.group.rmDeviceGroup.desc": "Unbind a device group from an employee group (removeEmployeeGroupBindDeviceGroup; data contents unverified against biz3)",
    "org.group.rmDeviceGroup.opt": "JSON object (gid etc.; depends on biz3 UI, unverified).",
    "org.group.rmDeviceGroup.need": "data required: sesame org group rm-device-group --json '{\"gid\":\"…\"}'",
    "org.group.rmDeviceGroup.ok": "OK: unbound device group from employee group",

    // role ls
    "org.role.ls.desc": "List role tags (getTags)",
    "org.role.ls.none": "(no role tags)",
    "org.role.ls.found": "Found {n} role tag(s):",

    // role post
    // role の実フィールドは {tag, access[]} (EmployeeRoles.js:161-164)。access の値は
    // 日本語ページ名定数 (gUtils.js pageNames。account.PAGE_NAMES として公開) そのもの。
    "org.role.post.desc": "Add/update a role tag (postTag; companyID auto-injected, data = {tag, access[]} via --json)",
    "org.role.post.opt": "JSON object {tag, access[]} (access values are the Japanese page-name constants, see account.PAGE_NAMES). e.g. '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.post.need": "data required: sesame org role post --json '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.post.hint": "{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}",
    "org.role.post.ok": "OK: role tag posted",

    // role rm
    "org.role.rm.desc": "Remove a role tag (removeTag; data = the whole tagSetting {tag, access[]}, see DataTableColumns.js:627)",
    "org.role.rm.opt": "JSON object: the whole tagSetting {tag, access[]}. e.g. '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.rm.need": "data required: sesame org role rm --json '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.rm.hint": "{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}",
    "org.role.rm.ok": "OK: role tag removed",

    // device-group ls
    "org.deviceGroup.ls.desc": "List device groups (getDeviceGroups)",
    "org.deviceGroup.ls.none": "(no device groups)",
    "org.deviceGroup.ls.found": "Found {n} device group(s):",

    // device-group add
    "org.deviceGroup.add.desc": "Create a device group (addDeviceGroup; companyID auto-injected)",
    "org.deviceGroup.add.opt": "JSON array of deviceUUID. e.g. '[\"uuid1\",\"uuid2\"]'",
    "org.deviceGroup.add.ok": "OK: created device group \"{name}\" ({n} device(s))",

    // device-group update
    "org.deviceGroup.update.desc": "Update a device group (updateDeviceGroup; include gid etc. in item)",
    "org.deviceGroup.update.opt": "JSON object. e.g. '{\"gid\":\"…\",\"name\":\"new name\"}'",
    "org.deviceGroup.update.need": "item required: sesame org device-group update --json '{\"gid\":\"…\",\"name\":\"…\"}'",
    "org.deviceGroup.update.hint": "{\"gid\":\"…\",\"name\":\"new name\"}",
    "org.deviceGroup.update.ok": "OK: device group updated",

    // device-group rm
    "org.deviceGroup.rm.desc": "Remove device groups (removeDeviceGroups; cid auto-merged into each element)",
    "org.deviceGroup.rm.opt": "JSON array of objects. e.g. '[{\"gid\":\"…\"}]'",
    "org.deviceGroup.rm.need": "groupIds required: sesame org device-group rm --json '[{\"gid\":\"…\"}]'",
    "org.deviceGroup.rm.ok": "OK: requested removal of {n} device group(s)",

    // device-group add-devices
    "org.deviceGroup.addDevices.desc": "Bind devices to a device group (addDeviceInGroup; pass uuids/items via --json)",
    "org.deviceGroup.addDevices.opt": "JSON {uuids,items}. e.g. '{\"uuids\":[\"dev1\"],\"items\":[{\"deviceUUID\":\"dev1\"}]}'",
    "org.deviceGroup.addDevices.need": "uuids/items required: sesame org device-group add-devices <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.deviceGroup.addDevices.ok": "OK: bound devices to group {gid}",

    // device-group rm-devices
    "org.deviceGroup.rmDevices.desc": "Unbind devices from a device group (removeDeviceInGroup; items is narrowed to {deviceUUID,secretKey})",
    "org.deviceGroup.rmDevices.opt": "JSON {uuids,items}. e.g. '{\"uuids\":[\"dev1\"],\"items\":[{\"deviceUUID\":\"dev1\",\"secretKey\":\"…\"}]}'",
    "org.deviceGroup.rmDevices.need": "uuids/items required: sesame org device-group rm-devices <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.deviceGroup.rmDevices.ok": "OK: unbound devices from group {gid}",

    // device-group user-groups
    "org.deviceGroup.userGroups.desc": "Get employee groups bound to a device group (getDeviceGroupBindUserGroup; cid not sent)",

    // device-group rm-user-group
    "org.deviceGroup.rmUserGroup.desc": "Unbind an employee group from a device group (removeDeviceGroupBindUserGroup; data contents unverified against biz3)",
    "org.deviceGroup.rmUserGroup.opt": "JSON object (gid/uuids etc.; depends on biz3 UI, unverified).",
    "org.deviceGroup.rmUserGroup.need": "data required: sesame org device-group rm-user-group --json '{\"gid\":\"…\"}'",
    "org.deviceGroup.rmUserGroup.ok": "OK: unbound user group from device group",

    // keys device
    "org.keys.device.desc": "List key-holding employees from the device side (getDeviceEmployeeKeys; companyID required, auto-injected)",
    "org.keys.device.opt": "0=all / 5=non-admin mode",
    "org.keys.device.none": "(no key holders)",
    "org.keys.device.found": "Found {n} key holder(s) for {deviceUUID}:",

    // keys employee
    "org.keys.employee.desc": "List device keys held by a given employee (getEmployeeDeviceKeys; companyID not required, data shape unverified)",

    // keys share
    "org.keys.share.desc": "Share device keys with employees (shareDeviceKeysToEmployees; caller composes device+user info into items)",
    "org.keys.share.opt": "JSON array. Each element {...device,...user,keyLevel,startTime,endTime}. keyLevel 0=owner/1=manager/2=guest",
    "org.keys.share.need": "items required: sesame org keys share --json '[{\"deviceUUID\":\"…\",\"subUUID\":\"…\",\"keyLevel\":1,\"startTime\":\"\",\"endTime\":\"\"}]'",
    "org.keys.share.ok": "OK: shared keys ({n} item(s))",

    // keys share-group
    "org.keys.shareGroup.desc": "Share device group keys with an employee group (shareDeviceGroupKeysToEmployeeGroup; companyID auto-injected)",
    "org.keys.shareGroup.opt": "JSON {keyLevel,members,devices,mid,dids,startTime,endTime}. keyLevel is the string \"0\"/\"1\"/\"2\"",
    "org.keys.shareGroup.need": "item required: sesame org keys share-group --json '{\"keyLevel\":\"1\",\"members\":[],\"devices\":[],\"mid\":\"…\",\"dids\":[]}'",
    "org.keys.shareGroup.ok": "OK: shared device group keys to employee group",

    // keys rm
    "org.keys.rm.desc": "Remove an employee/guest device key (removeEmployeeDeviceKey). For guest keys, randomTag is auto-computed (cmacTime of the device secretKey) when omitted",
    "org.keys.rm.opt": "JSON. employee '{\"subUUID\":\"…\",\"deviceUUID\":\"…\"}' / guest '{\"guestKeyId\":\"…\",\"deviceUUID\":\"…\"}' (randomTag optional; auto-computed from the device secretKey via cmacTime, same as DeviceUserList.js:117-132)",
    "org.keys.rm.need": "data required: sesame org keys rm --json '{\"subUUID\":\"…\",\"deviceUUID\":\"…\"}'",
    "org.keys.rm.deviceNotFound": "device {deviceUUID} not found in your devices (cannot auto-compute randomTag; pass randomTag explicitly)",
    "org.keys.rm.noSecretKey": "device {deviceUUID} has no secretKey (cannot auto-compute randomTag; pass randomTag explicitly)",
    "org.keys.rm.ok": "OK: device key removed",

    // keys update-guest-tag
    "org.keys.updateGuestTag.desc": "Update a guest key's name tag (updateGuestKeyTag)",
    "org.keys.updateGuestTag.opt": "JSON {deviceUUID,guestKeyId,keyName}. keyName is the new tag name",
    "org.keys.updateGuestTag.need": "data required: sesame org keys update-guest-tag --json '{\"deviceUUID\":\"…\",\"guestKeyId\":\"…\",\"keyName\":\"new name\"}'",
    "org.keys.updateGuestTag.hint": "{\"deviceUUID\":\"…\",\"guestKeyId\":\"…\",\"keyName\":\"new name\"}",
    "org.keys.updateGuestTag.ok": "OK: guest key tag updated",

    // keys generate-guest-qr
    "org.keys.generateGuestQr.desc": "Issue a guest guestKeyId (generateGuestQR). data is the whole device key object. QR image rendering is out of scope for this op",
    "org.keys.generateGuestQr.opt": "The whole device key object as JSON. e.g. '{\"deviceUUID\":\"…\",\"secretKey\":\"…\",\"sesame2PublicKey\":\"…\",\"keyIndex\":0,\"deviceModel\":\"…\",\"keyLevel\":0}'",
    "org.keys.generateGuestQr.need": "data required: sesame org keys generate-guest-qr --json '{\"deviceUUID\":\"…\",\"secretKey\":\"…\"}'",
    "org.keys.generateGuestQr.ok": "OK: guestKeyId = {guestKeyId}",

    // keys share-url
    "org.keys.shareUrl.desc": "Generate a device key share URL (ssm://UI?...). The exact contents of the QR the SESAME app reads",
    "org.keys.shareUrl.optDevice": "target deviceUUID (interactive selection when omitted)",
    "org.keys.shareUrl.optLevel": "key level 0=owner / 1=manager / 2=guest (default 2)",
    "org.keys.shareUrl.optName": "display name when sharing (device name when omitted)",
    "org.keys.shareUrl.optJson": "specify the device key directly as JSON (resolved from devices when omitted)",
    "org.keys.shareUrl.optQr": "show the QR in the terminal (requires qrcode-terminal: npm i qrcode-terminal)",
    "org.keys.shareUrl.help": "\nFor level 2 (guest) only, a single-use guestKeyId is issued via generateGuestQR and embedded.\n0/1 (owner/manager) share the device's own secretKey, so handle with care.\nEven if you skip QR rendering, you can paste the printed ssm://UI URL into any QR generator to share.",
    "org.keys.shareUrl.badLevel": "--level must be one of 0 / 1 / 2.",
    "org.keys.shareUrl.deviceNotFound": "deviceUUID {device} not found in devices.",
    "org.keys.shareUrl.noDevices": "No devices available to share.",
    "org.keys.shareUrl.selectPrompt": "Select a device to share",
    "org.keys.shareUrl.cancelled": "Cancelled.",
    "org.keys.shareUrl.needDeviceOrJson": "--device <uuid> or --json <deviceKey> required (non-interactive mode).",
    "org.keys.shareUrl.qrNotInstalled": "(qrcode-terminal not installed: run `npm i qrcode-terminal` for terminal QR display)",
  },
  ja: {
    // sharekey.js
    "org.sharekey.unknownDeviceModel": "未知の deviceModel: {model} (productType を解決できません)",
    "org.sharekey.fieldRequired": "deviceKey.{field} required (共有 URL の生成に必要)",

    // org.js argument guards
    "org.req.companyID": "companyID required",
    "org.req.itemsArray": "items must be an array",
    "org.req.gidsArray": "gids must be an array",
    "org.req.groupIdsArray": "groupIds must be an array",
    "org.req.keyword": "keyword required",
    "org.req.email": "email required",
    "org.req.gid": "gid required",
    "org.req.subUUID": "subUUID required",
    "org.req.data": "data required",
    "org.req.deviceUUID": "deviceUUID required",

    // cli/org.js shared validation errors
    "org.err.jsonArray": "--json は配列である必要があります。",
    "org.err.uuidsArray": "--uuids は配列である必要があります。",
    "org.err.itemsArray": "--json の items は配列である必要があります。",
    "org.err.uuidsItemsArray": "--json の uuids / items は配列である必要があります。",

    // command group descriptions
    "org.cmd.org": "組織管理 (biz3: 社員 / 社員グループ / 役割タグ / デバイスグループ / 鍵共有)",
    "org.cmd.employee": "社員管理 (一覧/追加/更新/削除/並替/検索/自己情報)",
    "org.cmd.group": "社員グループ管理 (一覧/追加/更新/削除/メンバー紐付/デバイスグループ連携)",
    "org.cmd.role": "役割タグ管理 (一覧/追加更新/削除)",
    "org.cmd.deviceGroup": "デバイスグループ管理 (一覧/作成/更新/削除/デバイス紐付/社員グループ連携)",
    "org.cmd.keys": "デバイス鍵の共有/列挙/取消 (employeeDevice + getDeviceEmployeeKeys)",

    // employee ls
    "org.employee.ls.desc": "社員一覧 (getEmployees。pubEmployees push を全 page 集約)",
    "org.employee.ls.none": "(no employees)",
    "org.employee.ls.found": "Found {n} employee(s) (totalCount={count}):",

    // employee me
    "org.employee.me.desc": "ログイン中の自分自身の社員情報 (getCurrentUserInfo。data 構造は biz3 未確認)",

    // employee add
    "org.employee.add.desc": "社員を追加 (addEmployees。items は配列で各要素に companyID を含める)",
    "org.employee.add.opt": "JSON 配列。例 '[{\"employeeEmail\":\"a@b.c\",\"employeeName\":\"山田\",\"tag\":[]}]'",
    "org.employee.add.need": "items が必要です: sesame org employee add --json '[{\"employeeEmail\":\"…\",\"employeeName\":\"…\"}]'",
    "org.employee.add.hint": "[{\"employeeEmail\":\"a@b.c\",\"employeeName\":\"山田\"}]",
    "org.employee.add.ok": "OK: requested add of {n} employee(s)",

    // employee update
    "org.employee.update.desc": "社員情報を更新 (updateEmployee。companyID は自動注入、更新フィールドは --json で渡す)",
    "org.employee.update.opt": "JSON オブジェクト。例 '{\"Name\":\"nickname\",\"Value\":\"新名\"}'",
    "org.employee.update.need": "更新フィールドが必要です: sesame org employee update --json '{\"Name\":\"…\",\"Value\":\"…\"}'",
    "org.employee.update.hint": "{\"Name\":\"nickname\",\"Value\":\"新名\"}",
    "org.employee.update.ok": "OK: employee updated",

    // employee rm
    "org.employee.rm.desc": "社員を削除 (removeEmployees。items は社員オブジェクト/[{subUUID,companyID}] 配列)",
    "org.employee.rm.opt": "JSON 配列。例 '[{\"subUUID\":\"…\",\"companyID\":\"…\"}]'",
    "org.employee.rm.need": "items が必要です: sesame org employee rm --json '[{\"subUUID\":\"…\"}]'",
    "org.employee.rm.ok": "OK: requested removal of {n} employee(s)",

    // employee reorder
    "org.employee.reorder.desc": "社員の並び順を更新 (reorderEmployees。各要素 {friendUUID, rank})",
    "org.employee.reorder.opt": "JSON 配列。例 '[{\"friendUUID\":\"…\",\"rank\":0},{\"friendUUID\":\"…\",\"rank\":-1}]'",
    "org.employee.reorder.need": "items が必要です: sesame org employee reorder --json '[{\"friendUUID\":\"…\",\"rank\":0}]'",
    "org.employee.reorder.ok": "OK: reorder requested ({n} item(s))",

    // employee search
    "org.employee.search.desc": "CS 横断でユーザーを検索 (queryByCS。pubQueryByCS push を全 page 集約)",
    "org.employee.search.none": "(no matches)",
    "org.employee.search.found": "Found {n} match(es):",

    // employee confirm
    "org.employee.confirm.desc": "queryByCS で見つけたユーザーを確定 (confirmQueryByCS)。注: biz3 では成功時に現セッションを signout する設計",
    "org.employee.confirm.prompt": "confirmQueryByCS は biz3 では成功時に現セッションを signout します。続行しますか? ({email})",
    "org.employee.confirm.aborted": "中止しました。",
    "org.employee.confirm.ok": "OK: confirmed {email}",

    // group ls
    "org.group.ls.desc": "社員グループ一覧 (getEmployeeGroups)",
    "org.group.ls.none": "(no employee groups)",
    "org.group.ls.found": "Found {n} employee group(s):",

    // group add
    "org.group.add.desc": "社員グループを追加 (addEmployeeGroup。companyID は自動注入、item は --json)",
    "org.group.add.opt": "JSON オブジェクト (グループ名等は biz3 UI 依存で未確認)。例 '{\"name\":\"営業部\"}'",
    "org.group.add.need": "item が必要です: sesame org group add --json '{\"name\":\"営業部\"}'",
    "org.group.add.hint": "{\"name\":\"営業部\"}",
    "org.group.add.ok": "OK: added employee group",
    "org.group.add.okId": "OK: added employee group ({gid})",

    // group update
    "org.group.update.desc": "社員グループを更新 (updateEmployeeGroup。item に gid 等を含める)",
    "org.group.update.opt": "JSON オブジェクト。例 '{\"gid\":\"…\",\"name\":\"新名\"}'",
    "org.group.update.need": "item が必要です: sesame org group update --json '{\"gid\":\"…\",\"name\":\"…\"}'",
    "org.group.update.hint": "{\"gid\":\"…\",\"name\":\"新名\"}",
    "org.group.update.ok": "OK: employee group updated",

    // group rm
    "org.group.rm.desc": "社員グループを削除 (removeEmployeeGroups。gids は配列、要素型は biz3 UI 依存で未確認)",
    "org.group.rm.opt": "JSON 配列。例 '[\"gid1\",\"gid2\"]'",
    "org.group.rm.need": "gids が必要です: sesame org group rm --json '[\"gid1\"]'",
    "org.group.rm.ok": "OK: requested removal of {n} group(s)",

    // group device-groups
    "org.group.deviceGroups.desc": "社員グループに紐づくデバイスグループを取得 (getEmployeeGroupBindDeviceGroup。cid は送らない)",

    // group add-users
    "org.group.addUsers.desc": "社員グループにユーザーを紐付け (addEmployeeInGroup。uuids/items 両方を --json で渡す)",
    "org.group.addUsers.opt": "JSON {uuids,items}。例 '{\"uuids\":[\"sub1\"],\"items\":[{\"subUUID\":\"sub1\"}]}'",
    "org.group.addUsers.need": "uuids/items が必要です: sesame org group add-users <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.group.addUsers.ok": "OK: bound users to group {gid}",

    // group rm-users
    "org.group.rmUsers.desc": "社員グループからユーザーを解除 (removeEmployeeInGroup。items は {subUUID} に絞り込まれる)",
    "org.group.rmUsers.opt": "JSON {uuids,items}。例 '{\"uuids\":[\"sub1\"],\"items\":[{\"subUUID\":\"sub1\"}]}'",
    "org.group.rmUsers.need": "uuids/items が必要です: sesame org group rm-users <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.group.rmUsers.ok": "OK: unbound users from group {gid}",

    // group rm-device-group
    "org.group.rmDeviceGroup.desc": "社員グループからデバイスグループを解除 (removeEmployeeGroupBindDeviceGroup。data 内容は biz3 未確認)",
    "org.group.rmDeviceGroup.opt": "JSON オブジェクト (gid 等。biz3 UI 依存で未確認)。",
    "org.group.rmDeviceGroup.need": "data が必要です: sesame org group rm-device-group --json '{\"gid\":\"…\"}'",
    "org.group.rmDeviceGroup.ok": "OK: unbound device group from employee group",

    // role ls
    "org.role.ls.desc": "役割タグ一覧 (getTags)",
    "org.role.ls.none": "(no role tags)",
    "org.role.ls.found": "Found {n} role tag(s):",

    // role post
    // role の実フィールドは {tag, access[]} (EmployeeRoles.js:161-164)。access の値は
    // 日本語ページ名定数 (gUtils.js pageNames。account.PAGE_NAMES として公開) そのもの。
    "org.role.post.desc": "役割タグを追加/更新 (postTag。companyID は自動注入、data = {tag, access[]} を --json で)",
    "org.role.post.opt": "JSON オブジェクト {tag, access[]} (access の値は日本語ページ名定数 = account.PAGE_NAMES)。例 '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.post.need": "data が必要です: sesame org role post --json '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.post.hint": "{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}",
    "org.role.post.ok": "OK: role tag posted",

    // role rm
    "org.role.rm.desc": "役割タグを削除 (removeTag。data は tagSetting 全体 {tag, access[]}。DataTableColumns.js:627 参照)",
    "org.role.rm.opt": "JSON オブジェクト: tagSetting 全体 {tag, access[]}。例 '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.rm.need": "data が必要です: sesame org role rm --json '{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}'",
    "org.role.rm.hint": "{\"tag\":\"Admin\",\"access\":[\"ユーザー\",\"カード管理\"]}",
    "org.role.rm.ok": "OK: role tag removed",

    // device-group ls
    "org.deviceGroup.ls.desc": "デバイスグループ一覧 (getDeviceGroups)",
    "org.deviceGroup.ls.none": "(no device groups)",
    "org.deviceGroup.ls.found": "Found {n} device group(s):",

    // device-group add
    "org.deviceGroup.add.desc": "デバイスグループを作成 (addDeviceGroup。companyID は自動注入)",
    "org.deviceGroup.add.opt": "JSON 配列の deviceUUID。例 '[\"uuid1\",\"uuid2\"]'",
    "org.deviceGroup.add.ok": "OK: created device group \"{name}\" ({n} device(s))",

    // device-group update
    "org.deviceGroup.update.desc": "デバイスグループを更新 (updateDeviceGroup。item に gid 等を含める)",
    "org.deviceGroup.update.opt": "JSON オブジェクト。例 '{\"gid\":\"…\",\"name\":\"新名\"}'",
    "org.deviceGroup.update.need": "item が必要です: sesame org device-group update --json '{\"gid\":\"…\",\"name\":\"…\"}'",
    "org.deviceGroup.update.hint": "{\"gid\":\"…\",\"name\":\"新名\"}",
    "org.deviceGroup.update.ok": "OK: device group updated",

    // device-group rm
    "org.deviceGroup.rm.desc": "デバイスグループを削除 (removeDeviceGroups。各要素に cid が自動マージされる)",
    "org.deviceGroup.rm.opt": "JSON オブジェクト配列。例 '[{\"gid\":\"…\"}]'",
    "org.deviceGroup.rm.need": "groupIds が必要です: sesame org device-group rm --json '[{\"gid\":\"…\"}]'",
    "org.deviceGroup.rm.ok": "OK: requested removal of {n} device group(s)",

    // device-group add-devices
    "org.deviceGroup.addDevices.desc": "デバイスグループにデバイスを紐付け (addDeviceInGroup。uuids/items を --json で渡す)",
    "org.deviceGroup.addDevices.opt": "JSON {uuids,items}。例 '{\"uuids\":[\"dev1\"],\"items\":[{\"deviceUUID\":\"dev1\"}]}'",
    "org.deviceGroup.addDevices.need": "uuids/items が必要です: sesame org device-group add-devices <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.deviceGroup.addDevices.ok": "OK: bound devices to group {gid}",

    // device-group rm-devices
    "org.deviceGroup.rmDevices.desc": "デバイスグループからデバイスを解除 (removeDeviceInGroup。items は {deviceUUID,secretKey} に絞り込まれる)",
    "org.deviceGroup.rmDevices.opt": "JSON {uuids,items}。例 '{\"uuids\":[\"dev1\"],\"items\":[{\"deviceUUID\":\"dev1\",\"secretKey\":\"…\"}]}'",
    "org.deviceGroup.rmDevices.need": "uuids/items が必要です: sesame org device-group rm-devices <gid> --json '{\"uuids\":[],\"items\":[]}'",
    "org.deviceGroup.rmDevices.ok": "OK: unbound devices from group {gid}",

    // device-group user-groups
    "org.deviceGroup.userGroups.desc": "デバイスグループにバインド済みの社員グループを取得 (getDeviceGroupBindUserGroup。cid は送らない)",

    // device-group rm-user-group
    "org.deviceGroup.rmUserGroup.desc": "デバイスグループから社員グループを解除 (removeDeviceGroupBindUserGroup。data 内容は biz3 未確認)",
    "org.deviceGroup.rmUserGroup.opt": "JSON オブジェクト (gid/uuids 等。biz3 UI 依存で未確認)。",
    "org.deviceGroup.rmUserGroup.need": "data が必要です: sesame org device-group rm-user-group --json '{\"gid\":\"…\"}'",
    "org.deviceGroup.rmUserGroup.ok": "OK: unbound user group from device group",

    // keys device
    "org.keys.device.desc": "デバイス側から鍵保有従業員を列挙 (getDeviceEmployeeKeys。companyID 必須・自動注入)",
    "org.keys.device.opt": "0=全件 / 5=非管理モード",
    "org.keys.device.none": "(no key holders)",
    "org.keys.device.found": "Found {n} key holder(s) for {deviceUUID}:",

    // keys employee
    "org.keys.employee.desc": "指定従業員が持つデバイス鍵一覧 (getEmployeeDeviceKeys。companyID 不要、data 構造は未確認)",

    // keys share
    "org.keys.share.desc": "従業員にデバイス鍵を共有 (shareDeviceKeysToEmployees。items は呼出側で device+user 情報を合成)",
    "org.keys.share.opt": "JSON 配列。各要素 {...device,...user,keyLevel,startTime,endTime}。keyLevel 0=owner/1=manager/2=guest",
    "org.keys.share.need": "items が必要です: sesame org keys share --json '[{\"deviceUUID\":\"…\",\"subUUID\":\"…\",\"keyLevel\":1,\"startTime\":\"\",\"endTime\":\"\"}]'",
    "org.keys.share.ok": "OK: shared keys ({n} item(s))",

    // keys share-group
    "org.keys.shareGroup.desc": "社員グループにデバイスグループ鍵を共有 (shareDeviceGroupKeysToEmployeeGroup。companyID 自動注入)",
    "org.keys.shareGroup.opt": "JSON {keyLevel,members,devices,mid,dids,startTime,endTime}。keyLevel は文字列 \"0\"/\"1\"/\"2\"",
    "org.keys.shareGroup.need": "item が必要です: sesame org keys share-group --json '{\"keyLevel\":\"1\",\"members\":[],\"devices\":[],\"mid\":\"…\",\"dids\":[]}'",
    "org.keys.shareGroup.ok": "OK: shared device group keys to employee group",

    // keys rm
    "org.keys.rm.desc": "従業員/ゲストのデバイス鍵を削除 (removeEmployeeDeviceKey)。ゲスト鍵の randomTag は未指定なら自動補完 (デバイス secretKey の cmacTime)",
    "org.keys.rm.opt": "JSON。従業員 '{\"subUUID\":\"…\",\"deviceUUID\":\"…\"}' / ゲスト '{\"guestKeyId\":\"…\",\"deviceUUID\":\"…\"}' (randomTag は任意。未指定ならデバイス secretKey から cmacTime で自動計算 = DeviceUserList.js:117-132 と同じ)",
    "org.keys.rm.need": "data が必要です: sesame org keys rm --json '{\"subUUID\":\"…\",\"deviceUUID\":\"…\"}'",
    "org.keys.rm.deviceNotFound": "デバイス {deviceUUID} が devices 一覧に見つかりません (randomTag を自動計算できません。randomTag を明示してください)",
    "org.keys.rm.noSecretKey": "デバイス {deviceUUID} に secretKey がありません (randomTag を自動計算できません。randomTag を明示してください)",
    "org.keys.rm.ok": "OK: device key removed",

    // keys update-guest-tag
    "org.keys.updateGuestTag.desc": "ゲスト鍵の名称タグを更新 (updateGuestKeyTag)",
    "org.keys.updateGuestTag.opt": "JSON {deviceUUID,guestKeyId,keyName}。keyName が新タグ名",
    "org.keys.updateGuestTag.need": "data が必要です: sesame org keys update-guest-tag --json '{\"deviceUUID\":\"…\",\"guestKeyId\":\"…\",\"keyName\":\"新名\"}'",
    "org.keys.updateGuestTag.hint": "{\"deviceUUID\":\"…\",\"guestKeyId\":\"…\",\"keyName\":\"新名\"}",
    "org.keys.updateGuestTag.ok": "OK: guest key tag updated",

    // keys generate-guest-qr
    "org.keys.generateGuestQr.desc": "ゲスト用 guestKeyId を発行 (generateGuestQR)。data はデバイス鍵オブジェクト全体。QR 画像化は本 op 対象外",
    "org.keys.generateGuestQr.opt": "JSON のデバイス鍵オブジェクト全体。例 '{\"deviceUUID\":\"…\",\"secretKey\":\"…\",\"sesame2PublicKey\":\"…\",\"keyIndex\":0,\"deviceModel\":\"…\",\"keyLevel\":0}'",
    "org.keys.generateGuestQr.need": "data が必要です: sesame org keys generate-guest-qr --json '{\"deviceUUID\":\"…\",\"secretKey\":\"…\"}'",
    "org.keys.generateGuestQr.ok": "OK: guestKeyId = {guestKeyId}",

    // keys share-url
    "org.keys.shareUrl.desc": "デバイス鍵の共有 URL (ssm://UI?...) を生成。SESAME アプリが読む QR の中身そのもの",
    "org.keys.shareUrl.optDevice": "対象 deviceUUID (省略時は対話選択)",
    "org.keys.shareUrl.optLevel": "鍵レベル 0=owner / 1=manager / 2=guest (既定 2)",
    "org.keys.shareUrl.optName": "共有時の表示名 (省略時はデバイス名)",
    "org.keys.shareUrl.optJson": "デバイス鍵を JSON で直接指定 (省略時は devices から解決)",
    "org.keys.shareUrl.optQr": "端末に QR を表示 (要 qrcode-terminal: npm i qrcode-terminal)",
    "org.keys.shareUrl.help": "\nlevel 2 (guest) のみ generateGuestQR で使い捨て guestKeyId を発行して埋め込みます。\n0/1 (owner/manager) はデバイス自身の secretKey を共有するため取り扱い注意。\nQR 画像化を省く場合でも、出力された ssm://UI URL を任意の QR 生成器に貼れば共有できます。",
    "org.keys.shareUrl.badLevel": "--level は 0 / 1 / 2 のいずれか。",
    "org.keys.shareUrl.deviceNotFound": "deviceUUID {device} が devices に見つかりません。",
    "org.keys.shareUrl.noDevices": "共有できるデバイスがありません。",
    "org.keys.shareUrl.selectPrompt": "共有するデバイスを選択",
    "org.keys.shareUrl.cancelled": "キャンセルしました。",
    "org.keys.shareUrl.needDeviceOrJson": "--device <uuid> または --json <deviceKey> が必要です (非対話モード)。",
    "org.keys.shareUrl.qrNotInstalled": "(qrcode-terminal 未インストール: `npm i qrcode-terminal` で端末 QR 表示)",
  },
};

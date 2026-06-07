export default {
  en: {
    // src/cli/company.js — commander descriptions
    "company.cmd.desc": "Company management (biz3ManageCompany: list / rename / add / payment config)",
    "company.ls.desc": "List companies linked to the logged-in user (getCompanies)",
    "company.rename.desc": "Rename the priority company (updateCompanyName; companyID is auto-injected)",
    "company.add.desc": "Register a new company (addCompany; employeeEmail/subUUID come from the logged-in user's customerInfo)",
    "company.payment.desc": "Get the priority company's payment level config (getPaymentConfig; response data structure unconfirmed)",
    // src/cli/company.js — output
    "company.ls.none": "(no companies)",
    "company.ls.found.one": "Found {count} company:",
    "company.ls.found.many": "Found {count} companies:",
    "company.ls.ownerTag": " [owner]",
    "company.rename.ok": 'OK: renamed company {companyID} → "{name}"',
    "company.add.missingCustomerInfo": "The logged-in user's customerInfo has no employeeEmail/subUUID (you may need to log in again).",
    "company.add.ok": 'OK: added company "{name}"{idSuffix}',
    "company.payment.none": "(no payment config / no response data)",
    // src/company.js — validation errors
    "company.err.companyIDRequired": "companyID required",
    "company.err.nameRequired": "name required",
    "company.err.employeeEmailRequired": "employeeEmail required (from the login user's customerInfo)",
    "company.err.subUUIDRequired": "subUUID required (from the login user's customerInfo)",
  },
  ja: {
    // src/cli/company.js — commander descriptions
    "company.cmd.desc": "会社管理 (biz3ManageCompany: 一覧 / 改名 / 追加 / 課金設定)",
    "company.ls.desc": "ログインユーザに紐づく会社一覧 (getCompanies)",
    "company.rename.desc": "優先会社の会社名を変更 (updateCompanyName。companyID は自動注入)",
    "company.add.desc": "会社を新規登録 (addCompany。employeeEmail/subUUID はログインユーザの customerInfo 由来)",
    "company.payment.desc": "優先会社の課金レベル設定を取得 (getPaymentConfig。応答 data の構造は未確認)",
    // src/cli/company.js — output
    "company.ls.none": "(no companies)",
    "company.ls.found.one": "Found {count} company:",
    "company.ls.found.many": "Found {count} companies:",
    "company.ls.ownerTag": " [オーナー]",
    "company.rename.ok": 'OK: renamed company {companyID} → "{name}"',
    "company.add.missingCustomerInfo": "ログインユーザの customerInfo に employeeEmail/subUUID がありません (再 login が必要かもしれません)。",
    "company.add.ok": 'OK: added company "{name}"{idSuffix}',
    "company.payment.none": "(no payment config / 応答 data 無し)",
    // src/company.js — validation errors
    "company.err.companyIDRequired": "companyID required",
    "company.err.nameRequired": "name required",
    "company.err.employeeEmailRequired": "employeeEmail required (login ユーザの customerInfo 由来)",
    "company.err.subUUIDRequired": "subUUID required (login ユーザの customerInfo 由来)",
  },
};

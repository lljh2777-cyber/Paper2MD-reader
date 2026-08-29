import { installPrecisionPermissionLeaseCleanup } from "./precision-permissions";

installPrecisionPermissionLeaseCleanup();

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("precision.html") });
});

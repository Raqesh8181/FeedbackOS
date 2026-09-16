const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function run(workspaceId, fn) {
  return storage.run({ workspaceId: Number(workspaceId) || null }, fn);
}
function getWorkspaceId() {
  return storage.getStore()?.workspaceId || null;
}

module.exports = { run, getWorkspaceId };

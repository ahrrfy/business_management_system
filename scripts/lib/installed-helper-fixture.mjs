import fs from "node:fs";

// Test-only ownership metadata for one temporary installed helper. All bytes,
// mode bits, file kinds, symlinks and other paths still use the real filesystem.
export function mockInstalledHelperOwner(helper) {
  const original = fs.lstatSync;
  let owner = 0;
  fs.lstatSync = function (file, ...args) {
    const stat = original.call(this, file, ...args);
    if (file === helper) Object.defineProperty(stat, "uid", { value: owner });
    return stat;
  };
  return {
    setOwner(uid) {
      owner = uid;
    },
    restore() {
      fs.lstatSync = original;
    },
  };
}

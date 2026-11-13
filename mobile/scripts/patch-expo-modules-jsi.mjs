// Re-applies a one-line compile fix to expo-modules-jsi after every `npm install`.
//
// Xcode 26.1's Swift 6.2 compiler rejects expo-modules-jsi 58.0.x with "sending 'slot' risks causing
// data races": a raw pointer is sent into an isolated closure. The fix passes the pointer's address
// (a Sendable integer) and rebuilds the pointer inside — same pointer, same thread, same behaviour.
// Without it the iOS app does not build, and a fresh install (CI, another developer, a clean clone)
// wipes a hand edit in node_modules, so the edit lives here instead.
//
// Safe to run any number of times: an already-patched file is left alone, and if a newer
// expo-modules-jsi changes this code the script only warns (the upstream fix may have landed).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'node_modules/expo-modules-jsi/apple/Sources/ExpoModulesJSI/Runtime/Values/JavaScriptObject.swift');
const tag = '[patch-expo-modules-jsi]';

if (!existsSync(file)) { console.log(`${tag} expo-modules-jsi not installed, nothing to do`); process.exit(0); }
const src = readFileSync(file, 'utf8');
if (src.includes('UInt(bitPattern: slot)')) { console.log(`${tag} already patched`); process.exit(0); }

const before = `    try runtime._withUnsafeGuaranteedRef { runtime in
      try JavaScriptActor.assumeIsolated {
        try encode(JavaScriptValue.Slot(slot), runtime)`;
const after = `    // Patched for Xcode 26.1's Swift 6.2 compiler, which rejects sending the pointer into the
    // isolated closure ("sending 'slot' risks causing data races"): pass its address (Sendable)
    // and rebuild the pointer inside. Same pointer, same thread; behaviour is unchanged.
    let address = UInt(bitPattern: slot)
    try runtime._withUnsafeGuaranteedRef { runtime in
      try JavaScriptActor.assumeIsolated {
        let slot = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: address)!
        try encode(JavaScriptValue.Slot(slot), runtime)`;

const at = src.indexOf(before);
if (at < 0 || src.indexOf(before, at + 1) >= 0) {
  console.warn(`${tag} WARNING: the code to patch was not found exactly once; expo-modules-jsi may have changed. If the iOS build fails with "sending 'slot' risks causing data races", update this script.`);
  process.exit(0);
}
writeFileSync(file, src.slice(0, at) + after + src.slice(at + before.length));
console.log(`${tag} applied the Xcode 26 compile fix`);

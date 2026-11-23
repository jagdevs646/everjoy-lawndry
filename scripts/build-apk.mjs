#!/usr/bin/env node
/**
 * Build the Everjoy Lawndry Android APK without Android Studio.
 *
 *   npm run app:apk            → debug APK (install on any phone for testing)
 *   npm run app:apk:release    → signed release APK (needs a keystore, see README "Android app")
 *   npm run app:aab            → signed release bundle (.aab) for the Google Play Store
 *
 * It finds Java 21 and the Android SDK, keeps Gradle's large cache off the C: drive when D: exists,
 * rebuilds the app screens (vite --mode app + cap sync) and copies the APK to ./release/.
 * Nothing is installed system-wide and no Windows settings are changed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bundle = process.argv.includes('--bundle');   // Play Store upload format; always a signed release
const release = bundle || process.argv.includes('--release');
const skipWeb = process.argv.includes('--skip-web');
const root = path.resolve(import.meta.dirname, '..');
const isWin = process.platform === 'win32';

function fail(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }
function firstDir(dir) { try { return fs.readdirSync(dir).map(d => path.join(dir, d)).find(d => fs.statSync(d).isDirectory()); } catch { return undefined; } }
function exists(p) { return !!p && fs.existsSync(p); }

// Java 21: JAVA_HOME, else the portable JDK unpacked under D:/dev-tools/jdk21-extract.
const javaHome = [process.env.EJ_JAVA_HOME, process.env.JAVA_HOME, firstDir('D:/dev-tools/jdk21-extract')]
  .find(p => exists(p) && exists(path.join(p, 'bin', isWin ? 'java.exe' : 'java')));
if (!javaHome) fail('Java 21 not found. Set JAVA_HOME (or EJ_JAVA_HOME) to a JDK 21 folder. See README → Android app.');

// Android SDK.
const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'), path.join(os.homedir(), 'Library', 'Android', 'sdk'), path.join(os.homedir(), 'Android', 'Sdk')]
  .find(p => exists(p) && exists(path.join(p, 'platform-tools')));
if (!sdk) fail('Android SDK not found. Set ANDROID_HOME. See README → Android app.');

// Gradle cache: hundreds of MB, so prefer D: when it exists.
const gradleHome = process.env.GRADLE_USER_HOME || (isWin && fs.existsSync('D:/') ? 'D:/dev-tools/gradle-home' : undefined);

// A release build must talk to the real server over HTTPS. Read the address the way Vite will
// (environment first, then .env.app), and never reuse old screens with --skip-web.
if (release) {
  if (skipWeb) fail('Release builds always rebuild the app screens; remove --skip-web.');
  const envFile = path.join(root, '.env.app');
  const fromFile = exists(envFile) ? /^\s*VITE_API_BASE\s*=\s*(.*)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1]?.trim() : undefined;
  const base = process.env.VITE_API_BASE ?? fromFile ?? '';
  if (!base.startsWith('https://')) fail(`Release builds need an https:// server address in .env.app (VITE_API_BASE). It is "${base || 'empty'}".`);
}
if (release && !process.env.EJ_KEYSTORE) fail('Release builds need EJ_KEYSTORE and EJ_KEYSTORE_PASSWORD (and optionally EJ_KEY_ALIAS, EJ_KEY_PASSWORD). See README → Android app.');
if (release && !exists(process.env.EJ_KEYSTORE)) fail(`Keystore not found: ${process.env.EJ_KEYSTORE}`);

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ...(gradleHome ? { GRADLE_USER_HOME: gradleHome } : {}) };
env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH}`;

console.log(`Java:   ${javaHome}\nSDK:    ${sdk}\nGradle: ${gradleHome ?? '(default ~/.gradle)'}\nBuild:  ${release ? 'release (signed)' : 'debug'}\n`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
}

// 1. Fresh app screens, copied into the Android project.
if (!skipWeb) {
  run('npx', ['vite', 'build', '--mode', 'app'], root);
  run('npx', ['cap', 'sync', 'android'], root);
}

// 2. Tell Gradle where the SDK is.
// Java .properties: forward slashes avoid escaping; a colon must be escaped as "\:".
fs.writeFileSync(path.join(root, 'android', 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/').replace(/:/g, '\\:')}\n`);

// 3. Build.
const task = bundle ? 'bundleRelease' : release ? 'assembleRelease' : 'assembleDebug';
// Full, quoted path: Windows may not search the current folder for commands, and the project path has spaces.
const gradlew = path.join(root, 'android', isWin ? 'gradlew.bat' : 'gradlew');
run(isWin ? `"${gradlew}"` : gradlew, [task, '--console=plain'], path.join(root, 'android'));

// 4. Copy the APK / bundle somewhere easy to find.
const variant = release ? 'release' : 'debug';
const ext = bundle ? 'aab' : 'apk';
const built = bundle
  ? path.join(root, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')
  : path.join(root, 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
if (!exists(built)) fail(`Gradle finished but ${built} is missing.`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `everjoy-lawndry-${pkg.version}-${variant}.${ext}`);
fs.copyFileSync(built, out);
console.log(`\n✔ ${ext.toUpperCase()} ready: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)\n`);

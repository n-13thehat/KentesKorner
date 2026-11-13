import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archArg = process.argv[2];
const arch = archArg === 'arm64' ? 'arm64' : archArg === 'x64' ? 'x86_64' : null;
if (!arch) throw new Error('Usage: node scripts/verify-mac-native-package.mjs <arm64|x64>');
// electron-builder uses its default x64 architecture without a suffix.
const output = path.join(root, 'dist', archArg === 'x64' ? 'mac' : `mac-${archArg}`);

async function findApp(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) return full;
  }
  return null;
}

const app = await findApp(output);
if (!app) throw new Error(`Packaged Mac app was not found in ${output}`);
const resources = path.join(app, 'Contents', 'Resources');
const unpacked = path.join(resources, 'app.asar.unpacked', 'electron', 'native');
const appRuntimeFiles = [
  path.join(resources, 'kente-server'),
  path.join(resources, 'web', 'index.html'),
  path.join(resources, 'web', 'js', 'config.js'),
  path.join(resources, 'web', 'js', 'flash.js'),
  path.join(resources, 'web', 'js', 'gamepad.js'),
  path.join(resources, 'web', 'js', 'native_player.js'),
  path.join(resources, 'web', 'js', 'panels.js'),
  path.join(resources, 'web', 'js', 'rom_tools.js'),
];
for (const file of appRuntimeFiles) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size < 100)
    throw new Error(`Mac player runtime component missing: ${file}`);
}
if (((await stat(appRuntimeFiles[0])).mode & 0o111) === 0)
  throw new Error('The bundled Mac Kente server is not executable.');
const asarPath = path.join(resources, 'app.asar');
const asar = createRequire(import.meta.url)('@electron/asar');
function readPackagedFile(file) {
  try { return asar.extractFile(asarPath, file).toString('utf8'); }
  catch (error) { throw new Error(`Packaged Electron file is missing or unreadable: ${file}: ${error.message}`); }
}
const mainSource = readPackagedFile('electron/main.js');
const preloadSource = readPackagedFile('electron/preload.js');
const nativeHostSource = readPackagedFile('electron/native/macos/libretro_host.mm');
const htmlSource = await readFile(appRuntimeFiles[1], 'utf8');
const playerSource = await readFile(appRuntimeFiles[5], 'utf8');
const gamepadSource = await readFile(appRuntimeFiles[4], 'utf8');
const panelsSource = await readFile(appRuntimeFiles[6], 'utf8');
const romToolsSource = await readFile(appRuntimeFiles[7], 'utf8');
for (const [label, source, required] of [
  ['Electron main', mainSource, ["setWindowOpenHandler", "return { action: 'deny' }", "'will-navigate'", "'will-redirect'", 'if (isMainFrame)', 'macLibretroHost.probeCore', "'kente:mac-player:launch'", "'kente:mac-player:control'", "'kente:mac-player:change-disc'", 'macLibretroHost.changeDisc(direction)', 'stopMacPlayerAndDetach', "macPlayerSurface?.setVisible(action === 'resume')", "macLibretroHost.setPaused(action === 'resume')"]],
  ['Electron preload', preloadSource, ['macNativeCoreAvailable', 'launchMacNativePlayer', 'controlMacNativePlayer', 'changeMacNativePlayerDisc']],
  ['Mac libretro host', nativeHostSource, ['PreferredCoreOption', 'key == "pcsx2_renderer"', 'return "metal"', 'RETRO_ENVIRONMENT_SET_HW_RENDER', 'RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE', 'Napi::Value ChangeDisc', 'get_num_images', 'set_eject_state', "PCEE2's retro_run() blocks until its CPU thread finishes the matching", 'p_run();', 'g_audioCallbackMutex', 'FillAudioQueueBuffer', 'if (!g_audioActive.load(std::memory_order_acquire)) return;', 'AudioQueueStop(g_audio.queue, true)']],
  ['Native player HUD', playerSource, ['launchMacNativePlayer', 'macNativePlayerStatus', "control('stop'", "control('resize'", 'macStandardMap', 'item?.connected', 'async function menu(opened)', 'function updateDiscControls(status)', 'async function changeDisc(direction)', "event.code === 'Escape'", "state.screen === 'paused') await control('pause'", "'PLAYSTATION 2 PAUSED'", 'if (wasPaused && !paused) frameDeadline = Date.now() + 60000', 'if (!paused && Date.now() >= frameDeadline) break', '() => launch(game, options)'] ],
  ['In-game HUD markup', htmlSource, ['id="igm-disc-prev"', 'id="igm-disc-next"']],
  ['Gamepad pause menu', gamepadSource, ['BTN.HOME', 'showIngameMenu()', 'hideIngameMenu()', 'filter(btn => !btn.hidden)']],
  ['Download Center native launch', panelsSource, ['launchNative(game, true, false, false, { filename: item.filename })']],
  ['PS2 BIOS launch continuation', romToolsSource, ['function showBiosPicker(game, romHandle, biosReq, continueLaunch = null)', 'if (continueLaunch) await continueLaunch()']],
]) {
  for (const token of required)
    if (!source.includes(token)) throw new Error(`${label} is missing required Mac player behavior: ${token}`);
}
if (/sleep_until\s*\(/.test(nativeHostSource))
  throw new Error('The Mac PCEE2 host adds a second frame limiter after retro_run().');
if (/shell\.openExternal|action:\s*['"]allow['"]/.test(mainSource))
  throw new Error('The packaged Electron main process contains an external-browser popup route.');
const files = [
  path.join(unpacked, 'mac-player.node'),
  path.join(unpacked, 'mac-libretro.node'),
  path.join(resources, 'emulators', 'pcee2', 'pcee2_libretro.dylib'),
  path.join(resources, 'emulators', 'pcee2', 'COPYING.GPLv3'),
  path.join(resources, 'emulators', 'pcee2', 'pcee2-source.tar.gz'),
  path.join(resources, 'emulators', 'pcee2', 'BUILD-INFO.txt'),
  path.join(resources, 'emulators', 'pcee2', 'DEPENDENCIES.txt'),
  path.join(resources, 'emulators', 'pcee2', 'runtime-resources', 'GameIndex.yaml'),
  path.join(resources, 'emulators', 'pcee2', 'libMoltenVK.dylib'),
];
const moltenVkLicense = path.join(resources, 'emulators', 'pcee2', 'MOLTENVK-LICENSE.txt');
files.push(moltenVkLicense);
for (const file of files) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size < 100) throw new Error(`Mac native package component missing: ${file}`);
}
for (const file of [files[0], files[1], files[2], files[8], appRuntimeFiles[0]])
  execFileSync('lipo', [file, '-verify_arch', arch]);
const license = await readFile(files[3], 'utf8');
if (!license.includes('GNU GENERAL PUBLIC LICENSE') || !license.includes('Version 3'))
  throw new Error('The bundled PCEE2 GPLv3 license is invalid.');
const moltenVkLicenseText = await readFile(moltenVkLicense, 'utf8');
if (!moltenVkLicenseText.includes('Apache License') || !moltenVkLicenseText.includes('Version 2.0'))
  throw new Error('The bundled MoltenVK Apache 2.0 license is missing or invalid.');
execFileSync('tar', ['-tzf', files[4]], { stdio: 'ignore' });
const buildInfo = await readFile(files[5], 'utf8');
for (const required of [`Architecture: ${arch}`, 'Core dylib SHA-256:', 'Source repository revision:',
  'Submodule revisions:', 'MoltenVK version:', 'MoltenVK license: Apache-2.0',
  'MoltenVK dylib SHA-256:', 'Source archive SHA-256:']) {
  if (!buildInfo.includes(required)) throw new Error(`PCEE2 build metadata is missing: ${required}`);
}
const expectedRevision = (await readFile(path.join(root, 'scripts', 'pcee2-mac-revision.txt'), 'utf8')).trim();
const packagedRevision = path.join(resources, 'emulators', 'pcee2', 'PCEE2-REVISION.txt');
if ((await readFile(packagedRevision, 'utf8')).trim() !== expectedRevision)
  throw new Error('The packaged runtime revision does not match the PCEE2 source revision lock.');
if (!buildInfo.includes(`Source repository revision: ${expectedRevision}`))
  throw new Error('The packaged PCEE2 source revision does not match Kente\'s reviewed revision lock.');
async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
for (const [label, file] of [
  ['Core dylib', files[2]], ['MoltenVK dylib', files[8]], ['Source archive', files[4]],
]) {
  const recorded = buildInfo.match(new RegExp(`^${label} SHA-256: ([a-f\\d]{64})$`, 'm'))?.[1];
  if (!recorded || recorded !== await sha256(file))
    throw new Error(`The packaged PCEE2 ${label.toLowerCase()} does not match its recorded checksum.`);
}
const dependencies = await readFile(files[6], 'utf8');
if (!dependencies.includes('pcee2_libretro.dylib') || !dependencies.includes('libMoltenVK.dylib'))
  throw new Error('The PCEE2 dependency report is missing a core or runtime-loaded dependency.');
const core = files[2];
const moltenVk = files[8];
const nativeHost = createRequire(import.meta.url)(files[1]);
if (typeof nativeHost.probeCore !== 'function' || nativeHost.probeCore(core) !== true)
  throw new Error('The packaged Mac libretro addon could not load and validate PCEE2.');
const executableDir = path.join(app, 'Contents', 'MacOS');
const executable = (await readdir(executableDir, { withFileTypes: true }))
  .find(entry => entry.isFile());
if (!executable) throw new Error('The packaged Mac app executable is missing.');
const appExecutable = path.join(executableDir, executable.name);
execFileSync('lipo', [appExecutable, '-verify_arch', arch]);
function rpaths(binary) {
  const loadCommands = execFileSync('otool', ['-l', binary], { encoding: 'utf8' });
  return loadCommands.split(/Load command \d+\n/)
    .filter(command => /\bcmd LC_RPATH\b/.test(command))
    .map(command => command.match(/^\s*path (.+?) \(offset \d+\)/m)?.[1])
    .filter(Boolean);
}
for (const binary of [files[0], files[1], core, moltenVk]) {
  const runPaths = [...rpaths(binary), ...rpaths(appExecutable)];
  const loadList = execFileSync('otool', ['-L', binary], { encoding: 'utf8' }).split(/\r?\n/).slice(1);
  for (const line of loadList) {
    const dependency = line.trim().match(/^(.+?)\s+\(compatibility version/);
    if (!dependency) continue;
    const name = dependency[1];
    // `otool -L` lists a dylib's LC_ID_DYLIB as its first entry. That is the
    // binary's install name, not a dependency that the loader must resolve.
    if (name === `@rpath/${path.basename(binary)}`) continue;
    if (name.startsWith('/System/Library/') || name.startsWith('/usr/lib/')) continue;
    let resolved = null;
    if (name.startsWith('@loader_path/'))
      resolved = path.resolve(path.dirname(binary), name.slice('@loader_path/'.length));
    else if (name.startsWith('@executable_path/'))
      resolved = path.resolve(executableDir, name.slice('@executable_path/'.length));
    else if (name.startsWith('@rpath/')) {
      const suffix = name.slice('@rpath/'.length);
      for (const runPath of runPaths) {
        let base;
        if (runPath.startsWith('@loader_path/'))
          base = path.resolve(path.dirname(binary), runPath.slice('@loader_path/'.length));
        else if (runPath.startsWith('@executable_path/'))
          base = path.resolve(executableDir, runPath.slice('@executable_path/'.length));
        else if (path.isAbsolute(runPath)) base = runPath;
        if (!base) continue;
        const candidate = path.resolve(base, suffix);
        if ((await stat(candidate).catch(() => null))?.isFile()) { resolved = candidate; break; }
      }
    } else if (path.isAbsolute(name)) resolved = name;
    if (!resolved || !(await stat(resolved).catch(() => null))?.isFile())
      throw new Error(`A packaged native player binary has an unresolved dependency: ${name}`);
    const insideBundle = path.relative(path.join(app, 'Contents'), resolved);
    if (insideBundle.startsWith(`..${path.sep}`) || path.isAbsolute(insideBundle))
      throw new Error(`A packaged native player binary depends on a library outside the app bundle: ${name}`);
    execFileSync('lipo', [resolved, '-verify_arch', arch]);
  }
}
console.log(`Verified packaged Mac native components for ${arch}: ${path.basename(app)}`);

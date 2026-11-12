import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('The PCEE2 Mac runtime must be staged on a macOS build runner.');
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
if (!arch) throw new Error(`Unsupported PCEE2 Mac architecture: ${process.arch}`);

const destination = path.join(root, 'resources', 'emulators', 'pcee2');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kente-pcee2-'));

function run(command, args, cwd = root, env = process.env, capture = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim())
      : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

try {
  // Build the emulator from a reviewed, pinned source revision and ship that
  // same checkout with the binary.
  const expectedRevision = (await readFile(path.join(root, 'scripts', 'pcee2-mac-revision.txt'), 'utf8')).trim();
  if (!/^[a-f\d]{40}$/i.test(expectedRevision))
    throw new Error('scripts/pcee2-mac-revision.txt must contain a full 40-character commit hash.');
  const source = path.join(temporary, 'source');
  await run('git', ['init', source]);
  await run('git', ['-C', source, 'remote', 'add', 'origin',
    'https://github.com/WizzardSK/pcee2-libretro.git']);
  await run('git', ['-C', source, 'fetch', '--depth', '1', 'origin', expectedRevision]);
  await run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
  await run('git', ['-C', source, 'submodule', 'update', '--init', '--recursive', '--depth', '1']);
  const revision = await run('git', ['rev-parse', 'HEAD'], source);
  if (revision.toLowerCase() !== expectedRevision.toLowerCase())
    throw new Error(`PCEE2 checkout mismatch: expected ${expectedRevision}, found ${revision}.`);
  const submoduleRevisions = await run('git', ['submodule', 'status', '--recursive'], source);
  if (!submoduleRevisions.trim() || submoduleRevisions.split(/\r?\n/)
    .some(line => !/^ [a-f\d]{40,64} /i.test(line)))
    throw new Error('The PCEE2 source checkout has missing or mismatched submodules.');
  const dependencyVersions = await readFile(path.join(source, 'pcee2-libretro', 'scripts', 'deps.versions'), 'utf8');
  const moltenVkVersion = dependencyVersions.match(/^MOLTENVK=(v[\w.-]+)$/m)?.[1];
  if (!moltenVkVersion) throw new Error('The checked-out PCEE2 source does not pin its MoltenVK release.');
  const moltenVkLicenseUrl = `https://raw.githubusercontent.com/KhronosGroup/MoltenVK/${moltenVkVersion}/LICENSE`;
  const moltenVkLicensePath = path.join(temporary, 'MOLTENVK-LICENSE.txt');
  await run('curl', ['-fL', '--retry', '3', '--retry-delay', '2', moltenVkLicenseUrl,
    '-o', moltenVkLicensePath]);
  const moltenVkLicense = await readFile(moltenVkLicensePath, 'utf8');
  if (!moltenVkLicense.includes('Apache License') || !moltenVkLicense.includes('Version 2.0'))
    throw new Error('The pinned MoltenVK release did not provide its Apache 2.0 license.');
  const deps = path.resolve(process.env.KENTE_PCEE2_DEPS_DIR || path.join(temporary, 'deps'));
  const depsWorkspace = path.resolve(process.env.KENTE_PCEE2_DEPS_WORKDIR || path.join(temporary, 'deps-work'));
  await mkdir(depsWorkspace, { recursive: true });
  const depsEnv = { ...process.env, OSX_ARCH: arch };
  await run('bash', [path.join(source, 'pcee2-libretro', 'scripts', 'build-deps-macos.sh'), deps],
    depsWorkspace, depsEnv, false);
  const build = path.join(temporary, 'build');
  const cmakeArgs = [
    '-B', build, '-G', 'Ninja',
    `-DCMAKE_PREFIX_PATH=${deps}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_OSX_ARCHITECTURES=${arch}`,
    '-DDISABLE_ADVANCE_SIMD=ON',
    '-DENABLE_QT_UI=OFF', '-DENABLE_TESTS=OFF', '-DENABLE_LIBRETRO=ON', '-DUSE_VULKAN=ON',
    '-DSHADERC_STATIC=ON', `-DSHADERC_LIBRARY=${path.join(deps, 'lib', 'libshaderc_combined.a')}`,
  ];
  if (arch === 'arm64') cmakeArgs.push('-DLTO_PCSX2_CORE=ON');
  await run('cmake', cmakeArgs, source, process.env, false);
  await run('cmake', ['--build', build, '--target', 'pcee2_libretro', '--parallel'], source, process.env, false);
  const core = path.join(build, 'bin', 'pcee2_libretro.dylib');
  const moltenVkBinary = path.join(deps, 'lib', 'libMoltenVK.dylib');
  if (!(await stat(core).catch(() => null))?.isFile())
    throw new Error('The source build did not produce pcee2_libretro.dylib.');
  if (!(await stat(moltenVkBinary).catch(() => null))?.isFile())
    throw new Error('The source dependency build did not produce libMoltenVK.dylib.');
  await run('lipo', ['-verify_arch', arch, core]);
  const coreSha256 = createHash('sha256').update(await readFile(core)).digest('hex');
  const coreDependencies = await run('otool', ['-L', core]);

  const runtimeResources = path.join(source, 'bin', 'resources');
  if (!(await stat(runtimeResources).catch(() => null))?.isDirectory())
    throw new Error('The PCEE2 source checkout is missing its runtime resources.');
  const sourceArchive = path.join(temporary, 'pcee2-source.tar.gz');
  await run('tar', ['-czf', sourceArchive, '--exclude=.git', '-C', source, '.']);
  const license = await readFile(path.join(source, 'COPYING.GPLv3'));
  const sourceSha256 = createHash('sha256').update(await readFile(sourceArchive)).digest('hex');
  const moltenVkUrl = `https://github.com/KhronosGroup/MoltenVK/releases/download/${moltenVkVersion}/MoltenVK-macos.tar`;
  await run('lipo', ['-verify_arch', arch, moltenVkBinary]);
  const moltenVkSha256 = createHash('sha256').update(await readFile(moltenVkBinary)).digest('hex');
  const moltenVkDependencies = await run('otool', ['-L', moltenVkBinary]);

  await mkdir(destination, { recursive: true });
  await cp(runtimeResources, path.join(destination, 'runtime-resources'), { recursive: true, force: true });
  const coreTarget = path.join(destination, 'pcee2_libretro.dylib');
  const moltenVkTarget = path.join(destination, 'libMoltenVK.dylib');
  await writeFile(coreTarget, await readFile(core));
  await writeFile(moltenVkTarget, await readFile(moltenVkBinary));
  await writeFile(path.join(destination, 'PCEE2-REVISION.txt'), `${revision}\n`);
  await writeFile(path.join(destination, 'COPYING.GPLv3'), license);
  await writeFile(path.join(destination, 'MOLTENVK-LICENSE.txt'), moltenVkLicense);
  await writeFile(path.join(destination, 'pcee2-source.tar.gz'), await readFile(sourceArchive));
  await writeFile(path.join(destination, 'DEPENDENCIES.txt'), [
    'Direct core dependencies:', coreDependencies,
    'Runtime-loaded MoltenVK dependencies:', moltenVkDependencies, '',
  ].join('\n'));
  await writeFile(path.join(destination, 'BUILD-INFO.txt'), [
    'Core: PCEE2 libretro PlayStation 2 emulator',
    `Architecture: ${arch}`,
    'Binary source: built from the bundled source revision on the native Mac architecture.',
    `Core dylib SHA-256: ${coreSha256}`,
    `MoltenVK version: ${moltenVkVersion}`,
    `MoltenVK source: ${moltenVkUrl}`,
    `MoltenVK license: Apache-2.0 (${moltenVkLicenseUrl})`,
    `MoltenVK dylib SHA-256: ${moltenVkSha256}`,
    `Source repository revision: ${revision}`,
    `Submodule revisions: ${submoduleRevisions.replace(/\r?\n/g, '; ')}`,
    'Runtime resources: included from bin/resources at the recorded source revision.',
    `Source archive SHA-256: ${sourceSha256}`,
    'License: GPL-3.0-only; full source archive and license are included.',
    'The binary was compiled from the bundled source revision; source and binary are an exact build pair.',
    '',
  ].join('\n'));
  const size = (await stat(coreTarget)).size;
  if (size < 1024 * 1024) throw new Error('The staged PCEE2 dylib is unexpectedly small.');
  console.log(`Staged PCEE2 ${arch} core (${size} bytes) and GPL source at ${path.relative(root, destination)}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

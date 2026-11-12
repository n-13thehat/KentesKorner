import { copyFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'electron/native/macos/build/Release/kente_mac_player.node');
const staged = path.join(root, 'electron/native/mac-player.node');
const products = [
  [built, staged],
  [path.join(root, 'electron/native/macos/build/Release/kente_mac_libretro.node'),
    path.join(root, 'electron/native/mac-libretro.node')],
];
await mkdir(path.dirname(staged), { recursive: true });
for (const [source, destination] of products) {
  const builtStat = await stat(source).catch(() => null);
  if (!builtStat?.isFile() || builtStat.size < 1024)
    throw new Error(`macOS native player component was not built: ${source}`);
  await copyFile(source, destination);
  console.log(`Staged macOS native component: ${path.relative(root, destination)}`);
}

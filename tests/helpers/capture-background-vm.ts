import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** VM cannot parse ESM declarations without an experimental Node flag. Keep
 * both real module bodies, isolate their lexical scopes, and wire named imports
 * exactly as the browser does instead of stubbing the new application branch. */
export function captureBackgroundVmSource() {
  const application = readFileSync(resolve('extensions/zhihang-capture/application-background.js'), 'utf8').replace(/^export /gmu, '');
  const background = readFileSync(resolve('extensions/zhihang-capture/background.js'), 'utf8').replace(/^import \{ isByteDancePage, openApplication, registerApplicationMessages \} from '\.\/application-background\.js';\r?\n/u, '');
  return `const {isByteDancePage,openApplication,registerApplicationMessages}=(()=>{${application}\nreturn {isByteDancePage,openApplication,registerApplicationMessages};})();\n${background}`;
}

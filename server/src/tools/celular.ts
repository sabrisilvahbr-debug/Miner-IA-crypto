// Libera o painel para o celular na MESMA rede Wi-Fi: npm run celular (chamado pelo Abrir-no-Celular.bat).
//  - HOST=0.0.0.0 (o painel passa a ouvir a rede local) e API_TOKEN obrigatório;
//  - se não houver token, cria um fácil de digitar no celular (16 caracteres, 80 bits): XXXX-XXXX-XXXX-XXXX;
//  - mostra o endereço do computador na rede local e o token (só nesta janela; nada é enviado para a internet).
// Para voltar a atender só este computador: npm run celular -- --desfazer
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sem 0/O e 1/I

export function readableToken(bytes: Buffer = randomBytes(16)): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] & 31];
  return out.match(/.{4}/g)!.join('-');
}

export function tokenOf(text: string): string | undefined {
  const m = /^API_TOKEN=[ \t]*([^\s#]+)/m.exec(text);
  return m?.[1];
}

function setKey(text: string, key: string, value: string, note: string): string {
  const line = `${key}=${value}${note ? `            # ${note}` : ''}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
}

export function enablePhone(text: string, newToken: () => string = readableToken): { text: string; token: string; criado: boolean } {
  const existing = tokenOf(text);
  const token = existing ?? newToken();
  let out = setKey(text, 'HOST', '0.0.0.0', 'rede local (celular); exige API_TOKEN');
  if (!existing) out = setKey(out, 'API_TOKEN', token, 'criado por npm run celular');
  return { text: out, token, criado: !existing };
}

export function disablePhone(text: string): string {
  return setKey(text, 'HOST', '127.0.0.1', 'só este computador');
}

export const PUBLIC_LINK_DEFAULT = 'https://minercriptoia.vercel.app';

/** Link do QR: abre a página pública (que guarda o endereço no celular) e segue direto para o painel já autorizado.
 *  O token vai depois do "#": essa parte nunca é enviada a nenhum servidor, nem à Vercel. */
export function phoneLink(ip: string, port: string | number, token: string, base = PUBLIC_LINK_DEFAULT): string {
  return `${base.replace(/\/+$/, '')}/?p=${ip}:${port}#t=${encodeURIComponent(token)}`;
}

/** Link direto na rede local (sem passar pela internet). */
export function lanLink(ip: string, port: string | number, token: string): string {
  return `http://${ip}:${port}/#token=${encodeURIComponent(token)}`;
}

/** Endereços IPv4 privados deste computador (Wi-Fi/cabo). Ignora loopback e endereços públicos.
 *  192.168.x.x vem primeiro: 172.x.x.x costuma ser rede virtual (WSL, Hyper-V, Docker). */
export function lanAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

function main() {
  const env = '.env';
  if (!existsSync(env)) copyFileSync('.env.example', env);
  const text = readFileSync(env, 'utf8');
  if (process.argv.includes('--desfazer')) {
    writeFileSync(env, disablePhone(text));
    console.log('Pronto: o painel volta a atender só este computador (HOST=127.0.0.1).');
    return;
  }
  const r = enablePhone(text);
  writeFileSync(env, r.text);
  const port = /^PORT=[ \t]*(\d+)/m.exec(r.text)?.[1] ?? '8050';
  if (process.argv.includes('--url-pc')) {
    // Usado pelo Abrir-no-Celular.bat: abre o painel neste computador já autorizado e com o QR na tela.
    console.log(`http://127.0.0.1:${port}/#celular:${r.token}`);
    return;
  }
  const ips = lanAddresses();
  console.log('');
  console.log('==================== PAINEL NO CELULAR ====================');
  console.log(' O celular precisa estar na MESMA rede Wi-Fi deste computador.');
  if (ips.length) {
    console.log(' Endereço para digitar no celular:');
    for (const ip of ips) console.log(`     http://${ip}:${port}`);
  } else {
    console.log(' Não encontrei endereço de rede local. O computador está no Wi-Fi ou no cabo?');
  }
  console.log(` Token de acesso${r.criado ? ' (novo)' : ''}:  ${r.token}`);
  console.log(' O painel vai abrir neste computador com um QR code: aponte a câmera do celular.');
  console.log(' Sem QR: digite o endereço acima no celular e o token quando o painel pedir.');
  console.log(' Se o Windows perguntar sobre o Node.js no firewall, permita só em "Redes privadas".');
  console.log('===========================================================');
  console.log('');
}

if (process.argv[1]?.endsWith('celular.ts')) main();

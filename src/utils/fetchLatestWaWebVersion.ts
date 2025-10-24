import axios, { AxiosRequestConfig } from 'axios';
import { fetchLatestBaileysVersion, WAVersion } from 'baileys';

const PHP_VERSION_URL = 'https://erp.fitlikeaglove.com.br/ws.php';
const WHATSAPP_SW_URL = 'https://web.whatsapp.com/sw.js';

export const fetchLatestWaWebVersion = async (options: AxiosRequestConfig<{}> = {}) => {
  // Tenta pegar versão do PHP
  try {
    const { data } = await axios.get(PHP_VERSION_URL, options);
    if (Array.isArray(data?.version)) {
      return { version: data.version as WAVersion, isLatest: true, source: 'php' };
    }
  } catch {
    // erro ignorado, vai pro fallback
  }

  // Tenta pegar versão diretamente do WhatsApp
  try {
    const { data } = await axios.get(WHATSAPP_SW_URL, { ...options, responseType: 'text' });
    const match = data.match(/\\"client_revision\\"?:\s*(\d+)/);
    if (match?.[1]) {
      return { version: [2, 3000, +match[1]] as WAVersion, isLatest: true, source: 'whatsapp' };
    }
  } catch {
    // erro ignorado, vai pro fallback final
  }

  // Fallback final: última versão conhecida pelo Baileys
  const latest = await fetchLatestBaileysVersion();
  return { version: latest.version as WAVersion, isLatest: false, source: 'baileys' };
};

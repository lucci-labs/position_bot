import WebSocket from "ws";
import axios from "axios";

const token = process.env.TELEGRAM_BOT_TOKEN;
const channel = process.env.TELEGRAM_CHANNEL_ID;

// --- CONFIG ---
const BATCH_SIZE = 100; // Binance cho tối đa 200 streams mỗi connection → dùng 100 cho an toàn
const FUTURES_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BINANCE_WS_URL = "wss://fstream.binance.com/stream?streams=";
const MIN_NOTIONAL = 500_000; // chỉ hiện trade > 500k USD

// --- LẤY DANH SÁCH SYMBOL ---
async function getSymbols(): Promise<string[]> {
  const res = await axios.get(FUTURES_INFO_URL);
  const symbols = res.data.symbols
    .filter(
      (s: any) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT"
    )
    .map((s: any) => s.symbol.toLowerCase());
  console.log(`✅ Loaded ${symbols.length} perpetual USDT-M symbols`);
  return symbols;
}

// --- FORMAT NUMBER WITH K/M SUFFIX ---
function formatPrice(value: number): string {
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(2) + "M";
  } else if (value >= 1_000) {
    return (value / 1_000).toFixed(2) + "k";
  }
  return value.toFixed(2);
}

async function sendTelegram(text: string) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: channel,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Telegram sendMessage failed:", res.status, t);
  }
}

// --- TẠO WEBSOCKET THEO BATCH ---
function createStream(symbols: string[], index: number) {
  const streams = symbols.map((s) => `${s}@trade`).join("/");
  const ws = new WebSocket(BINANCE_WS_URL + streams);

  ws.on("open", () => {
    console.log(`🔗 [Batch ${index}] Connected (${symbols.length} symbols)`);
  });

  ws.on("message", (msg) => {
    const payload = JSON.parse(msg.toString());
    const trade = payload.data;
    if (!trade) return;

    const price = parseFloat(trade.p);
    const qty = parseFloat(trade.q);
    const notional = price * qty;
    if (notional < MIN_NOTIONAL) return;

    // xác định bên tấn công (BUY/SELL)
    const side = trade.m ? "SELL" : "BUY";


    const icon = side == "BUY" ? "🟢" : "🔴";
    const alert =
      `${icon} <b>#${trade.s}</b> big trade detected: $${formatPrice(notional)} at $${(price)}`
    // Fire & forget
    sendTelegram(alert).catch(console.error);
  });

  ws.on("close", () => {
    console.warn(`⚠️ [Batch ${index}] Connection closed. Reconnecting...`);
    setTimeout(() => createStream(symbols, index), 3000);
  });

  ws.on("error", (err) => {
    console.error(`❌ [Batch ${index}] Error:`, err.message);
    ws.close();
  });
}

// --- CHẠY TOÀN BỘ ---
async function start() {
  const allSymbols = await getSymbols();
  const batches: string[][] = [];

  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    batches.push(allSymbols.slice(i, i + BATCH_SIZE));
  }

  console.log(`🚀 Starting ${batches.length} WebSocket connections...`);
  batches.forEach((batch, i) => createStream(batch, i + 1));
}

start().catch(console.error);

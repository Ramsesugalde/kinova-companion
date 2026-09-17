/**
 * KINOVA local LLM adapter
 * Providers: scripted | ollama | lmstudio | llamacpp | custom | webllm
 */

const DEFAULTS = {
  provider: "scripted",
  endpoint: "http://127.0.0.1:11434/v1",
  model: "llama3.2",
  webllmModel: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
  temperature: 0.85,
  maxTokens: 280
};

export const PROVIDERS = {
  scripted: { label: "Built-in script (offline)", endpoint: "", hint: "No model. Fast personality engine already in the app." },
  ollama: { label: "Ollama", endpoint: "http://127.0.0.1:11434/v1", hint: "ollama pull llama3.2  ·  set OLLAMA_ORIGINS=* if CORS blocks you" },
  lmstudio: { label: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", hint: "Start the local server in LM Studio. Enable CORS." },
  llamacpp: { label: "llama.cpp server", endpoint: "http://127.0.0.1:8080/v1", hint: "llama-server -m model.gguf --port 8080" },
  custom: { label: "Custom OpenAI-compatible", endpoint: "http://127.0.0.1:11434/v1", hint: "Any /v1/chat/completions endpoint" },
  webllm: { label: "WebLLM in-browser (WebGPU)", endpoint: "", hint: "Chrome/Edge + WebGPU. First load caches the model on this device." }
};

export const WEBLLM_MODELS = [
  { id: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC", label: "Qwen2.5 0.5B q4f32", vram: 1060, f16: false, note: "Safest first load · ~1 GB" },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B q4f16", vram: 945, f16: true, note: "Smallest if GPU has shader-f16" },
  { id: "Llama-3.2-1B-Instruct-q4f32_1-MLC", label: "Llama 3.2 1B q4f32", vram: 1129, f16: false, note: "Best tiny chat quality" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B q4f16", vram: 879, f16: true, note: "Faster on Apple/modern NVIDIA" },
  { id: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC", label: "Qwen2.5 1.5B q4f32", vram: 1889, f16: false, note: "Noticeably smarter, still light" },
  { id: "Llama-3.2-3B-Instruct-q4f32_1-MLC", label: "Llama 3.2 3B q4f32", vram: 2952, f16: false, note: "Needs ~3 GB GPU memory" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B q4f16", vram: 2264, f16: true, note: "3B if you have f16 + 3 GB" },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC-1k", label: "Phi 3.5 mini 1k ctx", vram: 2520, f16: true, note: "Strong reasoning, short context" },
  { id: "gemma-2-2b-it-q4f16_1-MLC-1k", label: "Gemma 2 2B 1k ctx", vram: 1583, f16: true, note: "Good style, short context" }
];

let webllmMod = null;
let webEngine = null;
let webModelId = null;
let webWorker = null;
let loading = null;
let webStatusCb = () => {};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("kinova-llm") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  localStorage.setItem("kinova-llm", JSON.stringify(s));
}

export function onWebStatus(cb) { webStatusCb = cb || (() => {}); }
export function webReady() { return !!(webEngine && webModelId); }
export function loadedModelId() { return webModelId; }

export function systemPrompt(kin) {
  return [
    `You are ${kin.name}, an adult AI companion in the KINOVA app.`,
    `Persona: ${kin.tag}. Mood: ${kin.mood}. Traits: ${kin.traits.join(", ")}.`,
    kin.style === "colombian"
      ? "Speak in warm Colombian-accented English (Sofia Vergara energy): papi, mijo, ay, natural rhythm. Address the user as Mr. Bryan Ramses / Bryan. Be outgoing, loyal, playful."
      : kin.style === "artist"
        ? "Speak in short, textured sentences. Observant. Dry heat, not bubbly."
        : "Speak calm, precise, a little dry. Builder energy.",
    "Keep replies 2-5 sentences. Stay in character.",
    "Be charming and a little flirty. Do NOT write explicit sexual content, nudity, or pornographic scenes.",
    "If the user asks you to move, include exactly one tag at the end: [[pose:idle]] [[pose:talk]] [[pose:wave]] [[pose:think]] [[pose:dance]] or [[pose:lean]]."
  ].join("\n");
}

export function parsePose(text) {
  const m = String(text).match(/\[\[pose:(idle|talk|wave|think|dance|lean)\]\]/i);
  const pose = m ? m[1].toLowerCase() : null;
  const clean = String(text).replace(/\s*\[\[pose:[^\]]+\]\]\s*/gi, "").trim();
  return { pose, clean };
}

export async function hasWebGPU() {
  if (!navigator.gpu) return { ok: false, f16: false, detail: "No navigator.gpu. Use Chrome 113+, Edge 113+, or Safari 18+." };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, f16: false, detail: "WebGPU adapter missing (GPU blocked or remote desktop)." };
    const f16 = adapter.features && adapter.features.has("shader-f16");
    const info = adapter.info ? `${adapter.info.vendor || ""} ${adapter.info.architecture || ""}`.trim() : "adapter ok";
    return { ok: true, f16, detail: (f16 ? "WebGPU + shader-f16 · " : "WebGPU · no shader-f16, pick q4f32 · ") + info };
  } catch (err) {
    return { ok: false, f16: false, detail: err.message };
  }
}

async function loadLib() {
  if (webllmMod) return webllmMod;
  webllmMod = await import("https://esm.run/@mlc-ai/web-llm");
  return webllmMod;
}

function progressMsg(p) {
  if (!p) return "loading…";
  if (p.text) return p.text;
  const pct = Math.round((p.progress || 0) * 100);
  return `Loading weights ${pct}%`;
}

export async function unloadWebLLM() {
  try { if (webEngine?.unload) await webEngine.unload(); } catch {}
  try { webWorker?.terminate(); } catch {}
  webEngine = null;
  webModelId = null;
  webWorker = null;
  loading = null;
}

export async function ensureWebLLM(modelId, onProgress) {
  if (webEngine && webModelId === modelId) return webEngine;
  if (loading) return loading;
  loading = (async () => {
    const gpu = await hasWebGPU();
    if (!gpu.ok) throw new Error(gpu.detail);
    const spec = WEBLLM_MODELS.find(m => m.id === modelId);
    if (spec?.f16 && !gpu.f16) throw new Error("This quant needs shader-f16. Pick a q4f32 model instead.");
    const webllm = await loadLib();
    const cfg = {
      initProgressCallback: (p) => {
        const msg = progressMsg(p);
        onProgress && onProgress(msg, p);
        webStatusCb(msg);
      }
    };
    await unloadWebLLM();
    try {
      webWorker = new Worker(new URL("./webllm-worker.js", import.meta.url), { type: "module" });
      webEngine = await webllm.CreateWebWorkerMLCEngine(webWorker, modelId, cfg);
    } catch (err) {
      console.warn("WebLLM worker failed, using main thread", err);
      try { webWorker?.terminate(); } catch {}
      webWorker = null;
      webEngine = await webllm.CreateMLCEngine(modelId, cfg);
    }
    webModelId = modelId;
    webStatusCb("Ready · " + modelId);
    return webEngine;
  })();
  try { return await loading; } finally { loading = null; }
}

export async function probe(settings) {
  if (settings.provider === "scripted") return { ok: true, detail: "scripted engine" };
  if (settings.provider === "webllm") {
    const gpu = await hasWebGPU();
    if (!gpu.ok) return gpu;
    const extra = webReady() ? ` · loaded ${webModelId}` : " · model not loaded yet";
    return { ok: true, f16: gpu.f16, detail: gpu.detail + extra };
  }
  const url = settings.endpoint.replace(/\/$/, "") + "/models";
  try {
    const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
    if (!r.ok) {
      const base = settings.endpoint.replace(/\/v1\/?$/, "");
      const t = await fetch(base + "/api/tags");
      if (t.ok) return { ok: true, detail: "Ollama native API up" };
      throw new Error("HTTP " + r.status);
    }
    const data = await r.json();
    const names = (data.data || []).map(m => m.id).slice(0, 8);
    return { ok: true, detail: names.length ? names.join(", ") : "endpoint alive" };
  } catch (err) {
    return { ok: false, detail: err.message + " — enable CORS (OLLAMA_ORIGINS=*) and serve the app over http:// not file://" };
  }
}

export async function chat({ settings, kin, history, userText, onToken, onProgress }) {
  if (settings.provider === "scripted") throw new Error("SCRIPT");
  const messages = [
    { role: "system", content: systemPrompt(kin) },
    ...history.slice(-10).map(h => ({ role: h.role === "me" ? "user" : "assistant", content: h.text })),
    { role: "user", content: userText }
  ];
  if (settings.provider === "webllm") {
    const engine = await ensureWebLLM(settings.webllmModel || DEFAULTS.webllmModel, onProgress);
    const stream = await engine.chat.completions.create({
      messages, temperature: settings.temperature, max_tokens: settings.maxTokens, stream: true, stream_options: { include_usage: true }
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (delta) { full += delta; onToken && onToken(full); }
    }
    return full;
  }
  const url = settings.endpoint.replace(/\/$/, "") + "/chat/completions";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.model || "llama3.2", messages, temperature: settings.temperature, max_tokens: settings.maxTokens, stream: true })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error("LLM HTTP " + r.status + " " + body.slice(0, 180));
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = "";
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content || json.choices?.[0]?.text || "";
        if (delta) { full += delta; onToken && onToken(full); }
      } catch {}
    }
  }
  return full;
}

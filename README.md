# KINOVA — companion studio

Kindroid-style character companion for student projects.

- Switch Camila / Luna / Mateo
- Idle, talk, wave, think, dance, lean
- On-device memory
- Built-in scripted brain (always works)
- Optional Ollama, LM Studio, llama.cpp, or WebLLM (WebGPU in Chrome/Edge)

## Live test

Open the deployed URL. Chat works immediately with the scripted personality.

To load an in-browser model:

1. Chrome or Edge with WebGPU
2. Local LLM → WebLLM in-browser
3. Probe GPU
4. Pick a q4f32 model if shader-f16 is missing
5. Load WebLLM (first download is cached on your machine)

Ollama / LM Studio only work when this page can reach `127.0.0.1` — so those are for local `python3 -m http.server`, not the public URL.

## Local

```bash
cd kinova
python3 -m http.server 8787
```

Open http://127.0.0.1:8787

See `WEBLLM.md` and `LOCAL_LLM.md`.
